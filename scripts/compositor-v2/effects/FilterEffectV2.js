/**
 * @fileoverview FilterEffectV2 — V2 screen-space multiplicative filter.
 *
 * Conceptually similar to a "color correction" pass, but implemented as a
 * multiplicative overlay: `out.rgb = in.rgb * filter`.
 *
 * Primary intended use is ink/outline-driven AO-style darkening for flat-colour
 * maps with heavy black linework, but it can also be used as a simple tint.
 *
 * @module compositor-v2/effects/FilterEffectV2
 */

import { createLogger } from '../../core/log.js';

const log = createLogger('FilterEffectV2');

const clamp01 = (n) => Math.max(0, Math.min(1, n));

export class FilterEffectV2 {
  constructor() {
    /** @type {boolean} */
    this._initialized = false;

    /**
     * Whether the entire render pass is allowed to run.
     * Keep this separate from params.enabled so we can hard-disable for debugging.
     * @type {boolean}
     */
    this.enabled = true;

    /**
     * Tweakpane params.
     * Note: values are intentionally conservative by default.
     */
    this.params = {
      enabled: false,

      // Global blend
      intensity: 1.0,

      // Simple tint multiplier.
      // White means "no change".
      tintColor: { r: 1.0, g: 1.0, b: 1.0 },

      // Ink/AO from the current scene texture.
      inkAoEnabled: true,
      inkAoStrength: 0.65,
      inkDarkThreshold: 0.72,
      inkDarkSoftness: 0.08,
      inkEdgeStrength: 1.0,
      inkEdgePower: 1.25,
      inkSpreadPx: 2.0,
      inkTintColor: { r: 0.0, g: 0.0, b: 0.0 },

      // Vignette-style multiplicative darken (separate from ColorCorrection vignette).
      vignetteEnabled: false,
      vignetteStrength: 0.35,
      vignetteInner: 0.55,
      vignetteOuter: 1.15,
      vignetteTintColor: { r: 0.0, g: 0.0, b: 0.0 },
    };

    /** @type {THREE.Scene|null} */
    this._composeScene = null;
    /** @type {THREE.OrthographicCamera|null} */
    this._composeCamera = null;
    /** @type {THREE.ShaderMaterial|null} */
    this._composeMaterial = null;
    /** @type {THREE.Mesh|null} */
    this._composeQuad = null;
  }

  // ── UI schema (used directly in V2 mode) ─────────────────────────────────

