/**
 * @fileoverview Fullscreen debug draw for one level texture URL (e.g. `_Outdoors`),
 * using the same world → `mapUv` mapping as `V3ThreeSandwichCompositor` so it
 * tracks pan/zoom.
 *
 * **Two-floor outdoors:** when the sandwich is drawing the upper layer (`uApplyUpper`),
 * we combine lower + upper `_Outdoors` by **lerping with the upper albedo’s alpha** —
 * same matte as “see lower through transparent holes in the upper”, i.e.
 * `mask = lower.r * (1 − a) + upper.r * a` with `a = texture(upperAlbedo, uv).a`.
 * On the ground view (`uApplyUpper` off), only the **lower** outdoors is shown — like the sandwich.
 */

import * as THREE from "../vendor/three.module.js";
import {
  V3_LEVEL_TEXTURE_FLIP_Y,
  V3_RENDER_CONVENTIONS,
} from "./V3RenderConventions.js";

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
  vScreenTL = vec2(uv.x * uResolution.x, (1.0 - uv.y) * uResolution.y);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

/** uComposeMode: 0 = single `uDebugTex`; 1 = lerp lower/upper mask by upper albedo alpha. */
const FRAG = `precision highp float;
in vec2 vScreenTL;
out vec4 fragColor;

uniform sampler2D uDebugTex;
uniform sampler2D uMaskLower;
uniform sampler2D uMaskUpper;
uniform sampler2D uAlbedoUpper;
uniform float uComposeMode;

uniform vec2 uResolution;
uniform vec2 uPivotWorld;
uniform float uInvScale;
uniform vec4 uSceneRect;
uniform float uFlipBackgroundY;
uniform float uOpacity;
uniform float uChannelView;

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

void main() {
  vec2 center = uResolution * 0.5;
  vec2 delta = vScreenTL - center;
  vec2 world = uPivotWorld + delta * uInvScale;
  vec2 mapUvRaw = (world - uSceneRect.xy) / max(uSceneRect.zw, vec2(1.0));
  if (mapUvRaw.x < 0.0 || mapUvRaw.x > 1.0 || mapUvRaw.y < 0.0 || mapUvRaw.y > 1.0) {
    fragColor = sRGBTransferOETF(vec4(0.0));
    return;
  }
  vec2 mapUv = mapUvRaw;
  if (uFlipBackgroundY > 0.5) {
    mapUv.y = 1.0 - mapUv.y;
  }

  float opacity = clamp(uOpacity, 0.0, 1.0);
  vec4 c;

  if (uComposeMode > 0.5) {
    float ml = texture(uMaskLower, mapUv).r;
    float mu = texture(uMaskUpper, mapUv).r;
    float a = clamp(texture(uAlbedoUpper, mapUv).a, 0.0, 1.0);
    float m = ml * (1.0 - a) + mu * a;
    c = vec4(m, m, m, m);
  } else {
    c = texture(uDebugTex, mapUv);
  }

  if (uChannelView > 1.5) {
    float g = c.a;
    fragColor = sRGBTransferOETF(vec4(g, g, g, opacity));
  } else if (uChannelView > 0.5) {
    float g = c.r;
    fragColor = sRGBTransferOETF(vec4(g, g, g, opacity));
  } else {
    fragColor = sRGBTransferOETF(vec4(c.rgb, c.a * opacity));
  }
}
`;

