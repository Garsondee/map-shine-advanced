/**
 * @fileoverview Minimal V3 water effect overlay.
 *
 * Renders a blue-tint pass from `_Water` masks in map UV space and applies
 * level occlusion using upper-floor albedo alpha (same visibility model as
 * the sandwich). Scene darkness / night tint follow the same rule as
 * {@link V3IlluminationPipeline} (Foundry `ambientDarkness`): linear tint is
 * multiplied by `mix(1, darknessTint, sceneDarkness)`.
 */

import * as THREE from "../vendor/three.module.js";
import {
  V3_LEVEL_TEXTURE_FLIP_Y,
  V3_RENDER_CONVENTIONS,
} from "./V3RenderConventions.js";

/** sRGB 0–1 triplet → linear working RGB (for compositing before output OETF). */
function linearRgbFromSrgbTriplet(rgb) {
  const c = new THREE.Color().setRGB(rgb[0], rgb[1], rgb[2], THREE.SRGBColorSpace);
  return [c.r, c.g, c.b];
}

const VERT = `precision highp float;
in vec3 position;
in vec2 uv;
uniform mat4 modelViewMatrix;
uniform mat4 projectionMatrix;
uniform vec2 uResolution;
out vec2 vScreenTL;
void main() {
  vScreenTL = vec2(uv.x * uResolution.x, (1.0 - uv.y) * uResolution.y);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const FRAG = `precision highp float;
in vec2 vScreenTL;
out vec4 fragColor;

uniform sampler2D uMaskLower;
uniform sampler2D uMaskUpper;
uniform sampler2D uAlbedoUpper;
uniform sampler2D uFgLower;
uniform sampler2D uFgUpper;

uniform vec2 uResolution;
uniform vec2 uPivotWorld;
uniform float uInvScale;
uniform vec4 uSceneRect;
uniform float uFlipBackgroundY;

uniform vec3 uTint;
uniform float uIntensity;
uniform float uApplyUpper;
uniform float uApplyFgUpper;