  static getControlSchema() {
    return {
      enabled: true,
      groups: [
        {
          label: 'Filter',
          items: [
            { type: 'toggle', id: 'enabled', label: 'Enabled', default: false },
            { type: 'slider', id: 'intensity', label: 'Intensity', min: 0, max: 1, step: 0.01, default: 1.0 },
            { type: 'color', id: 'tintColor', label: 'Tint (Multiply)', default: { r: 1, g: 1, b: 1 } },
          ],
        },
        {
          label: 'Ink AO (from scene)',
          items: [
            { type: 'toggle', id: 'inkAoEnabled', label: 'Enabled', default: true },
            { type: 'slider', id: 'inkAoStrength', label: 'Strength', min: 0, max: 2, step: 0.01, default: 0.65 },
            { type: 'slider', id: 'inkDarkThreshold', label: 'Dark Threshold', min: 0, max: 1, step: 0.01, default: 0.72 },
            { type: 'slider', id: 'inkDarkSoftness', label: 'Dark Softness', min: 0, max: 0.5, step: 0.01, default: 0.08 },
            { type: 'slider', id: 'inkEdgeStrength', label: 'Edge Strength', min: 0, max: 4, step: 0.01, default: 1.0 },
            { type: 'slider', id: 'inkEdgePower', label: 'Edge Power', min: 0.25, max: 4, step: 0.01, default: 1.25 },
            { type: 'slider', id: 'inkSpreadPx', label: 'Spread (px)', min: 0, max: 12, step: 0.25, default: 2.0 },
            { type: 'color', id: 'inkTintColor', label: 'AO Tint', default: { r: 0, g: 0, b: 0 } },
          ],
        },
        {
          label: 'Vignette (Multiply)',
          items: [
            { type: 'toggle', id: 'vignetteEnabled', label: 'Enabled', default: false },
            { type: 'slider', id: 'vignetteStrength', label: 'Strength', min: 0, max: 2, step: 0.01, default: 0.35 },
            { type: 'slider', id: 'vignetteInner', label: 'Inner', min: 0, max: 2, step: 0.01, default: 0.55 },
            { type: 'slider', id: 'vignetteOuter', label: 'Outer', min: 0, max: 2.5, step: 0.01, default: 1.15 },
            { type: 'color', id: 'vignetteTintColor', label: 'Tint', default: { r: 0, g: 0, b: 0 } },
          ],
        },
      ],
    };
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────

  initialize() {
    const THREE = window.THREE;
    if (!THREE) return;

    this._composeScene = new THREE.Scene();
    this._composeCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

    this._composeMaterial = new THREE.ShaderMaterial({
      uniforms: {
        tDiffuse: { value: null },
        uResolution: { value: new THREE.Vector2(1, 1) },

        uEnabled: { value: 0.0 },
        uIntensity: { value: 1.0 },

        uTint: { value: new THREE.Vector3(1, 1, 1) },

        uInkAoEnabled: { value: 0.0 },
        uInkAoStrength: { value: 0.65 },
        uInkDarkThreshold: { value: 0.72 },
        uInkDarkSoftness: { value: 0.08 },
        uInkEdgeStrength: { value: 1.0 },
        uInkEdgePower: { value: 1.25 },
        uInkSpreadPx: { value: 2.0 },
        uInkTint: { value: new THREE.Vector3(0, 0, 0) },

        uVignetteEnabled: { value: 0.0 },
        uVignetteStrength: { value: 0.35 },
        uVignetteInner: { value: 0.55 },
        uVignetteOuter: { value: 1.15 },
        uVignetteTint: { value: new THREE.Vector3(0, 0, 0) },
      },
      vertexShader: /* glsl */`
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = vec4(position.xy, 0.0, 1.0);
        }
      `,
      fragmentShader: /* glsl */`
        uniform sampler2D tDiffuse;
        uniform vec2 uResolution;

        uniform float uEnabled;
        uniform float uIntensity;
        uniform vec3  uTint;

        uniform float uInkAoEnabled;
        uniform float uInkAoStrength;
        uniform float uInkDarkThreshold;
        uniform float uInkDarkSoftness;
        uniform float uInkEdgeStrength;
        uniform float uInkEdgePower;
        uniform float uInkSpreadPx;
        uniform vec3  uInkTint;

        uniform float uVignetteEnabled;
        uniform float uVignetteStrength;
        uniform float uVignetteInner;
        uniform float uVignetteOuter;
        uniform vec3  uVignetteTint;

        varying vec2 vUv;

        float luma(vec3 c) {
          return dot(c, vec3(0.2126, 0.7152, 0.0722));
        }

        void main() {
          vec4 scene = texture2D(tDiffuse, vUv);
          vec3 base = scene.rgb;

          if (uEnabled <= 0.0 || uIntensity <= 0.0) {
            gl_FragColor = scene;
            return;
          }

          // Start with simple tint multiplier.
          vec3 filter = max(uTint, vec3(0.0));

          // ── Ink AO approximation ───────────────────────────────────────
          // Detect dark outlines and local contrast, then spread the influence
          // outwards by sampling at a configurable radius (dilation-ish).
          if (uInkAoEnabled > 0.5 && uInkAoStrength > 0.0) {
            vec2 texel = vec2(1.0) / max(uResolution, vec2(1.0));
            float rPx = max(0.0, uInkSpreadPx);
            vec2 o = texel * rPx;

            float Lc = luma(base);

            // Darkness mask at the center.
            float darkC = smoothstep(uInkDarkThreshold, uInkDarkThreshold - max(0.0001, uInkDarkSoftness), 1.0 - Lc);

            // Edge/contrast proxy.
            float Ln = luma(texture2D(tDiffuse, vUv + vec2(0.0,  o.y)).rgb);
            float Ls = luma(texture2D(tDiffuse, vUv + vec2(0.0, -o.y)).rgb);
            float Le = luma(texture2D(tDiffuse, vUv + vec2( o.x, 0.0)).rgb);
            float Lw = luma(texture2D(tDiffuse, vUv + vec2(-o.x, 0.0)).rgb);

            float edge = abs(Lc - Ln) + abs(Lc - Ls) + abs(Lc - Le) + abs(Lc - Lw);
            edge = pow(clamp(edge * uInkEdgeStrength, 0.0, 1.0), max(0.01, uInkEdgePower));

            // Spread darkness by sampling at radius (4 taps). This makes thick outlines
            // actually darken adjacent areas rather than only the line pixels.
            float dN = smoothstep(uInkDarkThreshold, uInkDarkThreshold - max(0.0001, uInkDarkSoftness), 1.0 - Ln);
            float dS = smoothstep(uInkDarkThreshold, uInkDarkThreshold - max(0.0001, uInkDarkSoftness), 1.0 - Ls);
            float dE = smoothstep(uInkDarkThreshold, uInkDarkThreshold - max(0.0001, uInkDarkSoftness), 1.0 - Le);
            float dW = smoothstep(uInkDarkThreshold, uInkDarkThreshold - max(0.0001, uInkDarkSoftness), 1.0 - Lw);

            float darkSpread = max(darkC, max(max(dN, dS), max(dE, dW)));

            float ao = clamp(darkSpread * edge, 0.0, 1.0);
            ao *= uInkAoStrength;

            // Multiplicative AO: filter *= mix(1, aoTint, ao)
            vec3 aoTint = mix(vec3(1.0), clamp(uInkTint, 0.0, 1.0), clamp(ao, 0.0, 1.0));
            filter *= aoTint;
          }

          // ── Vignette (multiplicative) ──────────────────────────────────
          if (uVignetteEnabled > 0.5 && uVignetteStrength > 0.0) {
            vec2 d = (vUv - 0.5) * 2.0;
            float len = length(d);
            float v = smoothstep(uVignetteInner, uVignetteOuter, len);
            float m = clamp(v * uVignetteStrength, 0.0, 1.0);
            vec3 vTint = mix(vec3(1.0), clamp(uVignetteTint, 0.0, 1.0), m);
            filter *= vTint;
          }

          // Apply filter with intensity.
          vec3 filtered = base * filter;
          vec3 outColor = mix(base, filtered, clamp(uIntensity, 0.0, 1.0));

          gl_FragColor = vec4(outColor, scene.a);
        }
      `,
      depthTest: false,
      depthWrite: false,
    });
    this._composeMaterial.toneMapped = false;

    this._composeQuad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this._composeMaterial);
    this._composeQuad.frustumCulled = false;
    this._composeScene.add(this._composeQuad);

    this._initialized = true;
    log.info('FilterEffectV2 initialized');
  }

