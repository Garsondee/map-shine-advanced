/**
 * @fileoverview V3 Floor Light Buffer Pass — texture-driven Foundry radial
 * light accumulation per floor, plus an N-floor downward cascade that clips
 * upper-floor light by the alpha of every intervening floor's occluder.
 *
 * Replaces the legacy `uFl*` / `uTfFl*` uniform-array light path inside
 * {@link V3IlluminationPipeline}. The previous model capped lights per bucket
 * at `MAX_FL` because GLSL3 uniform array length is fixed at compile time —
 * scenes with hundreds of lights silently dropped contributions when the
 * bucket overflowed. This pass renders all lights into per-floor RGB buffers
 * with additive blending, so the only practical limit is GPU fill rate.
 *
 * Pipeline (per frame, bottom-up):
 *   1. For every floor F with at least one assigned light:
 *      - Render `lightSum` (all lights) and `colorSum` (only lights with
 *        explicit color) into two scene-UV-space HDR RTs (RGBA16F when the
 *        context supports color-buffer half-float, otherwise RGBA8) by batching N
 *        lights at a time and additively blending. Light geometry is the
 *        same Foundry radial falloff (`v3FoundryRadialLightContrib`) the
 *        old `V3IlluminationPipeline` shader used, ported one-to-one so
 *        coloration techniques, attenuation, contrast, and shadows match.
 *   2. Build the viewed floor's local pair (`localLightRT`, `localColorRT`)
 *      = floor V's light buffers, no cascade.
 *   3. Build the through-floor pair (`throughLightRT`, `throughColorRT`):
 *      walk floors V+1 → top, maintaining
 *        `chain_next = chain_prev * transmit(occluder_U)`
 *        `accum_next = accum_prev + lightTex_U * chain_next`
 *      using the same combined occluder alpha that
 *      {@link V3BuildingShadowsPass} builds (albedo + foreground + tile
 *      overhead, MAX-combined). Each upper floor's contribution is
 *      attenuated by the alpha of every floor between it and the viewer,
 *      so light "leaks through holes" in the intervening plates exactly
 *      as the user requested.
 *   4. Output four scene-UV textures sampled by {@link V3IlluminationPipeline}
 *      at `mapUv` (the same flipped-Y convention as `uOccTex[]`).
 *
 * All RT textures use `flipY = V3_LEVEL_TEXTURE_FLIP_Y` so they line up with
 * the existing mask sampling convention (see {@link V3BuildingShadowsPass}).
 *
 * @module v3/V3FloorLightBufferPass
 */

import * as THREE from "../vendor/three.module.js";
import { V3_LEVEL_TEXTURE_FLIP_Y } from "./V3RenderConventions.js";

/**
 * RGBA8 dynamic range cap for `lightSum` / `colorSum`. Each Foundry-style
 * light contribution from `v3FoundryRadialLightContrib` is clamped to ~3.5
 * per channel; multiple overlapping bright lights can sum well past 1.0.
 * We pre-divide by this on write and re-multiply when consumed by the
 * illumination shader so the buffer can hold the same dynamic range as the
 * legacy uniform path. Half-float targets still use this packing so values
 * stay in a predictable range for the cascade pass.
 */
const LIGHT_BUFFER_RANGE = 8.0;

/** Number of lights per fullscreen accumulation batch (uniform array size). */
const BATCH_FL = 16;
/**
 * Per-light polygon gate cap (matches {@link V3IlluminationPipeline}'s
 * `MAX_FL_POLY` so collected lights survive the migration without re-shaping).
 */
const MAX_FL_POLY = 16;

/**
 * How many identical RGBA light/cascade targets we allocate (local, floor scratch,
 * cascade ×2 for light + color). Used with {@link resolveLightBufferRenderTargetType}
 * to derive a texel budget from {@link V3FloorLightBufferPass#_lightBufferVramBudgetMiB}.
 */
const LIGHT_COLOR_RT_COUNT = 8;

/** Hard ceiling on either RT dimension (WebGL texture limits; Foundry maps can be 10k+). */
const DEFAULT_MAX_EDGE_PX = 16384;

/** Default approximate VRAM for all {@link LIGHT_COLOR_RT_COUNT} RGBA half-float buffers. */
const DEFAULT_LIGHT_BUFFER_VRAM_BUDGET_MIB = 448;

/** Floor for the longest edge — small textures wash out radial falloff. */
const MIN_EDGE_PX = 640;

/**
 * HDR light accumulation removes 8-bit banding on smooth falloffs. WebGL2 can
 * render to RGBA16F by default; WebGL1 needs an extension.
 *
 * @param {THREE.WebGLRenderer|null} renderer
 * @returns {typeof THREE.UnsignedByteType|typeof THREE.HalfFloatType}
 */
function resolveLightBufferRenderTargetType(renderer) {
  if (!renderer) return THREE.UnsignedByteType;
  if (renderer.capabilities?.isWebGL2) return THREE.HalfFloatType;
  const ext = renderer.extensions;
  if (ext?.has?.("EXT_color_buffer_half_float") || ext?.has?.("EXT_color_buffer_float")) {
    return THREE.HalfFloatType;
  }
  return THREE.UnsignedByteType;
}

/**
 * @param {number} w
 * @param {number} h
 * @param {number} maxTexels `w * h` must not exceed this (preserves aspect).
 * @returns {{ w: number, h: number }}
 */
function fitDimensionsToTexelBudget(w, h, maxTexels) {
  const ww = Math.max(1, Math.round(w));
  const hh = Math.max(1, Math.round(h));
  const area = ww * hh;
  if (!Number.isFinite(maxTexels) || maxTexels <= 0 || area <= maxTexels) {
    return { w: ww, h: hh };
  }
  const s = Math.sqrt(maxTexels / area);
  return {
    w: Math.max(1, Math.round(ww * s)),
    h: Math.max(1, Math.round(hh * s)),
  };
}

const VERT = /* glsl */ `precision highp float;
in vec3 position;
in vec2 uv;
out vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

/**
 * Batched light accumulation fragment shader. Renders up to {@link BATCH_FL}
 * Foundry-style radial lights as a single fullscreen quad with additive
 * blending — the host invokes this once per batch per output mode (light vs
 * color) per floor.
 *
 * `uOutputMode == 0` writes the unweighted contribution sum (drives
 * "lightI" in the illumination shader). `uOutputMode == 1` writes only the
 * contribution from lights with `hasColor > 0.5` (drives the coloration
 * tint accumulator).
 *
 * Output is divided by {@link LIGHT_BUFFER_RANGE} so an RGBA8 RT can hold
 * the [0, LIGHT_BUFFER_RANGE] sum without saturating at 1.0 — the
 * illumination resolve multiplies by the same constant when sampling.
 */
const FRAG_LIGHT_BATCH = /* glsl */ `precision highp float;
#define BATCH_FL ${BATCH_FL}
#define MAX_FL_POLY ${MAX_FL_POLY}
#define LIGHT_BUFFER_RANGE ${LIGHT_BUFFER_RANGE.toFixed(6)}

in vec2 vUv;
out vec4 fragOut;