/** Effective scene darkness 0..1 (same as illumination uSceneDarkness). */
uniform float uSceneDarkness;
/** Linear RGB — Foundry ambientDarkness tint at full night (uDarknessTintRgb). */
uniform vec3 uDarknessTintLinear;

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

  float wLower = clamp(texture(uMaskLower, mapUv).r, 0.0, 1.0);
  float wUpper = clamp(texture(uMaskUpper, mapUv).r, 0.0, 1.0);
  float upperMatte = clamp(texture(uAlbedoUpper, mapUv).a * uApplyUpper, 0.0, 1.0);
  float fgLowerA = clamp(texture(uFgLower, mapUv).a, 0.0, 1.0);
  float fgUpperA = clamp(texture(uFgUpper, mapUv).a * uApplyFgUpper, 0.0, 1.0);
  float fgOcclude = clamp(fgLowerA + fgUpperA * (1.0 - fgLowerA), 0.0, 1.0);

  // Compute per-floor water first, then occlude by upper-floor matte.
  vec3 fxLower = uTint * wLower;
  vec3 fxUpper = uTint * wUpper;
  vec3 fx = mix(fxLower, fxUpper, upperMatte);
  float a = clamp(mix(wLower, wUpper, upperMatte) * uIntensity, 0.0, 1.0);
  // Foreground/overhead art should always draw over water.
  fx *= (1.0 - fgOcclude);
  a *= (1.0 - fgOcclude);

  float envDark = clamp(uSceneDarkness, 0.0, 1.0);
  vec3 nightMul = mix(vec3(1.0), uDarknessTintLinear, envDark);
  fx *= nightMul;

  fragColor = sRGBTransferOETF(vec4(fx, a));
}
`;

export class V3WaterOverlay {
  constructor() {
    this.scene = null;
    /** @type {THREE.Mesh|null} */ this.mesh = null;
    /** @type {THREE.RawShaderMaterial|null} */ this.material = null;

    /** @type {THREE.Texture|null} */ this._maskLower = null;
    /** @type {THREE.Texture|null} */ this._maskUpper = null;
    /** @type {THREE.Texture|null} */ this._albedoUpper = null;
    /** @type {THREE.DataTexture|null} */ this._fallback = null;
  }

  _ensureFallback() {
    if (this._fallback) return this._fallback;
    const data = new Uint8Array([0, 0, 0, 0]);
    const t = new THREE.DataTexture(data, 1, 1);
    t.needsUpdate = true;
    t.colorSpace = THREE.NoColorSpace;
    t.flipY = V3_LEVEL_TEXTURE_FLIP_Y;
    this._fallback = t;
    return this._fallback;
  }

  attachTo(scene) {
    if (!scene || this.scene === scene) return;
    this.detach();
    this.scene = scene;

    this.material = new THREE.RawShaderMaterial({
      glslVersion: THREE.GLSL3,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      uniforms: {
        uMaskLower: { value: this._ensureFallback() },
        uMaskUpper: { value: this._ensureFallback() },
        uAlbedoUpper: { value: this._ensureFallback() },
        uFgLower: { value: this._ensureFallback() },
        uFgUpper: { value: this._ensureFallback() },
        uResolution: { value: new THREE.Vector2(1, 1) },
        uPivotWorld: { value: new THREE.Vector2(0, 0) },
        uInvScale: { value: 1.0 },
        uSceneRect: { value: new THREE.Vector4(0, 0, 1, 1) },
        uFlipBackgroundY: {
          value: V3_RENDER_CONVENTIONS.flipBackgroundTextureY ? 1.0 : 0.0,
        },
        uTint: {
          value: new THREE.Vector3().fromArray(
            linearRgbFromSrgbTriplet([0.10, 0.42, 0.95]),
          ),
        },
        uIntensity: { value: 0.45 },
        uApplyUpper: { value: 1.0 },
        uApplyFgUpper: { value: 1.0 },
        uSceneDarkness: { value: 0.0 },
        uDarknessTintLinear: {
          value: new THREE.Vector3(0.033, 0.033, 0.033),
        },
      },
      vertexShader: VERT,
      fragmentShader: FRAG,
    });

    const geo = new THREE.PlaneGeometry(2, 2);
    this.mesh = new THREE.Mesh(geo, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 20;
    scene.add(this.mesh);
  }

  detach() {
    try { this.scene?.remove(this.mesh); } catch (_) {}
    this.scene = null;
  }

  _applyMaskTextureSettings(tex) {
    if (!tex) return;
    tex.flipY = V3_LEVEL_TEXTURE_FLIP_Y;
    tex.colorSpace = THREE.NoColorSpace;
    tex.premultiplyAlpha = false;
    tex.needsUpdate = true;
  }

  setLowerMask(texture) {
    this._maskLower = texture ?? null;
    const t = this._maskLower ?? this._ensureFallback();
    this._applyMaskTextureSettings(this._maskLower);
    if (this.material?.uniforms?.uMaskLower) this.material.uniforms.uMaskLower.value = t;
  }

  setUpperMask(texture) {
    this._maskUpper = texture ?? null;
    const t = this._maskUpper ?? this._ensureFallback();
    this._applyMaskTextureSettings(this._maskUpper);
    if (this.material?.uniforms?.uMaskUpper) this.material.uniforms.uMaskUpper.value = t;
  }

  setUpperAlbedo(texture) {
    this._albedoUpper = texture ?? null;
    const t = this._albedoUpper ?? this._ensureFallback();
    if (this.material?.uniforms?.uAlbedoUpper) this.material.uniforms.uAlbedoUpper.value = t;
  }

  setApplyUpper(apply) {
    if (this.material?.uniforms?.uApplyUpper) {
      this.material.uniforms.uApplyUpper.value = apply ? 1.0 : 0.0;
    }
  }

  setApplyFgUpper(apply) {
    if (this.material?.uniforms?.uApplyFgUpper) {
      this.material.uniforms.uApplyFgUpper.value = apply ? 1.0 : 0.0;
    }
  }

  setLowerForeground(texture) {
    const t = texture ?? this._ensureFallback();
    if (this.material?.uniforms?.uFgLower) this.material.uniforms.uFgLower.value = t;
  }

  setUpperForeground(texture) {
    const t = texture ?? this._ensureFallback();
    if (this.material?.uniforms?.uFgUpper) this.material.uniforms.uFgUpper.value = t;
  }

  /**
   * Match {@link V3IlluminationPipeline} environment darkness on map albedo
   * (`baseCol = litAmbient * mix(vec3(1), tint, darkness)` — water applies the
   * same multiplier to its linear tint).
   * @param {number} sceneDarkness01
   * @param {[number, number, number]} darknessTintLinearRgb
   */
  setFoundryEnvironmentDarkness(sceneDarkness01, darknessTintLinearRgb) {
    const u = this.material?.uniforms;
    if (!u) return;
    const d = Number(sceneDarkness01);
    u.uSceneDarkness.value = Number.isFinite(d) ? Math.max(0, Math.min(1, d)) : 0;
    if (Array.isArray(darknessTintLinearRgb) && darknessTintLinearRgb.length >= 3) {
      const r = Number(darknessTintLinearRgb[0]);
      const g = Number(darknessTintLinearRgb[1]);
      const b = Number(darknessTintLinearRgb[2]);
      if ([r, g, b].every((x) => Number.isFinite(x))) {
        u.uDarknessTintLinear.value.set(r, g, b);
      }
    }
  }

  setOutputSize(w, h) {
    if (!this.material?.uniforms?.uResolution) return;
    this.material.uniforms.uResolution.value.set(
      Math.max(1, Math.round(w)),
      Math.max(1, Math.round(h)),
    );
  }

  setViewUniforms(v) {
    const u = this.material?.uniforms;
    if (!u) return;
    if (v.pivotWorld) u.uPivotWorld.value.set(v.pivotWorld[0], v.pivotWorld[1]);
    if (typeof v.invScale === "number" && Number.isFinite(v.invScale)) {
      u.uInvScale.value = v.invScale;
    }
    if (v.sceneRect && v.sceneRect.length >= 4) {
      u.uSceneRect.value.set(v.sceneRect[0], v.sceneRect[1], v.sceneRect[2], v.sceneRect[3]);
    }
  }

  setDisplayOptions({ intensity, tintRgb, flipBackgroundTextureY } = {}) {
    const u = this.material?.uniforms;
    if (!u) return;
    if (typeof intensity === "number" && Number.isFinite(intensity)) {
      u.uIntensity.value = Math.max(0, Math.min(1, intensity));
    }
    if (Array.isArray(tintRgb) && tintRgb.length >= 3) {
      const r = Number(tintRgb[0]);
      const g = Number(tintRgb[1]);
      const b = Number(tintRgb[2]);
      if ([r, g, b].every((x) => Number.isFinite(x))) {
        const lin = linearRgbFromSrgbTriplet([r, g, b]);
        u.uTint.value.set(lin[0], lin[1], lin[2]);
      }
    }
    if (typeof flipBackgroundTextureY === "boolean") {
      u.uFlipBackgroundY.value = flipBackgroundTextureY ? 1.0 : 0.0;
    }
  }

  dispose() {
    this.detach();
    try { this.mesh?.geometry?.dispose(); } catch (_) {}
    try { this.material?.dispose(); } catch (_) {}
    try { this._fallback?.dispose(); } catch (_) {}
    this.mesh = null;
    this.material = null;
    this._maskLower = null;
    this._maskUpper = null;
    this._albedoUpper = null;
    this._fallback = null;
  }
}
