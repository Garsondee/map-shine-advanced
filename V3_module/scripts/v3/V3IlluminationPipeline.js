/**
 * @fileoverview V3 illumination pipeline — one **lighting resolve** pass that
 * combines ambient, occlusion (shadow-like) and direct (light-like) terms over
 * albedo produced by {@link V3ThreeSandwichCompositor}.
 *
 * Flow (driven by {@link V3ThreeSceneHost}):
 *
 *   sandwich.scene  --renderer.render-->  intermediate RT  (albedo, sRGB-encoded)
 *   pipeline.render(targetRT)            ->  lit output     (sRGB-encoded)
 *   overlays (water, …)                  ->  drawn on top of lit result
 *
 * **Stacked levels (bidirectional, N floors):** Foundry radial lights are no
 * longer packed into `uFl*` / `uTfFl*` uniform arrays. Instead,
 * {@link V3FloorLightBufferPass} renders each floor's lights into per-floor
 * HDR textures (`lightSum`, `colorSum`, typically RGBA16F) with additive blending, and
 * cascades every upper floor downward through the combined occluder alpha
 * (albedo + foreground + tile/overhead), attenuated by the chain factor
 * `chain_next = chain_prev * transmit(occluder_U)`. The resolve pass samples
 * two light textures at `mapUv`:
 *   - `uLocalLightTex`   — viewed-floor lights, no cascade
 *   - `uThroughLightTex` — light bled down from every upper floor, clipped by
 *     alpha holes at each intervening layer.
 *   (The floor pass still renders color RTs for diagnostics / future use; the
 *   resolve mimics v13 `LightingEffectV2`: one `safeLights` buffer drives
 *   both neutral multiply and coloration, like `tLightSources`.)
 *
 * This replaces the earlier fixed-cap `MAX_FL` pair-of-buckets model, supports
 * any number of lights per floor, and propagates light through any number of
 * floors without another recompile.
 *
 * **Why a separate resolve pass?** Before it existed, sky-lit darkness lived in
 * the sandwich shader. That works for a single shadow-like effect but breaks
 * as soon as a second shadow or any light is added: passes silently multiply
 * over each other and fight. Moving to one resolve pass with a small, stable
 * combine rule lets shadows and lights compose predictably.
 *
 * **Policy (texture-driven lights, V2 compose):** matches
 * `LightingEffectV2`: `lit = albedo * (ambient path + vec3(lightI)*master)` with
 * `minIllum` floor; **coloration** = `safeLights * master * perceivedBrightness(albedo) * strength`
 * using the **same** packed light buffer as `lightI` (not a second color RT).
 * Σ direct_j * albedo.a still adds after. Output alpha forced opaque.
 *
 * **Foundry AmbientLight (technique 1 “Adaptive Luminance”):** matches
 * `base-lighting.mjs` SHADER_TECHNIQUES.LUMINANCE coloration + `base-light-source.mjs`
 * colorationAlpha mapping, ported into {@link V3FloorLightBufferPass}'s batch
 * shader so packed `lightSum` retains the same Foundry response (color RTs are
 * still rendered for cascade bookkeeping; resolve uses V2 single-buffer compose).
 *
 * - `occ_i` ∈ [0,1] per pixel (or per channel) — shadows multiply inside one
 *   clamped product so "two shadows" never over-darken.
 * - `direct_j` ∈ vec3 — lights add **after** occlusion so they punch through
 *   night without being multiplied away by another fullscreen dim.
 * - `albedo.a` scales direct so premultiplied-alpha edges stay correct.
 *
 * **Storage convention:** the intermediate RT holds sRGB-encoded values —
 * matching what the sandwich/water shaders currently emit. The composer
 * decodes to linear (EOTF), combines in linear, and re-encodes (OETF) before
 * writing, so multiplication is perceptually correct and the pass is a true
 * visual passthrough when all terms are off.
 *
 * Terms register via {@link V3IlluminationPipeline#registerOcclusionTerm} /
 * {@link V3IlluminationPipeline#registerDirectTerm}.
 */

import * as THREE from "../vendor/three.module.js";
import { V3_LEVEL_TEXTURE_FLIP_Y } from "./V3RenderConventions.js";
import { V3IlluminationFrameContext } from "./V3IlluminationFrameContext.js";

const MAX_OCC = 4;
/** Direct-term texture slots (fragment samplers: uSrc + occ + dir + lights + tokens ≤ 16). */
const MAX_DIR = 4;

/**
 * Occlusion slot kinds. A term sets `slot.kind` inside its `update()`.
 *   UNIFORM       — factor = 1 - clamp(weight * scalar, 0, 1)   (no texture)
 *   SKY_REACH     — factor = 1 - clamp(scalar * (1 - tex.r) * weight, 0, 1)
 *   MASK_MULTIPLY — factor = mix(1.0, tex.r, weight)
 */
export const OCC_KIND = Object.freeze({
  UNIFORM: 0,
  SKY_REACH: 1,
  MASK_MULTIPLY: 2,
});

/**
 * Direct (emit) slot kinds.
 *   UNIFORM    — contrib = color * intensity
 *   MASKED_ADD — contrib = tex.rgb * color * intensity  (tex sampled in map UV)
 */
export const DIR_KIND = Object.freeze({
  UNIFORM: 0,
  MASKED_ADD: 1,
});

const VERT = /* glsl */ `precision highp float;
in vec3 position;
in vec2 uv;
out vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

const FRAG = /* glsl */ `precision highp float;
#define MAX_OCC ${MAX_OCC}
#define MAX_DIR ${MAX_DIR}

in vec2 vUv;
out vec4 fragColor;

uniform sampler2D uSrc;
uniform vec2  uResolution;
uniform vec2  uPivotWorld;
uniform float uInvScale;
uniform vec4  uSceneRect;
uniform float uFlipBackgroundY;

uniform vec3  uAmbientColor;
uniform float uAmbientStrength;
/** Effective scene darkness 0..1 (see {@link V3IlluminationFrameContext#sceneDarkness01}). */
uniform float uSceneDarkness;
// Linear RGB: Foundry ambientDarkness tint at full night (not black).
uniform vec3  uDarknessTintRgb;

uniform int       uOccCount;
uniform int       uOccKind[MAX_OCC];
uniform float     uOccEnabled[MAX_OCC];
uniform float     uOccWeight[MAX_OCC];
uniform float     uOccScalar[MAX_OCC];
uniform sampler2D uOccTex[MAX_OCC];
uniform float     uOccHasTex[MAX_OCC];