uniform int   uBatchCount;
uniform vec2  uFlCenter[BATCH_FL];
uniform float uFlInner[BATCH_FL];
uniform float uFlOuter[BATCH_FL];
uniform vec3  uFlColor[BATCH_FL];
uniform float uFlHasColor[BATCH_FL];
uniform float uFlColorationAlpha[BATCH_FL];
uniform float uFlAttenuation[BATCH_FL];
uniform float uFlColorationTechnique[BATCH_FL];
uniform float uFlLuminosity[BATCH_FL];
uniform float uFlContrast[BATCH_FL];
uniform float uFlSaturation[BATCH_FL];
uniform float uFlShadows[BATCH_FL];
uniform float uFlAngleDeg[BATCH_FL];
uniform float uFlRotationDeg[BATCH_FL];
uniform int   uFlPolyCount[BATCH_FL];
uniform vec2  uFlPolyVerts[BATCH_FL * MAX_FL_POLY];

uniform vec2  uWorldOrigin;
uniform vec2  uWorldSize;
uniform float uFlipUvY;

uniform sampler2D uAlbedoSurface;
uniform float     uHasAlbedoSurface;

uniform float uFlDimRadiusStrength;
uniform float uFlBrightRadiusStrength;

/** 0 = lightSum (all lights), 1 = colorSum (only lights with hasColor=1). */
uniform float uOutputMode;

vec3 sRGBDecode(vec3 c) {
  return mix(
    pow((c + vec3(0.055)) / 1.055, vec3(2.4)),
    c / 12.92,
    vec3(lessThanEqual(c, vec3(0.04045)))
  );
}

float foundryPerceivedBrightness(vec3 color) {
  const vec3 BT709 = vec3(0.2126, 0.7152, 0.0722);
  return sqrt(max(0.0, dot(BT709, color * color)));
}

vec3 v3ApplyFoundryLightBufferAdjustments(
  vec3 L,
  float contrast,
  float refl,
  float att,
  float brightRatio,
  float d,
  float luminosity,
  float saturation,
  float shadows
) {
  if (contrast != 0.0) {
    L = clamp((L - 0.5) * (contrast + 1.0) + 0.5, 0.0, 3.5);
  }
  if (saturation != 0.0) {
    vec3 grey = vec3(foundryPerceivedBrightness(L));
    L = clamp(mix(grey, L, 1.0 + saturation), 0.0, 3.5);
  }

  float exposure = luminosity * 2.0 - 1.0;
  if (exposure > 0.0) {
    float quartExposure = exposure * 0.25;
    float attenuationStrength = att * 0.25;
    float lowerEdge = 0.98 - attenuationStrength;
    float upperEdge = 1.02 + attenuationStrength;
    float finalExposure = quartExposure *
      (1.0 - smoothstep(brightRatio * lowerEdge, clamp(brightRatio * upperEdge, 0.0001, 1.0), d)) +
      quartExposure;
    L *= (1.0 + finalExposure);
  } else if (abs(exposure) > 1e-6) {
    L *= max(0.0, 1.0 + exposure);
  }

  if (shadows != 0.0) {
    float shadowing = mix(1.0, smoothstep(0.50, 0.80, foundryPerceivedBrightness(L)), shadows);
    L *= shadowing;
  }
  return clamp(L, vec3(0.0), vec3(3.5));
}

vec3 v3FoundryRadialLightContrib(
  vec2 world,
  vec3 rgbLinear,
  float refl,
  vec2 center,
  float innerPx,
  float outerPx,
  vec3 flColor,
  float colorationAlpha,
  float att,
  float technique,
  float luminosity,
  float contrast,
  float saturation,
  float shadows,
  float angleDeg,
  float rotationDeg
) {
  float outer = max(outerPx, innerPx + 1e-4);
  float distPx = distance(world, center);
  float d = clamp(distPx / outer, 0.0, 1.0);
  float brightRatio = clamp(innerPx / outer, 0.0, 0.999);
  float hardness = mix(0.05, 1.0, att);
  float dimFalloff = 1.0 - smoothstep(1.0 - hardness, 1.0, d);
  float brightDist = d / max(brightRatio, 1e-4);
  float brightFalloff = 1.0 - smoothstep(1.0 - hardness, 1.0, brightDist);
  float edgeFade = 1.0;
  if (att > 1e-5) {
    float e0 = min(max(1.0 - att, 0.0), 0.999);
    edgeFade = 1.0 - smoothstep(e0, 1.0, d);
  }
  float stamp = edgeFade * (
    dimFalloff * max(uFlDimRadiusStrength, 0.0) +
    brightFalloff * max(uFlBrightRadiusStrength, 0.0)
  );
  stamp = min(stamp, 6.0);

  float wedge = 1.0;
  if (angleDeg < 359.5) {
    vec2 dlt = world - center;
    float dlen = length(dlt);
    if (dlen > 1e-5) {
      float th = atan(dlt.y, dlt.x);
      float rot = radians(rotationDeg);
      float halfA = radians(angleDeg * 0.5);
      float off = abs(atan(sin(th - rot), cos(th - rot)));
      float edgeW = radians(max(4.0, angleDeg * 0.05));
      wedge = 1.0 - smoothstep(max(halfA - edgeW, 0.0), halfA + edgeW, off);
    }
  }
  stamp *= wedge;

  vec3 lightColor = clamp(flColor, 0.0, 1.0);
  vec3 tinted = clamp(lightColor * colorationAlpha, 0.0, 1.0);
  int tech = int(floor(technique + 0.5));
  vec3 L;
  if (tech == 0) {
    L = tinted * stamp;
  } else if (tech == 1) {
    L = tinted * stamp * refl;
  } else if (tech == 7) {
    float reflection = refl * smoothstep(0.35, 0.75, refl);
    L = tinted * stamp * reflection;
  } else if (tech == 8) {
    float reflection = refl * smoothstep(0.55, 0.85, refl);
    L = tinted * stamp * reflection;
  } else if (tech == 9) {
    float r = max(0.0, 1.0 - refl);
    L = tinted * stamp * (((r * r) * r) * (r * r));
  } else {
    L = rgbLinear * tinted * stamp;
  }
  return v3ApplyFoundryLightBufferAdjustments(
    L,
    contrast,
    refl,
    att,
    brightRatio,
    d,
    luminosity,
    saturation,
    shadows
  );
}

float v3LightPolygonMask(vec2 p, int li) {
  int n = uFlPolyCount[li];
  if (n < 3) return 1.0;
  bool inside = false;
  int base = li * MAX_FL_POLY;
  for (int j = 0; j < MAX_FL_POLY; j++) {
    if (j >= n) break;
    int k = (j + 1 >= n) ? 0 : (j + 1);
    vec2 a = uFlPolyVerts[base + j];
    vec2 b = uFlPolyVerts[base + k];
    bool intersects = ((a.y > p.y) != (b.y > p.y))
      && (p.x < ((b.x - a.x) * (p.y - a.y) / ((b.y - a.y) + 1e-6) + a.x));
    if (intersects) inside = !inside;
  }
  return inside ? 1.0 : 0.0;
}

