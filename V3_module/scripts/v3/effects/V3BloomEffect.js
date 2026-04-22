/**
 * @fileoverview V3 screen-space bloom — ports {@link BloomEffectV2} onto the
 * V3 {@link V3EffectChain}. Wraps `UnrealBloomPass` (mip-chain blur + additive
 * composite) with the same strength / radius / threshold / tint / blend and
 * optional water-specular injection path as V2.
 *
 * **Phase / order:** `postSceneOverlay` at order **200** so bloom runs before
 * stylised filters such as dot-screen (typical: glow → halftone / grain).
 *
 * **Water specular:** V3 water does not yet emit a separate specular MRT;
 * `setWaterSpecularBloomTexture` is exposed for when that pipeline lands. Until
 * then the mask falls back to a 1×1 black texture (same as V2 with no water
 * link).
 *
 * @module v3/effects/V3BloomEffect
 */

import * as THREE from "../../vendor/three.module.js";
import { UnrealBloomPass } from "../postprocessing/UnrealBloomPass.js";
import { V3_EFFECT_PHASES } from "../V3EffectChain.js";

export class V3BloomEffect {
  /**
   * @param {{
   *   id?: string,
   *   phase?: string,
   *   order?: number,
   *   enabled?: boolean,
   *   params?: Partial<{
   *     strength: number,
   *     radius: number,
   *     threshold: number,
   *     tintColor: { r: number, g: number, b: number },
   *     blendOpacity: number,
   *     waterSpecularBloomEnabled: boolean,
   *     waterSpecularBloomStrength: number,
   *     waterSpecularBloomGamma: number,
   *   }>,
   * }} [options]
   */
  constructor(options = {}) {
    this.id = String(options.id ?? "bloom");
    this.phase = options.phase ?? V3_EFFECT_PHASES.POST_SCENE_OVERLAY;
    this.order = Number.isFinite(options.order) ? Number(options.order) : 200;

    /** Master toggle — must be true for the chain to allocate the bloom path. */
    this.enabled = options.enabled === true;

    this.params = {
      strength: 0.63,
      radius: 0.82,
      threshold: 0.86,
      tintColor: { r: 1, g: 1, b: 1 },
      blendOpacity: 1.0,
      waterSpecularBloomEnabled: true,
      waterSpecularBloomStrength: 1.25,
      waterSpecularBloomGamma: 1.0,
      ...(options.params ?? {}),
    };

    /** @type {UnrealBloomPass|null} */
    this._pass = null;
    /** @type {THREE.WebGLRenderTarget|null} */
    this._bloomInputRT = null;
    /** @type {THREE.Scene|null} */
    this._copyScene = null;
    /** @type {THREE.OrthographicCamera|null} */
    this._copyCamera = null;
    /** @type {THREE.MeshBasicMaterial|null} */
    this._copyMaterial = null;
    /** @type {THREE.Mesh|null} */
    this._copyQuad = null;
    /** @type {THREE.Vector3|null} */
    this._tintVec = null;
    this._lastTintR = null;
    this._lastTintG = null;
    this._lastTintB = null;
    /** @type {THREE.Texture|null} */
    this._waterSpecBloomTexture = null;
    /** @type {THREE.Scene|null} */
    this._waterBloomCompositeScene = null;
    /** @type {THREE.OrthographicCamera|null} */
    this._waterBloomCompositeCamera = null;
    /** @type {THREE.ShaderMaterial|null} */
    this._waterBloomCompositeMaterial = null;
    /** @type {THREE.DataTexture|null} */
    this._black1x1Texture = null;
    /** @type {boolean} */
    this._initialized = false;
    /** @type {number} */
    this._lastW = 0;
    /** @type {number} */
    this._lastH = 0;
  }

  /**
   * Optional linear RGB specular mask (e.g. future water MRT). Pass `null` to clear.
   * @param {THREE.Texture|null} tex
   */
  setWaterSpecularBloomTexture(tex) {
    this._waterSpecBloomTexture = tex || null;
  }

