/**
 * @fileoverview V3 floor sandwich using **Three.js only** (no PIXI rendering).
 *
 * Same blend as before, in premultiplied alpha:
 *   mid = over(checker, lower)
 *   out = over(upper, mid)
 *
 * Level PNGs from Foundry are often **straight** alpha (RGB can stay white where
 * A=0). Treating those as premultiplied makes Porter–Duff add that RGB → **white
 * cutouts**. We clamp `rgb <= a` (valid premul envelope) before blending.
 *
 * `uApplyUpper` scales the upper layer: when viewing the **ground floor** in-game,
 * Foundry shows the lower albedo; we set `uApplyUpper = 0` so an opaque upper
 * map does not hide the ground (see `V3ThreeSceneHost` + `getViewedLevelIndex`).
 *
 * **Tokens (V3):** Two premultiplied RTs (logical **top-left** UV = `vScreenTL` /
 * `uResolution`, same basis as world mapping — **not** `gl_FragCoord`, which
 * breaks under device pixel ratio). **Below-deck** tokens sit between checker+lower
 * and upper; **on-deck** tokens (same Foundry level as the camera) sit on top of
 * the upper bitmap so they are not buried under their own floor art.
 *
 * **Foreground (V14 levels):** After on-deck tokens, lower then upper level
 * foreground images composite (straight-alpha → premul), with `uApplyFgUpper`
 * mirroring `uApplyUpper` so the upper level’s overhead art does not cover the
 * ground floor while viewing index 0.
 *
 * World positions outside `uSceneRect` draw `uClipColor` so nothing leaks into
 * Foundry’s padded margin.
 *
 * Owns a minimal THREE.Scene + orthographic camera + one mesh. The host
 * attaches a WebGLRenderer and calls render(scene, camera).
 *
 * **Albedo-only output (V3 lighting pipeline).** The sandwich no longer
 * modulates by scene darkness or sky-reach — it renders **pure map albedo**
 * (plus the checker underlay) into an intermediate render target, then
 * {@link V3IlluminationPipeline} runs a single resolve pass that applies
 * ambient × Π occlusion + Σ direct terms. Keeping albedo separate from
 * illumination is the design contract that lets multiple shadow/light
 * sources compose cleanly instead of fighting inside one shader.
 */

import * as THREE from "../vendor/three.module.js";
import {
  V3_LEVEL_TEXTURE_FLIP_Y,
  V3_RENDER_CONVENTIONS,
} from "./V3RenderConventions.js";

/** sRGB 0–1 triplet → linear working RGB (matches THREE.ColorManagement for RawShader paths). */
function linearRgbFromSrgbTriplet(rgb) {
  const c = new THREE.Color().setRGB(rgb[0], rgb[1], rgb[2], THREE.SRGBColorSpace);
  return [c.r, c.g, c.b];
}

const V3_DEFAULTS = Object.freeze({
  checkerSizePx: 24,
  checkerOpacity: 0.25,
  checkerColorA: linearRgbFromSrgbTriplet([1.0, 0.2, 0.8]),
  checkerColorB: linearRgbFromSrgbTriplet([0.2, 1.0, 0.9]),
  /** Foundry level URLs are usually straight-alpha PNGs; `false` uses `rgb*a`. */
  inputsPremultiplied: false,
});

// Three.js prepends `#version 300 es` + defines when glslVersion is GLSL3;
// do not repeat #version here or compilation fails (second #version illegal).
const VERT = `precision highp float;
in vec3 position;
in vec2 uv;
uniform mat4 modelViewMatrix;
uniform mat4 projectionMatrix;
uniform vec2 uResolution;
out vec2 vUv;
out vec2 vScreenTL;
void main() {
  vUv = uv;
  // Top-left origin, pixel coords (matches Foundry screen conventions).
  vScreenTL = vec2(uv.x * uResolution.x, (1.0 - uv.y) * uResolution.y);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const FRAG = `precision highp float;
in vec2 vScreenTL;
out vec4 fragColor;