  /**
   * Push current params to shader uniforms.
   * @param {{ elapsed:number, delta:number }} _timeInfo
   */
  update(_timeInfo) {
    if (!this._initialized || !this._composeMaterial) return;
    if (!this.params.enabled) return;

    const u = this._composeMaterial.uniforms;
    const p = this.params;

    u.uEnabled.value = p.enabled ? 1.0 : 0.0;
    u.uIntensity.value = clamp01(p.intensity ?? 1.0);

    if (p.tintColor) u.uTint.value.set(p.tintColor.r, p.tintColor.g, p.tintColor.b);

    u.uInkAoEnabled.value = p.inkAoEnabled ? 1.0 : 0.0;
    u.uInkAoStrength.value = Math.max(0.0, p.inkAoStrength ?? 0.0);
    u.uInkDarkThreshold.value = clamp01(p.inkDarkThreshold ?? 0.7);
    u.uInkDarkSoftness.value = Math.max(0.0, p.inkDarkSoftness ?? 0.05);
    u.uInkEdgeStrength.value = Math.max(0.0, p.inkEdgeStrength ?? 1.0);
    u.uInkEdgePower.value = Math.max(0.01, p.inkEdgePower ?? 1.0);
    u.uInkSpreadPx.value = Math.max(0.0, p.inkSpreadPx ?? 0.0);
    if (p.inkTintColor) u.uInkTint.value.set(p.inkTintColor.r, p.inkTintColor.g, p.inkTintColor.b);

    u.uVignetteEnabled.value = p.vignetteEnabled ? 1.0 : 0.0;
    u.uVignetteStrength.value = Math.max(0.0, p.vignetteStrength ?? 0.0);
    u.uVignetteInner.value = Math.max(0.0, p.vignetteInner ?? 0.55);
    u.uVignetteOuter.value = Math.max(0.0001, p.vignetteOuter ?? 1.15);
    if (p.vignetteTintColor) u.uVignetteTint.value.set(p.vignetteTintColor.r, p.vignetteTintColor.g, p.vignetteTintColor.b);
  }

  /**
   * Execute the filter pass.
   * @param {THREE.WebGLRenderer} renderer
   * @param {THREE.WebGLRenderTarget} inputRT
   * @param {THREE.WebGLRenderTarget} outputRT
   */
  render(renderer, inputRT, outputRT) {
    if (!this._initialized || !this._composeMaterial || !inputRT) return;
    if (!this.enabled) return;
    if (!this.params.enabled) return;

    this._composeMaterial.uniforms.tDiffuse.value = inputRT.texture;
    this._composeMaterial.uniforms.uResolution.value.set(inputRT.width, inputRT.height);

    const prevTarget = renderer.getRenderTarget();
    const prevAutoClear = renderer.autoClear;

    renderer.setRenderTarget(outputRT);
    renderer.autoClear = true;
    renderer.render(this._composeScene, this._composeCamera);

    renderer.autoClear = prevAutoClear;
    renderer.setRenderTarget(prevTarget);
  }

  dispose() {
    try { this._composeMaterial?.dispose(); } catch (_) {}
    try { this._composeQuad?.geometry?.dispose(); } catch (_) {}
    this._composeScene = null;
    this._composeCamera = null;
    this._composeMaterial = null;
    this._composeQuad = null;
    this._initialized = false;
    log.info('FilterEffectV2 disposed');
  }
}
