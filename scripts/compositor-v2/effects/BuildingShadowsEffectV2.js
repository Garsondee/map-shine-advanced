/**
 * @fileoverview Building Shadows Effect V2
 *
 * Builds a directional projected shadow field from the dark regions of _Outdoors
 * masks (indoors/buildings), then feeds a scene-space shadow-factor texture to
 * LightingEffectV2.
 *
 * HEALTH-WIRING BADGE (Map Shine Breaker Box):
 * If you change `shadowTarget` / `_strengthTarget` lifecycle, render cadence, or
 * LightingEffectV2 uniform wiring, you MUST update HealthEvaluator contracts for
 * `BuildingShadowsEffectV2` and the edge into `LightingEffectV2` to prevent silent failures.
 *
 * Multi-level behavior:
 * - Combines the active floor + all floors above it into one shadow field.
 * - As perspective moves upward, lower floors are excluded.
 * - Falls back to the active floor outdoors mask when no floor-stack data exists
 *   (single-level maps / non-level scenes).
 *
 * @module compositor-v2/effects/BuildingShadowsEffectV2
 *
 * Canvas padding: this pass renders scene-sized RTs (mask space), not full canvas.
 * Do not clip with `canvas.dimensions.sceneRect` offsets here — that mixes spaces.
 * {@link LightingEffectV2} already gates `tBuildingShadow` with `inSceneBounds`.
 */

import { createLogger } from '../../core/log.js';
import { weatherController } from '../../core/WeatherController.js';
import { resolveCompositorOutdoorsTexture } from '../../masks/resolve-compositor-outdoors.js';

const log = createLogger('BuildingShadowsEffectV2');

/**
 * Building shadows ray-march the full outdoors mask per pixel. Uncapped RT size
 * follows mask native resolution (often scene-sized, 4k–8k+); that tanks FPS on mid GPUs.
 */
const MAX_BUILDING_SHADOW_EDGE_PX = 2560;

export class BuildingShadowsEffectV2 {
  constructor() {
    this.params = {
      enabled: true,
      opacity: 0.5,
      length: 0.1,
      softness: 4,
      smear: 0.33,
      resolutionScale: 1,
      penumbra: 1,
      shadowCurve: 1.6,
      blurRadius: 4,
      sunLatitude: 0.1,
      dynamicLightShadowOverrideEnabled: true,
      dynamicLightShadowOverrideStrength: 0.7,
    };

    /** @type {THREE.WebGLRenderer|null} */
    this.renderer = null;
    /** @type {THREE.Camera|null} */
    this.mainCamera = null;

    /** @type {THREE.WebGLRenderTarget|null} Max-composited building shadow strength (0..1) */
    this._strengthTarget = null;
    /** @type {THREE.WebGLRenderTarget|null} Lighting-facing factor texture (1=lit, 0=shadowed) */
    this.shadowTarget = null;
    /** @type {THREE.WebGLRenderTarget|null} Temp target for separable blur */
    this._blurTarget = null;

    /** @type {THREE.Scene|null} */
    this._scene = null;
    /** @type {THREE.OrthographicCamera|null} */
    this._camera = null;
    /** @type {THREE.Mesh|null} */
    this._quad = null;
    /** @type {THREE.ShaderMaterial|null} */
    this._projectMaterial = null;
    /** @type {THREE.ShaderMaterial|null} */
    this._invertMaterial = null;
    /** @type {THREE.ShaderMaterial|null} */
    this._blurMaterial = null;

    /** @type {THREE.Vector2|null} */
    this.sunDir = null;
    /** @type {THREE.Vector2|null} */
    this._tempSize = null;

    /** @type {THREE.Texture|null} Latest outdoors mask from FloorCompositor sync */
    this._outdoorsMask = null;

    /** @type {boolean} One-shot debug guard for empty-floor diagnostics */
    this._loggedNoMaskOnce = false;

    this._sunAzimuthDeg = null;
    this._sunElevationDeg = null;
    this._dynamicLightOverride = null;

    /** @type {Promise<void>|null} Background floor-mask warmup in flight */
    this._floorPreloadPromise = null;
    /** @type {number} Last warmup attempt timestamp (ms) */
    this._lastFloorPreloadAttemptMs = 0;

    /** @type {object|null} Last-frame diagnostics for Breaker Box / health */
    this._healthDiagnostics = null;

    /** @type {string[]|null} Cached {@link #_computeSourceFloorKeys} result */
    this._floorKeysCache = null;
    /** @type {string} Signature when {@link #_floorKeysCache} remains valid */
    this._floorKeysSigCache = '';
  }

  /**
   * Snapshot for health / Breaker Box (updated each render when compositor ran).
   * @returns {object|null}
   */
  getHealthDiagnostics() {
    const d = this._healthDiagnostics;
    if (!d) return null;
    return {
      ...d,
      floorKeys: [...(d.floorKeys || [])],
    };
  }

  static getControlSchema() {
    return {
      enabled: true,
      groups: [
        {
          name: 'main',
          label: 'Building Shadows',
          type: 'inline',
          parameters: ['opacity', 'length', 'softness', 'smear', 'resolutionScale', 'penumbra', 'shadowCurve', 'blurRadius']
        }
      ],
      parameters: {
        opacity: {
          type: 'slider',
          label: 'Opacity',
          min: 0.0,
          max: 1.0,
          step: 0.01,
          default: 0.5
        },
        length: {
          type: 'slider',
          label: 'Length',
          min: 0.0,
          max: 0.6,
          step: 0.005,
          default: 0.1
        },
        softness: {
          type: 'slider',
          label: 'Softness',
          min: 0.5,
          max: 8.0,
          step: 0.1,
          default: 4
        },
        smear: {
          type: 'slider',
          label: 'Smear',
          min: 0.0,
          max: 1.0,
          step: 0.01,
          default: 0.33
        },
        resolutionScale: {
          type: 'slider',
          label: 'Resolution',
          min: 1.0,
          max: 2.0,
          step: 0.05,
          default: 1
        },
        penumbra: {
          type: 'slider',
          label: 'Penumbra',
          min: 0.0,
          max: 1.0,
          step: 0.01,
          default: 1
        },
        shadowCurve: {
          type: 'slider',
          label: 'Shadow Curve',
          min: 0.5,
          max: 1.6,
          step: 0.01,
          default: 1.6
        },
        blurRadius: {
          type: 'slider',
          label: 'Blur',
          min: 0.0,
          max: 4.0,
          step: 0.05,
          default: 4
        }
      }
    };
  }

  get enabled() {
    return !!this.params.enabled;
  }

  set enabled(v) {
    this.params.enabled = !!v;
  }

  get shadowFactorTexture() {
    return this.shadowTarget?.texture || null;
  }

  /**
   * Direct outdoors mask feed from FloorCompositor.
   * Used as a fallback when per-floor compositor lookups are not ready yet.
   * @param {THREE.Texture|null} texture
   */
  setOutdoorsMask(texture) {
    this._outdoorsMask = texture ?? null;
  }