void main() {
  vec2 uvForWorld = vec2(vUv.x, mix(vUv.y, 1.0 - vUv.y, uFlipUvY));
  vec2 world = uWorldOrigin + uvForWorld * uWorldSize;

  vec3 albedoLin = vec3(0.5);
  if (uHasAlbedoSurface > 0.5) {
    vec3 srgb = clamp(texture(uAlbedoSurface, vUv).rgb, 0.0, 1.0);
    albedoLin = sRGBDecode(srgb);
  }
  float refl = foundryPerceivedBrightness(albedoLin);

  bool colorOnly = uOutputMode > 0.5;

  vec3 sum = vec3(0.0);
  for (int i = 0; i < BATCH_FL; i++) {
    if (i >= uBatchCount) break;
    if (colorOnly && uFlHasColor[i] < 0.5) continue;
    float poly = v3LightPolygonMask(world, i);
    if (poly <= 0.0) continue;
    float att = clamp(uFlAttenuation[i], 0.0, 1.0);
    vec3 contrib = v3FoundryRadialLightContrib(
      world,
      albedoLin,
      refl,
      uFlCenter[i],
      uFlInner[i],
      uFlOuter[i],
      uFlColor[i],
      uFlColorationAlpha[i],
      att,
      uFlColorationTechnique[i],
      clamp(uFlLuminosity[i], 0.0, 1.0),
      uFlContrast[i],
      clamp(uFlSaturation[i], -1.0, 1.0),
      clamp(uFlShadows[i], 0.0, 1.0),
      uFlAngleDeg[i],
      uFlRotationDeg[i]
    );
    sum += contrib * poly;
  }

  // Pre-divide so the [0, LIGHT_BUFFER_RANGE] sum survives RGBA8 quantisation.
  // Illumination resolve multiplies by LIGHT_BUFFER_RANGE on consume.
  vec3 packed = clamp(sum / LIGHT_BUFFER_RANGE, 0.0, 1.0);
  fragOut = vec4(packed, 1.0);
}
`;

/**
 * Cascade fragment shader. Reads the running `(lightAccum, chain)` pair, the
 * current upper floor's light buffer, and the floor's combined occluder
 * alpha. Writes the next pair.
 *
 * Encoding: `out.rgb = lightAccum`, `out.a = chain`.
 *
 *   chain_next = chain_prev * transmit(occluder_U)
 *   light_next = light_prev + lightTex_U * chain_next
 *
 * `transmit = 1 - smoothstep(uAlphaHoleLo, uAlphaHoleHi, occluder.r)` —
 * mirrors {@link V3BuildingShadowsPass}'s alpha hole shaping so light and
 * shadow leak through the same authored hole edges.
 */
const FRAG_CASCADE = /* glsl */ `precision highp float;
in vec2 vUv;
out vec4 fragOut;

uniform sampler2D uPrevState;
uniform sampler2D uFloorLight;
uniform sampler2D uFloorOccluder;
uniform float uAlphaHoleLo;
uniform float uAlphaHoleHi;

