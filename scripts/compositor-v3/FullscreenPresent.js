/**
 * @fileoverview FullscreenPresent — the V3 pipeline's `present` pass: samples
 * the linear-HDR working buffer and writes it to the screen framebuffer with an
 * explicit linear→sRGB encode.
 *
 * The source RT holds LINEAR color (the bus renders albedo in linear space, and
 * lighting later adds linear radiance). The screen expects sRGB, so this pass
 * applies the sRGB OETF itself — a raw `ShaderMaterial` output is not
 * auto-encoded by three in this pipeline (confirmed: the earlier raw copy of an
 * already-sRGB buffer displayed correctly, i.e. three did not double-encode).
 *
 * Uses the same defensive renderer-state reset as V2 `_blitToScreen` (scissor
 * off, viewport to logical size, opaque clear) to avoid stale-underlay /
 * transparent-canvas artifacts.
 *
 * **HDR handling — a hue-preserving highlight rolloff, NOT global ACES.** The lit
 * buffer is HDR (candle glow / bright light cores exceed 1.0). A global ACES
 * curve desaturates the whole image and bleaches saturated light cores toward
 * white. Instead, this pass leaves everything below a knee (`uKnee`, default 0.9)
 * pixel-identical to the linear input — so Foundry-matched midtones and light
 * bodies are untouched — and compresses only the over-knee "filament" toward 1.0,
 * scaling RGB uniformly so the hot core keeps its color. Only the brightest part
 * of a light is affected; the rest of the frame is exactly what lighting produced.
 *
 * @module compositor-v3/FullscreenPresent
 */

import { createLogger } from '../core/log.js';

const log = createLogger('V3FullscreenPresent');

export class FullscreenPresent {
  /**
   * @param {object} [options]
   * @param {any} [options.THREE] - defaults to `window.THREE`.
   */
  constructor(options = {}) {
    this._THREE = options.THREE ?? (typeof window !== 'undefined' ? window.THREE : null);
    this._scene = null;
    this._camera = null;
    this._material = null;
    this._quad = null;
    this._sizeVec = null;
  }