uniform sampler2D uLower;
uniform sampler2D uUpper;
uniform vec2 uResolution;
uniform vec2 uPivotWorld;
uniform float uInvScale;
uniform vec4 uSceneRect;
uniform float uFlipBackgroundY;
uniform float uCheckerSizePx;
uniform float uCheckerOpacity;
uniform vec3 uCheckerColorA;
uniform vec3 uCheckerColorB;
uniform float uInputsPremultiplied;
uniform float uApplyUpper;
uniform vec3 uClipColor;
uniform sampler2D uTokenBelowPremul;
uniform float uHasTokenBelow;
uniform sampler2D uTokenAbovePremul;
uniform float uHasTokenAbove;
uniform sampler2D uFgLower;
uniform float uHasFgLower;
uniform sampler2D uFgUpper;
uniform float uHasFgUpper;
uniform float uApplyFgUpper;

// Same transfer as THREE.js colorspace_pars_fragment / linearToOutputTexel for SRGB output.
// RawShaderMaterial does not get Three's injected colorspace_fragment.
vec4 sRGBTransferOETF(in vec4 value) {
  return vec4(
    mix(
      pow(value.rgb, vec3(0.41666)) * 1.055 - vec3(0.055),
      value.rgb * 12.92,
      vec3(lessThanEqual(value.rgb, vec3(0.0031308)))
    ),
    value.a
  );
}

vec4 toPremul(vec4 c) {
  return vec4(c.rgb * c.a, c.a);
}

vec4 premulOver(vec4 top, vec4 bot) {
  return top + bot * (1.0 - top.a);
}

