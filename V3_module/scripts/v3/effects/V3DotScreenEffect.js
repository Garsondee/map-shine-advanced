/**
 * @fileoverview V3 dot-screen (halftone) screen-space effect.
 *
 * First concrete effect ported to the V3 {@link V3EffectChain}. Mirrors the
 * V2 artistic dot-screen filter: mixes the lit scene with a rotated sine grid
 * so bright areas read as a dot pattern (comic / newspaper look).
 *
 * Purely artistic — no masks, no world-space coupling. Runs as a single
 * fullscreen pass. Default phase is `postSceneOverlay` so the pattern is
 * applied after water/weather but stops short of drawings and PIXI UI.
 *
 * @module v3/effects/V3DotScreenEffect
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

/**
 * Halftone pattern over an sRGB-encoded input. The chain RTs are tagged as
 * `NoColorSpace` and hold the same sRGB-encoded values the default
 * framebuffer would (see `V3EffectChain.ensureTargets`), so no color-space
 * dance is required here — sampling + writing are symmetric.
 */
const FRAG = /* glsl */ `
uniform sampler2D tDiffuse;
uniform vec2 uResolutionPx;
uniform vec2 uCenterUv;
uniform float uAngle;
uniform float uScale;
uniform float uStrength;

varying vec2 vUv;

float dotPattern() {
  float s = sin(uAngle);
  float c = cos(uAngle);
  vec2 tex = vUv * uResolutionPx - uCenterUv * uResolutionPx;
  vec2 point = vec2(c * tex.x - s * tex.y, s * tex.x + c * tex.y) * uScale;
  return (sin(point.x) * sin(point.y)) * 4.0;
}

void main() {
  vec4 base = texture2D(tDiffuse, vUv);
  float average = (base.r + base.g + base.b) / 3.0;
  vec3 dots = vec3(average * 10.0 - 5.0 + dotPattern());
  vec3 color = mix(base.rgb, dots, clamp(uStrength, 0.0, 1.0));
  gl_FragColor = vec4(color, base.a);
}
`;

/**
 * V3 dot-screen halftone effect.
 *
 * Public:
 *   - {@link V3DotScreenEffect#enabled} — boolean toggle.
 *   - {@link V3DotScreenEffect#params} — live-mutable uniform values. The
 *     effect pulls from these every frame in `render()`; wire these to
 *     Tweakpane or any other UI without needing to reach into uniforms.
 */
export class V3DotScreenEffect {
  /**
   * @param {{
   *   id?: string,
   *   phase?: string,
   *   order?: number,
   *   enabled?: boolean,
   *   params?: Partial<{ strength: number, scale: number, angle: number, centerX: number, centerY: number }>,
   * }} [options]
   */
  constructor(options = {}) {
    this.id = String(options.id ?? "dotScreen");
    this.phase = options.phase ?? V3_EFFECT_PHASES.POST_SCENE_OVERLAY;
    this.order = Number.isFinite(options.order) ? Number(options.order) : 500;

    /** @type {boolean} */
    this.enabled = options.enabled === true;

    /**
     * Live-mutable params. Updated each frame in {@link render} before the
     * draw. `centerX/centerY` are normalised UV (0..1).
     */
    this.params = {
      strength: 0.85,
      scale: 1.6,
      angle: 1.57,
      centerX: 0.5,
      centerY: 0.5,
      ...(options.params ?? {}),
    };

    /** @type {THREE.ShaderMaterial|null} */
    this._material = null;
    /** @type {import("../V3FullscreenPass.js").V3FullscreenQuad|null} */
    this._quad = null;
    /** @type {THREE.Vector2|null} */
    this._resolutionVec = null;
    /** @type {THREE.Vector2|null} */
    this._centerVec = null;
    /** @type {boolean} */
    this._initialized = false;
  }

  _initialize() {
    if (this._initialized) return;
    this._resolutionVec = new THREE.Vector2(1, 1);
    this._centerVec = new THREE.Vector2(this.params.centerX, this.params.centerY);
    this._material = new THREE.ShaderMaterial({
      uniforms: {
        tDiffuse: { value: null },
        uResolutionPx: { value: this._resolutionVec },
        uCenterUv: { value: this._centerVec },
        uAngle: { value: Number(this.params.angle) },
        uScale: { value: Number(this.params.scale) },
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
   * Chain-level hook: called when the ping-pong RTs change size. Stored into
   * the `uResolutionPx` uniform so the halftone frequency stays in pixel
   * space (matching V2 behaviour).
   *
   * @param {number} w
   * @param {number} h
   */
  onResize(w, h) {
    if (!this._resolutionVec) return;
    this._resolutionVec.set(
      Math.max(1, Math.round(w)),
      Math.max(1, Math.round(h)),
    );
  }

  /**
   * @param {THREE.WebGLRenderer} renderer
   * @param {{
   *   inputTexture: THREE.Texture,
   *   outputRT: THREE.WebGLRenderTarget,
   *   inputRT: THREE.WebGLRenderTarget,
   * }} effCtx
   * @returns {boolean}
   */
  render(renderer, effCtx) {
    if (!renderer || !effCtx?.inputTexture || !effCtx.outputRT) return false;
    this._initialize();
    const mat = this._material;
    if (!mat || !this._quad) return false;

    // Keep resolution uniform in sync (ping-pong RTs match inputRT size).
    const rt = effCtx.outputRT;
    if (this._resolutionVec) {
      const w = Math.max(1, rt.width);
      const h = Math.max(1, rt.height);
      if (this._resolutionVec.x !== w || this._resolutionVec.y !== h) {
        this._resolutionVec.set(w, h);
      }
    }

    const p = this.params;
    mat.uniforms.tDiffuse.value = effCtx.inputTexture;
    mat.uniforms.uAngle.value = Number(p.angle);
    mat.uniforms.uScale.value = Number(p.scale);
    mat.uniforms.uStrength.value = Number(p.strength);
    if (this._centerVec) {
      this._centerVec.set(Number(p.centerX), Number(p.centerY));
    }

    renderFullscreenToTarget(renderer, this._quad, rt);
    return true;
  }

  dispose() {
    try { this._material?.dispose(); } catch (_) {}
    try { this._quad?.dispose(); } catch (_) {}
    this._material = null;
    this._quad = null;
    this._resolutionVec = null;
    this._centerVec = null;
    this._initialized = false;
  }

  /**
   * Read-only diagnostics snapshot. Safe to serialise.
   *
   * @returns {{ id: string, phase: string, order: number, enabled: boolean, params: typeof this.params }}
   */
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
