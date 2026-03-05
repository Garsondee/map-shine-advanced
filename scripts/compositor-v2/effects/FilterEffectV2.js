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
const finiteOr = (n, fallback) => (Number.isFinite(n) ? n : fallback);

function normalizeColor01(input, fallback) {
  if (!input || typeof input !== 'object') return fallback;
  let { r, g, b } = input;
  if (!Number.isFinite(r) || !Number.isFinite(g) || !Number.isFinite(b)) return fallback;
  // Accept both 0..1 and 0..255 UI payloads.
  if (r > 1 || g > 1 || b > 1) {
    r /= 255;
    g /= 255;
    b /= 255;
  }
  return { r: clamp01(r), g: clamp01(g), b: clamp01(b) };
}

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
      inkSpreadPx: 12.0,
      inkBlurPx: 2.0,
      inkOutdoorsDarkOnly: false,
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

    /** @type {THREE.Texture|null} */
    this._outdoorsMask = null;
  }

  // ── UI schema (used directly in V2 mode) ─────────────────────────────────

  static getControlSchema() {
    return {
      enabled: true,
      groups: [
        {
          name: 'filter',
          label: 'Filter',
          type: 'inline',
          parameters: ['intensity', 'tintColor'],
        },
        {
          name: 'inkAo',
          label: 'Ink AO (from scene)',
          type: 'folder',
          expanded: false,
          parameters: [
            'inkAoEnabled',
            'inkAoStrength',
            'inkDarkThreshold',
            'inkDarkSoftness',
            'inkEdgeStrength',
            'inkEdgePower',
            'inkSpreadPx',
            'inkBlurPx',
            'inkOutdoorsDarkOnly',
            'inkTintColor',
          ],
        },
        {
          name: 'vignette',
          label: 'Vignette (Multiply)',
          type: 'folder',
          expanded: false,
          parameters: ['vignetteEnabled', 'vignetteStrength', 'vignetteInner', 'vignetteOuter', 'vignetteTintColor'],
        },
      ],
      parameters: {
        enabled: { type: 'boolean', default: false, hidden: true },

        intensity: { type: 'slider', label: 'Intensity', min: 0, max: 1, step: 0.01, default: 1.0 },
        tintColor: { type: 'color', label: 'Tint (Multiply)', default: { r: 1, g: 1, b: 1 } },

        inkAoEnabled: { type: 'boolean', label: 'Enabled', default: true },
        inkAoStrength: { type: 'slider', label: 'Strength', min: 0, max: 2, step: 0.01, default: 0.85 },
        inkDarkThreshold: { type: 'slider', label: 'Dark Threshold', min: 0, max: 1, step: 0.01, default: 0.65 },
        inkDarkSoftness: { type: 'slider', label: 'Dark Softness', min: 0.001, max: 0.5, step: 0.01, default: 0.12 },
        inkEdgeStrength: { type: 'slider', label: 'Edge Strength', min: 0, max: 4, step: 0.01, default: 1.35 },
        inkEdgePower: { type: 'slider', label: 'Edge Power', min: 0.25, max: 4, step: 0.01, default: 1.15 },
        inkSpreadPx: { type: 'slider', label: 'Spread (px)', min: 0, max: 96, step: 0.5, default: 12.0 },
        inkBlurPx: { type: 'slider', label: 'Spread Blur (px)', min: 0, max: 24, step: 0.25, default: 2.0 },
        inkOutdoorsDarkOnly: { type: 'boolean', label: 'Only _Outdoors Dark Regions', default: false },
        inkTintColor: { type: 'color', label: 'AO Tint', default: { r: 0, g: 0, b: 0 } },

        vignetteEnabled: { type: 'boolean', label: 'Enabled', default: false },
        vignetteStrength: { type: 'slider', label: 'Strength', min: 0, max: 2, step: 0.01, default: 0.35 },
        vignetteInner: { type: 'slider', label: 'Inner', min: 0, max: 2, step: 0.01, default: 0.55 },
        vignetteOuter: { type: 'slider', label: 'Outer', min: 0.01, max: 2.5, step: 0.01, default: 1.15 },
        vignetteTintColor: { type: 'color', label: 'Tint', default: { r: 0, g: 0, b: 0 } },
      },
      presets: {
        Off: {
          intensity: 1.0,
          tintColor: { r: 1, g: 1, b: 1 },
          inkAoEnabled: false,
          vignetteEnabled: false,
        },
        'Ink AO — Subtle': {
          intensity: 1.0,
          tintColor: { r: 1, g: 1, b: 1 },
          inkAoEnabled: true,
          inkAoStrength: 0.6,
          inkDarkThreshold: 0.7,
          inkDarkSoftness: 0.1,
          inkEdgeStrength: 1.15,
          inkEdgePower: 1.2,
          inkSpreadPx: 2.0,
          inkTintColor: { r: 0.0, g: 0.0, b: 0.0 },
          vignetteEnabled: false,
        },
        'Ink AO — Bold': {
          intensity: 1.0,
          tintColor: { r: 1, g: 1, b: 1 },
          inkAoEnabled: true,
          inkAoStrength: 1.1,
          inkDarkThreshold: 0.62,
          inkDarkSoftness: 0.14,
          inkEdgeStrength: 1.6,
          inkEdgePower: 1.0,
          inkSpreadPx: 3.5,
          inkTintColor: { r: 0.0, g: 0.0, b: 0.0 },
          vignetteEnabled: false,
        },
      },
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
        uZoom: { value: 1.0 },
        // Three world-space view bounds (minX,minY,maxX,maxY)
        uViewBounds: { value: new THREE.Vector4(0, 0, 1, 1) },
        // Foundry sceneRect bounds (x,y,width,height) in Foundry coords (top-left origin)
        uSceneBounds: { value: new THREE.Vector4(0, 0, 1, 1) },
        // Full canvas dimensions (including padding) in Foundry coords
        uSceneDimensions: { value: new THREE.Vector2(1, 1) },

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
        uInkBlurPx: { value: 2.0 },
        uInkOutdoorsDarkOnly: { value: 0.0 },
        uInkTint: { value: new THREE.Vector3(0, 0, 0) },

        uOutdoorsMask: { value: null },
        uHasOutdoorsMask: { value: 0.0 },
        uOutdoorsMaskFlipY: { value: 0.0 },

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
        uniform float uZoom;
        uniform vec4 uViewBounds;
        uniform vec4 uSceneBounds;
        uniform vec2 uSceneDimensions;

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
        uniform float uInkBlurPx;
        uniform float uInkOutdoorsDarkOnly;
        uniform vec3  uInkTint;

        uniform sampler2D uOutdoorsMask;
        uniform float uHasOutdoorsMask;
        uniform float uOutdoorsMaskFlipY;

        uniform float uVignetteEnabled;
        uniform float uVignetteStrength;
        uniform float uVignetteInner;
        uniform float uVignetteOuter;
        uniform vec3  uVignetteTint;

        varying vec2 vUv;

        float luma(vec3 c) {
          return dot(c, vec3(0.2126, 0.7152, 0.0722));
        }

        float darkMaskFromLuma(float lum, float threshold, float softness) {
          float s = max(0.0001, softness);
          // 1 for dark pixels (lum << threshold), 0 for bright pixels.
          return 1.0 - smoothstep(threshold - s, threshold, lum);
        }

        float readOutdoorsMask(vec2 uv) {
          // Convert screen UV to Three world coordinates from current view bounds.
          float worldX = mix(uViewBounds.x, uViewBounds.z, uv.x);
          float worldY = mix(uViewBounds.y, uViewBounds.w, uv.y);

          // Map to sceneRect UV for world-space _Outdoors sampling.
          // Match V2 SkyColor/Cloud convention: world Y-up -> scene UV with V flip.
          vec2 maskUv = vec2(
            (worldX - uSceneBounds.x) / max(uSceneBounds.z, 1.0),
            1.0 - ((worldY - uSceneBounds.y) / max(uSceneBounds.w, 1.0))
          );
          maskUv = clamp(maskUv, 0.0, 1.0);

          // Optional compatibility flip for mask sources that require it.
          if (uOutdoorsMaskFlipY > 0.5) maskUv.y = 1.0 - maskUv.y;

          return clamp(texture2D(uOutdoorsMask, maskUv).r, 0.0, 1.0);
        }

        void main() {
          vec4 scene = texture2D(tDiffuse, vUv);
          vec3 base = scene.rgb;

          if (uEnabled <= 0.0 || uIntensity <= 0.0) {
            gl_FragColor = scene;
            return;
          }

          // Start with simple tint multiplier.
          vec3 filterMul = max(uTint, vec3(0.0));

          // ── Ink AO approximation ───────────────────────────────────────
          // Detect dark outlines and local contrast.
          // Then perform spread first (dilation-style), followed by blur.
          if (uInkAoEnabled > 0.5 && uInkAoStrength > 0.0) {
            vec2 texel = vec2(1.0) / max(uResolution, vec2(1.0));
            float zoom = max(uZoom, 0.0001);
            float spreadPx = max(0.0, uInkSpreadPx) * zoom;
            float blurPx = max(0.0, uInkBlurPx) * zoom;
            vec2 o = texel * spreadPx;
            vec2 b = texel * blurPx;

            float Lc = luma(base);

            // Darkness mask at the center.
            float darkC = darkMaskFromLuma(Lc, uInkDarkThreshold, uInkDarkSoftness);

            // Edge/contrast proxy.
            float Ln = luma(texture2D(tDiffuse, vUv + vec2(0.0,  o.y)).rgb);
            float Ls = luma(texture2D(tDiffuse, vUv + vec2(0.0, -o.y)).rgb);
            float Le = luma(texture2D(tDiffuse, vUv + vec2( o.x, 0.0)).rgb);
            float Lw = luma(texture2D(tDiffuse, vUv + vec2(-o.x, 0.0)).rgb);

            float Lne = luma(texture2D(tDiffuse, vUv + vec2( o.x,  o.y)).rgb);
            float Lnw = luma(texture2D(tDiffuse, vUv + vec2(-o.x,  o.y)).rgb);
            float Lse = luma(texture2D(tDiffuse, vUv + vec2( o.x, -o.y)).rgb);
            float Lsw = luma(texture2D(tDiffuse, vUv + vec2(-o.x, -o.y)).rgb);

            float edge = 0.0;
            edge += abs(Lc - Ln) + abs(Lc - Ls) + abs(Lc - Le) + abs(Lc - Lw);
            edge += 0.6 * (abs(Lc - Lne) + abs(Lc - Lnw) + abs(Lc - Lse) + abs(Lc - Lsw));
            edge = pow(clamp(edge * 0.5 * uInkEdgeStrength, 0.0, 1.0), max(0.01, uInkEdgePower));

            // Spread pass: dilation-like growth from dark linework.
            float dN = darkMaskFromLuma(Ln, uInkDarkThreshold, uInkDarkSoftness);
            float dS = darkMaskFromLuma(Ls, uInkDarkThreshold, uInkDarkSoftness);
            float dE = darkMaskFromLuma(Le, uInkDarkThreshold, uInkDarkSoftness);
            float dW = darkMaskFromLuma(Lw, uInkDarkThreshold, uInkDarkSoftness);
            float dNE = darkMaskFromLuma(Lne, uInkDarkThreshold, uInkDarkSoftness);
            float dNW = darkMaskFromLuma(Lnw, uInkDarkThreshold, uInkDarkSoftness);
            float dSE = darkMaskFromLuma(Lse, uInkDarkThreshold, uInkDarkSoftness);
            float dSW = darkMaskFromLuma(Lsw, uInkDarkThreshold, uInkDarkSoftness);

            float darkSpread = max(
              darkC,
              max(
                max(max(dN, dS), max(dE, dW)),
                max(max(dNE, dNW), max(dSE, dSW))
              )
            );

            // Blur pass on top of spread result.
            float darkBlur = darkSpread;
            if (blurPx > 0.0) {
              float bN = darkMaskFromLuma(luma(texture2D(tDiffuse, vUv + vec2(0.0,  b.y)).rgb), uInkDarkThreshold, uInkDarkSoftness);
              float bS = darkMaskFromLuma(luma(texture2D(tDiffuse, vUv + vec2(0.0, -b.y)).rgb), uInkDarkThreshold, uInkDarkSoftness);
              float bE = darkMaskFromLuma(luma(texture2D(tDiffuse, vUv + vec2( b.x, 0.0)).rgb), uInkDarkThreshold, uInkDarkSoftness);
              float bW = darkMaskFromLuma(luma(texture2D(tDiffuse, vUv + vec2(-b.x, 0.0)).rgb), uInkDarkThreshold, uInkDarkSoftness);
              float bNE = darkMaskFromLuma(luma(texture2D(tDiffuse, vUv + vec2( b.x,  b.y)).rgb), uInkDarkThreshold, uInkDarkSoftness);
              float bNW = darkMaskFromLuma(luma(texture2D(tDiffuse, vUv + vec2(-b.x,  b.y)).rgb), uInkDarkThreshold, uInkDarkSoftness);
              float bSE = darkMaskFromLuma(luma(texture2D(tDiffuse, vUv + vec2( b.x, -b.y)).rgb), uInkDarkThreshold, uInkDarkSoftness);
              float bSW = darkMaskFromLuma(luma(texture2D(tDiffuse, vUv + vec2(-b.x, -b.y)).rgb), uInkDarkThreshold, uInkDarkSoftness);
              darkBlur = (
                darkSpread +
                (bN + bS + bE + bW) * 0.85 +
                (bNE + bNW + bSE + bSW) * 0.65
              ) / (1.0 + 4.0 * 0.85 + 4.0 * 0.65);
            }

            // Mix darkness and edge evidence so flat dark strokes and high-contrast
            // linework both contribute to AO darkening.
            float ao = clamp(max(darkBlur * 0.7, darkBlur * edge), 0.0, 1.0);

            // Optional gate: only apply AO in dark (_Outdoors=0) regions.
            if (uInkOutdoorsDarkOnly > 0.5 && uHasOutdoorsMask > 0.5) {
              float outdoors = readOutdoorsMask(vUv);
              float indoorsGate = 1.0 - outdoors;
              ao *= indoorsGate;
            }

            ao *= uInkAoStrength;

            // Multiplicative AO: filterMul *= mix(1, aoTint, ao)
            vec3 aoTint = mix(vec3(1.0), clamp(uInkTint, 0.0, 1.0), clamp(ao, 0.0, 1.0));
            filterMul *= aoTint;
          }

          // ── Vignette (multiplicative) ──────────────────────────────────
          if (uVignetteEnabled > 0.5 && uVignetteStrength > 0.0) {
            vec2 d = (vUv - 0.5) * 2.0;
            float len = length(d);
            float v = smoothstep(uVignetteInner, uVignetteOuter, len);
            float m = clamp(v * uVignetteStrength, 0.0, 1.0);
            vec3 vTint = mix(vec3(1.0), clamp(uVignetteTint, 0.0, 1.0), m);
            filterMul *= vTint;
          }

          // Apply filter with intensity.
          vec3 filtered = base * filterMul;
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

    // Apply any mask that may have been provided before initialize().
    if (this._outdoorsMask) {
      this.setOutdoorsMask(this._outdoorsMask);
    }

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
    const intensity = clamp01(finiteOr(Number(p.intensity), 1.0));
    u.uIntensity.value = intensity;

    const tint = normalizeColor01(p.tintColor, { r: 1, g: 1, b: 1 });
    u.uTint.value.set(tint.r, tint.g, tint.b);

    u.uInkAoEnabled.value = p.inkAoEnabled ? 1.0 : 0.0;
    u.uInkAoStrength.value = Math.max(0.0, finiteOr(Number(p.inkAoStrength), 0.0));
    u.uInkDarkThreshold.value = clamp01(finiteOr(Number(p.inkDarkThreshold), 0.7));
    u.uInkDarkSoftness.value = Math.max(0.0, finiteOr(Number(p.inkDarkSoftness), 0.05));
    u.uInkEdgeStrength.value = Math.max(0.0, finiteOr(Number(p.inkEdgeStrength), 1.0));
    u.uInkEdgePower.value = Math.max(0.01, finiteOr(Number(p.inkEdgePower), 1.0));
    u.uInkSpreadPx.value = Math.max(0.0, finiteOr(Number(p.inkSpreadPx), 0.0));
    u.uInkBlurPx.value = Math.max(0.0, finiteOr(Number(p.inkBlurPx), 0.0));
    u.uInkOutdoorsDarkOnly.value = p.inkOutdoorsDarkOnly ? 1.0 : 0.0;
    const inkTint = normalizeColor01(p.inkTintColor, { r: 0, g: 0, b: 0 });
    u.uInkTint.value.set(inkTint.r, inkTint.g, inkTint.b);

    u.uVignetteEnabled.value = p.vignetteEnabled ? 1.0 : 0.0;
    u.uVignetteStrength.value = Math.max(0.0, finiteOr(Number(p.vignetteStrength), 0.0));
    u.uVignetteInner.value = Math.max(0.0, finiteOr(Number(p.vignetteInner), 0.55));
    u.uVignetteOuter.value = Math.max(0.0001, finiteOr(Number(p.vignetteOuter), 1.15));
    const vignetteTint = normalizeColor01(p.vignetteTintColor, { r: 0, g: 0, b: 0 });
    u.uVignetteTint.value.set(vignetteTint.r, vignetteTint.g, vignetteTint.b);
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
    const currentZoom = Number(window.MapShine?.sceneComposer?.currentZoom);
    this._composeMaterial.uniforms.uZoom.value = Number.isFinite(currentZoom) ? Math.max(0.0001, currentZoom) : 1.0;
    // Keep mask sampling world-locked by reconstructing Foundry coords from screen UV.
    const sc = window.MapShine?.sceneComposer;
    const sceneRect = canvas?.dimensions?.sceneRect;
    const sceneX = sceneRect?.x ?? 0;
    const sceneY = sceneRect?.y ?? 0;
    const sceneW = sceneRect?.width ?? 1;
    const sceneH = sceneRect?.height ?? 1;
    let vMinX = 0;
    let vMinY = 0;
    let vMaxX = sceneW;
    let vMaxY = sceneH;
    const cam = sc?.camera;
    if (cam) {
      if (cam.isOrthographicCamera) {
        const camPos = cam.position;
        vMinX = camPos.x + cam.left / cam.zoom;
        vMinY = camPos.y + cam.bottom / cam.zoom;
        vMaxX = camPos.x + cam.right / cam.zoom;
        vMaxY = camPos.y + cam.top / cam.zoom;
      } else {
        const groundZ = sc?.groundZ ?? 0;
        const dist = Math.max(1e-3, Math.abs((cam.position?.z ?? 0) - groundZ));
        const fovRad = ((Number(cam.fov) || 60) * Math.PI) / 180;
        const halfH = dist * Math.tan(fovRad * 0.5);
        const aspect = Number(cam.aspect) || ((sc?.baseViewportWidth || 1) / Math.max(1, (sc?.baseViewportHeight || 1)));
        const halfW = halfH * aspect;
        vMinX = cam.position.x - halfW;
        vMaxX = cam.position.x + halfW;
        vMinY = cam.position.y - halfH;
        vMaxY = cam.position.y + halfH;
      }
    }
    this._composeMaterial.uniforms.uViewBounds.value.set(vMinX, vMinY, vMaxX, vMaxY);
    this._composeMaterial.uniforms.uSceneBounds.value.set(sceneX, sceneY, sceneW, sceneH);
    const dims = canvas?.dimensions;
    if (dims && Number.isFinite(dims.width) && Number.isFinite(dims.height)) {
      this._composeMaterial.uniforms.uSceneDimensions.value.set(dims.width, dims.height);
    }

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

  /**
   * Set outdoors mask texture for optional AO gating.
   * @param {THREE.Texture|null} texture
   */
  setOutdoorsMask(texture) {
    this._outdoorsMask = texture ?? null;
    if (!this._composeMaterial) return;
    const u = this._composeMaterial.uniforms;
    u.uOutdoorsMask.value = this._outdoorsMask;
    u.uHasOutdoorsMask.value = this._outdoorsMask ? 1.0 : 0.0;
  }
}
