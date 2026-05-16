/**
 * @fileoverview Sky Reach Shadows Effect V2
 *
 * Projects directional shadows cast by **upper-floor `floorAlpha` silhouettes**
 * (the solid parts of upper floors) down onto the currently-viewed floor.
 *
 * Where {@link BuildingShadowsEffectV2} ray-marches the dark (indoor) regions
 * of `_Outdoors` masks for the active-and-above stack, this effect treats the
 * **opaque tile coverage of every floor strictly above the active floor** as
 * the shadow caster. A bridge on the middle floor casts a shadow on the ground
 * floor; a rooftop on the top floor casts a shadow on every floor below; holes
 * in upper-floor albedo let sunlight pass straight through.
 *
 * Output `shadowFactorTexture` matches {@link BuildingShadowsEffectV2}: scene-UV
 * space, R channel, `1 = fully lit`, `0 = fully shadowed`. {@link ShadowManagerV2}
 * folds it into `tCombinedShadow` next to the building/painted/overhead/cloud
 * factors so the existing roof/top-floor suppression gates apply.
 *
 * Also exposes `skyReachFactorTexture` — the **un-projected** composite of all
 * upper-floor `floorAlpha` masks. Useful for finer SkyColor masking later
 * (a non-directional gate on the area under a bridge), independent of the
 * already-available per-floor `skyReach` mask in {@link GpuSceneMaskCompositor}.
 *
 * HEALTH-WIRING BADGE (Map Shine Breaker Box):
 * If you change `shadowTarget` / `_strengthTarget` / `_compositeTarget` lifecycle,
 * render cadence, or ShadowManagerV2 / LightingEffectV2 uniform wiring, you MUST
 * update HealthEvaluator contracts for `SkyReachShadowsEffectV2` and the edge
 * into `ShadowManagerV2` / `LightingEffectV2` to prevent silent failures.
 *
 * Canvas padding: this pass renders scene-sized RTs (mask space), not full canvas.
 * Do not clip with `canvas.dimensions.sceneRect` offsets here — that mixes spaces.
 * ShadowManagerV2 already gates `tSkyReachShadow` with the same UV remap as
 * `tBuildingShadow`.
 *
 * @module compositor-v2/effects/SkyReachShadowsEffectV2
 */

import { createLogger } from '../../core/log.js';
import { weatherController } from '../../core/WeatherController.js';
import { loadTexture } from '../../assets/loader.js';

const log = createLogger('SkyReachShadowsEffectV2');

/**
 * Cap the projected RT size like {@link BuildingShadowsEffectV2}; ray-march cost
 * is proportional to RT pixels × steps × taps.
 */
const MAX_SKY_REACH_SHADOW_EDGE_PX = 2560;

export class SkyReachShadowsEffectV2 {
  constructor() {
    this.params = {
      enabled: true,
      opacity: 0.5,
      length: 0.1,
      softness: 8,
      smear: 1.0,
      resolutionScale: 1.25,
      penumbra: 1,
      shadowCurve: 0.81,
      blurRadius: 4,
      sunLatitude: 0.1,
      /**
       * Combine mode for the upper-floor `floorAlpha` composite:
       * - `'max'` (default): union of coverage — recommended for multi-floor since
       *   not every floor authors alpha (gives correct silhouettes).
       * - `'multiply'`: Π alpha (strict; gaps on any upper band weaken shadow).
       */
      upperFloorCombineMode: 'max',
      /**
       * When true, multiply the projected shadow by `(1 - activeFloorAlpha)` so
       * pixels of the active floor that are already covered by their own solid
       * tile don't get double-darkened. Off by default — looks more dramatic
       * with the shadow rolling under the bridge across both floors.
       */
      castInteriorReceiverOnly: false,
      dynamicLightShadowOverrideEnabled: true,
      dynamicLightShadowOverrideStrength: 0.7,
    };

    /** @type {THREE.WebGLRenderer|null} */
    this.renderer = null;
    /** @type {THREE.Camera|null} */
    this.mainCamera = null;

    /** @type {THREE.WebGLRenderTarget|null} Composited (union) upper-floor `floorAlpha` */
    this._compositeTarget = null;
    /** @type {THREE.WebGLRenderTarget|null} Max-blended ray-marched projection (0..1) */
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
    this._accumMaterial = null;
    /** @type {THREE.ShaderMaterial|null} */
    this._skyReachFallbackMaterial = null;
    /** @type {THREE.ShaderMaterial|null} */
    this._levelAlphaMaterial = null;
    /** @type {THREE.ShaderMaterial|null} */
    this._tileFootprintMaterial = null;
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

    this._sunAzimuthDeg = null;
    this._sunElevationDeg = null;
    this._dynamicLightOverride = null;

    /** @type {object|null} Last-frame diagnostics for Breaker Box / health */
    this._healthDiagnostics = null;

    /** @type {Promise<void>|null} Background floor-mask warmup in flight */
    this._floorPreloadPromise = null;
    /** @type {number} Last warmup attempt timestamp (ms) */
    this._lastFloorPreloadAttemptMs = 0;

    /**
     * Cache the upper-floor composite signature so we can skip the
     * accumulator pass when nothing has changed. Same trick as
     * `OverheadShadowsEffectV2._upperFloorCompositeLastSig`.
     */
    this._compositeLastSig = '';

    /** @type {boolean} One-shot debug guard */
    this._loggedNoUpperOnce = false;

    /** @type {Map<string, THREE.Texture|null>} */
    this._levelTextureCache = new Map();
    /** @type {Map<string, Promise<THREE.Texture|null>>} */
    this._levelTextureInflight = new Map();
  }

  getHealthDiagnostics() {
    const d = this._healthDiagnostics;
    if (!d) return null;
    return { ...d };
  }

