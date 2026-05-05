/**
 * @fileoverview V3 color inversion screen-space effect.
 *
 * Mirrors the V2 invert effect: blends each pixel toward `1 - rgb` by
 * `params.strength` (0..1). Runs as a single fullscreen pass in the V3
 * `postSceneOverlay` phase by default.
 *
 * @module v3/effects/V3InvertEffect
 */

import * as THREE from "../../vendor/three.module.js";
import {
  createFullscreenQuad,
  renderFullscreenToTarget,
} from "../V3FullscreenPass.js";
import { V3_EFFECT_PHASES } from "../V3EffectChain.js";

const VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const FRAG = /* glsl */ `
uniform sampler2D tDiffuse;
uniform float uStrength;
varying vec2 vUv;

void main() {
  vec4 base = texture2D(tDiffuse, vUv);
  vec3 inverted = vec3(1.0) - base.rgb;
  vec3 color = mix(base.rgb, inverted, clamp(uStrength, 0.0, 1.0));
  gl_FragColor = vec4(color, base.a);
}
`;

export class V3InvertEffect {
  /**
   * @param {{
   *   id?: string,
   *   phase?: string,
   *   order?: number,
   *   enabled?: boolean,
   *   params?: Partial<{ strength: number }>,
   * }} [options]
   */
  constructor(options = {}) {
    this.id = String(options.id ?? "invert");
    this.phase = options.phase ?? V3_EFFECT_PHASES.POST_SCENE_OVERLAY;
    this.order = Number.isFinite(options.order) ? Number(options.order) : 700;

    /** @type {boolean} */
    this.enabled = options.enabled === true;
    this.params = {
      strength: 1.0,
      ...(options.params ?? {}),
    };

    /** @type {THREE.ShaderMaterial|null} */
    this._material = null;
    /** @type {import("../V3FullscreenPass.js").V3FullscreenQuad|null} */
    this._quad = null;
    /** @type {boolean} */
    this._initialized = false;
  }

  _initialize() {
    if (this._initialized) return;
    this._material = new THREE.ShaderMaterial({
      uniforms: {
        tDiffuse: { value: null },
        uStrength: { value: Number(this.params.strength) },
      },
      vertexShader: VERT,
      fragmentShader: FRAG,
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
      transparent: false,
    });
    this._quad = createFullscreenQuad(this._material);
    this._initialized = true;
  }

  /**
   * @param {THREE.WebGLRenderer} renderer
   * @param {{
   *   inputTexture: THREE.Texture,
   *   outputRT: THREE.WebGLRenderTarget,
   * }} effCtx
   * @returns {boolean}
   */
  render(renderer, effCtx) {
    if (!renderer || !effCtx?.inputTexture || !effCtx.outputRT) return false;
    this._initialize();
    if (!this._material || !this._quad) return false;

    this._material.uniforms.tDiffuse.value = effCtx.inputTexture;
    this._material.uniforms.uStrength.value = Number(this.params.strength);
    renderFullscreenToTarget(renderer, this._quad, effCtx.outputRT);
    return true;
  }

  dispose() {
    try { this._material?.dispose(); } catch (_) {}
    try { this._quad?.dispose(); } catch (_) {}
    this._material = null;
    this._quad = null;
    this._initialized = false;
  }

  snapshot() {
    return {
      id: this.id,
      phase: this.phase,
      order: this.order,
      enabled: this.enabled,
      params: { ...this.params },
    };
  }
}