  /**
   * @param {number} w
   * @param {number} h
   */
  _initialize(w, h) {
    if (this._initialized) return;
    const targetW = Math.max(1, Math.round(w));
    const targetH = Math.max(1, Math.round(h));
    const size = new THREE.Vector2(targetW, targetH);

    this._pass = new UnrealBloomPass(
      size,
      this.params.strength,
      this.params.radius,
      this.params.threshold,
    );

    this._bloomInputRT = new THREE.WebGLRenderTarget(targetW, targetH, {
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      format: THREE.RGBAFormat,
      type: THREE.HalfFloatType,
      depthBuffer: false,
      stencilBuffer: false,
    });
    this._bloomInputRT.texture.colorSpace = THREE.LinearSRGBColorSpace;

    this._copyScene = new THREE.Scene();
    this._copyCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this._copyMaterial = new THREE.MeshBasicMaterial({ map: null });
    this._copyMaterial.toneMapped = false;
    this._copyQuad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this._copyMaterial);
    this._copyQuad.frustumCulled = false;
    this._copyScene.add(this._copyQuad);

    const blackPx = new Uint8Array([0, 0, 0, 255]);
    this._black1x1Texture = new THREE.DataTexture(blackPx, 1, 1, THREE.RGBAFormat);
    this._black1x1Texture.needsUpdate = true;