uniform int       uDirCount;
uniform int       uDirKind[MAX_DIR];
uniform float     uDirEnabled[MAX_DIR];
uniform vec3      uDirColor[MAX_DIR];
uniform float     uDirIntensity[MAX_DIR];
uniform sampler2D uDirTex[MAX_DIR];
uniform float     uDirHasTex[MAX_DIR];

// Texture-driven Foundry radial lights (produced by V3FloorLightBufferPass).
// Each sample is packed as packedSum = clamp(sum / uLightBufferRange, 0, 1)
// so an RGBA8 target can hold contributions well above 1.0 per channel.
// Multiply by uLightBufferRange on consume to recover the true sum.
uniform sampler2D uLocalLightTex;
uniform sampler2D uThroughLightTex;
uniform float     uLightBufferRange;
uniform float     uHasLightBuffers;

uniform float uFlLightAddScale;
uniform float uFlIlluminationStrength;
uniform float uFlColorationStrength;
uniform float uFlColorationReflectivity;
uniform float uFlColorationSaturation;
uniform float uFlGroundSaturation;
uniform float uFlGroundContrast;
uniform float uSceneGradeEnabled;
uniform float uSceneGradeExposure;
uniform float uSceneGradeTemperature;
uniform float uSceneGradeTint;
uniform float uSceneGradeBrightness;
uniform float uSceneGradeContrast;
uniform float uSceneGradeSaturation;
uniform float uSceneGradeVibrance;
uniform vec3  uSceneGradeLift;
uniform vec3  uSceneGradeGamma;
uniform vec3  uSceneGradeGain;
uniform float uSceneGradeMasterGamma;
uniform float uSceneGradeToneMapping;
uniform sampler2D uTokenBelowPremul;
uniform float uHasTokenBelow;
uniform sampler2D uTokenAbovePremul;
uniform float uHasTokenAbove;
uniform float uTokenGradeEnabled;
uniform float uTokenGradeExposure;
uniform float uTokenGradeTemperature;
uniform float uTokenGradeTint;
uniform float uTokenGradeBrightness;
uniform float uTokenGradeContrast;
uniform float uTokenGradeSaturation;
uniform float uTokenGradeVibrance;
uniform float uTokenGradeAmount;

vec3 sRGBDecode(vec3 c) {
  return mix(
    pow((c + vec3(0.055)) / 1.055, vec3(2.4)),
    c / 12.92,
    vec3(lessThanEqual(c, vec3(0.04045)))
  );
}

vec3 sRGBEncode(vec3 c) {
  return mix(
    pow(c, vec3(0.41666)) * 1.055 - vec3(0.055),
    c * 12.92,
    vec3(lessThanEqual(c, vec3(0.0031308)))
  );
}

vec3 v3AcesFilmicToneMapping(vec3 x) {
  float a = 2.51;
  float b = 0.03;
  float c = 2.43;
  float d = 0.59;
  float e = 0.14;
  return clamp((x * (a * x + b)) / (x * (c * x + d) + e), 0.0, 1.0);
}

vec3 v3ReinhardToneMapping(vec3 x) {
  return x / (x + vec3(1.0));
}

vec3 v3ApplyWhiteBalance(vec3 color, float temp, float tintVal) {
  vec3 tempShift = vec3(1.0 + temp, 1.0, 1.0 - temp);
  if (temp < 0.0) tempShift = vec3(1.0, 1.0, 1.0 - temp * 0.5);
  else tempShift = vec3(1.0 + temp * 0.5, 1.0, 1.0);
  vec3 tintShift = vec3(1.0 + max(tintVal, 0.0), 1.0 - abs(tintVal), 1.0 + max(tintVal, 0.0));
  if (tintVal < 0.0) tintShift = vec3(1.0 + tintVal, 1.0, 1.0 + tintVal);
  return color * tempShift * max(tintShift, vec3(0.001));
}

vec3 v3ApplySceneColorGrade(vec3 color) {
  color *= max(uSceneGradeExposure, 0.0);
  color = v3ApplyWhiteBalance(color, uSceneGradeTemperature, uSceneGradeTint);
  color += vec3(uSceneGradeBrightness * 0.25);
  float softContrast = 1.0 + ((uSceneGradeContrast - 1.0) * 0.35);
  color = (color - 0.5) * softContrast + 0.5;

  float luma = dot(color, vec3(0.2126, 0.7152, 0.0722));
  vec3 gray = vec3(luma);
  float sat = max(color.r, max(color.g, color.b)) - min(color.r, min(color.g, color.b));
  vec3 satColor = mix(gray, color, uSceneGradeSaturation);
  if (uSceneGradeVibrance != 0.0) {
    satColor = mix(satColor, mix(gray, satColor, 1.0 + uSceneGradeVibrance), (1.0 - sat));
  }
  color = satColor;

  color = color + (uSceneGradeLift * 0.1);
  color = max(color * uSceneGradeGain, vec3(0.0));
  color = pow(color, vec3(1.0) / max(uSceneGradeGamma, vec3(0.0001)));
  if (uSceneGradeMasterGamma != 1.0) {
    color = pow(color, vec3(1.0 / max(uSceneGradeMasterGamma, 0.0001)));
  }

  int toneMap = int(floor(uSceneGradeToneMapping + 0.5));
  if (toneMap == 1) color = v3AcesFilmicToneMapping(color);
  else if (toneMap == 2) color = v3ReinhardToneMapping(color);

  return clamp(color, 0.0, 1.0);
}

vec3 v3ApplyTokenColorGrade(vec3 color) {
  color *= max(uTokenGradeExposure, 0.0);
  color = v3ApplyWhiteBalance(color, uTokenGradeTemperature, uTokenGradeTint);
  color += vec3(uTokenGradeBrightness * 0.25);
  float softContrast = 1.0 + ((uTokenGradeContrast - 1.0) * 0.35);
  color = (color - 0.5) * softContrast + 0.5;
  float luma = dot(color, vec3(0.2126, 0.7152, 0.0722));
  vec3 gray = vec3(luma);
  float sat = max(color.r, max(color.g, color.b)) - min(color.r, min(color.g, color.b));
  vec3 satColor = mix(gray, color, uTokenGradeSaturation);
  if (uTokenGradeVibrance != 0.0) {
    satColor = mix(satColor, mix(gray, satColor, 1.0 + uTokenGradeVibrance), (1.0 - sat));
  }
  return clamp(satColor, 0.0, 3.5);
}