  initialize(renderer, camera) {
    const THREE = window.THREE;
    if (!THREE || !renderer) return;

    this.renderer = renderer;
    this.mainCamera = camera || null;
    this._tempSize = new THREE.Vector2();

    this._scene = new THREE.Scene();
    this._camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

    this._projectMaterial = new THREE.ShaderMaterial({
      uniforms: {
        uOutdoorsMask: { value: null },
        uHasMask: { value: 0.0 },
        uOutdoorsMaskFlipY: { value: 0.0 },
        uReceiverOutdoorsMask: { value: null },
        uHasReceiverMask: { value: 0.0 },
        uReceiverOutdoorsMaskFlipY: { value: 0.0 },
        uSunDir: { value: new THREE.Vector2(0, 1) },
        uLength: { value: this.params.length },
        uSoftness: { value: this.params.softness },
        uSmear: { value: this.params.smear },
        uPenumbra: { value: this.params.penumbra },
        uShadowCurve: { value: this.params.shadowCurve },
        uZoom: { value: 1.0 },
        uTexelSize: { value: new THREE.Vector2(1 / 1024, 1 / 1024) },
        uSceneDimensions: { value: new THREE.Vector2(1, 1) },
        tDynamicLight: { value: null },
        tWindowLight: { value: null },
        uHasDynamicLight: { value: 0.0 },
        uHasWindowLight: { value: 0.0 },
        uDynamicLightShadowOverrideEnabled: { value: 1.0 },
        uDynamicLightShadowOverrideStrength: { value: this.params.dynamicLightShadowOverrideStrength ?? 0.7 },
        uDynViewBounds: { value: new THREE.Vector4(0, 0, 1, 1) },
        uDynSceneDimensions: { value: new THREE.Vector2(1, 1) },
        uDynSceneRect: { value: new THREE.Vector4(0, 0, 1, 1) },
        uHasDynSceneRect: { value: 0.0 }
      },
      vertexShader: `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = vec4(position.xy, 0.0, 1.0);
        }
      `,
      fragmentShader: `
        uniform sampler2D uOutdoorsMask;
        uniform float uHasMask;
        uniform float uOutdoorsMaskFlipY;
        uniform sampler2D uReceiverOutdoorsMask;
        uniform float uHasReceiverMask;
        uniform float uReceiverOutdoorsMaskFlipY;
        uniform vec2 uSunDir;
        uniform float uLength;
        uniform float uSoftness;
        uniform float uSmear;
        uniform float uPenumbra;
        uniform float uShadowCurve;
        uniform float uZoom;
        uniform vec2 uTexelSize;
        uniform vec2 uSceneDimensions;
        uniform sampler2D tDynamicLight;
        uniform sampler2D tWindowLight;
        uniform float uHasDynamicLight;
        uniform float uHasWindowLight;
        uniform float uDynamicLightShadowOverrideEnabled;
        uniform float uDynamicLightShadowOverrideStrength;
        uniform vec4 uDynViewBounds;
        uniform vec2 uDynSceneDimensions;
        uniform vec4 uDynSceneRect;
        uniform float uHasDynSceneRect;
        varying vec2 vUv;

        float uvInBounds(vec2 uv) {
          vec2 safeMin = max(uTexelSize * 0.5, vec2(0.0));
          vec2 safeMax = min(vec2(1.0) - uTexelSize * 0.5, vec2(1.0));
          vec2 ge0 = step(safeMin, uv);
          vec2 le1 = step(uv, safeMax);
          return ge0.x * ge0.y * le1.x * le1.y;
        }

        float readOutdoorsMask(vec2 uv) {
          vec2 suv = clamp(uv, 0.0, 1.0);
          if (uOutdoorsMaskFlipY > 0.5) {
            suv.y = 1.0 - suv.y;
          }
          // Treat transparent texels as default outdoors (1.0). Some per-floor
          // masks are sparse and encode valid coverage in alpha.
          vec4 m = texture2D(uOutdoorsMask, suv);
          return clamp(mix(1.0, m.r, m.a), 0.0, 1.0);
        }

        float readReceiverOutdoorsMask(vec2 uv) {
          if (uHasReceiverMask < 0.5) return readOutdoorsMask(uv);
          vec2 suv = clamp(uv, 0.0, 1.0);
          if (uReceiverOutdoorsMaskFlipY > 0.5) {
            suv.y = 1.0 - suv.y;
          }
          vec4 m = texture2D(uReceiverOutdoorsMask, suv);
          return clamp(mix(1.0, m.r, m.a), 0.0, 1.0);
        }

        float sampleCasterIndoor(vec2 uv, float receiverOutdoorGate) {
          float valid = uvInBounds(uv);
          float casterOutdoors = readOutdoorsMask(uv);
          return (1.0 - casterOutdoors) * receiverOutdoorGate * valid;
        }

        vec2 sceneUvToDynScreenUv(vec2 sceneUv) {
          vec2 foundryPos = uDynSceneRect.xy + sceneUv * max(uDynSceneRect.zw, vec2(1e-5));
          vec2 threePos = vec2(foundryPos.x, uDynSceneDimensions.y - foundryPos.y);
          vec2 span = max(uDynViewBounds.zw - uDynViewBounds.xy, vec2(1e-5));
          return (threePos - uDynViewBounds.xy) / span;
        }

        void main() {
          if (uHasMask < 0.5) {
            gl_FragColor = vec4(0.0);
            return;
          }

          // This pass renders in scene/world UV space (not screen UV), so
          // projection distance must remain world-stable and NOT scale with
          // camera zoom. Scaling by zoom here causes visible shadow length
          // changes while zooming.
          vec2 dir = -normalize(uSunDir);
          float pxLen = uLength * 1400.0;
          vec2 maskTexel = uTexelSize;
          vec2 baseOffsetUv = dir * pxLen * maskTexel;

          // Use a continuous receiver outdoors gate from the active/view floor.
          // This avoids abrupt binary cut lines while still preventing indoor
          // receivers from being fully darkened by projected building shadow.
          float receiverOutdoors = readReceiverOutdoorsMask(vUv);
          float receiverOutdoorGate = clamp(receiverOutdoors, 0.0, 1.0);

          // Directional ray integration with lateral penumbra spread.
          // This replaces "stacked offset copies" with continuous transport along
          // the projected sun direction for smoother and more natural elongation.
          vec2 ortho = vec2(-dir.y, dir.x);
          float smearAmount = clamp(uSmear, 0.0, 1.0);
          float penumbraAmount = clamp(uPenumbra, 0.0, 1.0);
          float accum = 0.0;
          float weightSum = 0.0;
          float peakHit = 0.0;

          // 8 steps vs 12: ~35% less texture work in this hot pass (full-RT per floor).
          const int RAY_STEPS = 8;
          for (int i = 0; i < RAY_STEPS; i++) {
            float t = (float(i) + 0.5) / float(RAY_STEPS);
            // Spread toward far end for better long-shadow continuity.
            float spreadT = mix(t, t * t, 0.45 + 0.4 * smearAmount);
            vec2 centerUv = vUv + (baseOffsetUv * spreadT);

            float sigma = max(uSoftness, 0.5) * mix(0.8, 2.8, (t * t) + (0.5 * penumbraAmount * t));
            float lateral = sigma * maskTexel.x * mix(0.8, 1.6, penumbraAmount);
            float distanceFade = mix(1.0, 0.55, t);

            float c0 = sampleCasterIndoor(centerUv, receiverOutdoorGate);
            float c1 = sampleCasterIndoor(centerUv + ortho * lateral, receiverOutdoorGate);
            float c2 = sampleCasterIndoor(centerUv - ortho * lateral, receiverOutdoorGate);

            float stepHit = c0 * 0.5 + c1 * 0.25 + c2 * 0.25;
            peakHit = max(peakHit, stepHit);

            float stepWeight = mix(1.1, 0.7, t) * distanceFade;
            accum += stepHit * stepWeight;
            weightSum += stepWeight;
          }

          float integrated = (weightSum > 0.0) ? (accum / weightSum) : 0.0;
          float strength = mix(integrated, peakHit, 0.35 + 0.25 * smearAmount);
          strength = smoothstep(0.0, 1.0, clamp(strength, 0.0, 1.0));
          strength = pow(strength, max(uShadowCurve, 0.01));
          if ((uHasDynamicLight > 0.5 || uHasWindowLight > 0.5) && uDynamicLightShadowOverrideEnabled > 0.5 && uHasDynSceneRect > 0.5) {
            vec2 dynUv = clamp(sceneUvToDynScreenUv(vUv), vec2(0.0), vec2(1.0));
            float dynI = 0.0;
            if (uHasDynamicLight > 0.5) {
              vec3 dyn = texture2D(tDynamicLight, dynUv).rgb;
              dynI = max(dynI, clamp(max(dyn.r, max(dyn.g, dyn.b)), 0.0, 1.0));
            }
            if (uHasWindowLight > 0.5) {
              vec3 win = texture2D(tWindowLight, dynUv).rgb;
              dynI = max(dynI, clamp(max(win.r, max(win.g, win.b)), 0.0, 1.0));
            }
            float dynPresence = smoothstep(0.02, 0.30, dynI);
            float dynLift = clamp(dynPresence * max(uDynamicLightShadowOverrideStrength, 0.0), 0.0, 1.0);
            strength = mix(strength, 0.0, dynLift);
          }
          gl_FragColor = vec4(vec3(clamp(strength, 0.0, 1.0)), 1.0);
        }
      `,
      depthTest: false,
      depthWrite: false,
      transparent: false,
      blending: THREE.CustomBlending,
      blendEquation: THREE.MaxEquation,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneFactor,
      blendEquationAlpha: THREE.MaxEquation,
      blendSrcAlpha: THREE.OneFactor,
      blendDstAlpha: THREE.OneFactor,
    });
    this._projectMaterial.toneMapped = false;

    this._invertMaterial = new THREE.ShaderMaterial({
      uniforms: {
        tStrength: { value: null },
        uOpacity: { value: this.params.opacity }
      },
      vertexShader: `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = vec4(position.xy, 0.0, 1.0);
        }
      `,
      fragmentShader: `
        uniform sampler2D tStrength;
        uniform float uOpacity;
        varying vec2 vUv;

        void main() {
          float s = clamp(texture2D(tStrength, vUv).r, 0.0, 1.0);
          float factor = 1.0 - s * clamp(uOpacity, 0.0, 1.0);
          gl_FragColor = vec4(vec3(factor), 1.0);
        }
      `,
      depthTest: false,
      depthWrite: false,
      transparent: false,
      blending: THREE.NoBlending,
    });
    this._invertMaterial.toneMapped = false;

    this._blurMaterial = new THREE.ShaderMaterial({
      uniforms: {
        tInput: { value: null },
        uTexelSize: { value: new THREE.Vector2(1 / 1024, 1 / 1024) },
        uDirection: { value: new THREE.Vector2(1, 0) },
        uRadius: { value: this.params.blurRadius },
      },
      vertexShader: `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = vec4(position.xy, 0.0, 1.0);
        }
      `,
      fragmentShader: `
        uniform sampler2D tInput;
        uniform vec2 uTexelSize;
        uniform vec2 uDirection;
        uniform float uRadius;
        varying vec2 vUv;

        void main() {
          float r = clamp(uRadius, 0.0, 4.0);
          vec2 stepUv = uDirection * uTexelSize * r;

          // 9-tap separable Gaussian kernel.
          float w0 = 0.227027;
          float w1 = 0.1945946;
          float w2 = 0.1216216;
          float w3 = 0.054054;
          float w4 = 0.016216;

          float s = texture2D(tInput, vUv).r * w0;
          s += texture2D(tInput, vUv + stepUv * 1.0).r * w1;
          s += texture2D(tInput, vUv - stepUv * 1.0).r * w1;
          s += texture2D(tInput, vUv + stepUv * 2.0).r * w2;
          s += texture2D(tInput, vUv - stepUv * 2.0).r * w2;
          s += texture2D(tInput, vUv + stepUv * 3.0).r * w3;
          s += texture2D(tInput, vUv - stepUv * 3.0).r * w3;
          s += texture2D(tInput, vUv + stepUv * 4.0).r * w4;
          s += texture2D(tInput, vUv - stepUv * 4.0).r * w4;

          gl_FragColor = vec4(vec3(clamp(s, 0.0, 1.0)), 1.0);
        }
      `,
      depthTest: false,
      depthWrite: false,
      transparent: false,
      blending: THREE.NoBlending,
    });
    this._blurMaterial.toneMapped = false;

    this._quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this._projectMaterial);
    this._quad.frustumCulled = false;
    this._scene.add(this._quad);