void main() {
  vec4 prev = texture(uPrevState, vUv);
  vec3 lightAccum = prev.rgb;
  float chain = prev.a;

  vec3 lU = texture(uFloorLight, vUv).rgb;
  float aU = clamp(texture(uFloorOccluder, vUv).r, 0.0, 1.0);

  float solid = smoothstep(uAlphaHoleLo, uAlphaHoleHi, aU);
  float transmit = clamp(1.0 - solid, 0.0, 1.0);

  float chainNext = clamp(chain * transmit, 0.0, 1.0);
  vec3 lightNext = clamp(lightAccum + lU * chainNext, 0.0, 1.0);

  fragOut = vec4(lightNext, chainNext);
}
`;

/**
 * Initialize the cascade running state: `RGB = 0` (no accumulated light yet),
 * `A = 1` (fully transparent chain above the viewed floor).
 */
const FRAG_INIT_STATE = /* glsl */ `precision highp float;
out vec4 fragOut;
void main() {
  fragOut = vec4(0.0, 0.0, 0.0, 1.0);
}
`;

/**
 * Seed the per-floor occluder alpha accumulator from the alpha channel of
 * one source texture. Output single-channel in `.r` so the cascade shader's
 * `texture(uFloorOccluder, vUv).r` has consistent semantics regardless of
 * how many occluder textures fed it.
 */
const FRAG_OCCLUDER_SEED = /* glsl */ `precision highp float;
in vec2 vUv;
out vec4 fragOut;
uniform sampler2D uSource;
void main() {
  float a = clamp(texture(uSource, vUv).a, 0.0, 1.0);
  fragOut = vec4(a, 0.0, 0.0, 1.0);
}
`;

/**
 * Fold one additional occluder alpha texture into the accumulator using
 * MAX. Lets albedo + foreground + tile/overhead combine into a single
 * "any of these blocks light" per-pixel signal.
 */
const FRAG_OCCLUDER_MAX = /* glsl */ `precision highp float;
in vec2 vUv;
out vec4 fragOut;
uniform sampler2D uPrev;
uniform sampler2D uAdd;
void main() {
  float prevA = clamp(texture(uPrev, vUv).r, 0.0, 1.0);
  float addA = clamp(texture(uAdd, vUv).a, 0.0, 1.0);
  fragOut = vec4(max(prevA, addA), 0.0, 0.0, 1.0);
}
`;

/** @param {number} n */
function clamp01(n) {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

/**
 * Per-frame floor-indexed light accumulator + multi-floor downward cascade.
 *
 * One instance per host. Owns its render targets, materials, and a quad
 * geometry; the host calls {@link attach} with a renderer at mount and
 * {@link run} once per frame after collecting per-floor light lists.
 *
 * @typedef {{
 *   wx: number, wy: number,
 *   inner: number, outer: number,
 *   color: [number, number, number],
 *   hasColor: boolean,
 *   colorationAlpha: number,
 *   attenuation: number,
 *   coloration: number,
 *   luminosity: number,
 *   contrast: number,
 *   saturation: number,
 *   shadows: number,
 *   angleDeg: number,
 *   rotationDeg: number,
 *   priority?: number,
 *   polygon?: number[],
 * }} V3FloorLight
 *
 * @typedef {{
 *   floorIndex: number,
 *   lights: V3FloorLight[],
 *   occluderTexArray: THREE.Texture[],
 *   surfaceTex?: THREE.Texture|null,
 * }} V3FloorLightSpec
 *
 * @typedef {{
 *   localLightTex: THREE.Texture|null,
 *   localColorTex: THREE.Texture|null,
 *   throughLightTex: THREE.Texture|null,
 *   throughColorTex: THREE.Texture|null,
 *   throughChainTex: THREE.Texture|null,
 *   bufferRange: number,
 *   diag: V3FloorLightBufferDiagnostics,
 * }} V3FloorLightBufferRunResult
 *
 * @typedef {{
 *   lastRunFrame: number,
 *   lastRunMs: number,
 *   lastRtSize: [number, number],
 *   lastFloorCount: number,
 *   lastViewedIndex: number,
 *   lastCascadedFloors: number,
 *   lastTotalLights: number,
 *   lastBatchDraws: number,
 *   lastSkipReason: (string|null),
 *   totalRuns: number,
 *   totalSkips: number,
 *   lastLightBufferType: ("half"|"uint8"),
 * }} V3FloorLightBufferDiagnostics
 */
export class V3FloorLightBufferPass {
  /**
   * @param {{
   *   logger?: { log?: Function, warn?: Function },
   *   maxEdgePx?: number,
   *   lightBufferVramBudgetMiB?: number,
   * }} [opts]
   */
  constructor({ logger, maxEdgePx, lightBufferVramBudgetMiB } = {}) {
    /** @type {(...args: any[]) => void} */
    this.log = logger?.log ?? (() => {});
    /** @type {(...args: any[]) => void} */
    this.warn = logger?.warn ?? (() => {});

    const capEdge = Number(maxEdgePx);
    this._maxEdgePxCap = Number.isFinite(capEdge) && capEdge >= 1024
      ? Math.min(16384, Math.round(capEdge))
      : DEFAULT_MAX_EDGE_PX;

    const budget = Number(lightBufferVramBudgetMiB);
    this._lightBufferVramBudgetMiB = Number.isFinite(budget) && budget >= 256
      ? Math.min(4096, Math.round(budget))
      : DEFAULT_LIGHT_BUFFER_VRAM_BUDGET_MIB;

    /** @type {THREE.WebGLRenderer|null} */
    this.renderer = null;

    /** @type {THREE.Scene} */
    this._quadScene = new THREE.Scene();
    /** @type {THREE.OrthographicCamera} */
    this._quadCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this._quadCamera.position.set(0, 0, 0.5);
    /** @type {THREE.PlaneGeometry} */
    this._geo = new THREE.PlaneGeometry(2, 2);
    /** @type {THREE.Mesh} */
    this._mesh = new THREE.Mesh(this._geo);
    this._mesh.frustumCulled = false;
    this._quadScene.add(this._mesh);

    this._batchMaterial = new THREE.RawShaderMaterial({
      glslVersion: THREE.GLSL3,
      depthTest: false,
      depthWrite: false,
      transparent: true,
      blending: THREE.CustomBlending,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneFactor,
      blendEquation: THREE.AddEquation,
      blendSrcAlpha: THREE.OneFactor,
      blendDstAlpha: THREE.OneFactor,
      vertexShader: VERT,
      fragmentShader: FRAG_LIGHT_BATCH,
      uniforms: this._buildBatchUniforms(),
    });

    this._cascadeMaterial = new THREE.RawShaderMaterial({
      glslVersion: THREE.GLSL3,
      depthTest: false,
      depthWrite: false,
      transparent: false,
      vertexShader: VERT,
      fragmentShader: FRAG_CASCADE,
      uniforms: {
        uPrevState: { value: null },
        uFloorLight: { value: null },
        uFloorOccluder: { value: null },
        uAlphaHoleLo: { value: 0.1 },
        uAlphaHoleHi: { value: 0.9 },
      },
    });

    this._initStateMaterial = new THREE.RawShaderMaterial({
      glslVersion: THREE.GLSL3,
      depthTest: false,
      depthWrite: false,
      transparent: false,
      vertexShader: VERT,
      fragmentShader: FRAG_INIT_STATE,
      uniforms: {},
    });

    this._occluderSeedMaterial = new THREE.RawShaderMaterial({
      glslVersion: THREE.GLSL3,
      depthTest: false,
      depthWrite: false,
      transparent: false,
      vertexShader: VERT,
      fragmentShader: FRAG_OCCLUDER_SEED,
      uniforms: { uSource: { value: null } },
    });

    this._occluderMaxMaterial = new THREE.RawShaderMaterial({
      glslVersion: THREE.GLSL3,
      depthTest: false,
      depthWrite: false,
      transparent: false,
      vertexShader: VERT,
      fragmentShader: FRAG_OCCLUDER_MAX,
      uniforms: {
        uPrev: { value: null },
        uAdd: { value: null },
      },
    });

    /** Local viewed-floor `lightSum` RT. */
    /** @type {THREE.WebGLRenderTarget|null} */ this._localLightRT = null;
    /** Local viewed-floor `colorSum` RT. */
    /** @type {THREE.WebGLRenderTarget|null} */ this._localColorRT = null;

    /** Per-upper-floor scratch (recycled bottom-up across floors). */
    /** @type {THREE.WebGLRenderTarget|null} */ this._floorLightRT = null;
    /** @type {THREE.WebGLRenderTarget|null} */ this._floorColorRT = null;

    /** Cascade ping-pong for `lightSum` (RGB = light, A = chain). */
    /** @type {THREE.WebGLRenderTarget|null} */ this._cascadeLightA = null;
    /** @type {THREE.WebGLRenderTarget|null} */ this._cascadeLightB = null;

    /** Cascade ping-pong for `colorSum` (RGB = color, A = chain — independent). */
    /** @type {THREE.WebGLRenderTarget|null} */ this._cascadeColorA = null;
    /** @type {THREE.WebGLRenderTarget|null} */ this._cascadeColorB = null;

    /** Per-floor occluder alpha ping-pong. */
    /** @type {THREE.WebGLRenderTarget|null} */ this._occluderRTA = null;
    /** @type {THREE.WebGLRenderTarget|null} */ this._occluderRTB = null;

    /** @type {THREE.DataTexture|null} */ this._fallbackBlackTex = null;
    /** @type {THREE.DataTexture|null} */ this._fallbackOpaqueTex = null;
    /** @type {THREE.DataTexture|null} */ this._fallbackTransparentTex = null;

    /** @type {V3FloorLightBufferDiagnostics} */
    this._diag = {
      lastRunFrame: -1,
      lastRunMs: 0,
      lastRtSize: [0, 0],
      lastFloorCount: 0,
      lastViewedIndex: -1,
      lastCascadedFloors: 0,
      lastTotalLights: 0,
      lastBatchDraws: 0,
      lastSkipReason: "never-run",
      totalRuns: 0,
      totalSkips: 0,
      lastLightBufferType: "uint8",
    };
  }

  _buildBatchUniforms() {
    return {
      uBatchCount: { value: 0 },
      uFlCenter: { value: Array.from({ length: BATCH_FL }, () => new THREE.Vector2(0, 0)) },
      uFlInner: { value: new Array(BATCH_FL).fill(0) },
      uFlOuter: { value: new Array(BATCH_FL).fill(0) },
      uFlColor: {
        value: Array.from({ length: BATCH_FL }, () => new THREE.Vector3(0, 0, 0)),
      },
      uFlHasColor: { value: new Array(BATCH_FL).fill(0) },
      uFlColorationAlpha: { value: new Array(BATCH_FL).fill(0) },
      uFlAttenuation: { value: new Array(BATCH_FL).fill(0.5) },
      uFlColorationTechnique: { value: new Array(BATCH_FL).fill(1) },
      uFlLuminosity: { value: new Array(BATCH_FL).fill(0.5) },
      uFlContrast: { value: new Array(BATCH_FL).fill(0) },
      uFlSaturation: { value: new Array(BATCH_FL).fill(0) },
      uFlShadows: { value: new Array(BATCH_FL).fill(0) },
      uFlAngleDeg: { value: new Array(BATCH_FL).fill(360) },
      uFlRotationDeg: { value: new Array(BATCH_FL).fill(0) },
      uFlPolyCount: { value: new Array(BATCH_FL).fill(0) },
      uFlPolyVerts: {
        value: Array.from({ length: BATCH_FL * MAX_FL_POLY }, () => new THREE.Vector2(0, 0)),
      },
      uWorldOrigin: { value: new THREE.Vector2(0, 0) },
      uWorldSize: { value: new THREE.Vector2(1, 1) },
      uFlipUvY: { value: V3_LEVEL_TEXTURE_FLIP_Y ? 1 : 0 },
      uAlbedoSurface: { value: null },
      uHasAlbedoSurface: { value: 0 },
      uFlDimRadiusStrength: { value: 0.7 },
      uFlBrightRadiusStrength: { value: 4.0 },
      uOutputMode: { value: 0 },
    };
  }

  /** @param {THREE.WebGLRenderer} renderer */
  attach(renderer) {
    this.renderer = renderer || null;
  }

  detach() {
    this._disposeTargets();
    this.renderer = null;
  }

  dispose() {
    this._disposeTargets();
    try { this._batchMaterial.dispose(); } catch (_) {}
    try { this._cascadeMaterial.dispose(); } catch (_) {}
    try { this._initStateMaterial.dispose(); } catch (_) {}
    try { this._occluderSeedMaterial.dispose(); } catch (_) {}
    try { this._occluderMaxMaterial.dispose(); } catch (_) {}
    try { this._fallbackBlackTex?.dispose(); } catch (_) {}
    try { this._fallbackOpaqueTex?.dispose(); } catch (_) {}
    try { this._fallbackTransparentTex?.dispose(); } catch (_) {}
    this._fallbackBlackTex = null;
    this._fallbackOpaqueTex = null;
    this._fallbackTransparentTex = null;
    try { this._geo.dispose(); } catch (_) {}
    try { this._quadScene.remove(this._mesh); } catch (_) {}
    this._mesh = null;
    this.renderer = null;
  }

  /**
   * Quantised dynamic range used for unpacking light buffers in the
   * illumination shader (must be multiplied back in by the consumer).
   * @returns {number}
   */
  getBufferRange() {
    return LIGHT_BUFFER_RANGE;
  }

  /** @returns {V3FloorLightBufferDiagnostics} */
  getDiagnostics() {
    return {
      ...this._diag,
      lastRtSize: [...this._diag.lastRtSize],
    };
  }

  /**
   * Per-frame entry point. Walks every floor with assigned lights, builds
   * its `lightSum` / `colorSum` textures, then folds upper floors into the
   * through-floor accumulators with alpha-clipped transmission.
   *
   * @param {{
   *   floors: V3FloorLightSpec[],
   *   viewedIndex: number,
   *   sceneRect: [number, number, number, number],
   *   flipBackgroundTextureY?: boolean,
   *   appearance: { dimRadiusStrength: number, brightRadiusStrength: number },
   *   alphaHoleLo?: number,
   *   alphaHoleHi?: number,
   *   resolutionScale?: number,
   *   frame?: number,
   * }} args
   * @returns {V3FloorLightBufferRunResult|null}
   */
  run({
    floors,
    viewedIndex,
    sceneRect,
    flipBackgroundTextureY = V3_LEVEL_TEXTURE_FLIP_Y,
    appearance,
    alphaHoleLo = 0.1,
    alphaHoleHi = 0.9,
    resolutionScale = 1.0,
    frame = -1,
  }) {
    const renderer = this.renderer;
    const t0 = (typeof performance !== "undefined" && performance?.now)
      ? performance.now()
      : Date.now();

    if (!renderer) return this._skip("no-renderer", frame);
    if (!Array.isArray(floors)) return this._skip("no-floors", frame);
    if (!Array.isArray(sceneRect) || sceneRect.length < 4) {
      return this._skip("bad-sceneRect", frame);
    }
    if (!Number.isFinite(sceneRect[2]) || !Number.isFinite(sceneRect[3])
      || sceneRect[2] <= 0 || sceneRect[3] <= 0) {
      return this._skip("bad-sceneRect", frame);
    }

    const size = this._chooseTargetSize(floors, resolutionScale, sceneRect);
    if (!size) return this._skip("no-target-size", frame);

    this._ensureTargets(size.width, size.height);
    if (!this._localLightRT || !this._floorLightRT
      || !this._cascadeLightA || !this._occluderRTA) {
      return this._skip("rt-alloc-failed", frame);
    }

    const floorByIdx = new Map();
    for (const f of floors) {
      if (!f) continue;
      const idx = f.floorIndex | 0;
      floorByIdx.set(idx, f);
    }

    const upperIndices = Array.from(floorByIdx.keys())
      .filter((i) => i > viewedIndex)
      .sort((a, b) => a - b);

    const prevTarget = renderer.getRenderTarget();
    const prevAutoClear = renderer.autoClear;
    const prevClearColor = new THREE.Color();
    renderer.getClearColor(prevClearColor);
    const prevClearAlpha = renderer.getClearAlpha();

    let totalLights = 0;
    let totalBatches = 0;
    let cascadedFloors = 0;

    try {
      renderer.setClearColor(0x000000, 0);
      renderer.autoClear = false;

      const viewedSpec = floorByIdx.get(viewedIndex) ?? null;
      this._clearRTToZero(renderer, this._localLightRT);
      this._clearRTToZero(renderer, this._localColorRT);
      if (viewedSpec) {
        const lightCount = Array.isArray(viewedSpec.lights) ? viewedSpec.lights.length : 0;
        if (lightCount > 0) {
          totalLights += lightCount;
          totalBatches += this._renderFloorLights({
            renderer,
            destLightRT: this._localLightRT,
            destColorRT: this._localColorRT,
            spec: viewedSpec,
            sceneRect,
            flipBackgroundTextureY,
            appearance,
          });
        }
      }

      this._drawInitState(renderer, this._cascadeLightA);
      this._drawInitState(renderer, this._cascadeColorA);
      let readLight = this._cascadeLightA;
      let writeLight = this._cascadeLightB;
      let readColor = this._cascadeColorA;
      let writeColor = this._cascadeColorB;

      for (const upperIdx of upperIndices) {
        const upperSpec = floorByIdx.get(upperIdx);
        if (!upperSpec) continue;
        const lightCount = Array.isArray(upperSpec.lights) ? upperSpec.lights.length : 0;
        if (lightCount === 0
          && (!Array.isArray(upperSpec.occluderTexArray) || upperSpec.occluderTexArray.length === 0)) {
          continue;
        }

        // Per-floor light buffers (regenerated each iteration into the shared
        // floor scratch RTs).
        this._clearRTToZero(renderer, this._floorLightRT);
        this._clearRTToZero(renderer, this._floorColorRT);
        if (lightCount > 0) {
          totalLights += lightCount;
          totalBatches += this._renderFloorLights({
            renderer,
            destLightRT: this._floorLightRT,
            destColorRT: this._floorColorRT,
            spec: upperSpec,
            sceneRect,
            flipBackgroundTextureY,
            appearance,
          });
        }

        const occluderTex = this._buildFloorOccluderAlphaTexture(
          renderer,
          upperSpec.occluderTexArray ?? [],
        );

        // A floor without authored occluder data is treated as open air —
        // upper-floor light passes straight through without attenuation
        // (transmit = 1). This mirrors the shadow pass's "skip floors without
        // albedo" policy inverted for light: missing data ⇒ no blocker ⇒
        // light propagates, rather than silently dropping the upper light.
        const openAirTex = this._fallbackTransparentTexture();
        this._drawCascade(renderer, writeLight, {
          prevStateTex: readLight.texture,
          floorLightTex: this._floorLightRT.texture,
          floorOccluderTex: occluderTex ?? openAirTex,
          alphaHoleLo,
          alphaHoleHi,
        });
        this._drawCascade(renderer, writeColor, {
          prevStateTex: readColor.texture,
          floorLightTex: this._floorColorRT.texture,
          floorOccluderTex: occluderTex ?? openAirTex,
          alphaHoleLo,
          alphaHoleHi,
        });
        let swap = readLight; readLight = writeLight; writeLight = swap;
        swap = readColor; readColor = writeColor; writeColor = swap;
        cascadedFloors++;
      }

      this._diag.lastRunFrame = frame;
      this._diag.lastRtSize = [size.width, size.height];
      this._diag.lastFloorCount = floors.length;
      this._diag.lastViewedIndex = viewedIndex;
      this._diag.lastCascadedFloors = cascadedFloors;
      this._diag.lastTotalLights = totalLights;
      this._diag.lastBatchDraws = totalBatches;
      this._diag.lastSkipReason = null;
      this._diag.totalRuns++;

      const t1 = (typeof performance !== "undefined" && performance?.now)
        ? performance.now()
        : Date.now();
      this._diag.lastRunMs = t1 - t0;

      return {
        localLightTex: this._localLightRT.texture,
        localColorTex: this._localColorRT.texture,
        throughLightTex: readLight.texture,
        throughColorTex: readColor.texture,
        throughChainTex: readLight.texture,
        bufferRange: LIGHT_BUFFER_RANGE,
        diag: this.getDiagnostics(),
      };
    } catch (err) {
      this.warn("V3FloorLightBufferPass run failed", err);
      this._diag.lastSkipReason = "exception";
      this._diag.totalSkips++;
      return null;
    } finally {
      renderer.setRenderTarget(prevTarget);
      renderer.setClearColor(prevClearColor, prevClearAlpha);
      renderer.autoClear = prevAutoClear;
    }
  }

  /**
   * @param {string} reason
   * @param {number} frame
   * @returns {null}
   */
  _skip(reason, frame) {
    this._diag.lastSkipReason = reason;
    this._diag.lastRunFrame = frame;
    this._diag.totalSkips++;
    return null;
  }

  /**
   * @param {V3FloorLightSpec[]} floors
   * @param {number} resolutionScale
   * @param {number[]} sceneRect `[x, y, w, h]` in canvas pixels — ensures the
   *   buffer is not undersampled vs the visible scene when mask textures are small.
   * @returns {{ width: number, height: number }|null}
   */
  _chooseTargetSize(floors, resolutionScale, sceneRect) {
    let maxW = 0;
    let maxH = 0;
    for (const f of floors) {
      const tex = f?.surfaceTex ?? null;
      const occluders = Array.isArray(f?.occluderTexArray) ? f.occluderTexArray : [];
      const candidates = [tex, ...occluders];
      for (const t of candidates) {
        const img = t?.image;
        const iw = img?.width ?? img?.naturalWidth ?? 0;
        const ih = img?.height ?? img?.naturalHeight ?? 0;
        if (iw > maxW) maxW = iw;
        if (ih > maxH) maxH = ih;
      }
    }
    if (maxW <= 0 || maxH <= 0) {
      // Best effort fallback when no textures are available — pick a square
      // mid-range RT so downstream sampling doesn't skip the pass entirely.
      maxW = MIN_EDGE_PX;
      maxH = MIN_EDGE_PX;
    }
    const scale = Number.isFinite(resolutionScale)
      ? Math.max(0.25, Math.min(2.0, resolutionScale))
      : 1.0;
    let w = Math.max(1, Math.round(maxW * scale));
    let h = Math.max(1, Math.round(maxH * scale));
    const sceneW = Math.ceil(Math.max(1, Number(sceneRect?.[2]) || 0));
    const sceneH = Math.ceil(Math.max(1, Number(sceneRect?.[3]) || 0));
    if (sceneW > 1 && sceneH > 1) {
      w = Math.max(w, Math.max(1, Math.round(sceneW * scale)));
      h = Math.max(h, Math.max(1, Math.round(sceneH * scale)));
    }

    const colorType = resolveLightBufferRenderTargetType(this.renderer);
    const bytesPerTexel = colorType === THREE.HalfFloatType ? 8 : 4;
    const budgetBytes = this._lightBufferVramBudgetMiB * 1024 * 1024;
    const maxTexelsPerRt = Math.max(
      MIN_EDGE_PX * MIN_EDGE_PX,
      Math.floor(budgetBytes / (LIGHT_COLOR_RT_COUNT * bytesPerTexel)),
    );
    const fitted = fitDimensionsToTexelBudget(w, h, maxTexelsPerRt);
    w = fitted.w;
    h = fitted.h;

    const maxTexDim = (this.renderer?.capabilities?.maxTextureSize | 0) || this._maxEdgePxCap;
    const dimCap = Math.min(this._maxEdgePxCap, Math.max(1024, maxTexDim));
    const longest = Math.max(w, h);
    if (longest > dimCap) {
      const s = dimCap / longest;
      w = Math.max(1, Math.round(w * s));
      h = Math.max(1, Math.round(h * s));
    }
    if (Math.max(w, h) < MIN_EDGE_PX) {
      const s = MIN_EDGE_PX / Math.max(w, h);
      w = Math.max(1, Math.round(w * s));
      h = Math.max(1, Math.round(h * s));
    }
    return { width: w, height: h };
  }

  /**
   * @param {number} width
   * @param {number} height
   */
  _ensureTargets(width, height) {
    const colorType = resolveLightBufferRenderTargetType(this.renderer);
    const makeLight = () => {
      const rt = new THREE.WebGLRenderTarget(width, height, {
        depthBuffer: false,
        stencilBuffer: false,
        minFilter: THREE.LinearFilter,
        magFilter: THREE.LinearFilter,
        wrapS: THREE.ClampToEdgeWrapping,
        wrapT: THREE.ClampToEdgeWrapping,
        colorSpace: THREE.NoColorSpace,
        generateMipmaps: false,
        type: colorType,
      });
      rt.texture.flipY = V3_LEVEL_TEXTURE_FLIP_Y;
      return rt;
    };
    const makeOccluder = () => {
      const rt = new THREE.WebGLRenderTarget(width, height, {
        depthBuffer: false,
        stencilBuffer: false,
        minFilter: THREE.LinearFilter,
        magFilter: THREE.LinearFilter,
        wrapS: THREE.ClampToEdgeWrapping,
        wrapT: THREE.ClampToEdgeWrapping,
        colorSpace: THREE.NoColorSpace,
        generateMipmaps: false,
        type: THREE.UnsignedByteType,
      });
      rt.texture.flipY = V3_LEVEL_TEXTURE_FLIP_Y;
      return rt;
    };
    const ensureLight = (prop) => {
      const existing = this[prop];
      if (existing
        && existing.width === width
        && existing.height === height
        && existing.texture?.type === colorType) {
        return;
      }
      try { existing?.dispose(); } catch (_) {}
      this[prop] = makeLight();
    };
    const ensureOcc = (prop) => {
      const existing = this[prop];
      if (existing && existing.width === width && existing.height === height) return;
      try { existing?.dispose(); } catch (_) {}
      this[prop] = makeOccluder();
    };
    ensureLight("_localLightRT");
    ensureLight("_localColorRT");
    ensureLight("_floorLightRT");
    ensureLight("_floorColorRT");
    ensureLight("_cascadeLightA");
    ensureLight("_cascadeLightB");
    ensureLight("_cascadeColorA");
    ensureLight("_cascadeColorB");
    ensureOcc("_occluderRTA");
    ensureOcc("_occluderRTB");
    this._diag.lastLightBufferType = colorType === THREE.HalfFloatType ? "half" : "uint8";
  }

  _disposeTargets() {
    for (const k of [
      "_localLightRT", "_localColorRT",
      "_floorLightRT", "_floorColorRT",
      "_cascadeLightA", "_cascadeLightB",
      "_cascadeColorA", "_cascadeColorB",
      "_occluderRTA", "_occluderRTB",
    ]) {
      try { this[k]?.dispose(); } catch (_) {}
      this[k] = null;
    }
  }

  /**
   * Render a floor's light list into a `(lightSum, colorSum)` texture pair.
   * Lights are batched into {@link BATCH_FL}-sized groups and each batch is
   * drawn twice (once with `uOutputMode = 0` into `destLightRT`, once with
   * `uOutputMode = 1` into `destColorRT`) so the colored-only sum stays in
   * its own buffer for the coloration term in the resolve pass.
   *
   * @returns {number} batch draw count (for diagnostics).
   */
  _renderFloorLights({
    renderer,
    destLightRT,
    destColorRT,
    spec,
    sceneRect,
    flipBackgroundTextureY,
    appearance,
  }) {
    const lights = Array.isArray(spec.lights) ? spec.lights : [];
    if (!lights.length) return 0;
    const u = this._batchMaterial.uniforms;
    u.uWorldOrigin.value.set(Number(sceneRect[0]) || 0, Number(sceneRect[1]) || 0);
    u.uWorldSize.value.set(
      Math.max(1, Number(sceneRect[2]) || 1),
      Math.max(1, Number(sceneRect[3]) || 1),
    );
    u.uFlipUvY.value = flipBackgroundTextureY ? 1 : 0;
    u.uHasAlbedoSurface.value = spec.surfaceTex ? 1 : 0;
    u.uAlbedoSurface.value = spec.surfaceTex ?? this._fallbackBlackTexture();
    u.uFlDimRadiusStrength.value = Math.max(0, Number(appearance?.dimRadiusStrength) || 0.7);
    u.uFlBrightRadiusStrength.value = Math.max(0, Number(appearance?.brightRadiusStrength) || 4.0);

    let batches = 0;
    for (let start = 0; start < lights.length; start += BATCH_FL) {
      const slice = lights.slice(start, start + BATCH_FL);
      this._packBatchUniforms(slice);
      // Pass A: lightSum (all lights).
      u.uOutputMode.value = 0;
      this._drawAdditiveBatch(renderer, destLightRT);
      // Pass B: colorSum (lights with explicit color only).
      u.uOutputMode.value = 1;
      this._drawAdditiveBatch(renderer, destColorRT);
      batches++;
    }
    return batches * 2;
  }

  /**
   * @param {V3FloorLight[]} slice
   */
  _packBatchUniforms(slice) {
    const u = this._batchMaterial.uniforms;
    u.uBatchCount.value = Math.min(slice.length, BATCH_FL);
    for (let i = 0; i < BATCH_FL; i++) {
      const L = i < slice.length ? slice[i] : null;
      if (L) {
        u.uFlCenter.value[i].set(Number(L.wx) || 0, Number(L.wy) || 0);
        const inner = Math.max(0, Number(L.inner) || 0);
        const outerRaw = Number(L.outer);
        const outer = Number.isFinite(outerRaw) && outerRaw > inner
          ? outerRaw
          : inner + 1e-3;
        u.uFlInner.value[i] = inner;
        u.uFlOuter.value[i] = outer;
        const c = Array.isArray(L.color) && L.color.length >= 3 ? L.color : [1, 1, 1];
        u.uFlColor.value[i].set(Number(c[0]) || 0, Number(c[1]) || 0, Number(c[2]) || 0);
        u.uFlHasColor.value[i] = L.hasColor ? 1 : 0;
        u.uFlColorationAlpha.value[i] = Math.max(0, Number(L.colorationAlpha) || 0);
        const att = Number(L.attenuation);
        u.uFlAttenuation.value[i] = Number.isFinite(att) ? clamp01(att) : 0.5;
        u.uFlColorationTechnique.value[i] = Number.isFinite(Number(L.coloration))
          ? Math.max(0, Math.round(Number(L.coloration)))
          : 1;
        u.uFlLuminosity.value[i] = clamp01(Number(L.luminosity) || 0.5);
        u.uFlContrast.value[i] = Number.isFinite(Number(L.contrast)) ? Number(L.contrast) : 0;
        u.uFlSaturation.value[i] = Number.isFinite(Number(L.saturation))
          ? Math.max(-1, Math.min(1, Number(L.saturation)))
          : 0;
        u.uFlShadows.value[i] = Number.isFinite(Number(L.shadows))
          ? clamp01(Number(L.shadows))
          : 0;
        const ad = Number(L.angleDeg);
        u.uFlAngleDeg.value[i] = Number.isFinite(ad) && ad > 0 ? ad : 360;
        u.uFlRotationDeg.value[i] = Number.isFinite(Number(L.rotationDeg))
          ? Number(L.rotationDeg)
          : 0;
        const poly = Array.isArray(L.polygon) ? L.polygon : [];
        const nPolyRaw = Math.floor(poly.length / 2);
        const nPoly = Number.isFinite(nPolyRaw)
          ? Math.max(0, Math.min(MAX_FL_POLY, nPolyRaw))
          : 0;
        u.uFlPolyCount.value[i] = nPoly >= 3 ? nPoly : 0;
        const base = i * MAX_FL_POLY;
        for (let pv = 0; pv < MAX_FL_POLY; pv++) {
          const p = u.uFlPolyVerts.value[base + pv];
          if (pv < nPoly) {
            p.set(Number(poly[pv * 2]) || 0, Number(poly[pv * 2 + 1]) || 0);
          } else {
            p.set(0, 0);
          }
        }
      } else {
        u.uFlCenter.value[i].set(0, 0);
        u.uFlInner.value[i] = 0;
        u.uFlOuter.value[i] = 0;
        u.uFlColor.value[i].set(0, 0, 0);
        u.uFlHasColor.value[i] = 0;
        u.uFlColorationAlpha.value[i] = 0;
        u.uFlAttenuation.value[i] = 0.5;
        u.uFlColorationTechnique.value[i] = 1;
        u.uFlLuminosity.value[i] = 0.5;
        u.uFlContrast.value[i] = 0;
        u.uFlSaturation.value[i] = 0;
        u.uFlShadows.value[i] = 0;
        u.uFlAngleDeg.value[i] = 360;
        u.uFlRotationDeg.value[i] = 0;
        u.uFlPolyCount.value[i] = 0;
        const base = i * MAX_FL_POLY;
        for (let pv = 0; pv < MAX_FL_POLY; pv++) {
          u.uFlPolyVerts.value[base + pv].set(0, 0);
        }
      }
    }
    this._batchMaterial.uniformsNeedUpdate = true;
  }

  /**
   * @param {THREE.WebGLRenderer} renderer
   * @param {THREE.WebGLRenderTarget} dst
   */
  _drawAdditiveBatch(renderer, dst) {
    this._mesh.material = this._batchMaterial;
    renderer.setRenderTarget(dst);
    renderer.render(this._quadScene, this._quadCamera);
  }

  /**
   * @param {THREE.WebGLRenderer} renderer
   * @param {THREE.WebGLRenderTarget} dst
   */
  _drawInitState(renderer, dst) {
    this._mesh.material = this._initStateMaterial;
    renderer.setRenderTarget(dst);
    renderer.autoClear = true;
    renderer.render(this._quadScene, this._quadCamera);
    renderer.autoClear = false;
  }

  /**
   * Clear an RT to fully transparent black so subsequent additive batches
   * accumulate from a known zero baseline.
   *
   * @param {THREE.WebGLRenderer} renderer
   * @param {THREE.WebGLRenderTarget} dst
   */
  _clearRTToZero(renderer, dst) {
    renderer.setRenderTarget(dst);
    const prevAuto = renderer.autoClear;
    const prevColor = new THREE.Color();
    renderer.getClearColor(prevColor);
    const prevAlpha = renderer.getClearAlpha();
    renderer.setClearColor(0x000000, 0);
    renderer.autoClear = true;
    renderer.clear(true, false, false);
    renderer.setClearColor(prevColor, prevAlpha);
    renderer.autoClear = prevAuto;
  }

  /**
   * @param {THREE.WebGLRenderer} renderer
   * @param {THREE.WebGLRenderTarget} dst
   * @param {{
   *   prevStateTex: THREE.Texture,
   *   floorLightTex: THREE.Texture,
   *   floorOccluderTex: THREE.Texture,
   *   alphaHoleLo: number,
   *   alphaHoleHi: number,
   * }} args
   */
  _drawCascade(renderer, dst, { prevStateTex, floorLightTex, floorOccluderTex, alphaHoleLo, alphaHoleHi }) {
    const u = this._cascadeMaterial.uniforms;
    u.uPrevState.value = prevStateTex;
    u.uFloorLight.value = floorLightTex;
    u.uFloorOccluder.value = floorOccluderTex;
    const lo = clamp01(alphaHoleLo);
    let hi = clamp01(alphaHoleHi);
    if (hi <= lo) hi = Math.min(1, lo + 0.01);
    u.uAlphaHoleLo.value = lo;
    u.uAlphaHoleHi.value = hi;
    this._mesh.material = this._cascadeMaterial;
    renderer.setRenderTarget(dst);
    renderer.render(this._quadScene, this._quadCamera);
  }

  /**
   * Combine an arbitrary number of occluder textures into a single
   * single-channel alpha texture by repeated MAX folding. Mirrors the
   * builder in {@link V3BuildingShadowsPass} so the cascade transmit
   * value is consistent across the shadow + light cascades.
   *
   * @param {THREE.WebGLRenderer} renderer
   * @param {THREE.Texture[]} occluderTexArray
   * @returns {THREE.Texture|null}
   */
  _buildFloorOccluderAlphaTexture(renderer, occluderTexArray) {
    if (!Array.isArray(occluderTexArray)) return null;
    const list = occluderTexArray.filter(Boolean);
    if (!list.length || !this._occluderRTA || !this._occluderRTB) return null;
    this._drawOccluderSeed(renderer, this._occluderRTA, list[0]);
    let read = this._occluderRTA;
    let write = this._occluderRTB;
    for (let i = 1; i < list.length; i++) {
      this._drawOccluderMax(renderer, write, read.texture, list[i]);
      const swap = read; read = write; write = swap;
    }
    return read.texture;
  }

  /**
   * @param {THREE.WebGLRenderer} renderer
   * @param {THREE.WebGLRenderTarget} dst
   * @param {THREE.Texture} sourceTex
   */
  _drawOccluderSeed(renderer, dst, sourceTex) {
    this._occluderSeedMaterial.uniforms.uSource.value = sourceTex;
    this._mesh.material = this._occluderSeedMaterial;
    renderer.setRenderTarget(dst);
    renderer.render(this._quadScene, this._quadCamera);
  }

  /**
   * @param {THREE.WebGLRenderer} renderer
   * @param {THREE.WebGLRenderTarget} dst
   * @param {THREE.Texture} prevTex
   * @param {THREE.Texture} addTex
   */
  _drawOccluderMax(renderer, dst, prevTex, addTex) {
    const u = this._occluderMaxMaterial.uniforms;
    u.uPrev.value = prevTex;
    u.uAdd.value = addTex;
    this._mesh.material = this._occluderMaxMaterial;
    renderer.setRenderTarget(dst);
    renderer.render(this._quadScene, this._quadCamera);
  }

  /** @returns {THREE.Texture} */
  _fallbackBlackTexture() {
    if (this._fallbackBlackTex) return this._fallbackBlackTex;
    const t = new THREE.DataTexture(new Uint8Array([0, 0, 0, 0]), 1, 1);
    t.colorSpace = THREE.NoColorSpace;
    t.flipY = V3_LEVEL_TEXTURE_FLIP_Y;
    t.needsUpdate = true;
    this._fallbackBlackTex = t;
    return t;
  }

  /**
   * 1×1 RGBA(255,255,255,255) — alpha = 1, R = 1. Fed as `uFloorOccluder`
   * where a fully-opaque blocker is desired (chain decays to 0, no
   * through-light). Currently unused by the cascade itself (we default to
   * a transparent fallback below for the "no data" case); kept for callers
   * that explicitly want to stop propagation.
   *
   * @returns {THREE.Texture}
   */
  _fallbackOpaqueTexture() {
    if (this._fallbackOpaqueTex) return this._fallbackOpaqueTex;
    const t = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
    t.colorSpace = THREE.NoColorSpace;
    t.flipY = V3_LEVEL_TEXTURE_FLIP_Y;
    t.needsUpdate = true;
    this._fallbackOpaqueTex = t;
    return t;
  }

  /**
   * 1×1 RGBA(0,0,0,0) — alpha = 0. Fed as `uFloorOccluder` for floors that
   * have lights but no authored occluder textures: the cascade treats the
   * layer as open air (transmit = 1), letting upper-floor light propagate
   * unattenuated to lower floors rather than being silently dropped due to
   * missing data.
   *
   * @returns {THREE.Texture}
   */
  _fallbackTransparentTexture() {
    if (this._fallbackTransparentTex) return this._fallbackTransparentTex;
    const t = new THREE.DataTexture(new Uint8Array([0, 0, 0, 0]), 1, 1);
    t.colorSpace = THREE.NoColorSpace;
    t.flipY = V3_LEVEL_TEXTURE_FLIP_Y;
    t.needsUpdate = true;
    this._fallbackTransparentTex = t;
    return t;
  }
}

export { LIGHT_BUFFER_RANGE, BATCH_FL as V3_FLOOR_LIGHT_BATCH_SIZE, MAX_FL_POLY as V3_FLOOR_LIGHT_POLY_CAP };