  static getControlSchema() {
    return {
      enabled: true,
      groups: [
        {
          name: 'main',
          label: 'Sky Reach Shadows',
          type: 'inline',
          parameters: [
            'opacity',
            'length',
            'softness',
            'smear',
            'resolutionScale',
            'penumbra',
            'shadowCurve',
            'blurRadius',
            'upperFloorCombineMode',
            'castInteriorReceiverOnly',
          ],
        },
      ],
      parameters: {
        opacity: { type: 'slider', label: 'Opacity', min: 0.0, max: 1.0, step: 0.01, default: 0.5 },
        length: { type: 'slider', label: 'Length', min: 0.0, max: 0.6, step: 0.005, default: 0.1 },
        softness: { type: 'slider', label: 'Softness', min: 0.5, max: 8.0, step: 0.1, default: 8 },
        smear: { type: 'slider', label: 'Smear', min: 0.0, max: 1.0, step: 0.01, default: 1.0 },
        resolutionScale: { type: 'slider', label: 'Resolution', min: 1.0, max: 2.0, step: 0.05, default: 1.25 },
        penumbra: { type: 'slider', label: 'Penumbra', min: 0.0, max: 1.0, step: 0.01, default: 1 },
        shadowCurve: { type: 'slider', label: 'Shadow Curve', min: 0.5, max: 1.6, step: 0.01, default: 0.81 },
        blurRadius: { type: 'slider', label: 'Blur', min: 0.0, max: 4.0, step: 0.05, default: 4 },
        upperFloorCombineMode: {
          type: 'select',
          label: 'Upper-Floor Combine',
          options: {
            'Max (union)': 'max',
            'Multiply (strict)': 'multiply',
          },
          default: 'max',
        },
        castInteriorReceiverOnly: {
          type: 'boolean',
          label: 'Receiver: interior only',
          default: false,
        },
      },
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
   * Un-projected union of upper-floor `floorAlpha` (R channel). Exposed for
   * downstream consumers (e.g. SkyColorEffectV2) that want a non-directional
   * "what is above me" gate.
   * @returns {THREE.Texture|null}
   */
  get skyReachFactorTexture() {
    return this._compositeTarget?.texture || null;
  }

  initialize(renderer, camera) {
    const THREE = window.THREE;
    if (!THREE || !renderer) return;

    this.renderer = renderer;
    this.mainCamera = camera || null;
    this._tempSize = new THREE.Vector2();

    this._scene = new THREE.Scene();
    this._camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

    this._accumMaterial = new THREE.ShaderMaterial({
      uniforms: {
        tUpperAlpha: { value: null },
        uUpperAlphaFlipY: { value: 0.0 },
      },
      vertexShader: `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = vec4(position.xy, 0.0, 1.0);
        }
      `,
      fragmentShader: `
        uniform sampler2D tUpperAlpha;
        uniform float uUpperAlphaFlipY;
        varying vec2 vUv;
        void main() {
          vec2 suv = clamp(vUv, 0.0, 1.0);
          if (uUpperAlphaFlipY > 0.5) suv.y = 1.0 - suv.y;
          float a = clamp(texture2D(tUpperAlpha, suv).r, 0.0, 1.0);
          gl_FragColor = vec4(a, a, a, a);
        }
      `,
      depthTest: false,
      depthWrite: false,
      transparent: true,
    });
    this._accumMaterial.toneMapped = false;

    this._skyReachFallbackMaterial = new THREE.ShaderMaterial({
      uniforms: {
        tSkyReach: { value: null },
        tOutdoors: { value: null },
        uHasOutdoors: { value: 0.0 },
        uSkyReachFlipY: { value: 0.0 },
        uOutdoorsFlipY: { value: 0.0 },
      },
      vertexShader: `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = vec4(position.xy, 0.0, 1.0);
        }
      `,
      fragmentShader: `
        uniform sampler2D tSkyReach;
        uniform sampler2D tOutdoors;
        uniform float uHasOutdoors;
        uniform float uSkyReachFlipY;
        uniform float uOutdoorsFlipY;
        varying vec2 vUv;

        float readDataMask(sampler2D tex, vec2 uv, float flipY) {
          vec2 suv = clamp(uv, 0.0, 1.0);
          if (flipY > 0.5) suv.y = 1.0 - suv.y;
          vec4 m = texture2D(tex, suv);
          return clamp(mix(1.0, m.r, m.a), 0.0, 1.0);
        }

        void main() {
          float reach = readDataMask(tSkyReach, vUv, uSkyReachFlipY);
          float outdoors = uHasOutdoors > 0.5 ? readDataMask(tOutdoors, vUv, uOutdoorsFlipY) : 1.0;
          float outdoorValid = smoothstep(0.02, 0.12, outdoors);
          float overhead = 1.0 - clamp(reach / max(outdoors, 0.05), 0.0, 1.0);
          overhead *= outdoorValid;
          gl_FragColor = vec4(vec3(clamp(overhead, 0.0, 1.0)), 1.0);
        }
      `,
      depthTest: false,
      depthWrite: false,
      transparent: false,
      blending: THREE.NoBlending,
    });
    this._skyReachFallbackMaterial.toneMapped = false;

    this._levelAlphaMaterial = new THREE.ShaderMaterial({
      uniforms: {
        tLevelAlbedo: { value: null },
        uFlipY: { value: 0.0 },
      },
      vertexShader: `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = vec4(position.xy, 0.0, 1.0);
        }
      `,
      fragmentShader: `
        uniform sampler2D tLevelAlbedo;
        uniform float uFlipY;
        varying vec2 vUv;

        void main() {
          vec2 uv = clamp(vUv, 0.0, 1.0);
          if (uFlipY > 0.5) uv.y = 1.0 - uv.y;
          vec4 albedo = texture2D(tLevelAlbedo, uv);
          float a = clamp(albedo.a, 0.0, 1.0);
          gl_FragColor = vec4(vec3(a), a);
        }
      `,
      depthTest: false,
      depthWrite: false,
      transparent: true,
      blending: THREE.CustomBlending,
      blendEquation: THREE.MaxEquation,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneFactor,
      blendEquationAlpha: THREE.MaxEquation,
      blendSrcAlpha: THREE.OneFactor,
      blendDstAlpha: THREE.OneFactor,
    });
    this._levelAlphaMaterial.toneMapped = false;

    this._tileFootprintMaterial = new THREE.ShaderMaterial({
      uniforms: {
        uTileRect: { value: new THREE.Vector4(0, 0, 1, 1) },
        uScaleSign: { value: new THREE.Vector2(1, 1) },
        uRotation: { value: 0.0 },
      },
      vertexShader: `
        varying vec2 vTileUv;
        uniform vec4 uTileRect;
        uniform vec2 uScaleSign;
        uniform float uRotation;

        void main() {
          vec2 sceneUv = position.xy * 0.5 + 0.5;
          vec2 tileUv = (sceneUv - uTileRect.xy) / max(uTileRect.zw, vec2(1e-5));
          vec2 centered = tileUv - 0.5;
          float c = cos(-uRotation);
          float s = sin(-uRotation);
          centered = vec2(
            centered.x * c - centered.y * s,
            centered.x * s + centered.y * c
          );
          tileUv = centered + 0.5;
          if (uScaleSign.x < 0.0) tileUv.x = 1.0 - tileUv.x;
          if (uScaleSign.y < 0.0) tileUv.y = 1.0 - tileUv.y;
          vTileUv = tileUv;
          gl_Position = vec4(position.xy, 0.0, 1.0);
        }
      `,
      fragmentShader: `
        varying vec2 vTileUv;
        void main() {
          if (vTileUv.x < 0.0 || vTileUv.x > 1.0 || vTileUv.y < 0.0 || vTileUv.y > 1.0) {
            discard;
          }
          gl_FragColor = vec4(1.0);
        }
      `,
      depthTest: false,
      depthWrite: false,
      transparent: true,
      blending: THREE.CustomBlending,
      blendEquation: THREE.MaxEquation,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneFactor,
      blendEquationAlpha: THREE.MaxEquation,
      blendSrcAlpha: THREE.OneFactor,
      blendDstAlpha: THREE.OneFactor,
    });
    this._tileFootprintMaterial.toneMapped = false;

    this._projectMaterial = new THREE.ShaderMaterial({
      uniforms: {
        uCasterMask: { value: null },
        uHasCaster: { value: 0.0 },
        uActiveFloorAlpha: { value: null },
        uHasActiveFloorAlpha: { value: 0.0 },
        uActiveFloorAlphaFlipY: { value: 0.0 },
        uCastInteriorOnly: { value: 0.0 },
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
        uHasDynSceneRect: { value: 0.0 },
      },
      vertexShader: `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = vec4(position.xy, 0.0, 1.0);
        }
      `,
      fragmentShader: `
        uniform sampler2D uCasterMask;
        uniform float uHasCaster;
        uniform sampler2D uActiveFloorAlpha;
        uniform float uHasActiveFloorAlpha;
        uniform float uActiveFloorAlphaFlipY;
        uniform float uCastInteriorOnly;
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

        // Caster = union/product of upper-floor floorAlpha (R channel, alpha-extracted).
        // No alpha-aware "no data → 1.0" remap: floorAlpha is authored as
        // (alpha, alpha, alpha, alpha) by the accumulator pass, so .r is the value.
        float readCasterAlpha(vec2 uv) {
          vec2 suv = clamp(uv, 0.0, 1.0);
          return clamp(texture2D(uCasterMask, suv).r, 0.0, 1.0);
        }

        float sampleCaster(vec2 uv) {
          float valid = uvInBounds(uv);
          return readCasterAlpha(uv) * valid;
        }

        vec2 sceneUvToDynScreenUv(vec2 sceneUv) {
          vec2 foundryPos = uDynSceneRect.xy + sceneUv * max(uDynSceneRect.zw, vec2(1e-5));
          vec2 threePos = vec2(foundryPos.x, uDynSceneDimensions.y - foundryPos.y);
          vec2 span = max(uDynViewBounds.zw - uDynViewBounds.xy, vec2(1e-5));
          return (threePos - uDynViewBounds.xy) / span;
        }

        void main() {
          if (uHasCaster < 0.5) {
            gl_FragColor = vec4(0.0);
            return;
          }

          // Scene/world UV space — projection distance is world-stable and
          // must NOT scale with camera zoom (same convention as
          // BuildingShadowsEffectV2 to avoid shadow length changing while zooming).
          vec2 dir = -normalize(uSunDir);
          float pxLen = uLength * 1400.0;
          vec2 maskTexel = uTexelSize;
          vec2 baseOffsetUv = dir * pxLen * maskTexel;

          vec2 ortho = vec2(-dir.y, dir.x);
          float smearAmount = clamp(uSmear, 0.0, 1.0);
          float penumbraAmount = clamp(uPenumbra, 0.0, 1.0);
          float accum = 0.0;
          float weightSum = 0.0;
          float peakHit = 0.0;

          // Match BuildingShadowsEffectV2: 8 directional steps.
          const int RAY_STEPS = 8;
          for (int i = 0; i < RAY_STEPS; i++) {
            float t = (float(i) + 0.5) / float(RAY_STEPS);
            float spreadT = mix(t, t * t, 0.45 + 0.4 * smearAmount);
            vec2 centerUv = vUv + (baseOffsetUv * spreadT);

            float sigma = max(uSoftness, 0.5) * mix(0.8, 2.8, (t * t) + (0.5 * penumbraAmount * t));
            float lateral = sigma * maskTexel.x * mix(0.8, 1.6, penumbraAmount);
            float distanceFade = mix(1.0, 0.55, t);

            float c0 = sampleCaster(centerUv);
            float c1 = sampleCaster(centerUv + ortho * lateral);
            float c2 = sampleCaster(centerUv - ortho * lateral);

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

          // Optional receiver gate: don't double-darken the active floor's own
          // solid tiles. When uCastInteriorOnly = 0, every receiver pixel is
          // eligible — this is the "shadow rolls under the bridge across the
          // active floor's own surface too" look the user described.
          if (uCastInteriorOnly > 0.5 && uHasActiveFloorAlpha > 0.5) {
            vec2 fuv = clamp(vUv, 0.0, 1.0);
            if (uActiveFloorAlphaFlipY > 0.5) fuv.y = 1.0 - fuv.y;
            float actAlpha = clamp(texture2D(uActiveFloorAlpha, fuv).r, 0.0, 1.0);
            strength *= clamp(1.0 - actAlpha, 0.0, 1.0);
          }

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
        uOpacity: { value: this.params.opacity },
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

    log.info('SkyReachShadowsEffectV2 initialized');
  }

  onResize(width, height) {
    const THREE = window.THREE;
    if (!THREE || !width || !height) return;
    const rtSize = this._computeRenderTargetSize(width, height);
    const rtWidth = rtSize.x;
    const rtHeight = rtSize.y;

    const ensureRT = (rt, name) => {
      if (rt) {
        rt.setSize(rtWidth, rtHeight);
        return rt;
      }
      const nrt = new THREE.WebGLRenderTarget(rtWidth, rtHeight, {
        minFilter: THREE.LinearFilter,
        magFilter: THREE.LinearFilter,
        format: THREE.RGBAFormat,
        type: THREE.UnsignedByteType,
        depthBuffer: false,
        stencilBuffer: false,
      });
      nrt.texture.name = name;
      nrt.texture.flipY = false;
      return nrt;
    };

    this._compositeTarget = ensureRT(this._compositeTarget, 'SkyReachShadow_composite');
    this._strengthTarget = ensureRT(this._strengthTarget, 'SkyReachShadow_strength');
    this.shadowTarget = ensureRT(this.shadowTarget, 'SkyReachShadow_factor');
    this._blurTarget = ensureRT(this._blurTarget, 'SkyReachShadow_blur');

    if (this._projectMaterial?.uniforms?.uTexelSize) {
      this._projectMaterial.uniforms.uTexelSize.value.set(1 / rtWidth, 1 / rtHeight);
    }
    if (this._blurMaterial?.uniforms?.uTexelSize) {
      this._blurMaterial.uniforms.uTexelSize.value.set(1 / rtWidth, 1 / rtHeight);
    }

    this._clearShadowTargetToWhite(this.renderer);

    // The composite RT is rendered with floorAlpha textures whose native
    // resolution may differ — onResize gives us a baseline that's resized
    // per-frame if needed via {@link #_resolveCompositeTargetSize}.
    this._compositeLastSig = '';
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
    u.uCastInteriorOnly.value = this.params.castInteriorReceiverOnly ? 1.0 : 0.0;
    if (this.sunDir) u.uSunDir.value.copy(this.sunDir);

    const dlo = this._dynamicLightOverride;
    const dynTex = dlo?.texture ?? null;
    const winTex = dlo?.windowTexture ?? null;
    if (u.tDynamicLight) u.tDynamicLight.value = dynTex;
    if (u.tWindowLight) u.tWindowLight.value = winTex;
    if (u.uHasDynamicLight) u.uHasDynamicLight.value = dynTex ? 1.0 : 0.0;
    if (u.uHasWindowLight) u.uHasWindowLight.value = winTex ? 1.0 : 0.0;
    if (u.uDynamicLightShadowOverrideEnabled) {
      u.uDynamicLightShadowOverrideEnabled.value =
        (this.params.dynamicLightShadowOverrideEnabled !== false && dlo?.enabled !== false) ? 1.0 : 0.0;
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
   * @returns {{
   *   textures: THREE.Texture[],
   *   activeFloorAlpha: (THREE.Texture|null),
   *   activeFloorIndex: number|null,
   *   receiverBaseIndex: number|null,
   *   casterKeys: string[],
   *   candidateKeys: string[],
   *   fallbackFloor: (object|null)
   * }}
   * @private
   */
  _collectUpperFloorAlphaTextures() {
    const compositor = window.MapShine?.sceneComposer?._sceneMaskCompositor;
    if (!compositor?.getFloorTexture) {
      return { textures: [], activeFloorAlpha: null, activeFloorIndex: null, receiverBaseIndex: null, casterKeys: [], fallbackFloor: null };
    }
    const floorStack = window.MapShine?.floorStack;
    const floors = floorStack?.getFloors?.() ?? [];
    const activeFloor = floorStack?.getActiveFloor?.() ?? null;
    const activeIdx = Number(activeFloor?.index);
    if (!Number.isFinite(activeIdx)) {
      return { textures: [], activeFloorAlpha: null, activeFloorIndex: null, receiverBaseIndex: null, casterKeys: [], candidateKeys: [], fallbackFloor: null };
    }

    const resolveFloorAlpha = (floor) => {
      if (!floor) return null;
      const ck = floor.compositorKey != null ? String(floor.compositorKey) : '';
      let tex = ck ? (compositor.getFloorTexture(ck, 'floorAlpha') ?? null) : null;
      if (!tex) {
        const b = Number(floor.elevationMin);
        const t = Number(floor.elevationMax);
        if (Number.isFinite(b) && Number.isFinite(t)) {
          tex = compositor.getFloorTexture(`${b}:${t}`, 'floorAlpha') ?? null;
        }
      }
      return tex;
    };

    // The visible stack can contain lower floors seen through alpha holes while
    // the active floor is the top/roof floor. In that common view, "floors above
    // active" is empty, but lower visible receivers still need every floor above
    // them to cast. Use the lowest visible receiver as the caster cutoff.
    let receiverBaseIdx = activeIdx;
    try {
      const visible = floorStack?.getVisibleFloors?.() ?? [];
      for (const f of visible) {
        const idx = Number(f?.index);
        if (Number.isFinite(idx)) receiverBaseIdx = Math.min(receiverBaseIdx, idx);
      }
    } catch (_) {}

    const upper = [];
    const casterKeys = [];
    const candidateKeys = [];
    const seenTextures = new Set();
    const pushTexture = (key, tex) => {
      if (!tex || seenTextures.has(tex.uuid ?? tex)) return;
      seenTextures.add(tex.uuid ?? tex);
      upper.push(tex);
      casterKeys.push(key);
    };
    for (const f of floors) {
      const idx = Number(f?.index);
      if (!Number.isFinite(idx) || idx <= receiverBaseIdx) continue;
      const candidateKey = f?.compositorKey != null ? String(f.compositorKey) : String(idx);
      candidateKeys.push(candidateKey);
      const tex = resolveFloorAlpha(f);
      pushTexture(candidateKey, tex);
    }

    // Fallback: scan compositor cache/meta directly. Some floor stacks use
    // display/index bands that don't exactly match compositor cache keys, while
    // getFloorTexture(key, 'floorAlpha') is still populated under numeric
    // "bottom:top" keys. Use the receiver bottom elevation as the cutoff.
    const fallbackFloor = floors.find((f) => Number(f?.index) === receiverBaseIdx) ?? activeFloor;
    const receiverBottom = Number(fallbackFloor?.elevationMin);
    const allKeys = new Set([
      ...Array.from(compositor?._floorCache?.keys?.() ?? []),
      ...Array.from(compositor?._floorMeta?.keys?.() ?? []),
    ]);
    for (const key of allKeys) {
      const parts = String(key).split(':');
      if (parts.length !== 2) continue;
      const kb = Number(parts[0]);
      if (!Number.isFinite(kb)) continue;
      if (Number.isFinite(receiverBottom) && !(kb > receiverBottom)) continue;
      if (!candidateKeys.includes(String(key))) candidateKeys.push(String(key));
      const tex = compositor.getFloorTexture(String(key), 'floorAlpha') ?? null;
      pushTexture(String(key), tex);
    }
    let fallbackSolidTileCount = 0;
    for (const tex of upper) {
      fallbackSolidTileCount += Number(tex?.userData?.floorAlphaFallbackSolidCount ?? 0) || 0;
    }
    const activeFloorAlpha = resolveFloorAlpha(activeFloor);
    return {
      textures: upper,
      activeFloorAlpha,
      activeFloorIndex: activeIdx,
      receiverBaseIndex: receiverBaseIdx,
      casterKeys,
      candidateKeys,
      fallbackSolidTileCount,
      fallbackFloor,
    };
  }

  _resolveFloorTexture(floor, maskType) {
    const compositor = window.MapShine?.sceneComposer?._sceneMaskCompositor;
    if (!compositor?.getFloorTexture) return null;
    const targetFloor = floor ?? window.MapShine?.floorStack?.getActiveFloor?.() ?? null;
    const ck = targetFloor?.compositorKey != null ? String(targetFloor.compositorKey) : '';
    if (ck) {
      const tex = compositor.getFloorTexture(ck, maskType) ?? null;
      if (tex) return tex;
    }
    const b = Number(targetFloor?.elevationMin);
    const t = Number(targetFloor?.elevationMax);
    if (Number.isFinite(b) && Number.isFinite(t)) {
      const direct = compositor.getFloorTexture(`${b}:${t}`, maskType) ?? null;
      if (direct) return direct;
    }
    if (Number.isFinite(b) && Number.isFinite(t)) {
      const mid = (b + t) * 0.5;
      const allKeys = new Set([
        ...Array.from(compositor?._floorCache?.keys?.() ?? []),
        ...Array.from(compositor?._floorMeta?.keys?.() ?? []),
      ]);
      let bestKey = null;
      let bestDelta = Infinity;
      for (const key of allKeys) {
        const parts = String(key).split(':');
        if (parts.length !== 2) continue;
        const kb = Number(parts[0]);
        const kt = Number(parts[1]);
        if (!Number.isFinite(kb) || !Number.isFinite(kt)) continue;
        if (mid < kb || mid > kt) continue;
        const delta = Math.abs(kb - b) + Math.abs(kt - t);
        if (delta < bestDelta) {
          bestDelta = delta;
          bestKey = String(key);
        }
      }
      if (bestKey) return compositor.getFloorTexture(bestKey, maskType) ?? null;
    }
    return null;
  }

  _collectUpperFloorTileCasters(receiverBaseIndex, candidateKeys = []) {
    const compositor = window.MapShine?.sceneComposer?._sceneMaskCompositor ?? null;
    const scene = canvas?.scene ?? null;
    const floorStack = window.MapShine?.floorStack;
    const floors = floorStack?.getFloors?.() ?? [];
    const bands = [];
    const seenBands = new Set();
    const pushBand = (key, bottom, top, levelId = null) => {
      const b = Number(bottom);
      const t = Number(top);
      if (!Number.isFinite(b) || !Number.isFinite(t)) return;
      const id = `${b}:${t}`;
      if (seenBands.has(id)) return;
      seenBands.add(id);
      bands.push({ key: key || id, bottom: b, top: t, levelId: levelId ?? null });
    };

    for (const f of floors) {
      const idx = Number(f?.index);
      if (!Number.isFinite(idx) || idx <= receiverBaseIndex) continue;
      pushBand(
        f?.compositorKey != null ? String(f.compositorKey) : '',
        f?.elevationMin,
        f?.elevationMax,
        f?.levelId ?? null,
      );
    }
    for (const key of candidateKeys || []) {
      const parts = String(key).split(':');
      if (parts.length !== 2) continue;
      pushBand(String(key), Number(parts[0]), Number(parts[1]));
    }

    const out = [];
    const seenTiles = new Set();
    const pushTile = (tileDoc, key) => {
      if (!tileDoc) return;
      const id = tileDoc.id ?? tileDoc._id ?? `${key}:${out.length}`;
      if (seenTiles.has(id)) return;
      seenTiles.add(id);
      out.push({ tileDoc, key });
    };

    for (const band of bands) {
      let entries = [];
      try {
        if (typeof compositor?._getActiveLevelTiles === 'function') {
          entries = compositor._getActiveLevelTiles(scene, { bottom: band.bottom, top: band.top, levelId: band.levelId });
        }
      } catch (_) {
        entries = [];
      }
      for (const entry of entries || []) {
        pushTile(entry?.tileDoc ?? entry, band.key);
      }
    }

    return { tiles: out, bands };
  }

  _requestLevelTexture(src) {
    const key = String(src || '').trim();
    if (!key) return null;
    if (this._levelTextureCache.has(key)) return this._levelTextureCache.get(key);
    if (!this._levelTextureInflight.has(key)) {
      const promise = loadTexture(key, { suppressProbeErrors: true })
        .then((tex) => {
          if (tex) {
            try {
              tex.flipY = false;
              tex.needsUpdate = true;
            } catch (_) {}
          }
          this._levelTextureCache.set(key, tex ?? null);
          return tex ?? null;
        })
        .catch((err) => {
          log.debug('SkyReachShadowsEffectV2: failed to load level albedo texture', { src: key, err });
          this._levelTextureCache.set(key, null);
          return null;
        })
        .finally(() => {
          this._levelTextureInflight.delete(key);
        });
      this._levelTextureInflight.set(key, promise);
    }
    return null;
  }

  _collectUpperFloorLevelImageCasters(receiverBaseIndex) {
    const scene = canvas?.scene ?? null;
    const floorStack = window.MapShine?.floorStack;
    const floors = floorStack?.getFloors?.() ?? [];
    const textures = [];
    const candidates = [];
    const loaded = [];
    const inflight = [];

    const pushSrc = (floor, kind, src) => {
      const s = String(src || '').trim();
      if (!s) return;
      const label = `${floor?.compositorKey ?? floor?.index ?? '?'}:${kind}`;
      candidates.push(label);
      const tex = this._requestLevelTexture(s);
      if (tex) {
        textures.push(tex);
        loaded.push(label);
      } else if (this._levelTextureInflight.has(s)) {
        inflight.push(label);
      }
    };

    for (const f of floors) {
      const idx = Number(f?.index);
      if (!Number.isFinite(idx) || idx <= receiverBaseIndex) continue;
      const levelId = f?.levelId;
      const level = levelId ? (scene?.levels?.get?.(levelId) ?? null) : null;
      pushSrc(f, 'background', level?.background?.src);
      pushSrc(f, 'foreground', level?.foreground?.src);
    }

    return { textures, candidates, loaded, inflight };
  }

  _maybeWarmFloorMaskCache(compositor, floorCount) {
    if (!compositor) return;
    if (this._floorPreloadPromise) return;
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
        log.debug('SkyReachShadowsEffectV2: preloadAllFloors warmup failed', err);
      })
      .finally(() => {
        this._floorPreloadPromise = null;
      });
  }

  /**
   * Pick the composite RT size from the largest input floorAlpha, with caps.
   * @private
   */
  _resolveCompositeTargetSize(textures) {
    let maxW = 0;
    let maxH = 0;
    for (const t of textures) {
      if (!t) continue;
      const iw = t.image?.width ?? t.source?.data?.width ?? t.width ?? 0;
      const ih = t.image?.height ?? t.source?.data?.height ?? t.height ?? 0;
      if (iw > maxW) maxW = iw;
      if (ih > maxH) maxH = ih;
    }
    if (maxW <= 0 || maxH <= 0) {
      try {
        const comp = window.MapShine?.sceneComposer?._sceneMaskCompositor;
        const od = comp?.getOutputDims?.('floorAlpha');
        const ow = Math.floor(Number(od?.width));
        const oh = Math.floor(Number(od?.height));
        if (ow > 0 && oh > 0) {
          maxW = Math.max(maxW, ow);
          maxH = Math.max(maxH, oh);
        }
      } catch (_) {}
    }
    if ((maxW <= 0 || maxH <= 0) && this.renderer) {
      const d = new (window.THREE.Vector2)();
      this.renderer.getDrawingBufferSize(d);
      maxW = Math.max(maxW, Math.max(2, Math.floor(d.x)));
      maxH = Math.max(maxH, Math.max(2, Math.floor(d.y)));
    }
    const cap = (this.renderer?.capabilities?.maxTextureSize | 0) || 8192;
    return {
      x: Math.max(2, Math.min(maxW, cap, MAX_SKY_REACH_SHADOW_EDGE_PX)),
      y: Math.max(2, Math.min(maxH, cap, MAX_SKY_REACH_SHADOW_EDGE_PX)),
    };
  }

  render(renderer, camera) {
    if (camera) this.mainCamera = camera;
    if (!renderer
      || !this._projectMaterial
      || !this._invertMaterial
      || !this._accumMaterial
      || !this._scene
      || !this._quad
      || !this.shadowTarget
      || !this._strengthTarget
      || !this._compositeTarget) {
      return;
    }

    if (!this.params.enabled) {
      this._healthDiagnostics = {
        timestamp: Date.now(),
        paramsEnabled: false,
        compositorPresent: false,
        upperFloorCount: 0,
        drewAny: false,
        note: 'Sky reach shadows disabled',
      };
      this._clearShadowTargetToWhite(renderer);
      return;
    }

    const THREE = window.THREE;
    if (!THREE) return;

    const compositor = window.MapShine?.sceneComposer?._sceneMaskCompositor ?? null;
    const floorCount = Number(window.MapShine?.floorStack?.getFloors?.()?.length ?? 0);
    const {
      textures: upperAlphaTextures,
      activeFloorAlpha,
      activeFloorIndex,
      receiverBaseIndex,
      casterKeys,
      candidateKeys,
      fallbackSolidTileCount,
      fallbackFloor,
    } = this._collectUpperFloorAlphaTextures();
    const fallbackSkyReachTex = upperAlphaTextures.length === 0 ? this._resolveFloorTexture(fallbackFloor, 'skyReach') : null;
    const fallbackOutdoorsTex = fallbackSkyReachTex ? this._resolveFloorTexture(fallbackFloor, 'outdoors') : null;
    const levelImageCasters = (upperAlphaTextures.length === 0 && !fallbackSkyReachTex)
      ? this._collectUpperFloorLevelImageCasters(receiverBaseIndex)
      : { textures: [], candidates: [], loaded: [], inflight: [] };
    const directTileCasters = (upperAlphaTextures.length === 0 && !fallbackSkyReachTex && levelImageCasters.textures.length === 0)
      ? this._collectUpperFloorTileCasters(receiverBaseIndex, candidateKeys)
      : { tiles: [], bands: [] };
    if (upperAlphaTextures.length === 0 && !fallbackSkyReachTex && levelImageCasters.textures.length === 0 && directTileCasters.tiles.length === 0) {
      this._maybeWarmFloorMaskCache(compositor, floorCount);
      if (!this._loggedNoUpperOnce) {
        this._loggedNoUpperOnce = true;
        log.debug('SkyReachShadowsEffectV2: no caster input available yet (floorAlpha, receiver skyReach, V14 level image alpha, or direct tile fallback).');
      }
      this._healthDiagnostics = {
        timestamp: Date.now(),
        paramsEnabled: true,
        compositorPresent: !!compositor,
        floorCount,
        activeFloorIndex,
        receiverBaseIndex,
        casterKeys,
        candidateKeys,
        fallbackSolidTileCount,
        levelImageCandidates: levelImageCasters.candidates,
        levelImageLoaded: levelImageCasters.loaded,
        levelImageInflight: levelImageCasters.inflight,
        directTileCasterCount: 0,
        directTileBands: directTileCasters.bands.map((band) => `${band.key}${band.levelId ? `#${band.levelId}` : ''}`),
        upperFloorCount: 0,
        fallbackSkyReachUsed: false,
        levelImageFallbackUsed: false,
        directTileFallbackUsed: false,
        drewAny: false,
        note: 'No floorAlpha, no receiver skyReach, no loaded upper level image alpha, and no direct tile casters',
      };
      try {
        if (window.MapShine) window.MapShine.__skyReachShadowsDiagnostics = this.getHealthDiagnostics();
      } catch (_) {}
      this._clearShadowTargetToWhite(renderer);
      return;
    }
    // Reset the once-guard so future single-level renders log once if it
    // ever becomes empty again after being populated.
    this._loggedNoUpperOnce = false;

    // ── 1) Build (or reuse cached) composite RT of upper-floor floorAlpha ──
    const usingDirectTileFallback = upperAlphaTextures.length === 0 && !fallbackSkyReachTex && directTileCasters.tiles.length > 0;
    const usingLevelImageFallback = upperAlphaTextures.length === 0 && !fallbackSkyReachTex && levelImageCasters.textures.length > 0;
    const compositeSources = upperAlphaTextures.length > 0
      ? upperAlphaTextures
      : (fallbackSkyReachTex ? [fallbackSkyReachTex] : levelImageCasters.textures);
    const compSize = this._resolveCompositeTargetSize(compositeSources);
    if (this._compositeTarget.width !== compSize.x || this._compositeTarget.height !== compSize.y) {
      this._compositeTarget.setSize(compSize.x, compSize.y);
      this._compositeLastSig = '';
    }

    const usingSkyReachFallback = upperAlphaTextures.length === 0 && !!fallbackSkyReachTex;
    const combineMode = usingLevelImageFallback
      ? 'levelImageFallback'
      : (usingDirectTileFallback
      ? 'directTileFallback'
      : (usingSkyReachFallback ? 'skyReachFallback' : String(this.params.upperFloorCombineMode || 'max').toLowerCase()));
    let sig = `${combineMode}|${compSize.x}x${compSize.y}|${compositeSources.length}`;
    for (const t of compositeSources) {
      sig += `|${t?.uuid ?? ''}:${t?.version ?? 0}:${t?.flipY ? 1 : 0}`;
    }
    sig += `|out:${fallbackOutdoorsTex?.uuid ?? ''}:${fallbackOutdoorsTex?.version ?? 0}:${fallbackOutdoorsTex?.flipY ? 1 : 0}`;
    if (usingLevelImageFallback) {
      for (const label of levelImageCasters.loaded) sig += `|level:${label}`;
    }
    if (usingDirectTileFallback) {
      for (const { tileDoc, key } of directTileCasters.tiles) {
        sig += `|tile:${key}:${tileDoc?.id ?? tileDoc?._id ?? ''}:${tileDoc?.x ?? 0}:${tileDoc?.y ?? 0}:${tileDoc?.width ?? 0}:${tileDoc?.height ?? 0}:${tileDoc?.rotation ?? 0}:${tileDoc?.texture?.scaleX ?? 1}:${tileDoc?.texture?.scaleY ?? 1}`;
      }
    }
    const needsComposite = sig !== this._compositeLastSig;

    if (needsComposite) {
      const prevTarget = renderer.getRenderTarget();
      const prevAutoClear = renderer.autoClear;
      const prevClearColor = new THREE.Color();
      renderer.getClearColor(prevClearColor);
      const prevClearAlpha = renderer.getClearAlpha();

      renderer.setRenderTarget(this._compositeTarget);
      if (usingLevelImageFallback) {
        renderer.setClearColor(0x000000, 0);
        renderer.clear();
        this._quad.material = this._levelAlphaMaterial;
        this._levelAlphaMaterial.blending = THREE.CustomBlending;
        this._levelAlphaMaterial.transparent = true;
        renderer.autoClear = false;
        for (const tex of levelImageCasters.textures) {
          this._levelAlphaMaterial.uniforms.tLevelAlbedo.value = tex;
          this._levelAlphaMaterial.uniforms.uFlipY.value = tex?.flipY ? 1.0 : 0.0;
          renderer.render(this._scene, this._camera);
        }
      } else if (usingDirectTileFallback) {
        renderer.setClearColor(0x000000, 0);
        renderer.clear();
        this._quad.material = this._tileFootprintMaterial;
        this._tileFootprintMaterial.blending = THREE.CustomBlending;
        this._tileFootprintMaterial.transparent = true;
        renderer.autoClear = false;

        const dims = canvas?.dimensions;
        const rect = dims?.sceneRect ?? dims;
        const sceneX = Number(rect?.x ?? dims?.sceneX ?? 0);
        const sceneY = Number(rect?.y ?? dims?.sceneY ?? 0);
        const sceneW = Math.max(1, Number(rect?.width ?? dims?.sceneWidth ?? dims?.width ?? 1));
        const sceneH = Math.max(1, Number(rect?.height ?? dims?.sceneHeight ?? dims?.height ?? 1));

        for (const { tileDoc } of directTileCasters.tiles) {
          const tileX = Number(tileDoc?.x ?? 0);
          const tileY = Number(tileDoc?.y ?? 0);
          const tileW = Number(tileDoc?.width ?? 0);
          const tileH = Number(tileDoc?.height ?? 0);
          if (!tileW || !tileH) continue;
          const u0 = (tileX - sceneX) / sceneW;
          const vH = tileH / sceneH;
          const v0 = 1.0 - (((tileY - sceneY) / sceneH) + vH);
          const uW = tileW / sceneW;
          const scaleX = Number(tileDoc?.texture?.scaleX ?? 1);
          const scaleY = Number(tileDoc?.texture?.scaleY ?? 1);
          const rotRad = Number(tileDoc?.rotation ?? 0) * Math.PI / 180;
          this._tileFootprintMaterial.uniforms.uTileRect.value.set(u0, v0, uW, vH);
          this._tileFootprintMaterial.uniforms.uScaleSign.value.set(Math.sign(scaleX) || 1, Math.sign(scaleY) || 1);
          this._tileFootprintMaterial.uniforms.uRotation.value = rotRad;
          renderer.render(this._scene, this._camera);
        }
      } else if (usingSkyReachFallback) {
        renderer.setClearColor(0x000000, 0);
        renderer.clear();
        this._quad.material = this._skyReachFallbackMaterial;
        this._skyReachFallbackMaterial.uniforms.tSkyReach.value = fallbackSkyReachTex;
        this._skyReachFallbackMaterial.uniforms.tOutdoors.value = fallbackOutdoorsTex ?? fallbackSkyReachTex;
        this._skyReachFallbackMaterial.uniforms.uHasOutdoors.value = fallbackOutdoorsTex ? 1.0 : 0.0;
        this._skyReachFallbackMaterial.uniforms.uSkyReachFlipY.value = fallbackSkyReachTex?.flipY ? 1.0 : 0.0;
        this._skyReachFallbackMaterial.uniforms.uOutdoorsFlipY.value = fallbackOutdoorsTex?.flipY ? 1.0 : 0.0;
        renderer.autoClear = false;
        renderer.render(this._scene, this._camera);
      } else {
      const useMultiply = combineMode === 'multiply';
      if (useMultiply) {
        renderer.setClearColor(0xffffff, 1);
        renderer.clear();
        this._accumMaterial.blending = THREE.CustomBlending;
        this._accumMaterial.blendEquation = THREE.AddEquation;
        this._accumMaterial.blendSrc = THREE.DstColorFactor;
        this._accumMaterial.blendDst = THREE.ZeroFactor;
        this._accumMaterial.blendEquationAlpha = THREE.AddEquation;
        this._accumMaterial.blendSrcAlpha = THREE.OneFactor;
        this._accumMaterial.blendDstAlpha = THREE.ZeroFactor;
      } else {
        renderer.setClearColor(0x000000, 0);
        renderer.clear();
        this._accumMaterial.blending = THREE.CustomBlending;
        this._accumMaterial.blendEquation = THREE.MaxEquation ?? THREE.AddEquation;
        this._accumMaterial.blendEquationAlpha = THREE.MaxEquation ?? THREE.AddEquation;
        this._accumMaterial.blendSrc = THREE.OneFactor;
        this._accumMaterial.blendDst = THREE.OneFactor;
        this._accumMaterial.blendSrcAlpha = THREE.OneFactor;
        this._accumMaterial.blendDstAlpha = THREE.OneFactor;
      }
      this._accumMaterial.transparent = true;
      this._quad.material = this._accumMaterial;
      renderer.autoClear = false;
      for (const tex of upperAlphaTextures) {
        this._accumMaterial.uniforms.tUpperAlpha.value = tex;
        this._accumMaterial.uniforms.uUpperAlphaFlipY.value = tex?.flipY ? 1.0 : 0.0;
        try {
          renderer.render(this._scene, this._camera);
        } catch (e) {
          log.debug('SkyReachShadowsEffectV2: accumulator draw failed', e);
        }
      }
      this._accumMaterial.blending = THREE.NoBlending;
      this._accumMaterial.transparent = false;
      }

      renderer.setClearColor(prevClearColor, prevClearAlpha);
      renderer.autoClear = prevAutoClear;
      renderer.setRenderTarget(prevTarget);

      this._compositeLastSig = sig;
    }

    // ── 2) Resize the projection/blur RTs to match composite scene space ─
    const targetSize = this._compositeTarget.width && this._compositeTarget.height
      ? { x: this._compositeTarget.width, y: this._compositeTarget.height }
      : { x: 1024, y: 1024 };
    const rtSize = this._computeRenderTargetSize(targetSize.x, targetSize.y);
    if (this._strengthTarget.width !== rtSize.x || this._strengthTarget.height !== rtSize.y) {
      this._strengthTarget.setSize(rtSize.x, rtSize.y);
      this.shadowTarget.setSize(rtSize.x, rtSize.y);
      this._blurTarget.setSize(rtSize.x, rtSize.y);
      if (this._projectMaterial?.uniforms?.uTexelSize) {
        this._projectMaterial.uniforms.uTexelSize.value.set(1 / rtSize.x, 1 / rtSize.y);
      }
      if (this._blurMaterial?.uniforms?.uTexelSize) {
        this._blurMaterial.uniforms.uTexelSize.value.set(1 / rtSize.x, 1 / rtSize.y);
      }
    }

    this.update(null);

    // ── 3) Ray-march the composite into the strength RT ──────────────────
    const prevTarget = renderer.getRenderTarget();
    const prevAutoClear = renderer.autoClear;

    this._projectMaterial.uniforms.uCasterMask.value = this._compositeTarget.texture;
    this._projectMaterial.uniforms.uHasCaster.value = 1.0;
    if (this._projectMaterial.uniforms.uActiveFloorAlpha) {
      this._projectMaterial.uniforms.uActiveFloorAlpha.value = activeFloorAlpha ?? null;
    }
    this._projectMaterial.uniforms.uHasActiveFloorAlpha.value = activeFloorAlpha ? 1.0 : 0.0;
    this._projectMaterial.uniforms.uActiveFloorAlphaFlipY.value = activeFloorAlpha?.flipY ? 1.0 : 0.0;

    renderer.setRenderTarget(this._strengthTarget);
    renderer.setClearColor(0x000000, 1);
    renderer.clear();
    renderer.autoClear = false;
    this._quad.material = this._projectMaterial;
    renderer.render(this._scene, this._camera);

    // ── 4) Optional separable blur on the strength target ────────────────
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

    // ── 5) Invert strength → lighting-facing factor (1=lit, 0=shadowed) ──
    this._quad.material = this._invertMaterial;
    this._invertMaterial.uniforms.tStrength.value = finalStrengthTex;
    renderer.setRenderTarget(this.shadowTarget);
    renderer.setClearColor(0xffffff, 1);
    renderer.clear();
    renderer.autoClear = true;
    renderer.render(this._scene, this._camera);

    renderer.autoClear = prevAutoClear;
    renderer.setRenderTarget(prevTarget);

    this._healthDiagnostics = {
      timestamp: Date.now(),
      paramsEnabled: true,
      compositorPresent: true,
      floorCount,
      activeFloorIndex,
      receiverBaseIndex,
      upperFloorCount: upperAlphaTextures.length,
      casterKeys,
      candidateKeys,
      fallbackSolidTileCount,
      levelImageCandidates: levelImageCasters.candidates,
      levelImageLoaded: levelImageCasters.loaded,
      levelImageInflight: levelImageCasters.inflight,
      levelImageFallbackUsed: usingLevelImageFallback,
      directTileCasterCount: directTileCasters.tiles.length,
      directTileBands: directTileCasters.bands.map((band) => `${band.key}${band.levelId ? `#${band.levelId}` : ''}`),
      fallbackSkyReachUsed: usingSkyReachFallback,
      directTileFallbackUsed: usingDirectTileFallback,
      drewAny: true,
      combineMode,
      receiverInteriorOnly: !!this.params.castInteriorReceiverOnly,
      compositeTextureUuid: this._compositeTarget.texture?.uuid ?? null,
      shadowFactorTextureUuid: this.shadowTarget?.texture?.uuid ?? null,
      dynamicLightOverrideBound: !!(this._dynamicLightOverride?.texture || this._dynamicLightOverride?.windowTexture),
    };
    try {
      if (window.MapShine) window.MapShine.__skyReachShadowsDiagnostics = this.getHealthDiagnostics();
    } catch (_) {}
  }

  _computeRenderTargetSize(width, height) {
    const scaleRaw = Number(this.params?.resolutionScale ?? 1.0);
    const scale = Number.isFinite(scaleRaw) ? Math.min(2.0, Math.max(1.0, scaleRaw)) : 1.0;
    let x = Math.max(1, Math.round(width * scale));
    let y = Math.max(1, Math.round(height * scale));
    const maxE = Math.max(x, y);
    if (maxE > MAX_SKY_REACH_SHADOW_EDGE_PX) {
      const s = MAX_SKY_REACH_SHADOW_EDGE_PX / maxE;
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
      const t = (hour % 24.0) / 24.0;
      const azimuth = (t - 0.5) * (Math.PI * 2.0);
      x = -Math.sin(azimuth);
      y = -Math.cos(azimuth) * lat;
    }

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
    this._floorPreloadPromise = null;
    this._compositeLastSig = '';
    try { this._compositeTarget?.dispose(); } catch (_) {}
    try { this._strengthTarget?.dispose(); } catch (_) {}
    try { this.shadowTarget?.dispose(); } catch (_) {}
    try { this._blurTarget?.dispose(); } catch (_) {}
    try { this._accumMaterial?.dispose(); } catch (_) {}
    try { this._skyReachFallbackMaterial?.dispose(); } catch (_) {}
    try { this._levelAlphaMaterial?.dispose(); } catch (_) {}
    try { this._tileFootprintMaterial?.dispose(); } catch (_) {}
    try { this._projectMaterial?.dispose(); } catch (_) {}
    try { this._invertMaterial?.dispose(); } catch (_) {}
    try { this._blurMaterial?.dispose(); } catch (_) {}
    try { this._quad?.geometry?.dispose(); } catch (_) {}

    this._compositeTarget = null;
    this._strengthTarget = null;
    this.shadowTarget = null;
    this._blurTarget = null;
    this._accumMaterial = null;
    this._skyReachFallbackMaterial = null;
    this._levelAlphaMaterial = null;
    this._tileFootprintMaterial = null;
    this._projectMaterial = null;
    this._invertMaterial = null;
    this._blurMaterial = null;
    this._quad = null;
    this._scene = null;
    this._camera = null;

    log.info('SkyReachShadowsEffectV2 disposed');
  }
}