    renderer.getDrawingBufferSize(this._tempSize);
    this.onResize(this._tempSize.x, this._tempSize.y);

    log.info('BuildingShadowsEffectV2 initialized');
  }

  onResize(width, height) {
    const THREE = window.THREE;
    if (!THREE || !width || !height) return;
    const rtSize = this._computeRenderTargetSize(width, height);
    const rtWidth = rtSize.x;
    const rtHeight = rtSize.y;

    if (!this._strengthTarget) {
      this._strengthTarget = new THREE.WebGLRenderTarget(rtWidth, rtHeight, {
        minFilter: THREE.LinearFilter,
        magFilter: THREE.LinearFilter,
        format: THREE.RGBAFormat,
        type: THREE.UnsignedByteType,
        depthBuffer: false,
        stencilBuffer: false,
      });
    } else {
      this._strengthTarget.setSize(rtWidth, rtHeight);
    }

    if (!this.shadowTarget) {
      this.shadowTarget = new THREE.WebGLRenderTarget(rtWidth, rtHeight, {
        minFilter: THREE.LinearFilter,
        magFilter: THREE.LinearFilter,
        format: THREE.RGBAFormat,
        type: THREE.UnsignedByteType,
        depthBuffer: false,
        stencilBuffer: false,
      });
    } else {
      this.shadowTarget.setSize(rtWidth, rtHeight);
    }

    if (!this._blurTarget) {
      this._blurTarget = new THREE.WebGLRenderTarget(rtWidth, rtHeight, {
        minFilter: THREE.LinearFilter,
        magFilter: THREE.LinearFilter,
        format: THREE.RGBAFormat,
        type: THREE.UnsignedByteType,
        depthBuffer: false,
        stencilBuffer: false,
      });
    } else {
      this._blurTarget.setSize(rtWidth, rtHeight);
    }

    if (this._projectMaterial?.uniforms?.uTexelSize) {
      this._projectMaterial.uniforms.uTexelSize.value.set(1 / rtWidth, 1 / rtHeight);
    }
    if (this._blurMaterial?.uniforms?.uTexelSize) {
      this._blurMaterial.uniforms.uTexelSize.value.set(1 / rtWidth, 1 / rtHeight);
    }

    this._clearShadowTargetToWhite(this.renderer);
  }

  update(_timeInfo) {
    if (!this._projectMaterial) return;

    this._updateSunDirection();

    const u = this._projectMaterial.uniforms;
    u.uLength.value = this.params.length;
    u.uSoftness.value = this.params.softness;
    u.uSmear.value = this.params.smear;
    u.uPenumbra.value = this.params.penumbra;
    u.uShadowCurve.value = this.params.shadowCurve;
    u.uZoom.value = this._getEffectiveZoom();
    if (this.sunDir) u.uSunDir.value.copy(this.sunDir);
    const dlo = this._dynamicLightOverride;
    const dynTex = dlo?.texture ?? null;
    const winTex = dlo?.windowTexture ?? null;
    if (u.tDynamicLight) u.tDynamicLight.value = dynTex;
    if (u.tWindowLight) u.tWindowLight.value = winTex;
    if (u.uHasDynamicLight) u.uHasDynamicLight.value = dynTex ? 1.0 : 0.0;
    if (u.uHasWindowLight) u.uHasWindowLight.value = winTex ? 1.0 : 0.0;
    if (u.uDynamicLightShadowOverrideEnabled) {
      u.uDynamicLightShadowOverrideEnabled.value = (this.params.dynamicLightShadowOverrideEnabled !== false && dlo?.enabled !== false) ? 1.0 : 0.0;
    }
    if (u.uDynamicLightShadowOverrideStrength) {
      const dynStrength = Number.isFinite(Number(dlo?.strength))
        ? Number(dlo.strength)
        : Number(this.params.dynamicLightShadowOverrideStrength ?? 0.7);
      u.uDynamicLightShadowOverrideStrength.value = Math.max(0.0, Math.min(1.0, dynStrength));
    }
    if (u.uDynViewBounds) {
      const vb = dlo?.viewBounds;
      if (vb && Number.isFinite(vb.x) && Number.isFinite(vb.y) && Number.isFinite(vb.z) && Number.isFinite(vb.w)) {
        u.uDynViewBounds.value.set(vb.x, vb.y, vb.z, vb.w);
      }
    }
    if (u.uDynSceneDimensions) {
      const sdim = dlo?.sceneDimensions;
      if (sdim && Number.isFinite(sdim.x) && Number.isFinite(sdim.y)) {
        u.uDynSceneDimensions.value.set(sdim.x, sdim.y);
      }
    }
    if (u.uDynSceneRect && u.uHasDynSceneRect) {
      const srect = dlo?.sceneRect;
      if (srect && Number.isFinite(srect.x) && Number.isFinite(srect.y) && Number.isFinite(srect.z) && Number.isFinite(srect.w)) {
        u.uDynSceneRect.value.set(srect.x, srect.y, srect.z, srect.w);
        u.uHasDynSceneRect.value = 1.0;
      } else {
        u.uHasDynSceneRect.value = 0.0;
      }
    }

    const dims = canvas?.dimensions;
    if (dims && u.uSceneDimensions) {
      const sw = dims.sceneWidth || dims.width || 1;
      const sh = dims.sceneHeight || dims.height || 1;
      u.uSceneDimensions.value.set(sw, sh);
    }

    if (this._invertMaterial?.uniforms?.uOpacity) {
      this._invertMaterial.uniforms.uOpacity.value = this.params.opacity;
    }
    if (this._blurMaterial?.uniforms?.uRadius) {
      this._blurMaterial.uniforms.uRadius.value = this.params.blurRadius;
    }
  }

  setSunAngles(azimuthDeg, elevationDeg) {
    this._sunAzimuthDeg = Number(azimuthDeg);
    this._sunElevationDeg = Number(elevationDeg);
  }

  setDynamicLightOverride(payload = null) {
    this._dynamicLightOverride = payload && typeof payload === 'object' ? payload : null;
  }

  /**
   * Align with {@link FloorCompositor#_resolveOutdoorsMask}: never use lowest-band ground
   * (or scene background bundle) as a stand-in _Outdoors source while viewing an upper
   * floor in a multi-floor stack — that masks the real upper-band mask and kills shadows.
   * @returns {boolean}
   */
  _skipGroundAndBundleFallbackForUpperMultiFloor() {
    let floorStackFloors = [];
    try {
      floorStackFloors = window.MapShine?.floorStack?.getFloors?.() ?? [];
    } catch (_) {
      floorStackFloors = [];
    }
    const af = window.MapShine?.floorStack?.getActiveFloor?.() ?? null;
    const idx = Number(af?.index);
    return floorStackFloors.length > 1 && Number.isFinite(idx) && idx > 0;
  }

  render(renderer, camera) {
    if (camera) this.mainCamera = camera;
    if (!renderer || !this._projectMaterial || !this._invertMaterial || !this._scene || !this._quad || !this.shadowTarget || !this._strengthTarget) {
      return;
    }

    if (!this.params.enabled) {
      this._healthDiagnostics = {
        timestamp: Date.now(),
        paramsEnabled: false,
        compositorPresent: false,
        drewAny: false,
        note: 'Building shadows disabled',
      };
      this._clearShadowTargetToWhite(renderer);
      return;
    }

    const sc = window.MapShine?.sceneComposer;
    const compositor = sc?._sceneMaskCompositor;
    if (!compositor) {
      this._healthDiagnostics = {
        timestamp: Date.now(),
        paramsEnabled: true,
        compositorPresent: false,
        drewAny: false,
        note: 'GpuSceneMaskCompositor missing',
      };
      this._clearShadowTargetToWhite(renderer);
      return;
    }

    const strictUpper = this._skipGroundAndBundleFallbackForUpperMultiFloor();
    const outdoorResolve = resolveCompositorOutdoorsTexture(
      compositor,
      window.MapShine?.activeLevelContext ?? null,
      {
        skipGroundFallback: strictUpper,
        allowBundleFallback: !strictUpper,
      },
    );

    const floorCount = Number(window.MapShine?.floorStack?.getFloors?.()?.length ?? 0);
    // Warmup schedules async preload + GPU work — only when we truly have no outdoors yet.
    if (!outdoorResolve.texture) {
      this._maybeWarmFloorMaskCache(compositor, floorCount);
    }

    const floorKeys = this._resolveSourceFloorKeys(compositor);
    // Multi-floor safety: never fall back to an ambiguous single outdoors texture
    // (often ground) when per-floor keys are unavailable; that causes cross-floor
    // leakage on upper floors. Single-floor scenes still use fallbackMask.
    const allowFallbackMask = floorCount <= 1;
    let fallbackMask = allowFallbackMask ? (this._outdoorsMask ?? null) : null;
    if (allowFallbackMask && !fallbackMask) {
      fallbackMask = outdoorResolve.texture ?? null;
    }

    // If using bundle fallback and no floor keys, inject 'bundle' as a synthetic key
    // so the render loop has something to iterate over. The loop will then use the
    // fallbackMask texture directly for drawing.
    if (floorKeys.length === 0 && fallbackMask && outdoorResolve.route === 'bundle') {
      floorKeys.push('bundle');
    }

    // NO OUTDOORS MASK FALLBACK: if absolutely no outdoors mask exists (not in GPU cache,
    // not in bundle, not ground), treat everything as outdoors and draw shadows everywhere.
    // This matches specular behavior where "no outdoors mask = full outdoors".
    if (floorKeys.length === 0 && !fallbackMask) {
      if (!this._loggedNoMaskOnce) {
        this._loggedNoMaskOnce = true;
        log.warn('BuildingShadowsEffectV2: no _Outdoors mask found anywhere (GPU cache, bundle, or ground). Treating everything as outdoors.');
      }
      // Use "full outdoors" mode - inject a synthetic key that tells the render loop
      // to draw shadows everywhere (white mask assumption)
      floorKeys.push('full-outdoors');
    }

    // Building shadow is a world/scene-space texture consumed by LightingEffectV2
    // via scene UV reconstruction. Do NOT size this RT to the current screen.
    // Match scene/mask space instead so sampling is stable and not view-dependent.
    const targetSize = this._resolveSceneTargetSize(compositor, floorKeys, fallbackMask);
    const rtSize = this._computeRenderTargetSize(targetSize.x, targetSize.y);
    if (this._strengthTarget.width !== rtSize.x || this._strengthTarget.height !== rtSize.y) {
      this.onResize(targetSize.x, targetSize.y);
    }

    this.update(null);

    const receiverMaskTex = this._resolveReceiverMaskTexture(compositor);
    if (this._projectMaterial?.uniforms) {
      this._projectMaterial.uniforms.uReceiverOutdoorsMask.value = receiverMaskTex;
      this._projectMaterial.uniforms.uHasReceiverMask.value = receiverMaskTex ? 1.0 : 0.0;
      this._projectMaterial.uniforms.uReceiverOutdoorsMaskFlipY.value = receiverMaskTex?.flipY ? 1.0 : 0.0;
    }

    const THREE = window.THREE;
    if (!THREE) return;

    const prevTarget = renderer.getRenderTarget();
    const prevAutoClear = renderer.autoClear;

    renderer.setRenderTarget(this._strengthTarget);
    renderer.setClearColor(0x000000, 1);
    renderer.clear();
    renderer.autoClear = false;

    this._quad.material = this._projectMaterial;
    let drewAny = false;
    let keyedDrew = false;
    for (const key of floorKeys) {
      if (key === 'full-outdoors') {
        // No outdoors mask exists - treat everything as outdoors (white mask)
        // Set hasMask to 0 so shader uses full outdoors assumption
        this._projectMaterial.uniforms.uOutdoorsMask.value = null;
        this._projectMaterial.uniforms.uHasMask.value = 0.0;
        this._projectMaterial.uniforms.uOutdoorsMaskFlipY.value = 0.0;
        renderer.render(this._scene, this._camera);
        drewAny = true;
        keyedDrew = true;
        continue;
      }
      // Handle synthetic 'bundle' key by using the fallbackMask directly
      const maskTex = key === 'bundle' ? fallbackMask : compositor.getFloorTexture(key, 'outdoors');
      if (!maskTex) continue;
      this._projectMaterial.uniforms.uOutdoorsMask.value = maskTex;
      this._projectMaterial.uniforms.uHasMask.value = 1.0;
      this._projectMaterial.uniforms.uOutdoorsMaskFlipY.value = maskTex?.flipY ? 1.0 : 0.0;
      renderer.render(this._scene, this._camera);
      drewAny = true;
      keyedDrew = true;
    }

    // Fallback: if keyed lookups weren't ready this frame, still project from the
    // direct outdoors texture feed so the effect doesn't disappear.
    if (!drewAny && fallbackMask) {
      this._projectMaterial.uniforms.uOutdoorsMask.value = fallbackMask;
      this._projectMaterial.uniforms.uHasMask.value = 1.0;
      this._projectMaterial.uniforms.uOutdoorsMaskFlipY.value = fallbackMask?.flipY ? 1.0 : 0.0;
      renderer.render(this._scene, this._camera);
      drewAny = true;
    }

    if (!drewAny) {
      // Last-resort fallback when keys exist but none resolve this frame.
      // Keep shadows active by treating missing mask as full-outdoors.
      this._projectMaterial.uniforms.uOutdoorsMask.value = null;
      this._projectMaterial.uniforms.uHasMask.value = 0.0;
      this._projectMaterial.uniforms.uOutdoorsMaskFlipY.value = 0.0;
      renderer.render(this._scene, this._camera);
      drewAny = true;
    }

    if (!drewAny) {
      this._healthDiagnostics = {
        timestamp: Date.now(),
        paramsEnabled: true,
        compositorPresent: true,
        floorKeys: [...floorKeys],
        floorKeyCount: floorKeys.length,
        syncOutdoorsMaskUuid: this._outdoorsMask?.uuid ?? null,
        fallbackUsed: false,
        outdoorsResolveRoute: outdoorResolve.route,
        outdoorsResolveKey: outdoorResolve.resolvedKey,
        drewAny: false,
        note: 'Keyed passes produced no draw (mask textures null?)',
      };
      this._clearShadowTargetToWhite(renderer);
      renderer.autoClear = prevAutoClear;
      renderer.setRenderTarget(prevTarget);
      return;
    }

    // Track if bundle fallback or full-outdoors fallback was used
    const usedBundleFallback = floorKeys.includes('bundle') || (outdoorResolve.route === 'bundle');
    const usedFullOutdoorsFallback = floorKeys.includes('full-outdoors');
    this._healthDiagnostics = {
      timestamp: Date.now(),
      paramsEnabled: true,
      compositorPresent: true,
      floorKeys: [...floorKeys],
      floorKeyCount: floorKeys.length,
      syncOutdoorsMaskUuid: this._outdoorsMask?.uuid ?? null,
      fallbackUsed: drewAny && !keyedDrew && !!fallbackMask,
      fallbackMaskUuid: (drewAny && !keyedDrew && fallbackMask) ? (fallbackMask?.uuid ?? null) : null,
      bundleFallbackUsed: usedBundleFallback,
      fullOutdoorsFallbackUsed: usedFullOutdoorsFallback,
      outdoorsResolveRoute: outdoorResolve.route,
      outdoorsResolveKey: outdoorResolve.resolvedKey,
      drewAny: true,
      receiverMaskUuid: receiverMaskTex?.uuid ?? null,
      shadowFactorTextureUuid: this.shadowTarget?.texture?.uuid ?? null,
      dynamicLightOverrideBound: !!(this._dynamicLightOverride?.texture || this._dynamicLightOverride?.windowTexture),
    };

    const blurRadius = Number(this.params.blurRadius ?? 0);
    const useBlur = !!this._blurMaterial && !!this._blurTarget && blurRadius > 0.01;
    let finalStrengthTex = this._strengthTarget.texture;

    if (useBlur) {
      this._quad.material = this._blurMaterial;
      this._blurMaterial.uniforms.tInput.value = this._strengthTarget.texture;
      this._blurMaterial.uniforms.uDirection.value.set(1, 0);
      renderer.setRenderTarget(this._blurTarget);
      renderer.setClearColor(0x000000, 1);
      renderer.clear();
      renderer.render(this._scene, this._camera);

      this._blurMaterial.uniforms.tInput.value = this._blurTarget.texture;
      this._blurMaterial.uniforms.uDirection.value.set(0, 1);
      renderer.setRenderTarget(this._strengthTarget);
      renderer.setClearColor(0x000000, 1);
      renderer.clear();
      renderer.render(this._scene, this._camera);
      finalStrengthTex = this._strengthTarget.texture;
    }

    this._quad.material = this._invertMaterial;
    this._invertMaterial.uniforms.tStrength.value = finalStrengthTex;
    renderer.setRenderTarget(this.shadowTarget);
    renderer.setClearColor(0xffffff, 1);
    renderer.clear();
    renderer.autoClear = true;
    renderer.render(this._scene, this._camera);

    renderer.autoClear = prevAutoClear;
    renderer.setRenderTarget(prevTarget);
  }

  /**
   * @param {object} compositor
   * @returns {string}
   */
  _floorKeysSignature(compositor) {
    const ctx = window.MapShine?.activeLevelContext ?? null;
    const ak = (ctx && Number.isFinite(Number(ctx.bottom)) && Number.isFinite(Number(ctx.top)))
      ? `${ctx.bottom}:${ctx.top}`
      : '';
    const floors = window.MapShine?.floorStack?.getFloors?.() ?? [];
    const af = window.MapShine?.floorStack?.getActiveFloor?.() ?? null;
    const floorPart = floors.map((f) => `${f?.index ?? ''}:${f?.compositorKey ?? ''}`).join('|');
    const metaN = compositor?._floorMeta?.size ?? 0;
    const cacheN = compositor?._floorCache?.size ?? 0;
    return `${ak}#${floors.length}#${af?.index ?? ''}#${af?.compositorKey ?? ''}#m${metaN}c${cacheN}`;
  }

  /**
   * Cached wrapper — cold path scans every _floorMeta key each frame (expensive).
   */
  _resolveSourceFloorKeys(compositor) {
    const sig = this._floorKeysSignature(compositor);
    if (this._floorKeysCache && sig === this._floorKeysSigCache) {
      return this._floorKeysCache;
    }
    const keys = this._computeSourceFloorKeys(compositor);
    this._floorKeysSigCache = sig;
    this._floorKeysCache = keys;
    return keys;
  }

  /**
   * Active floor index comes from `floorStack` (and active-level key fallback) —
   * same inputs as `createLightingPerspectiveContext()` in `LightingPerspectiveContext.js`.
   * `FloorCompositor` refreshes that snapshot at frame start before this pass runs.
   */
  _computeSourceFloorKeys(compositor) {
    const ctx = window.MapShine?.activeLevelContext ?? null;
    const activeKey = (ctx && Number.isFinite(Number(ctx.bottom)) && Number.isFinite(Number(ctx.top)))
      ? `${ctx.bottom}:${ctx.top}`
      : null;
    const activeBottom = Number(ctx?.bottom);

    // Compositor cache keys with textures available this frame.
    const cachedEntries = [];
    try {
      const floorMeta = compositor?._floorMeta;
      if (floorMeta && typeof floorMeta.entries === 'function') {
        for (const [key] of floorMeta.entries()) {
          const parts = String(key).split(':');
          const b = Number(parts[0]);
          const t = Number(parts[1]);
          if (!Number.isFinite(b) || !Number.isFinite(t)) continue;
          if (!compositor.getFloorTexture(key, 'outdoors')) continue;
          cachedEntries.push({ key, bottom: b, top: t });
        }
      }
    } catch (_) {}

    const floorStack = window.MapShine?.floorStack;
    const activeFloor = floorStack?.getActiveFloor?.() ?? null;
    const activeIdx = Number.isFinite(activeFloor?.index)
      ? Number(activeFloor.index)
      : null;

    const keys = [];
    const seen = new Set();
    const pushKey = (key) => {
      if (!key || seen.has(key)) return;
      if (!compositor.getFloorTexture(key, 'outdoors')) return;
      seen.add(key);
      keys.push(key);
    };

    const floors = floorStack?.getFloors?.() ?? [];
    let resolvedActiveIdx = activeIdx;
    if (Array.isArray(floors) && floors.length > 0) {
      if (!Number.isFinite(resolvedActiveIdx) && activeKey) {
        const match = floors.find((floor) => {
          const b = Number(floor?.elevationMin);
          const t = Number(floor?.elevationMax);
          return Number.isFinite(b) && Number.isFinite(t) && `${b}:${t}` === activeKey;
        });
        if (Number.isFinite(match?.index)) resolvedActiveIdx = Number(match.index);
      }
    }
    if (!Number.isFinite(resolvedActiveIdx)) {
      resolvedActiveIdx = 0;
    }

    const skipGroundGlobalFallback = floors.length > 1
      && Number.isFinite(resolvedActiveIdx)
      && resolvedActiveIdx > 0;

    if (Array.isArray(floors) && floors.length > 0) {
      for (const floor of floors) {
        if (!Number.isFinite(floor?.index) || floor.index < resolvedActiveIdx) continue;
        const ck = floor?.compositorKey != null ? String(floor.compositorKey) : '';
        if (ck) pushKey(ck);
        const b = Number(floor?.elevationMin);
        const t = Number(floor?.elevationMax);
        if (Number.isFinite(b) && Number.isFinite(t)) {
          pushKey(`${b}:${t}`);
        }
      }
    }

    if (keys.length === 0 && activeFloor) {
      if (activeFloor.compositorKey) pushKey(String(activeFloor.compositorKey));
      const b = Number(activeFloor?.elevationMin);
      const t = Number(activeFloor?.elevationMax);
      if (Number.isFinite(b) && Number.isFinite(t)) {
        pushKey(`${b}:${t}`);
      }
    }

    // Single-level / no-floor-stack fallback: use active context band if available.
    if (keys.length === 0 && activeKey) {
      pushKey(activeKey);
    }

    // If floor-stack selection produced no valid keyed textures yet, prefer
    // compositor cache filtered by the active level band BEFORE 'ground'.
    // Otherwise pushKey('ground') often succeeds first while upper-floor keys
    // are still warming, and we never reach this path — ground shadows leak
    // onto upper floors.
    if (keys.length === 0 && cachedEntries.length > 0) {
      cachedEntries.sort((a, b) => a.bottom - b.bottom);
      if (Number.isFinite(activeBottom)) {
        const filtered = cachedEntries
          .filter((entry) => entry.bottom >= activeBottom)
          .map((entry) => entry.key);
        if (filtered.length > 0) return filtered;
      }
      if (floors.length <= 1 || resolvedActiveIdx <= 0) {
        return cachedEntries.map((entry) => entry.key);
      }
    }

    // Non-level fallback used by some scenes. Never use ground alone for an
    // upper floor in a multi-floor stack — that projects the wrong silhouette.
    if (keys.length === 0 && (floors.length <= 1 || resolvedActiveIdx <= 0)) {
      pushKey('ground');
    }

    // Unified resolver: sibling / extra keys only — never ground (or background bundle)
    // on upper multi-floor; that yields floorKeys ["0:20"] while active is 20:30 and
    // wipes correct upper-band building shadows until GPU meta repopulates.
    if (keys.length === 0 && compositor) {
      const r = resolveCompositorOutdoorsTexture(
        compositor,
        window.MapShine?.activeLevelContext ?? null,
        {
          skipGroundFallback: skipGroundGlobalFallback,
          allowBundleFallback: !skipGroundGlobalFallback,
        },
      );
      if (r.resolvedKey && r.texture) {
        pushKey(r.resolvedKey);
      }
    }

    // EMERGENCY FALLBACK: if we STILL have no keys but the level context is valid,
    // force-try the active context band even if getFloorTexture currently fails.
    // This handles cases where FloorStack and LevelContext disagree (e.g., 0:10 vs 20:20).
    if (keys.length === 0 && activeKey && compositor) {
      if (!this._loggedEmergencyFallbackOnce) {
        this._loggedEmergencyFallbackOnce = true;
        log.warn('BuildingShadowsEffectV2: emergency fallback - using active context band directly', {
          activeKey,
          floorStackBand: activeFloor ? `${activeFloor.elevationMin}:${activeFloor.elevationMax}` : null,
          metaKeys: cachedEntries.map((e) => e.key),
        });
      }
      // Force-add the key without checking getFloorTexture - the render loop
      // will try to fetch it and fallback to direct resolver if needed
      if (!seen.has(activeKey)) {
        seen.add(activeKey);
        keys.push(activeKey);
      }
    }

    return keys;
  }

  /**
   * When {@link #setOutdoorsMask} / FloorCompositor sync has not populated `_outdoorsMask`
   * yet, still resolve _Outdoors from GpuSceneMaskCompositor using the same key order as
   * FloorCompositor._resolveOutdoorsMask (single-floor / missed-sync safety).
   * @param {object} compositor
   * @returns {import('three').Texture|null}
   * @private
   */
  _resolveCompositorOutdoorsDirect(compositor) {
    if (!compositor) return null;
    const strictUpper = this._skipGroundAndBundleFallbackForUpperMultiFloor();
    const r = resolveCompositorOutdoorsTexture(
      compositor,
      window.MapShine?.activeLevelContext ?? null,
      {
        skipGroundFallback: strictUpper,
        allowBundleFallback: !strictUpper,
      },
    );
    return r.texture ?? null;
  }

  _resolveReceiverMaskTexture(compositor) {
    if (!compositor) return this._outdoorsMask ?? null;

    const floorStackFloors = window.MapShine?.floorStack?.getFloors?.() ?? [];
    const activeFloorForMask = window.MapShine?.floorStack?.getActiveFloor?.() ?? null;
    const activeIdxForMask = Number(activeFloorForMask?.index);
    const skipGroundGlobalFallback = floorStackFloors.length > 1
      && Number.isFinite(activeIdxForMask)
      && activeIdxForMask > 0;

    const r = resolveCompositorOutdoorsTexture(
      compositor,
      window.MapShine?.activeLevelContext ?? null,
      { skipGroundFallback: skipGroundGlobalFallback, allowBundleFallback: false },
    );
    if (r.texture) return r.texture;

    // Fractional band vs integer compositor keys (FloorCompositor fire path). Include
    // _floorMeta keys — _floorCache can be empty while file/bundle masks live in meta only.
    const ctx = window.MapShine?.activeLevelContext ?? null;
    const b = Number.isFinite(Number(activeFloorForMask?.elevationMin))
      ? Number(activeFloorForMask.elevationMin)
      : Number(ctx?.bottom);
    const t = Number.isFinite(Number(activeFloorForMask?.elevationMax))
      ? Number(activeFloorForMask.elevationMax)
      : Number(ctx?.top);
    if (Number.isFinite(b) && Number.isFinite(t)) {
      const mid = (b + t) * 0.5;
      const keySet = new Set([
        ...Array.from(compositor._floorCache?.keys?.() ?? []),
        ...Array.from(compositor._floorMeta?.keys?.() ?? []),
      ]);
      let bestKey = null;
      let bestDelta = Infinity;
      for (const key of keySet) {
        const parts = String(key).split(':');
        if (parts.length !== 2) continue;
        const kb = Number(parts[0]);
        const kt = Number(parts[1]);
        if (!Number.isFinite(kb) || !Number.isFinite(kt)) continue;
        if (mid < kb || mid > kt) continue;
        const delta = Math.abs(kb - b) + Math.abs(kt - t);
        if (delta < bestDelta) {
          bestDelta = delta;
          bestKey = key;
        }
      }
      if (bestKey) {
        const tex = compositor.getFloorTexture(bestKey, 'outdoors');
        if (tex) return tex;
      }
    }

    return this._outdoorsMask ?? null;
  }

  _maybeWarmFloorMaskCache(compositor, floorCount) {
    if (!compositor) return;
    if (this._floorPreloadPromise) return;

    // render() calls this every frame; preloadAllFloors used to bust _floorMeta on
    // single-band maps every time, forcing expensive composeFloor on each retry (~throttle ms).
    // At low FPS that still schedules full recomposites ~every few seconds and freezes the tab.
    if (floorCount <= 1) {
      try {
        const ctx = window.MapShine?.activeLevelContext;
        const b = Number(ctx?.bottom);
        const t = Number(ctx?.top);
        if (Number.isFinite(b) && Number.isFinite(t)) {
          const k = `${b}:${t}`;
          if (typeof compositor.hasSingleBandPreloadDone === 'function' && compositor.hasSingleBandPreloadDone(k)) {
            return;
          }
        }
      } catch (_) {}
    }

    const now = Date.now();
    const throttleMs = floorCount <= 1 ? 3500 : 1000;
    if ((now - this._lastFloorPreloadAttemptMs) < throttleMs) return;
    this._lastFloorPreloadAttemptMs = now;

    const scene = canvas?.scene ?? null;
    if (!scene || typeof compositor.preloadAllFloors !== 'function') return;

    const activeLevelContext = window.MapShine?.activeLevelContext ?? null;
    const lastMaskBasePath = compositor?._activeFloorBasePath ?? null;

    this._floorPreloadPromise = compositor.preloadAllFloors(scene, {
      activeLevelContext,
      lastMaskBasePath,
    })
      .catch((err) => {
        log.debug('BuildingShadowsEffectV2: preloadAllFloors warmup failed', err);
      })
      .finally(() => {
        this._floorPreloadPromise = null;
      });
  }

  /**
   * Resolve scene-space target size for building shadow RTs.
   * Prefers outdoors mask texture dimensions (already scene-space composed),
   * falls back to scene rect dimensions.
   * @private
   */
  _resolveSceneTargetSize(compositor, floorKeys, fallbackMask) {
    const fromTex = (tex) => {
      const w = Number(tex?.image?.width ?? tex?.source?.data?.width ?? tex?.source?.width ?? 0);
      const h = Number(tex?.image?.height ?? tex?.source?.data?.height ?? tex?.source?.height ?? 0);
      if (Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0) {
        return { x: Math.max(1, Math.round(w)), y: Math.max(1, Math.round(h)) };
      }
      return null;
    };

    for (const key of floorKeys || []) {
      const tex = compositor?.getFloorTexture?.(key, 'outdoors') ?? null;
      const sz = fromTex(tex);
      if (sz) return sz;
    }

    const fallbackSize = fromTex(fallbackMask);
    if (fallbackSize) return fallbackSize;

    const rect = canvas?.dimensions?.sceneRect;
    const sw = Number(rect?.width ?? canvas?.dimensions?.sceneWidth ?? canvas?.dimensions?.width ?? 1);
    const sh = Number(rect?.height ?? canvas?.dimensions?.sceneHeight ?? canvas?.dimensions?.height ?? 1);
    return {
      x: Math.max(1, Math.round(sw)),
      y: Math.max(1, Math.round(sh)),
    };
  }

  _computeRenderTargetSize(width, height) {
    const scaleRaw = Number(this.params?.resolutionScale ?? 1.0);
    const scale = Number.isFinite(scaleRaw) ? Math.min(2.0, Math.max(1.0, scaleRaw)) : 1.0;
    let x = Math.max(1, Math.round(width * scale));
    let y = Math.max(1, Math.round(height * scale));
    const maxE = Math.max(x, y);
    if (maxE > MAX_BUILDING_SHADOW_EDGE_PX) {
      const s = MAX_BUILDING_SHADOW_EDGE_PX / maxE;
      x = Math.max(1, Math.round(x * s));
      y = Math.max(1, Math.round(y * s));
    }
    return { x, y };
  }

  _getEffectiveZoom() {
    const sceneComposer = window.MapShine?.sceneComposer;
    if (sceneComposer?.currentZoom !== undefined) {
      return sceneComposer.currentZoom;
    }
    if (!this.mainCamera) return 1.0;
    if (this.mainCamera.isOrthographicCamera) return this.mainCamera.zoom || 1.0;
    const baseDist = 10000.0;
    const dist = this.mainCamera.position?.z || baseDist;
    return dist > 0.1 ? (baseDist / dist) : 1.0;
  }

  _updateSunDirection() {
    const THREE = window.THREE;
    if (!THREE) return;

    const lat = Math.max(0.0, Math.min(1.0, this.params.sunLatitude ?? 0.1));
    let x = 0.0;
    let y = -1.0 * lat;

    if (Number.isFinite(this._sunAzimuthDeg)) {
      const azimuthRad = this._sunAzimuthDeg * (Math.PI / 180.0);
      x = -Math.sin(azimuthRad);
      y = -Math.cos(azimuthRad) * lat;
    } else {
      let hour = 12.0;
      try {
        if (weatherController && typeof weatherController.timeOfDay === 'number') {
          hour = weatherController.timeOfDay;
        }
      } catch (_) {}
      // Full 24h azimuth orbit:
      // 12h (noon)   ->   0
      //  6h (sunrise)-> -PI/2
      // 18h (sunset) -> +PI/2
      //  0h/24h      -> -PI (same direction as +PI, continuous wrap)
      const t = (hour % 24.0) / 24.0;
      const azimuth = (t - 0.5) * (Math.PI * 2.0);
      x = -Math.sin(azimuth);
      y = -Math.cos(azimuth) * lat;
    }

    // Prevent zero-length vectors from reaching shader normalize() when latitude
    // is zero and azimuth crosses noon/midnight in full-orbit mode.
    const dirLenSq = (x * x) + (y * y);
    if (dirLenSq < 1e-8) {
      const prevX = Number(this.sunDir?.x);
      const prevY = Number(this.sunDir?.y);
      const prevLenSq = (prevX * prevX) + (prevY * prevY);
      if (Number.isFinite(prevLenSq) && prevLenSq > 1e-8) {
        x = prevX;
        y = prevY;
      } else {
        x = Math.cos(Number.isFinite(this._sunAzimuthDeg) ? (this._sunAzimuthDeg * (Math.PI / 180.0)) : 0.0) >= 0.0 ? -1.0 : 1.0;
        y = 0.0;
      }
    }

    if (!this.sunDir) this.sunDir = new THREE.Vector2(x, y);
    else this.sunDir.set(x, y);
  }

  _clearShadowTargetToWhite(renderer) {
    if (!renderer || !this.shadowTarget) return;
    const prevTarget = renderer.getRenderTarget();
    renderer.setRenderTarget(this.shadowTarget);
    renderer.setClearColor(0xffffff, 1);
    renderer.clear();
    renderer.setRenderTarget(prevTarget);
  }

  dispose() {
    this._healthDiagnostics = null;
    this._floorKeysCache = null;
    this._floorKeysSigCache = '';
    try { this._strengthTarget?.dispose(); } catch (_) {}
    try { this.shadowTarget?.dispose(); } catch (_) {}
    try { this._blurTarget?.dispose(); } catch (_) {}
    try { this._projectMaterial?.dispose(); } catch (_) {}
    try { this._invertMaterial?.dispose(); } catch (_) {}
    try { this._blurMaterial?.dispose(); } catch (_) {}
    try { this._quad?.geometry?.dispose(); } catch (_) {}

    this._strengthTarget = null;
    this.shadowTarget = null;
    this._blurTarget = null;
    this._projectMaterial = null;
    this._invertMaterial = null;
    this._blurMaterial = null;
    this._quad = null;
    this._scene = null;
    this._camera = null;

    log.info('BuildingShadowsEffectV2 disposed');
  }
}