void main() {
  vec2 center = uResolution * 0.5;
  vec2 delta = vScreenTL - center;
  vec2 world = uPivotWorld + delta * uInvScale;
  vec2 mapUvRaw = (world - uSceneRect.xy) / max(uSceneRect.zw, vec2(1.0));
  if (mapUvRaw.x < 0.0 || mapUvRaw.x > 1.0 || mapUvRaw.y < 0.0 || mapUvRaw.y > 1.0) {
    fragColor = sRGBTransferOETF(vec4(uClipColor, 1.0));
    return;
  }
  vec2 mapUv = mapUvRaw;
  if (uFlipBackgroundY > 0.5) {
    mapUv.y = 1.0 - mapUv.y;
  }

  vec4 lowerSample = texture(uLower, mapUv);
  vec4 upperSample = texture(uUpper, mapUv);

  vec4 lowerPM = (uInputsPremultiplied > 0.5) ? lowerSample : toPremul(lowerSample);
  vec4 upperPM = (uInputsPremultiplied > 0.5) ? upperSample : toPremul(upperSample);
  // Straight-alpha exports often leave rgb=1 where a=0; enforce valid premul rgb.
  lowerPM.rgb = min(lowerPM.rgb, vec3(lowerPM.a));
  upperPM.rgb = min(upperPM.rgb, vec3(upperPM.a));
  upperPM.rgb *= uApplyUpper;
  upperPM.a *= uApplyUpper;

  vec2 pxCoord = vScreenTL;
  float cell = max(uCheckerSizePx, 1.0);
  vec2 cellIdx = floor(pxCoord / cell);
  float parity = mod(cellIdx.x + cellIdx.y, 2.0);
  vec3 chkRgb = mix(uCheckerColorA, uCheckerColorB, parity);
  float chkA = clamp(uCheckerOpacity, 0.0, 1.0);
  vec4 chkPM = vec4(chkRgb * chkA, chkA);

  vec4 midPM = chkPM + lowerPM * (1.0 - chkPM.a);
  // Token RTs are rasterised at drawing-buffer size but **sampled in logical
  // top-left space** matching vScreenTL / uResolution (same as world mapping).
  vec2 tokUv = vec2(
    vScreenTL.x / max(uResolution.x, 1.0),
    1.0 - vScreenTL.y / max(uResolution.y, 1.0)
  );

  vec4 mid1 = midPM;
  if (uHasTokenBelow > 0.5) {
    vec4 tbs = texture(uTokenBelowPremul, tokUv);
    vec4 tb = (uInputsPremultiplied > 0.5) ? tbs : toPremul(tbs);
    tb.rgb = min(tb.rgb, vec3(tb.a));
    mid1 = premulOver(tb, midPM);
  }

  vec4 deck = premulOver(upperPM, mid1);

  vec4 outPM = deck;
  if (uHasTokenAbove > 0.5) {
    vec4 tas = texture(uTokenAbovePremul, tokUv);
    vec4 ta = (uInputsPremultiplied > 0.5) ? tas : toPremul(tas);
    ta.rgb = min(ta.rgb, vec3(ta.a));
    outPM = premulOver(ta, deck);
  }

  if (uHasFgLower > 0.5) {
    vec4 f0s = texture(uFgLower, mapUv);
    vec4 f0 = (uInputsPremultiplied > 0.5) ? f0s : toPremul(f0s);
    f0.rgb = min(f0.rgb, vec3(f0.a));
    outPM = premulOver(f0, outPM);
  }
  if (uHasFgUpper > 0.5) {
    vec4 f1s = texture(uFgUpper, mapUv);
    vec4 f1 = (uInputsPremultiplied > 0.5) ? f1s : toPremul(f1s);
    f1.rgb = min(f1.rgb, vec3(f1.a));
    f1.rgb *= uApplyFgUpper;
    f1.a *= uApplyFgUpper;
    outPM = premulOver(f1, outPM);
  }

  // Pure albedo out — the illumination pipeline owns darkness / shadow / light.
  fragColor = sRGBTransferOETF(clamp(outPM, vec4(0.0), vec4(1.0)));
}
`;

export class V3ThreeSandwichCompositor {
  constructor() {
    this.scene = new THREE.Scene();
    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 10);
    this.camera.position.set(0, 0, 1);
    this.camera.lookAt(0, 0, 0);

    this.uniforms = {
      uCheckerSizePx: V3_DEFAULTS.checkerSizePx,
      uCheckerOpacity: V3_DEFAULTS.checkerOpacity,
      uCheckerColorA: [...V3_DEFAULTS.checkerColorA],
      uCheckerColorB: [...V3_DEFAULTS.checkerColorB],
      uInputsPremultiplied: V3_DEFAULTS.inputsPremultiplied ? 1.0 : 0.0,
      uApplyUpper: 1.0,
      uApplyFgUpper: 1.0,
      uClipColor: [0, 0, 0],
      uResolutionPx: [1, 1],
      flipBackgroundTextureY: V3_RENDER_CONVENTIONS.flipBackgroundTextureY,
    };

    // RawShaderMaterial: our #version 300 es must be the first token in the
    // final shader. ShaderMaterial prepends Three chunks (skinning, etc.),
    // which breaks #version and duplicates attributes/uniforms.
    this.material = new THREE.RawShaderMaterial({
      glslVersion: THREE.GLSL3,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      uniforms: {
        uLower: { value: null },
        uUpper: { value: null },
        uResolution: { value: new THREE.Vector2(1, 1) },
        uPivotWorld: { value: new THREE.Vector2(0, 0) },
        uInvScale: { value: 1 },
        uSceneRect: { value: new THREE.Vector4(0, 0, 1, 1) },
        uFlipBackgroundY: {
          value: V3_RENDER_CONVENTIONS.flipBackgroundTextureY ? 1.0 : 0.0,
        },
        uCheckerSizePx: { value: this.uniforms.uCheckerSizePx },
        uCheckerOpacity: { value: this.uniforms.uCheckerOpacity },
        uCheckerColorA: { value: new THREE.Vector3().fromArray(this.uniforms.uCheckerColorA) },
        uCheckerColorB: { value: new THREE.Vector3().fromArray(this.uniforms.uCheckerColorB) },
        uInputsPremultiplied: { value: this.uniforms.uInputsPremultiplied },
      uApplyUpper: { value: 1.0 },
      uClipColor: { value: new THREE.Vector3(0, 0, 0) },
      uTokenBelowPremul: { value: null },
      uHasTokenBelow: { value: 0.0 },
      uTokenAbovePremul: { value: null },
      uHasTokenAbove: { value: 0.0 },
      uFgLower: { value: null },
      uHasFgLower: { value: 0.0 },
      uFgUpper: { value: null },
      uHasFgUpper: { value: 0.0 },
      uApplyFgUpper: { value: 1.0 },
    },
      vertexShader: VERT,
      fragmentShader: FRAG,
    });

    const geo = new THREE.PlaneGeometry(2, 2);
    this.mesh = new THREE.Mesh(geo, this.material);
    this.mesh.renderOrder = 0;
    this.scene.add(this.mesh);

    const fb = this._ensureFallbackTransparent();
    this.material.uniforms.uTokenBelowPremul.value = fb;
    this.material.uniforms.uHasTokenBelow.value = 0.0;
    this.material.uniforms.uTokenAbovePremul.value = fb;
    this.material.uniforms.uHasTokenAbove.value = 0.0;
    this.material.uniforms.uFgLower.value = fb;
    this.material.uniforms.uHasFgLower.value = 0.0;
    this.material.uniforms.uFgUpper.value = fb;
    this.material.uniforms.uHasFgUpper.value = 0.0;
    this.material.uniforms.uApplyFgUpper.value = 1.0;

    /** @type {THREE.Texture|null} */ this.lowerTex = null;
    /** @type {THREE.Texture|null} */ this.upperTex = null;
    /** @type {THREE.Texture|null} */ this.lowerFgTex = null;
    /** @type {THREE.Texture|null} */ this.upperFgTex = null;
    /** @type {THREE.DataTexture|null} */ this._fallbackTransparent = null;
  }

  /**
   * 1×1 transparent texture so null slots never sample an invalid sampler.
   * @returns {THREE.DataTexture}
   */
  _ensureFallbackTransparent() {
    if (this._fallbackTransparent) return this._fallbackTransparent;
    const data = new Uint8Array([0, 0, 0, 0]);
    const t = new THREE.DataTexture(data, 1, 1);
    t.needsUpdate = true;
    t.colorSpace = THREE.NoColorSpace;
    this._fallbackTransparent = t;
    return t;
  }

  /**
   * When false, the upper texture does not contribute (ground-floor view with a
   * second loaded layer that would otherwise occlude the lower albedo).
   * @param {boolean} apply
   */
  setApplyUpper(apply) {
    const v = apply ? 1.0 : 0.0;
    this.uniforms.uApplyUpper = v;
    if (this.material?.uniforms?.uApplyUpper) {
      this.material.uniforms.uApplyUpper.value = v;
    }
  }

  /**
   * When false, the upper **foreground** slot does not contribute (same floor
   * index rule as {@link setApplyUpper} for upper backgrounds).
   * @param {boolean} apply
   */
  setApplyFgUpper(apply) {
    const v = apply ? 1.0 : 0.0;
    this.uniforms.uApplyFgUpper = v;
    if (this.material?.uniforms?.uApplyFgUpper) {
      this.material.uniforms.uApplyFgUpper.value = v;
    }
  }

  /**
   * Linear working RGB (0–1) for padded area outside the scene rect; host converts from Foundry sRGB.
   * @param {[number, number, number]} rgb
   */
  setClipColorRgb(rgb) {
    if (!Array.isArray(rgb) || rgb.length < 3) return;
    const r = Number(rgb[0]);
    const g = Number(rgb[1]);
    const b = Number(rgb[2]);
    if (![r, g, b].every((x) => Number.isFinite(x))) return;
    this.uniforms.uClipColor = [r, g, b];
    if (this.material?.uniforms?.uClipColor) {
      this.material.uniforms.uClipColor.value.set(r, g, b);
    }
  }

  /**
   * @param {THREE.Texture|null} lower
   * @param {THREE.Texture|null} upper
   */
  setTextures(lower, upper) {
    if (this.lowerTex && this.lowerTex !== lower) {
      try { this.lowerTex.dispose(); } catch (_) {}
    }
    if (this.upperTex && this.upperTex !== upper) {
      try { this.upperTex.dispose(); } catch (_) {}
    }
    this.lowerTex = lower;
    this.upperTex = upper;
    const fallback = this._ensureFallbackTransparent();
    for (const t of [lower, upper]) {
      if (t) {
        t.colorSpace = THREE.SRGBColorSpace;
        t.premultiplyAlpha = false;
        t.flipY = V3_LEVEL_TEXTURE_FLIP_Y;
        t.needsUpdate = true;
      }
    }
    this.material.uniforms.uLower.value = lower ?? fallback;
    this.material.uniforms.uUpper.value = upper ?? fallback;
  }

  /**
   * Per-level foreground images (same UV / flip / color space as backgrounds).
   * Pass null to disable a slot; clears GPU textures when replaced.
   *
   * @param {THREE.Texture|null} lowerFg
   * @param {THREE.Texture|null} upperFg
   */
  setForegroundTextures(lowerFg, upperFg) {
    if (this.lowerFgTex && this.lowerFgTex !== lowerFg) {
      try { this.lowerFgTex.dispose(); } catch (_) {}
    }
    if (this.upperFgTex && this.upperFgTex !== upperFg) {
      try { this.upperFgTex.dispose(); } catch (_) {}
    }
    this.lowerFgTex = lowerFg;
    this.upperFgTex = upperFg;
    const fallback = this._ensureFallbackTransparent();
    const u = this.material?.uniforms;
    if (!u) return;
    for (const t of [lowerFg, upperFg]) {
      if (t) {
        t.colorSpace = THREE.SRGBColorSpace;
        t.premultiplyAlpha = false;
        t.flipY = V3_LEVEL_TEXTURE_FLIP_Y;
        t.needsUpdate = true;
      }
    }
    const hasL = !!(lowerFg && lowerFg.image && lowerFg.image.width > 0);
    const hasU = !!(upperFg && upperFg.image && upperFg.image.width > 0);
    u.uFgLower.value = lowerFg ?? fallback;
    u.uHasFgLower.value = hasL ? 1.0 : 0.0;
    u.uFgUpper.value = upperFg ?? fallback;
    u.uHasFgUpper.value = hasU ? 1.0 : 0.0;
  }

  /**
   * @param {{ belowHas: boolean, belowTex: THREE.Texture|null, aboveHas: boolean, aboveTex: THREE.Texture|null }} p
   */
  setTokenDeckLayers(p) {
    const u = this.material?.uniforms;
    if (!u) return;
    const fb = this._ensureFallbackTransparent();
    const bh = p.belowHas && p.belowTex ? 1.0 : 0.0;
    const ah = p.aboveHas && p.aboveTex ? 1.0 : 0.0;
    u.uHasTokenBelow.value = bh;
    u.uTokenBelowPremul.value = bh > 0.5 && p.belowTex ? p.belowTex : fb;
    u.uHasTokenAbove.value = ah;
    u.uTokenAbovePremul.value = ah > 0.5 && p.aboveTex ? p.aboveTex : fb;
  }

  /**
   * Checker grid is in output pixels (screen-space feel).
   * @param {number} w
   * @param {number} h
   */
  setOutputSize(w, h) {
    const ww = Math.max(1, Math.round(w));
    const hh = Math.max(1, Math.round(h));
    this.uniforms.uResolutionPx = [ww, hh];
    this.material.uniforms.uResolution.value.set(ww, hh);
  }

  /**
   * Match Foundry pan/zoom: stage pivot = world at view centre, scale = zoom.
   * sceneRect = canvas.dimensions.sceneRect (x,y,w,h in world px for backgrounds).
   * @param {{ pivotWorld: [number, number], invScale: number, sceneRect: [number, number, number, number] }} v
   */
  setViewUniforms(v) {
    const u = this.material?.uniforms;
    if (!u) return;
    if (v.pivotWorld) u.uPivotWorld.value.set(v.pivotWorld[0], v.pivotWorld[1]);
    if (typeof v.invScale === "number" && Number.isFinite(v.invScale)) {
      u.uInvScale.value = v.invScale;
    }
    if (v.sceneRect && v.sceneRect.length >= 4) {
      u.uSceneRect.value.set(
        v.sceneRect[0],
        v.sceneRect[1],
        v.sceneRect[2],
        v.sceneRect[3],
      );
    }
  }

  /**
   * @param {object} partial
   */
  setUniforms(partial) {
    if (!partial || typeof partial !== "object") return;
    const u = this.material.uniforms;

    if (typeof partial.checkerSizePx === "number") {
      this.uniforms.uCheckerSizePx = partial.checkerSizePx;
      u.uCheckerSizePx.value = partial.checkerSizePx;
    }
    if (typeof partial.checkerOpacity === "number") {
      this.uniforms.uCheckerOpacity = partial.checkerOpacity;
      u.uCheckerOpacity.value = partial.checkerOpacity;
    }
    if (Array.isArray(partial.checkerColorA) && partial.checkerColorA.length === 3) {
      const lin = linearRgbFromSrgbTriplet(partial.checkerColorA);
      this.uniforms.uCheckerColorA = [...lin];
      u.uCheckerColorA.value.fromArray(lin);
    }
    if (Array.isArray(partial.checkerColorB) && partial.checkerColorB.length === 3) {
      const lin = linearRgbFromSrgbTriplet(partial.checkerColorB);
      this.uniforms.uCheckerColorB = [...lin];
      u.uCheckerColorB.value.fromArray(lin);
    }
    if (typeof partial.inputsPremultiplied === "boolean") {
      this.uniforms.uInputsPremultiplied = partial.inputsPremultiplied ? 1.0 : 0.0;
      u.uInputsPremultiplied.value = this.uniforms.uInputsPremultiplied;
    }
    if (typeof partial.flipBackgroundTextureY === "boolean") {
      this.uniforms.flipBackgroundTextureY = partial.flipBackgroundTextureY;
      u.uFlipBackgroundY.value = partial.flipBackgroundTextureY ? 1.0 : 0.0;
    }
  }

  snapshotUniforms() {
    const u = this.material?.uniforms;
    return {
      checkerSizePx: this.uniforms.uCheckerSizePx,
      checkerOpacity: this.uniforms.uCheckerOpacity,
      checkerColorA: [...this.uniforms.uCheckerColorA],
      checkerColorB: [...this.uniforms.uCheckerColorB],
      inputsPremultiplied: this.uniforms.uInputsPremultiplied > 0.5,
      resolutionPx: [...this.uniforms.uResolutionPx],
      pivotWorld: u ? [u.uPivotWorld.value.x, u.uPivotWorld.value.y] : null,
      invScale: u ? u.uInvScale.value : null,
      sceneRect: u
        ? [u.uSceneRect.value.x, u.uSceneRect.value.y, u.uSceneRect.value.z, u.uSceneRect.value.w]
        : null,
      flipBackgroundTextureY: this.uniforms.flipBackgroundTextureY,
      applyUpper: this.uniforms.uApplyUpper > 0.5,
      clipColor: [...this.uniforms.uClipColor],
      hasTokenBelow: u ? u.uHasTokenBelow.value > 0.5 : false,
      hasTokenAbove: u ? u.uHasTokenAbove.value > 0.5 : false,
      hasFgLower: u ? u.uHasFgLower.value > 0.5 : false,
      hasFgUpper: u ? u.uHasFgUpper.value > 0.5 : false,
      applyFgUpper: u ? u.uApplyFgUpper.value > 0.5 : false,
    };
  }

  dispose() {
    try { this.mesh?.geometry?.dispose(); } catch (_) {}
    try { this.material?.dispose(); } catch (_) {}
    try { this.lowerTex?.dispose(); } catch (_) {}
    try { this.upperTex?.dispose(); } catch (_) {}
    try { this.lowerFgTex?.dispose(); } catch (_) {}
    try { this.upperFgTex?.dispose(); } catch (_) {}
    try { this._fallbackTransparent?.dispose(); } catch (_) {}
    this.lowerTex = null;
    this.upperTex = null;
    this.lowerFgTex = null;
    this.upperFgTex = null;
    this._fallbackTransparent = null;
  }
}

export { V3_DEFAULTS };