    this._waterBloomCompositeMaterial = new THREE.ShaderMaterial({
      uniforms: {
        tDiffuse: { value: null },
        tWaterSpecBloom: { value: this._black1x1Texture },
        uWaterBloomMix: { value: 0 },
        uWaterBloomGamma: { value: 1.0 },
      },
      vertexShader: /* glsl */ `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = vec4(position.xy, 0.0, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        uniform sampler2D tDiffuse;
        uniform sampler2D tWaterSpecBloom;
        uniform float uWaterBloomMix;
        uniform float uWaterBloomGamma;
        varying vec2 vUv;
        void main() {
          vec4 c = texture2D(tDiffuse, vUv);
          vec3 h0 = texture2D(tWaterSpecBloom, vUv).rgb * uWaterBloomMix;
          float g = max(0.05, uWaterBloomGamma);
          vec3 h = pow(max(h0, vec3(0.0)), vec3(g));
          gl_FragColor = vec4(c.rgb + h, c.a);
        }
      `,
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
    });
    const wbQuad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this._waterBloomCompositeMaterial);
    wbQuad.frustumCulled = false;
    this._waterBloomCompositeScene = new THREE.Scene();
    this._waterBloomCompositeCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this._waterBloomCompositeScene.add(wbQuad);

    this._tintVec = new THREE.Vector3(1, 1, 1);
    this._updateTintColor();

    this._lastW = targetW;
    this._lastH = targetH;
    this._initialized = true;
  }

  _updateTintColor() {
    if (!this._pass || !this._tintVec) return;
    const tc = this.params.tintColor;
    this._tintVec.set(tc.r, tc.g, tc.b);
    const tintColors = this._pass.bloomTintColors;
    if (tintColors) {
      for (let i = 0; i < tintColors.length; i++) {
        tintColors[i].copy(this._tintVec);
      }
    }
    this._lastTintR = tc.r;
    this._lastTintG = tc.g;
    this._lastTintB = tc.b;
  }

  /**
   * @param {number} w
   * @param {number} h
   */
  onResize(w, h) {
    const targetW = Math.max(1, Math.round(w));
    const targetH = Math.max(1, Math.round(h));
    // Stay lazy while disabled: the chain invokes `onResize` on every
    // registered effect whenever its ping-pong RTs are allocated (any effect
    // enabled → all effects resized). For bloom that previously forced the
    // five-kernel UnrealBloomPass program set to compile even when the user
    // only toggled a cheap filter like dot-screen. Defer until either the
    // effect is enabled or it has already been initialised (e.g. via the
    // explicit warmup path or a prior render).
    if (!this._initialized) {
      if (this.enabled === true) {
        this._initialize(targetW, targetH);
      } else {
        this._lastW = targetW;
        this._lastH = targetH;
      }
      return;
    }
    if (this._lastW === targetW && this._lastH === targetH) return;
    this._lastW = targetW;
    this._lastH = targetH;
    try {
      this._pass?.setSize(targetW, targetH);
    } catch (_) {}
    try {
      this._bloomInputRT?.setSize(targetW, targetH);
    } catch (_) {}
  }

  /**
   * Called by {@link V3EffectChain} once per enabled effect before `render`.
   * @param {object} [_ctx]
   */
  update(_ctx) {
    if (!this._initialized || !this._pass) return;
    const p = this.params;
    this._pass.strength = p.strength;
    this._pass.radius = p.radius;
    this._pass.threshold = p.threshold;
    try {
      const u = this._pass.copyUniforms || this._pass.blendMaterial?.uniforms;
      if (u?.opacity?.value !== undefined) {
        u.opacity.value = p.blendOpacity;
      }
    } catch (_) {}
    const tc = p.tintColor;
    if (tc.r !== this._lastTintR || tc.g !== this._lastTintG || tc.b !== this._lastTintB) {
      this._updateTintColor();
    }
  }

  /**
   * @param {THREE.WebGLRenderer} renderer
   * @param {{
   *   inputTexture: THREE.Texture,
   *   inputRT: THREE.WebGLRenderTarget,
   *   outputRT: THREE.WebGLRenderTarget,
   * }} effCtx
   * @returns {boolean}
   */
  render(renderer, effCtx) {
    if (!renderer || !effCtx?.inputRT || !effCtx.outputRT) return false;
    const p = this.params;
    if (!(p.strength > 1e-6) || !(p.blendOpacity > 1e-6)) return false;

    const w = effCtx.outputRT.width;
    const h = effCtx.outputRT.height;
    this.onResize(w, h);
    if (!this._initialized || !this._pass || !this._bloomInputRT) return false;

    const prevTarget = renderer.getRenderTarget();
    const prevAutoClear = renderer.autoClear;

    try {
      const p0 = this.params;
      const useWaterBloom =
        this._waterSpecBloomTexture &&
        p0.waterSpecularBloomEnabled !== false &&
        Number(p0.waterSpecularBloomStrength) > 1e-6;

      if (useWaterBloom && this._waterBloomCompositeMaterial && this._waterBloomCompositeScene) {
        const wm = this._waterBloomCompositeMaterial.uniforms;
        wm.tDiffuse.value = effCtx.inputTexture;
        wm.tWaterSpecBloom.value = this._waterSpecBloomTexture;
        wm.uWaterBloomMix.value = Number(p0.waterSpecularBloomStrength) || 0;
        wm.uWaterBloomGamma.value = Math.max(0.05, Number(p0.waterSpecularBloomGamma) || 1.0);
        renderer.setRenderTarget(this._bloomInputRT);
        renderer.autoClear = true;
        renderer.render(this._waterBloomCompositeScene, this._waterBloomCompositeCamera);
      } else {
        this._copyMaterial.map = effCtx.inputTexture;
        renderer.setRenderTarget(this._bloomInputRT);
        renderer.autoClear = true;
        renderer.render(this._copyScene, this._copyCamera);
      }

      this._pass.render(renderer, null, this._bloomInputRT, 0.016, false);

      this._copyMaterial.map = this._bloomInputRT.texture;
      renderer.setRenderTarget(effCtx.outputRT);
      renderer.autoClear = true;
      renderer.render(this._copyScene, this._copyCamera);
      return true;
    } catch (_) {
      try {
        this._copyMaterial.map = effCtx.inputTexture;
        renderer.setRenderTarget(effCtx.outputRT);
        renderer.autoClear = true;
        renderer.render(this._copyScene, this._copyCamera);
      } catch (_) {}
      return false;
    } finally {
      renderer.autoClear = prevAutoClear;
      renderer.setRenderTarget(prevTarget);
    }
  }

  dispose() {
    try {
      this._pass?.dispose();
    } catch (_) {}
    try {
      this._bloomInputRT?.dispose();
    } catch (_) {}
    try {
      this._copyMaterial?.dispose();
    } catch (_) {}
    try {
      this._copyQuad?.geometry?.dispose();
    } catch (_) {}
    try {
      const q = this._waterBloomCompositeScene?.children?.[0];
      if (q?.geometry) q.geometry.dispose();
    } catch (_) {}
    try {
      this._waterBloomCompositeMaterial?.dispose();
    } catch (_) {}
    try {
      this._black1x1Texture?.dispose();
    } catch (_) {}
    this._waterBloomCompositeScene = null;
    this._waterBloomCompositeCamera = null;
    this._waterBloomCompositeMaterial = null;
    this._black1x1Texture = null;
    this._waterSpecBloomTexture = null;
    this._pass = null;
    this._bloomInputRT = null;
    this._copyScene = null;
    this._copyCamera = null;
    this._copyMaterial = null;
    this._copyQuad = null;
    this._tintVec = null;
    this._initialized = false;
    this._lastW = 0;
    this._lastH = 0;
  }

  snapshot() {
    return {
      id: this.id,
      phase: this.phase,
      order: this.order,
      enabled: this.enabled,
      params: { ...this.params, tintColor: { ...this.params.tintColor } },
      initialized: this._initialized,
    };
  }
}