// WebGL: sampler2D array indices must be **constant** at compile time. Route
// dynamic slot indices through branches so each texture() uses a literal slot.
float sampleOccTexR(int slot, vec2 uv) {
  float r = 0.0;
  if (slot == 0) r = texture(uOccTex[0], uv).r;
  else if (slot == 1) r = texture(uOccTex[1], uv).r;
  else if (slot == 2) r = texture(uOccTex[2], uv).r;
  else r = texture(uOccTex[3], uv).r;
  return r;
}

vec3 sampleDirTexRgb(int slot, vec2 uv) {
  vec3 c = vec3(0.0);
  if (slot == 0) c = texture(uDirTex[0], uv).rgb;
  else if (slot == 1) c = texture(uDirTex[1], uv).rgb;
  else if (slot == 2) c = texture(uDirTex[2], uv).rgb;
  else c = texture(uDirTex[3], uv).rgb;
  return c;
}

// Foundry base-shader-mixin.mjs PERCEIVED_BRIGHTNESS (BT709), used by
// base-lighting.mjs SHADER_TECHNIQUES.LUMINANCE.coloration.
float foundryPerceivedBrightness(vec3 color) {
  const vec3 BT709 = vec3(0.2126, 0.7152, 0.0722);
  return sqrt(max(0.0, dot(BT709, color * color)));
}

// Same as LightingEffectV2 perceivedBrightness — linear luma for coloration weight.
float v2PerceivedBrightness(vec3 c) {
  return dot(c, vec3(0.2126, 0.7152, 0.0722));
}