export class V3LevelTextureDebugOverlay {
  constructor() {
    this.scene = null;
    /** @type {THREE.Mesh|null} */ this.mesh = null;
    /** @type {THREE.RawShaderMaterial|null} */ this.material = null;
    /** Single-texture path. Ownership tracked by {@link _textureOwned}. */
    /** @type {THREE.Texture|null} */ this.texture = null;
    /** Dual path (owned). */
    /** @type {THREE.Texture|null} */ this.textureMaskLower = null;
    /** @type {THREE.Texture|null} */ this.textureMaskUpper = null;
    /** Borrowed from compositor (upper albedo) — never dispose. */
    /** @type {THREE.Texture|null} */ this._albedoUpperRef = null;
    /** @type {THREE.DataTexture|null} */ this._fallbackSample = null;
    /**
     * When false, the single-texture slot is borrowed from elsewhere (e.g.
     * {@link V3MaskHub}) and must not be disposed when replaced.
     */
    this._textureOwned = true;

    this.uniforms = {
      uResolutionPx: [1, 1],
      flipBackgroundTextureY: V3_RENDER_CONVENTIONS.flipBackgroundTextureY,
    };

    this.material = new THREE.RawShaderMaterial({
      glslVersion: THREE.GLSL3,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      blending: THREE.NormalBlending,
      uniforms: {
        uDebugTex: { value: null },
        uMaskLower: { value: null },
        uMaskUpper: { value: null },
        uAlbedoUpper: { value: null },
        uComposeMode: { value: 0.0 },
        uResolution: { value: new THREE.Vector2(1, 1) },
        uPivotWorld: { value: new THREE.Vector2(0, 0) },
        uInvScale: { value: 1 },
        uSceneRect: { value: new THREE.Vector4(0, 0, 1, 1) },
        uFlipBackgroundY: {
          value: V3_RENDER_CONVENTIONS.flipBackgroundTextureY ? 1.0 : 0.0,
        },
        uOpacity: { value: 0.65 },
        uChannelView: { value: 1.0 },
      },
      vertexShader: VERT,
      fragmentShader: FRAG,
    });

    const geo = new THREE.PlaneGeometry(2, 2);
    this.mesh = new THREE.Mesh(geo, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 1000;
  }

  attachTo(compositorScene) {
    this.detach();
    this.scene = compositorScene;
    if (this.scene && this.mesh) this.scene.add(this.mesh);
  }

  detach() {
    if (this.mesh && this.mesh.parent) {
      try {
        this.mesh.parent.remove(this.mesh);
      } catch (_) {}
    }
    this.scene = null;
  }

  _ensureFallbackSampler() {
    if (this._fallbackSample) return this._fallbackSample;
    const data = new Uint8Array([0, 0, 0, 0]);
    const t = new THREE.DataTexture(data, 1, 1);
    t.needsUpdate = true;
    t.colorSpace = THREE.NoColorSpace;
    this._fallbackSample = t;
    return t;
  }

  _applyMaskTexSettings(tex, isMask) {
    tex.premultiplyAlpha = false;
    tex.flipY = V3_LEVEL_TEXTURE_FLIP_Y;
    tex.colorSpace = isMask ? THREE.NoColorSpace : THREE.SRGBColorSpace;
    tex.needsUpdate = true;
  }

  /**
   * @param {THREE.Texture|null} tex Single-mask path when not dual-composing.
   * @param {{
   *   isMask?: boolean,
   *   ownsTexture?: boolean,
   *   dualMaskOverAlbedo?: null | { lowerTex: THREE.Texture, upperTex: THREE.Texture, albedoUpper: THREE.Texture },
   * }} [opts]
   */
  setTexture(tex, opts = {}) {
    const dual = opts.dualMaskOverAlbedo;
    const useDual = !!(dual?.lowerTex && dual?.upperTex && dual?.albedoUpper);
    const nextOwns = opts.ownsTexture !== false;

    if (this.texture && this._textureOwned && (useDual || this.texture !== tex)) {
      try {
        this.texture.dispose();
      } catch (_) {}
    }
    this.texture = useDual ? null : (tex || null);
    this._textureOwned = useDual ? true : nextOwns;

    if (this.textureMaskLower && (!useDual || (dual && this.textureMaskLower !== dual.lowerTex))) {
      try {
        this.textureMaskLower.dispose();
      } catch (_) {}
    }
    if (this.textureMaskUpper && (!useDual || (dual && this.textureMaskUpper !== dual.upperTex))) {
      try {
        this.textureMaskUpper.dispose();
      } catch (_) {}
    }
    this.textureMaskLower = useDual ? dual.lowerTex : null;
    this.textureMaskUpper = useDual ? dual.upperTex : null;
    this._albedoUpperRef = useDual ? dual.albedoUpper : null;

    const u = this.material?.uniforms;
    if (!u) return;

    if (useDual) {
      u.uComposeMode.value = 1.0;
      u.uMaskLower.value = dual.lowerTex;
      u.uMaskUpper.value = dual.upperTex;
      u.uAlbedoUpper.value = dual.albedoUpper;
      u.uDebugTex.value = this._ensureFallbackSampler();
      this._applyMaskTexSettings(dual.lowerTex, opts.isMask !== false);
      this._applyMaskTexSettings(dual.upperTex, opts.isMask !== false);
    } else {
      u.uComposeMode.value = 0.0;
      u.uMaskLower.value = this._ensureFallbackSampler();
      u.uMaskUpper.value = this._ensureFallbackSampler();
      u.uAlbedoUpper.value = this._ensureFallbackSampler();
      u.uDebugTex.value = tex;
      if (tex) {
        this._applyMaskTexSettings(tex, opts.isMask !== false);
      }
    }

    if (!tex && !useDual) {
      return;
    }
  }

  setOutputSize(w, h) {
    const ww = Math.max(1, Math.round(w));
    const hh = Math.max(1, Math.round(h));
    this.uniforms.uResolutionPx = [ww, hh];
    if (this.material?.uniforms?.uResolution) {
      this.material.uniforms.uResolution.value.set(ww, hh);
    }
  }

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

  setDisplayOptions(p) {
    if (!p || !this.material?.uniforms) return;
    const u = this.material.uniforms;
    if (typeof p.opacity === "number" && Number.isFinite(p.opacity)) {
      u.uOpacity.value = Math.max(0, Math.min(1, p.opacity));
    }
    if (p.channelView === "rgba") u.uChannelView.value = 0;
    else if (p.channelView === "a") u.uChannelView.value = 2;
    else if (p.channelView === "r") u.uChannelView.value = 1;

    if (typeof p.flipBackgroundTextureY === "boolean") {
      this.uniforms.flipBackgroundTextureY = p.flipBackgroundTextureY;
      u.uFlipBackgroundY.value = p.flipBackgroundTextureY ? 1.0 : 0.0;
    }
  }

  snapshot() {
    const u = this.material?.uniforms;
    return {
      visible: !!this.mesh?.parent,
      hasTexture: !!this.texture?.image,
      composeDualMask: (u?.uComposeMode?.value ?? 0) > 0.5,
      opacity: u?.uOpacity?.value ?? null,
      channelView:
        u?.uChannelView?.value > 1.5 ? "a" : u?.uChannelView?.value > 0.5 ? "r" : "rgba",
    };
  }

  dispose() {
    this.detach();
    try {
      this.mesh?.geometry?.dispose();
    } catch (_) {}
    try {
      this.material?.dispose();
    } catch (_) {}
    if (this._textureOwned) {
      try {
        this.texture?.dispose();
      } catch (_) {}
    }
    try {
      this.textureMaskLower?.dispose();
    } catch (_) {}
    try {
      this.textureMaskUpper?.dispose();
    } catch (_) {}
    try {
      this._fallbackSample?.dispose();
    } catch (_) {}
    this.mesh = null;
    this.material = null;
    this.texture = null;
    this.textureMaskLower = null;
    this.textureMaskUpper = null;
    this._albedoUpperRef = null;
    this._fallbackSample = null;
    this._textureOwned = true;
  }
}