  /** @param {any} THREE @private */
  _ensure(THREE) {
    if (this._scene || !THREE) return;
    this._scene = new THREE.Scene();
    this._camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this._sizeVec = new THREE.Vector2();
    this._material = new THREE.ShaderMaterial({
      uniforms: { tDiffuse: { value: null }, uToneMap: { value: 1 }, uKnee: { value: 0.9 } },
      vertexShader: /* glsl */`
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = vec4(position.xy, 0.0, 1.0);
        }
      `,
      fragmentShader: /* glsl */`
        precision highp float;
        uniform sampler2D tDiffuse;
        uniform float uToneMap;   // 1 = highlight rolloff, 0 = passthrough (hard clip)
        uniform float uKnee;      // peak luminance below which color is untouched
        varying vec2 vUv;
        // Standard sRGB OETF (linear → gamma-encoded display).
        vec3 linearToSRGB(vec3 c) {
          vec3 lo = c * 12.92;
          vec3 hi = 1.055 * pow(max(c, vec3(0.0)), vec3(1.0 / 2.4)) - 0.055;
          return mix(lo, hi, step(vec3(0.0031308), c));
        }
        // Hue-preserving highlight rolloff. Below the knee: identity (the frame is
        // exactly what lighting produced — Foundry-matched). Above the knee: the
        // PEAK channel is compressed toward display white with slope 1 at the knee
        // (no visible kink) and asymptote 1.0, and all channels are scaled by the
        // same factor so the hot core keeps its hue/saturation instead of bleaching
        // to white (the ACES failure mode). Only the brightest filament is touched.
        vec3 highlightRolloff(vec3 c, float knee) {
          float L = max(c.r, max(c.g, c.b));
          if (L <= knee) return c;
          float h = max(1.0 - knee, 1e-3);   // headroom from knee to display white
          float x = L - knee;                // HDR excess over the knee
          float Lc = knee + h * x / (h + x); // f'(knee)=1, f(∞)→1.0 (smooth shoulder)
          return c * (Lc / max(L, 1e-5));    // uniform scale → hue/saturation preserved
        }
        void main() {
          vec3 lin = max(texture2D(tDiffuse, vUv).rgb, vec3(0.0));
          if (uToneMap > 0.5) lin = highlightRolloff(lin, uKnee);
          gl_FragColor = vec4(linearToSRGB(lin), 1.0);
        }
      `,
      depthTest: false,
      depthWrite: false,
      transparent: false,
      blending: THREE.NoBlending,
    });
    this._material.toneMapped = false;
    this._quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this._material);
    this._quad.frustumCulled = false;
    this._scene.add(this._quad);
    log.debug('FullscreenPresent initialized');
  }

  /**
   * Blit `texture` to the screen framebuffer (null render target).
   * @param {THREE.WebGLRenderer} renderer
   * @param {THREE.Texture} texture
   * @param {{tonemap?: boolean, knee?: number}} [opts] - `tonemap` applies the
   *   highlight rolloff (default true); `knee` overrides the rolloff knee
   *   (default 0.9 — lower compresses more of the highlights, higher affects only
   *   the very brightest filament).
   * @returns {boolean} whether a blit happened
   */
  present(renderer, texture, opts = null) {
    const THREE = this._THREE ?? (typeof window !== 'undefined' ? window.THREE : null);
    if (!renderer || !texture || !THREE) return false;
    this._ensure(THREE);
    if (!this._material || !this._scene || !this._camera) return false;

    const prevTarget = renderer.getRenderTarget?.();
    const prevAutoClear = renderer.autoClear;
    const prevScissorTest = (typeof renderer.getScissorTest === 'function')
      ? renderer.getScissorTest() : null;

    this._material.uniforms.tDiffuse.value = texture;
    this._material.uniforms.uToneMap.value = (opts?.tonemap === false) ? 0 : 1;
    if (opts && Number.isFinite(opts.knee)) {
      this._material.uniforms.uKnee.value = Math.max(0.0, Math.min(1.0, opts.knee));
    }
    try {
      renderer.setRenderTarget(null);
      renderer.autoClear = false;
      if (typeof renderer.setScissorTest === 'function') renderer.setScissorTest(false);
      if (typeof renderer.setViewport === 'function' && typeof renderer.getSize === 'function') {
        renderer.getSize(this._sizeVec);
        renderer.setViewport(0, 0, Math.max(1, this._sizeVec.x), Math.max(1, this._sizeVec.y));
      }
      // Opaque clear so the quad is never composited over a transparent/stale
      // framebuffer (the V2 stale-underlay hazard).
      if (typeof renderer.setClearColor === 'function') renderer.setClearColor(0x000000, 1);
      if (typeof renderer.setClearAlpha === 'function') renderer.setClearAlpha(1);
      if (typeof renderer.clear === 'function') renderer.clear(true, true, true);
      renderer.render(this._scene, this._camera);
    } catch (err) {
      log.warn('present blit failed', err);
      return false;
    } finally {
      renderer.autoClear = prevAutoClear;
      if (prevScissorTest !== null && typeof renderer.setScissorTest === 'function') {
        try { renderer.setScissorTest(prevScissorTest); } catch (_) {}
      }
      // Intentionally do NOT restore a transparent clearAlpha (V2 note): leaving
      // clearAlpha=0 ends the frame transparent and reveals stale content.
      try { renderer.setRenderTarget(prevTarget ?? null); } catch (_) {}
    }
    return true;
  }

  dispose() {
    try { this._quad?.geometry?.dispose?.(); } catch (_) {}
    try { this._material?.dispose?.(); } catch (_) {}
    this._scene = null; this._camera = null; this._material = null; this._quad = null;
  }
}