void main() {
  vec4 src = texture(uSrc, vUv);

  // Reconstruct map UV using the same transform as the sandwich so mask-space
  // terms (skyReach et al.) align pixel-perfectly with the albedo underneath.
  vec2 center = uResolution * 0.5;
  vec2 screenTL = vec2(vUv.x * uResolution.x, (1.0 - vUv.y) * uResolution.y);
  vec2 delta = screenTL - center;
  vec2 world = uPivotWorld + delta * uInvScale;
  vec2 mapUvRaw = (world - uSceneRect.xy) / max(uSceneRect.zw, vec2(1.0));
  bool outside = mapUvRaw.x < 0.0 || mapUvRaw.x > 1.0 || mapUvRaw.y < 0.0 || mapUvRaw.y > 1.0;
  vec2 mapUv = mapUvRaw;
  if (uFlipBackgroundY > 0.5) mapUv.y = 1.0 - mapUv.y;
  mapUv = clamp(mapUv, 0.0, 1.0);

  vec3 rgbLinear = sRGBDecode(src.rgb);
  float a = src.a;

  vec3 ambient = uAmbientColor * max(uAmbientStrength, 0.0);

  float occ = 1.0;
  for (int i = 0; i < MAX_OCC; i++) {
    if (i >= uOccCount) break;
    if (uOccEnabled[i] < 0.5) continue;
    int kind = uOccKind[i];
    float w = max(uOccWeight[i], 0.0);
    float factor = 1.0;
    if (kind == 0) {
      factor = clamp(1.0 - w * uOccScalar[i], 0.0, 1.0);
    } else if (kind == 1) {
      float d = clamp(uOccScalar[i], 0.0, 1.0);
      float skyR = 1.0;
      if (outside) {
        skyR = 0.0;
      } else if (uOccHasTex[i] > 0.5) {
        skyR = clamp(sampleOccTexR(i, mapUv), 0.0, 1.0);
      }
      float darkAmt = clamp(d * (1.0 - skyR) * w, 0.0, 1.0);
      factor = 1.0 - darkAmt;
    } else if (kind == 2) {
      float m = 1.0;
      if (!outside && uOccHasTex[i] > 0.5) {
        m = clamp(sampleOccTexR(i, mapUv), 0.0, 1.0);
      }
      factor = mix(1.0, m, w);
    }
    occ *= factor;
  }
  occ = clamp(occ, 0.0, 1.0);

  vec3 direct = vec3(0.0);
  for (int i = 0; i < MAX_DIR; i++) {
    if (i >= uDirCount) break;
    if (uDirEnabled[i] < 0.5) continue;
    int kind = uDirKind[i];
    vec3 contrib = vec3(0.0);
    if (kind == 0) {
      contrib = uDirColor[i] * max(uDirIntensity[i], 0.0);
    } else if (kind == 1) {
      vec3 c = (!outside && uDirHasTex[i] > 0.5) ? sampleDirTexRgb(i, mapUv) : vec3(0.0);
      contrib = c * uDirColor[i] * max(uDirIntensity[i], 0.0);
    }
    direct += contrib;
  }

  float envDark = clamp(uSceneDarkness, 0.0, 1.0);
  vec3 ambOcc = ambient * occ;
  vec3 ambOccNight = ambOcc * mix(vec3(1.0), uDarknessTintRgb, envDark);
  vec3 dirAdd = direct * a;

  // Foundry-style radial lights sourced from per-floor texture buffers. The
  // local bucket holds the viewed floor's own lights; the through bucket is
  // the alpha-clipped downward cascade of every upper floor (built by
  // V3FloorLightBufferPass). Samples are packed in [0,1]; multiply by
  // uLightBufferRange to reconstruct the true contribution sum.
  vec3 lightSum = vec3(0.0);
  if (uHasLightBuffers > 0.5 && !outside) {
    float range = max(uLightBufferRange, 0.0);
    vec3 local = texture(uLocalLightTex, mapUv).rgb * range;
    vec3 thr   = texture(uThroughLightTex, mapUv).rgb * range;
    lightSum = local + thr;
  }

  // LightingEffectV2 compose (same bus texture for intensity + coloration tint):
  //   safeLights from tLightSources (+ window channel in V2); here = packed lightSum.
  float addScale = max(uFlLightAddScale, 0.0);
  vec3 safeLights = max(lightSum * addScale, vec3(0.0));
  vec3 safeForColor = safeLights;
  if (uFlColorationSaturation != 0.0) {
    vec3 greySL = vec3(foundryPerceivedBrightness(safeLights));
    safeForColor = clamp(mix(greySL, safeLights, 1.0 + uFlColorationSaturation), 0.0, 3.5);
  }
  float lightI = max(max(safeLights.r, safeLights.g), safeLights.b);
  float master = max(uFlIlluminationStrength, 0.0);
  // litColor = base * totalIllum; totalIllum = ambientTerms + vec3(lightI)*master
  vec3 dynIll = vec3(lightI) * master;
  vec3 totalIllum = ambOccNight + dynIll;
  // V2: minIllum = mix(ambientDay, ambientNight, localDarkness) * 0.1 — approximate
  // with the same ambient path already multiplied by occ + night tint.
  vec3 minIllum = ambOccNight * 0.1;
  totalIllum = max(totalIllum, minIllum);
  vec3 litColor = clamp(rgbLinear * totalIllum, 0.0, 1.0);
  // V2: coloration = safeLights * master * perceivedBrightness(base) * strength
  float reflV2 = v2PerceivedBrightness(rgbLinear);
  float colorationReflect = mix(1.0, reflV2, clamp(uFlColorationReflectivity, 0.0, 1.0));
  vec3 coloration = clamp(
    safeForColor * master * colorationReflect * max(uFlColorationStrength, 0.0),
    0.0,
    1.5
  );
  vec3 rgbLit = litColor + coloration + dirAdd;
  float lightPresence = clamp(lightI * master, 0.0, 1.0);
  if (uFlGroundSaturation != 0.0) {
    vec3 grey = vec3(foundryPerceivedBrightness(rgbLit));
    vec3 satLit = clamp(mix(grey, rgbLit, 1.0 + uFlGroundSaturation), 0.0, 3.5);
    rgbLit = mix(rgbLit, satLit, lightPresence);
  }
  if (uFlGroundContrast != 0.0) {
    vec3 conLit = clamp((rgbLit - 0.5) * (1.0 + uFlGroundContrast) + 0.5, 0.0, 3.5);
    rgbLit = mix(rgbLit, conLit, lightPresence);
  }

  if (uSceneGradeEnabled > 0.5) {
    rgbLit = v3ApplySceneColorGrade(rgbLit);
  }
  if (uTokenGradeEnabled > 0.5) {
    vec2 tokUv = vUv;
    float tokenA = 0.0;
    if (uHasTokenBelow > 0.5) tokenA = max(tokenA, clamp(texture(uTokenBelowPremul, tokUv).a, 0.0, 1.0));
    if (uHasTokenAbove > 0.5) tokenA = max(tokenA, clamp(texture(uTokenAbovePremul, tokUv).a, 0.0, 1.0));
    float w = clamp(tokenA * max(uTokenGradeAmount, 0.0), 0.0, 1.0);
    if (w > 0.0) {
      vec3 tokenGraded = v3ApplyTokenColorGrade(rgbLit);
      rgbLit = mix(rgbLit, tokenGraded, w);
    }
  }
  rgbLit = clamp(rgbLit, 0.0, 1.0);
  // Force opaque Three canvas output. The browser compositor stacks the Three
  // <canvas> below the (transparent) PIXI canvas; any fragment α<1 here lets
  // the DOM reveal the cleared/stale WebGL swap chain for one frame during
  // dual-canvas presentation drift — reads as a black flash. src.a is still
  // used above (via dirAdd = direct * a) so transparent albedo regions
  // correctly receive no direct light; only the final output alpha is clamped.
  fragColor = vec4(sRGBEncode(rgbLit), 1.0);
}
`;

/**
 * @typedef {{
 *   enabled: boolean,
 *   weight: number,
 *   scalar: number,
 *   kind: number,
 *   texture: (import('../vendor/three.module.js').Texture|null),
 * }} OcclusionSlot
 *
 * @typedef {{
 *   id: string,
 *   order?: number,
 *   update: (ctx: V3IlluminationFrameContext, slot: OcclusionSlot) => void,
 * }} OcclusionTermRegistration
 *
 * @typedef {{
 *   enabled: boolean,
 *   color: [number, number, number],
 *   intensity: number,
 *   kind: number,
 *   texture: (import('../vendor/three.module.js').Texture|null),
 * }} DirectSlot
 *
 * @typedef {{
 *   id: string,
 *   order?: number,
 *   update: (ctx: V3IlluminationFrameContext, slot: DirectSlot) => void,
 * }} DirectTermRegistration
 *
 * @typedef {{
 *   localLightTex?: (import('../vendor/three.module.js').Texture|null),
 *   localColorTex?: (import('../vendor/three.module.js').Texture|null),
 *   throughLightTex?: (import('../vendor/three.module.js').Texture|null),
 *   throughColorTex?: (import('../vendor/three.module.js').Texture|null),
 *   bufferRange?: number,
 *   hasLightBuffers?: boolean,
 * }} V3LightBufferState — `localColorTex` / `throughColorTex` are ignored (V2-style single buffer).
 */

export class V3IlluminationPipeline {
  constructor() {
    this.scene = new THREE.Scene();
    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 10);
    this.camera.position.set(0, 0, 1);

    /** @type {THREE.WebGLRenderTarget|null} */
    this._sourceRT = null;
    /** @type {THREE.DataTexture|null} 1×1 white fallback for `uOcc/uDir` samplers. */
    this._fallbackTex = null;
    /** @type {THREE.DataTexture|null} 1×1 RGBA(0,0,0,0) fallback for optional masks. */
    this._fallbackMatteTex = null;
    /** @type {THREE.DataTexture|null} 1×1 RGBA(0,0,0,0) fallback for unfilled light buffers. */
    this._fallbackLightTex = null;

    /** @type {THREE.Texture|null} Token premul deck (below map upper). */
    this._tokenBelowTex = null;
    /** @type {THREE.Texture|null} Token premul deck (on viewed floor). */
    this._tokenAboveTex = null;
    this._tokenBelowHas = 0;
    this._tokenAboveHas = 0;

    /** @type {THREE.Texture|null} */ this._localLightTex = null;
    /** @type {THREE.Texture|null} */ this._throughLightTex = null;
    this._lightBufferRange = 1.0;
    this._hasLightBuffers = 0;

    /**
     * Ambient "env" light applied before occlusion; default is identity
     * (white × 1) so the pass is a passthrough when no other terms contribute.
     */
    this._ambient = {
      color: new THREE.Color(1, 1, 1),
      strength: 1.0,
    };

    /** @type {OcclusionTermRegistration[]} */
    this._occTerms = [];
    /** @type {DirectTermRegistration[]} */
    this._dirTerms = [];

    this.material = new THREE.RawShaderMaterial({
      glslVersion: THREE.GLSL3,
      transparent: false,
      depthTest: false,
      depthWrite: false,
      uniforms: this._buildInitialUniforms(),
      vertexShader: VERT,
      fragmentShader: FRAG,
    });

    const geo = new THREE.PlaneGeometry(2, 2);
    this.mesh = new THREE.Mesh(geo, this.material);
    this.mesh.frustumCulled = false;
    this.scene.add(this.mesh);

    /** @type {V3IlluminationFrameContext} */
    this.frameContext = new V3IlluminationFrameContext();

    /** Policy tag surfaced in diag; bump when the combine rule changes. */
    this.policy = "v3-lightingeffectv2-compose";

    this._frameCount = 0;

    /**
     * Reused term scratch for {@link #_applyTermsToUniforms} — terms only write
     * into the slot each call; avoids allocating fresh `{...}` per term per frame.
     */
    this._occSlotScratch = {
      enabled: true,
      weight: 1,
      scalar: 0,
      kind: OCC_KIND.UNIFORM,
      texture: /** @type {any} */ (null),
    };
    this._dirSlotScratch = {
      enabled: true,
      color: /** @type {[number, number, number]} */ ([0, 0, 0]),
      intensity: 0,
      kind: DIR_KIND.UNIFORM,
      texture: /** @type {any} */ (null),
    };
  }

  _buildInitialUniforms() {
    return {
      uSrc: { value: null },
      uResolution: { value: new THREE.Vector2(1, 1) },
      uPivotWorld: { value: new THREE.Vector2(0, 0) },
      uInvScale: { value: 1 },
      uSceneRect: { value: new THREE.Vector4(0, 0, 1, 1) },
      uFlipBackgroundY: { value: 1 },

      uAmbientColor: { value: new THREE.Vector3(1, 1, 1) },
      uAmbientStrength: { value: 1 },
      uSceneDarkness: { value: 0 },
      uDarknessTintRgb: { value: new THREE.Vector3(0.033, 0.033, 0.033) },

      uOccCount: { value: 0 },
      uOccKind: { value: new Array(MAX_OCC).fill(0) },
      uOccEnabled: { value: new Array(MAX_OCC).fill(0) },
      uOccWeight: { value: new Array(MAX_OCC).fill(0) },
      uOccScalar: { value: new Array(MAX_OCC).fill(0) },
      uOccTex: { value: new Array(MAX_OCC).fill(null) },
      uOccHasTex: { value: new Array(MAX_OCC).fill(0) },

      uDirCount: { value: 0 },
      uDirKind: { value: new Array(MAX_DIR).fill(0) },
      uDirEnabled: { value: new Array(MAX_DIR).fill(0) },
      uDirColor: {
        value: Array.from({ length: MAX_DIR }, () => new THREE.Vector3(0, 0, 0)),
      },
      uDirIntensity: { value: new Array(MAX_DIR).fill(0) },
      uDirTex: { value: new Array(MAX_DIR).fill(null) },
      uDirHasTex: { value: new Array(MAX_DIR).fill(0) },

      uLocalLightTex: { value: null },
      uThroughLightTex: { value: null },
      uLightBufferRange: { value: 1.0 },
      uHasLightBuffers: { value: 0.0 },

      uFlLightAddScale: { value: 0.5 },
      uFlIlluminationStrength: { value: 0.5 },
      uFlColorationStrength: { value: 3.0 },
      uFlColorationReflectivity: { value: 1.0 },
      uFlColorationSaturation: { value: 0.0 },
      uFlGroundSaturation: { value: 0.0 },
      uFlGroundContrast: { value: 0.0 },
      uSceneGradeEnabled: { value: 0.0 },
      uSceneGradeExposure: { value: 1.0 },
      uSceneGradeTemperature: { value: 0.0 },
      uSceneGradeTint: { value: 0.0 },
      uSceneGradeBrightness: { value: 0.0 },
      uSceneGradeContrast: { value: 1.0 },
      uSceneGradeSaturation: { value: 1.0 },
      uSceneGradeVibrance: { value: 0.0 },
      uSceneGradeLift: { value: new THREE.Vector3(0, 0, 0) },
      uSceneGradeGamma: { value: new THREE.Vector3(1, 1, 1) },
      uSceneGradeGain: { value: new THREE.Vector3(1, 1, 1) },
      uSceneGradeMasterGamma: { value: 1.0 },
      uSceneGradeToneMapping: { value: 0.0 },
      uTokenBelowPremul: { value: null },
      uHasTokenBelow: { value: 0.0 },
      uTokenAbovePremul: { value: null },
      uHasTokenAbove: { value: 0.0 },
      uTokenGradeEnabled: { value: 0.0 },
      uTokenGradeExposure: { value: 1.0 },
      uTokenGradeTemperature: { value: 0.0 },
      uTokenGradeTint: { value: 0.0 },
      uTokenGradeBrightness: { value: 0.0 },
      uTokenGradeContrast: { value: 1.0 },
      uTokenGradeSaturation: { value: 1.0 },
      uTokenGradeVibrance: { value: 0.0 },
      uTokenGradeAmount: { value: 1.0 },
    };
  }

  _ensureFallbackTex() {
    if (this._fallbackTex) return this._fallbackTex;
    const t = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
    t.colorSpace = THREE.NoColorSpace;
    t.flipY = false;
    t.needsUpdate = true;
    this._fallbackTex = t;
    return t;
  }

  _ensureFallbackMatteTex() {
    if (this._fallbackMatteTex) return this._fallbackMatteTex;
    const data = new Uint8Array([0, 0, 0, 0]);
    const t = new THREE.DataTexture(data, 1, 1);
    t.colorSpace = THREE.NoColorSpace;
    t.flipY = V3_LEVEL_TEXTURE_FLIP_Y;
    t.needsUpdate = true;
    this._fallbackMatteTex = t;
    return t;
  }

  _ensureFallbackLightTex() {
    if (this._fallbackLightTex) return this._fallbackLightTex;
    const data = new Uint8Array([0, 0, 0, 0]);
    const t = new THREE.DataTexture(data, 1, 1);
    t.colorSpace = THREE.NoColorSpace;
    t.flipY = V3_LEVEL_TEXTURE_FLIP_Y;
    t.needsUpdate = true;
    this._fallbackLightTex = t;
    return t;
  }

  /**
   * Bind the texture-driven light buffers produced by
   * {@link V3FloorLightBufferPass}. Call once per frame (or whenever the
   * pass's output changes). Pass `hasLightBuffers: false` to disable
   * the light term entirely — the shader will skip the texture lookups
   * and `lightSum` stays at zero.
   * @param {V3LightBufferState} [opts]
   */
  setLightBufferTextures({
    localLightTex,
    throughLightTex,
    bufferRange,
    hasLightBuffers,
  } = {}) {
    this._localLightTex = localLightTex ?? null;
    this._throughLightTex = throughLightTex ?? null;
    if (Number.isFinite(bufferRange) && bufferRange > 0) {
      this._lightBufferRange = Number(bufferRange);
    }
    const enabled = hasLightBuffers === undefined
      ? !!(localLightTex || throughLightTex)
      : !!hasLightBuffers;
    this._hasLightBuffers = enabled ? 1 : 0;
  }

  /**
   * @deprecated Superseded by {@link setLightBufferTextures}. Preserved as a
   * no-op so callers on older paths keep working while the integration lands.
   */
  setAdjacentFloorMatteState() { /* no-op in v2 pipeline */ }

  /**
   * @deprecated Backcompat alias for {@link setAdjacentFloorMatteState}.
   */
  setThroughFloorMatteState() { /* no-op in v2 pipeline */ }

  /**
   * @deprecated The adjacent-floor blocker is now subsumed by the combined
   * occluder alpha inside {@link V3FloorLightBufferPass}; callers no longer
   * need to provide it separately.
   */
  setThroughFloorBlockerState() { /* no-op in v2 pipeline */ }

  /**
   * Token premul deck textures for token-only grading masks in the resolve pass.
   * @param {{ belowTex?: (import("../vendor/three.module.js").Texture|null), aboveTex?: (import("../vendor/three.module.js").Texture|null), belowHas?: boolean, aboveHas?: boolean }} [opts]
   */
  setTokenDeckState({ belowTex, aboveTex, belowHas, aboveHas } = {}) {
    this._tokenBelowTex = belowTex ?? null;
    this._tokenAboveTex = aboveTex ?? null;
    this._tokenBelowHas = belowHas ? 1 : 0;
    this._tokenAboveHas = aboveHas ? 1 : 0;
  }

  /**
   * WebGL requires every sampler to point at a valid texture, even if the
   * corresponding `has*` flag is zero — leaving a slot at `null` produces
   * "Active draw objects using uninitialized samplers" warnings. Pad
   * empties with 1×1 fallbacks.
   * @private
   */
  _padSamplerArrays() {
    const fb = this._ensureFallbackTex();
    const lightFb = this._ensureFallbackLightTex();
    const matteFb = this._ensureFallbackMatteTex();
    const u = this.material.uniforms;
    for (let i = 0; i < MAX_OCC; i++) {
      if (!u.uOccTex.value[i]) u.uOccTex.value[i] = fb;
    }
    for (let i = 0; i < MAX_DIR; i++) {
      if (!u.uDirTex.value[i]) u.uDirTex.value[i] = fb;
    }
    if (!u.uLocalLightTex?.value) u.uLocalLightTex.value = lightFb;
    if (!u.uThroughLightTex?.value) u.uThroughLightTex.value = lightFb;
    if (!u.uTokenBelowPremul?.value) {
      u.uTokenBelowPremul.value = matteFb;
    }
    if (!u.uTokenAbovePremul?.value) {
      u.uTokenAbovePremul.value = matteFb;
    }
  }

  /** @param {THREE.WebGLRenderTarget|null} rt */
  setSourceRenderTarget(rt) {
    this._sourceRT = rt ?? null;
  }

  /**
   * Base environmental wash applied before the occlusion product.
   * @param {{ color?: [number, number, number], strength?: number }} [opts]
   */
  setAmbient({ color, strength } = {}) {
    if (Array.isArray(color) && color.length >= 3) {
      const r = Number(color[0]);
      const g = Number(color[1]);
      const b = Number(color[2]);
      if ([r, g, b].every((n) => Number.isFinite(n))) {
        this._ambient.color.setRGB(r, g, b);
      }
    }
    if (typeof strength === "number" && Number.isFinite(strength)) {
      this._ambient.strength = Math.max(0, strength);
    }
  }

  /**
   * Register a shadow-like term that **multiplies** into the occlusion product.
   * Lower `order` evaluates first; `update(ctx, slot)` writes into the fixed
   * slot for the current frame. Duplicate ids replace the prior registration.
   *
   * @param {OcclusionTermRegistration} reg
   * @returns {() => void} unregister
   */
  registerOcclusionTerm(reg) {
    if (!reg?.id || typeof reg.update !== "function") {
      throw new Error("registerOcclusionTerm requires { id, update }");
    }
    this.unregisterTerm(reg.id);
    this._occTerms.push({
      id: String(reg.id),
      order: Number.isFinite(reg.order) ? Number(reg.order) : 100,
      update: reg.update,
    });
    this._occTerms.sort((a, b) => a.order - b.order);
    return () => this.unregisterTerm(reg.id);
  }

  /**
   * Register a light-like term that **adds** into the direct accumulator
   * after occlusion. Duplicate ids replace the prior registration.
   *
   * @param {DirectTermRegistration} reg
   * @returns {() => void} unregister
   */
  registerDirectTerm(reg) {
    if (!reg?.id || typeof reg.update !== "function") {
      throw new Error("registerDirectTerm requires { id, update }");
    }
    this.unregisterTerm(reg.id);
    if (this._dirTerms.length >= MAX_DIR) {
      throw new Error(`registerDirectTerm: at most ${MAX_DIR} direct terms (WebGL fragment sampler limit)`);
    }
    this._dirTerms.push({
      id: String(reg.id),
      order: Number.isFinite(reg.order) ? Number(reg.order) : 100,
      update: reg.update,
    });
    this._dirTerms.sort((a, b) => a.order - b.order);
    return () => this.unregisterTerm(reg.id);
  }

  /**
   * Remove a term (occlusion or direct) by id. Returns true if anything was
   * removed.
   * @param {string} id
   */
  unregisterTerm(id) {
    const sid = String(id);
    const before = this._occTerms.length + this._dirTerms.length;
    this._occTerms = this._occTerms.filter((t) => t.id !== sid);
    this._dirTerms = this._dirTerms.filter((t) => t.id !== sid);
    return this._occTerms.length + this._dirTerms.length !== before;
  }

  /** @returns {string[]} term ids in evaluation order. */
  listTermIds() {
    return [
      ...this._occTerms.map((t) => `occ:${t.id}`),
      ...this._dirTerms.map((t) => `dir:${t.id}`),
    ];
  }

  /**
   * Mutate the frame context in place (cheaper than allocating each tick).
   * @param {(ctx: V3IlluminationFrameContext) => void} mut
   */
  updateFrameContext(mut) {
    if (typeof mut === "function") mut(this.frameContext);
    return this.frameContext;
  }

  /** @private */
  _applyTermsToUniforms() {
    const u = this.material.uniforms;
    const ctx = this.frameContext;
    const readNum = (v, fallback) => {
      const n = Number(v);
      return Number.isFinite(n) ? n : fallback;
    };

    u.uAmbientColor.value.set(this._ambient.color.r, this._ambient.color.g, this._ambient.color.b);
    u.uAmbientStrength.value = this._ambient.strength;
    u.uSceneDarkness.value = Math.max(0, Math.min(1, Number(ctx.sceneDarkness01) || 0));
    const dt = Array.isArray(ctx.darknessTintLinear) ? ctx.darknessTintLinear : [0.033, 0.033, 0.033];
    u.uDarknessTintRgb.value.set(
      Math.max(0, Number(dt[0]) || 0),
      Math.max(0, Number(dt[1]) || 0),
      Math.max(0, Number(dt[2]) || 0),
    );

    u.uResolution.value.set(ctx.resolutionPx[0], ctx.resolutionPx[1]);
    u.uPivotWorld.value.set(ctx.pivotWorld[0], ctx.pivotWorld[1]);
    u.uInvScale.value = ctx.invScale;
    u.uSceneRect.value.set(
      ctx.sceneRect[0],
      ctx.sceneRect[1],
      ctx.sceneRect[2],
      ctx.sceneRect[3],
    );
    u.uFlipBackgroundY.value = ctx.flipBackgroundTextureY ? 1 : 0;
    u.uFlLightAddScale.value = Math.max(
      0,
      Math.min(2, readNum(ctx.foundryLightAddScale, 0.5)),
    );
    u.uFlIlluminationStrength.value = Math.max(
      0,
      Math.min(4, readNum(ctx.foundryLightIlluminationStrength, 0.25)),
    );
    u.uFlColorationStrength.value = Math.max(
      0,
      Math.min(4, readNum(ctx.foundryLightColorationStrength, 1.0)),
    );
    u.uFlColorationReflectivity.value = Math.max(
      0,
      Math.min(1, readNum(ctx.foundryLightColorationReflectivity, 1)),
    );
    u.uFlColorationSaturation.value = Math.max(
      -1,
      Math.min(4, readNum(ctx.foundryLightColorationSaturation, 1.0)),
    );
    u.uFlGroundSaturation.value = Math.max(
      -1,
      Math.min(4, readNum(ctx.foundryLightGroundSaturation, 0)),
    );
    u.uFlGroundContrast.value = Math.max(
      -1,
      Math.min(2, readNum(ctx.foundryLightGroundContrast, -0.2)),
    );
    u.uSceneGradeEnabled.value = ctx.sceneColorGradeEnabled ? 1 : 0;
    u.uSceneGradeExposure.value = Math.max(0, readNum(ctx.sceneGradeExposure, 1));
    u.uSceneGradeTemperature.value = Math.max(-1, Math.min(1, readNum(ctx.sceneGradeTemperature, 0)));
    u.uSceneGradeTint.value = Math.max(-1, Math.min(1, readNum(ctx.sceneGradeTint, 0)));
    u.uSceneGradeBrightness.value = Math.max(-0.1, Math.min(0.1, readNum(ctx.sceneGradeBrightness, 0)));
    u.uSceneGradeContrast.value = Math.max(0.5, Math.min(1.5, readNum(ctx.sceneGradeContrast, 0.995)));
    u.uSceneGradeSaturation.value = Math.max(0, Math.min(2.5, readNum(ctx.sceneGradeSaturation, 1.4)));
    u.uSceneGradeVibrance.value = Math.max(-1, Math.min(1, readNum(ctx.sceneGradeVibrance, 0)));
    const lift = Array.isArray(ctx.sceneGradeLift) ? ctx.sceneGradeLift : [0, 0, 0];
    const gamma = Array.isArray(ctx.sceneGradeGamma) ? ctx.sceneGradeGamma : [1, 1, 1];
    const gain = Array.isArray(ctx.sceneGradeGain) ? ctx.sceneGradeGain : [1, 1, 1];
    u.uSceneGradeLift.value.set(
      Math.max(0, Math.min(1, readNum(lift[0], 0))),
      Math.max(0, Math.min(1, readNum(lift[1], 0))),
      Math.max(0, Math.min(1, readNum(lift[2], 0))),
    );
    u.uSceneGradeGamma.value.set(
      Math.max(0.0001, Math.min(2, readNum(gamma[0], 1))),
      Math.max(0.0001, Math.min(2, readNum(gamma[1], 1))),
      Math.max(0.0001, Math.min(2, readNum(gamma[2], 1))),
    );
    u.uSceneGradeGain.value.set(
      Math.max(0, Math.min(2, readNum(gain[0], 1))),
      Math.max(0, Math.min(2, readNum(gain[1], 1))),
      Math.max(0, Math.min(2, readNum(gain[2], 1))),
    );
    u.uSceneGradeMasterGamma.value = Math.max(0.1, Math.min(3, readNum(ctx.sceneGradeMasterGamma, 1.05)));
    u.uSceneGradeToneMapping.value = Math.max(0, Math.min(2, Math.round(readNum(ctx.sceneGradeToneMapping, 0))));
    u.uTokenGradeEnabled.value = ctx.tokenColorGradeEnabled ? 1 : 0;
    u.uTokenGradeExposure.value = Math.max(0, Math.min(5, readNum(ctx.tokenGradeExposure, 0.9)));
    u.uTokenGradeTemperature.value = Math.max(-1, Math.min(1, readNum(ctx.tokenGradeTemperature, 0)));
    u.uTokenGradeTint.value = Math.max(-1, Math.min(1, readNum(ctx.tokenGradeTint, 0)));
    u.uTokenGradeBrightness.value = Math.max(-0.1, Math.min(0.1, readNum(ctx.tokenGradeBrightness, 0)));
    u.uTokenGradeContrast.value = Math.max(0.5, Math.min(1.5, readNum(ctx.tokenGradeContrast, 1)));
    u.uTokenGradeSaturation.value = Math.max(0, Math.min(2.5, readNum(ctx.tokenGradeSaturation, 1.25)));
    u.uTokenGradeVibrance.value = Math.max(-1, Math.min(1, readNum(ctx.tokenGradeVibrance, 0)));
    u.uTokenGradeAmount.value = Math.max(0, Math.min(1, readNum(ctx.tokenGradeAmount, 1)));

    const nOcc = Math.min(this._occTerms.length, MAX_OCC);
    u.uOccCount.value = nOcc;
    for (let i = 0; i < nOcc; i++) {
      const slot = this._occSlotScratch;
      slot.enabled = true;
      slot.weight = 1;
      slot.scalar = 0;
      slot.kind = OCC_KIND.UNIFORM;
      slot.texture = null;
      try {
        this._occTerms[i].update(ctx, slot);
      } catch (_) {
        slot.enabled = false;
      }
      u.uOccKind.value[i] = slot.kind | 0;
      u.uOccEnabled.value[i] = slot.enabled ? 1 : 0;
      u.uOccWeight.value[i] = Math.max(0, Number(slot.weight) || 0);
      u.uOccScalar.value[i] = Number.isFinite(slot.scalar) ? Number(slot.scalar) : 0;
      u.uOccTex.value[i] = slot.texture ?? null;
      u.uOccHasTex.value[i] = slot.texture ? 1 : 0;
    }
    for (let i = nOcc; i < MAX_OCC; i++) {
      u.uOccEnabled.value[i] = 0;
      u.uOccTex.value[i] = null;
      u.uOccHasTex.value[i] = 0;
    }

    const nDir = Math.min(this._dirTerms.length, MAX_DIR);
    u.uDirCount.value = nDir;
    for (let i = 0; i < nDir; i++) {
      const slot = this._dirSlotScratch;
      slot.enabled = true;
      slot.color[0] = 0;
      slot.color[1] = 0;
      slot.color[2] = 0;
      slot.intensity = 0;
      slot.kind = DIR_KIND.UNIFORM;
      slot.texture = null;
      try {
        this._dirTerms[i].update(ctx, slot);
      } catch (_) {
        slot.enabled = false;
      }
      u.uDirKind.value[i] = slot.kind | 0;
      u.uDirEnabled.value[i] = slot.enabled ? 1 : 0;
      const c = Array.isArray(slot.color) && slot.color.length >= 3 ? slot.color : [0, 0, 0];
      u.uDirColor.value[i].set(Number(c[0]) || 0, Number(c[1]) || 0, Number(c[2]) || 0);
      u.uDirIntensity.value[i] = Number.isFinite(slot.intensity)
        ? Math.max(0, Number(slot.intensity))
        : 0;
      u.uDirTex.value[i] = slot.texture ?? null;
      u.uDirHasTex.value[i] = slot.texture ? 1 : 0;
    }
    for (let i = nDir; i < MAX_DIR; i++) {
      u.uDirEnabled.value[i] = 0;
      u.uDirTex.value[i] = null;
      u.uDirHasTex.value[i] = 0;
    }

    u.uLocalLightTex.value = this._localLightTex ?? this._ensureFallbackLightTex();
    u.uThroughLightTex.value = this._throughLightTex ?? this._ensureFallbackLightTex();
    u.uLightBufferRange.value = Number.isFinite(this._lightBufferRange) && this._lightBufferRange > 0
      ? this._lightBufferRange
      : 1.0;
    u.uHasLightBuffers.value = this._hasLightBuffers ? 1 : 0;

    u.uTokenBelowPremul.value = this._tokenBelowTex;
    u.uHasTokenBelow.value = this._tokenBelowHas;
    u.uTokenAbovePremul.value = this._tokenAboveTex;
    u.uHasTokenAbove.value = this._tokenAboveHas;

    this._padSamplerArrays();
  }

  /**
   * Render the resolve pass. `targetRT = null` means the default framebuffer.
   *
   * @param {THREE.WebGLRenderer} renderer
   * @param {THREE.WebGLRenderTarget|null} [targetRT]
   */
  render(renderer, targetRT = null) {
    if (!renderer || !this._sourceRT) return;
    this.material.uniforms.uSrc.value = this._sourceRT.texture;
    this._applyTermsToUniforms();
    this._frameCount++;
    const prevRT = renderer.getRenderTarget();
    const prevAutoClear = renderer.autoClear;
    renderer.setRenderTarget(targetRT);
    // `autoClear: false`: the fullscreen quad writes every pixel of the target
    // with opaque alpha (see FRAG above), so a prior `gl.clear` is redundant.
    // Clearing the *default framebuffer* here also opens a transient-cleared
    // window that the browser compositor can sample between our clear and the
    // quad draw when Three and PIXI present on independent vsyncs — visible as
    // a one-frame black flash. See `docs/archive/2026-04-20-pre-restructure/V3-flicker-investigation.md` F4/F7.
    renderer.autoClear = false;
    renderer.render(this.scene, this.camera);
    renderer.setRenderTarget(prevRT);
    renderer.autoClear = prevAutoClear;
  }

  /** Diagnostics snapshot listing ambient + every registered term. */
  snapshot() {
    const u = this.material.uniforms;
    return {
      policy: this.policy,
      frameCount: this._frameCount,
      ambient: {
        color: [this._ambient.color.r, this._ambient.color.g, this._ambient.color.b],
        strength: this._ambient.strength,
      },
      frameContext: this.frameContext.snapshot(),
      occlusion: this._occTerms.map((t, i) => ({
        id: t.id,
        order: t.order,
        slot: i,
        enabled: (u.uOccEnabled.value[i] ?? 0) > 0.5,
        kind: u.uOccKind.value[i],
        weight: u.uOccWeight.value[i],
        scalar: u.uOccScalar.value[i],
        hasTex: (u.uOccHasTex.value[i] ?? 0) > 0.5,
      })),
      direct: this._dirTerms.map((t, i) => ({
        id: t.id,
        order: t.order,
        slot: i,
        enabled: (u.uDirEnabled.value[i] ?? 0) > 0.5,
        kind: u.uDirKind.value[i],
        color: [
          u.uDirColor.value[i].x,
          u.uDirColor.value[i].y,
          u.uDirColor.value[i].z,
        ],
        intensity: u.uDirIntensity.value[i],
        hasTex: (u.uDirHasTex.value[i] ?? 0) > 0.5,
      })),
      lightBuffers: {
        enabled: (u.uHasLightBuffers.value ?? 0) > 0.5,
        bufferRange: u.uLightBufferRange.value ?? 1.0,
        hasLocalLight: !!this._localLightTex,
        hasThroughLight: !!this._throughLightTex,
      },
    };
  }

  dispose() {
    try { this.mesh?.geometry?.dispose(); } catch (_) {}
    try { this.material?.dispose(); } catch (_) {}
    try { this._fallbackTex?.dispose(); } catch (_) {}
    try { this._fallbackMatteTex?.dispose(); } catch (_) {}
    try { this._fallbackLightTex?.dispose(); } catch (_) {}
    this._fallbackTex = null;
    this._fallbackMatteTex = null;
    this._fallbackLightTex = null;
    this._sourceRT = null;
    this._occTerms.length = 0;
    this._dirTerms.length = 0;
    this._localLightTex = null;
    this._throughLightTex = null;
  }
}

export { MAX_OCC, MAX_DIR };
