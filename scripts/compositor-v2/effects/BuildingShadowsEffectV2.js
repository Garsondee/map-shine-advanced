/**
 * @fileoverview Building Shadows Effect V2
 *
 * Builds a directional projected shadow field from the dark regions of _Outdoors
 * masks (indoors/buildings), then feeds a scene-space shadow-factor texture to
 * LightingEffectV2.
 *
 * HEALTH-WIRING BADGE (Map Shine Breaker Box):
 * If you change `shadowTarget` / `_strengthTarget` / `_sharpHoldTarget` lifecycle, render cadence, or
 * LightingEffectV2 uniform wiring, you MUST update HealthEvaluator contracts for
 * `BuildingShadowsEffectV2` and the edge into `LightingEffectV2` to prevent silent failures.
 *
 * Multi-level behavior:
 * - Single-floor maps: one combined shadowFactorTexture (legacy path).
 * - Multi-floor maps: per-receiver-floor lit targets (groundOnlyLitTexture +
 *   renderLitForSingleFloor), mirroring PaintedShadowEffectV2. Each floor gets
 *   casters from its index upward and receiver gating from that floor's _Outdoors.
 * - Falls back to the active floor outdoors mask when no floor-stack data exists.
 *
 * @module compositor-v2/effects/BuildingShadowsEffectV2
 *
 * Canvas padding: this pass renders scene-sized RTs (mask space), not full canvas.
 * Do not clip with `canvas.dimensions.sceneRect` offsets here — that mixes spaces.
 * {@link LightingEffectV2} already gates `tBuildingShadow` with `inSceneBounds`.
 */

import { createLogger } from '../../core/log.js';
import { isFloorPreloadSuppressedAfterLevelChange } from '../floor-sim-decimation.js';
import { weatherController } from '../../core/WeatherController.js';
import { resolveAuthoredOutdoorsForFloorKey, resolveCompositorOutdoorsTexture } from '../../masks/resolve-compositor-outdoors.js';
import { FLOOR_ID_OUTDOORS_RECEIVER_GLSL } from '../shadow-system/DirectionalShadowProjector.js';
import {
  resolveEffectShadowSun2D,
  writeEffectSunDir,
} from '../shadow-system/ShadowSunDirection.js';
import { collectOutdoorsTexturesByFloorIndex } from '../shadow-system/floor-outdoors-slots.js';
import { resolveReceiverOutdoorsMaskTexture } from '../shadow-system/resolve-receiver-outdoors-mask.js';
import { resolveBakeRayLength, resolveBakeSmear } from '../lightning/shadow-bake-override.js';

const log = createLogger('BuildingShadowsEffectV2');

/** Projector shader: `pxLen = uLength * 1400` (mask texels). */
const BUILDING_SHADOW_LENGTH_SHADER_SCALE = 1400;
/** Target mask-space length at full dawn/dusk weight with default slider (0.075). */
const BUILDING_SHADOW_PEAK_PX_AT_DEFAULT_LENGTH = 400;
const BUILDING_SHADOW_DEFAULT_LENGTH = 0.075;
const BUILDING_SHADOW_PEAK_U_LENGTH =
  BUILDING_SHADOW_PEAK_PX_AT_DEFAULT_LENGTH / BUILDING_SHADOW_LENGTH_SHADER_SCALE;

/**
 * Building shadows ray-march the full outdoors mask per pixel. Uncapped RT size
 * follows mask native resolution (often scene-sized, 4k–8k+); that tanks FPS on mid GPUs.
 */
const MAX_BUILDING_SHADOW_EDGE_PX = 2560;
/** Internal RT downsample — shadows are low-frequency; half-res is visually equivalent. */
const INTERNAL_SHADOW_DOWNSAMPLE = 0.5;

/** Camera/world view bounds snap for cache keys (avoids per-frame float jitter). */
const BUILDING_SHADOW_VIEW_BOUNDS_QUANTIZE = 24;
const BUILDING_SHADOW_DRIVER_EPS = 0.002;
const BUILDING_SHADOW_SUN_EPS_DEG = 0.1;
/** Throttle dynamic-light coupling (texture.version bumps every lighting frame). */
const BUILDING_SHADOW_THROTTLE_DYNAMIC_MS = 50;
const BUILDING_SHADOW_THROTTLE_STATIC_MS = 400;
const BUILDING_SHADOW_SAFETY_DYNAMIC_MS = 1000;
const BUILDING_SHADOW_SAFETY_STATIC_MS = 3000;

export class BuildingShadowsEffectV2 {
  constructor() {
    this.params = {
      enabled: true,
      opacity: 0.3,
      /** Multiplier on shadow darkening after opacity (1 = legacy, up to 10 = much deeper penumbra). */
      shadowStrengthBoost: 1,
      length: 0.075,
      softness: 8,
      smear: 0.65,
      resolutionScale: 2,
      penumbra: 0.85,
      shadowCurve: 1.15,
      blurRadius: 3.0,
      /** 1 = keep full strength at the caster contact; fringe still uses blurred field. 0 = legacy (uniform blur can eat the footprint edge). */
      contactShadowPreserve: 0.15,
      /** smoothstep(low,high,sharpStrength) — widens/narrows where the pre-blur field wins over blur. */
      contactSharpBlendLow: 0.06,
      contactSharpBlendHigh: 0.58,
      /** Grow shadow coverage in shadow RT pixels (max-filter) to cover bright rim cracks at silhouette. */
      shadowEdgeInflatePx: 0.5,
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
    /** @type {THREE.WebGLRenderTarget|null} Pre-blur strength snapshot (used when contactShadowPreserve > 0) */
    this._sharpHoldTarget = null;

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
    /** @type {THREE.ShaderMaterial|null} */
    this._copyMaterial = null;

    /** @type {THREE.Vector2|null} */
    this.sunDir = null;
    /** @type {THREE.Vector2|null} */
    this._tempSize = null;

    /** @type {THREE.Texture|null} Latest outdoors mask from FloorCompositor sync */
    this._outdoorsMask = null;

    /** @type {boolean} One-shot debug guard for empty-floor diagnostics */
    this._loggedNoMaskOnce = false;
    /** @type {boolean} One-shot emergency fallback log */
    this._loggedEmergencyFallbackOnce = false;

    /** @type {(import('three').Texture|null)[]} Per-floor _Outdoors for floor-id receiver sampling */
    this._outdoorsMasks = [null, null, null, null];
    /** @type {import('three').Texture|null} */
    this._floorIdTex = null;
    /** @type {import('three').WebGLRenderTarget|null} Floor-0-only lit factor (multi-floor ground pass) */
    this._groundOnlyLitTarget = null;
    /** @type {import('three').WebGLRenderTarget|null} Scratch lit RT for on-demand per-floor resolve */
    this._litScratchTarget = null;
    /** @type {(import('three').WebGLRenderTarget|null)[]} Cached lit factor per receiver floor */
    this._perFloorLitTargets = [null, null, null, null];
    /** @type {number} Bumped each multi-floor {@link render} */
    this._perFloorLitCacheSerial = 0;
    /** @type {number[]} Matches {@link #_perFloorLitCacheSerial} when slot is warm */
    this._perFloorLitLastFillSerial = [0, 0, 0, 0];

    this._sunAzimuthDeg = null;
    this._sunElevationDeg = null;
    this._dynamicLightOverride = null;
    /** @type {number} Echo of {@link ShadowDriverState#tuning.shadowLengthScale} */
    this._driverShadowLengthScale = 1.0;
    this._driverShadowSoftnessScale = 1.0;
    this._driverShadowSmearScale = 1.0;

    /** @type {Promise<void>|null} Background floor-mask warmup in flight */
    this._floorPreloadPromise = null;
    /** @type {number} Last warmup attempt timestamp (ms) */
    this._lastFloorPreloadAttemptMs = 0;

    /** @type {object} Last-frame diagnostics for Breaker Box / health (mutated each frame) */
    this._healthDiagnostics = {
      timestamp: 0,
      paramsEnabled: false,
      compositorPresent: false,
      drewAny: false,
      floorKeys: [],
      floorKeyCount: 0,
      syncOutdoorsMaskUuid: null,
      fallbackUsed: false,
      fallbackMaskUuid: null,
      bundleFallbackUsed: false,
      fullOutdoorsFallbackUsed: false,
      outdoorsResolveRoute: null,
      outdoorsResolveKey: null,
      receiverMaskUuid: null,
      shadowFactorTextureUuid: null,
      dynamicLightOverrideBound: false,
      note: null,
    };

    /** @type {string[]|null} Cached {@link #_computeSourceFloorKeys} result */
    this._floorKeysCache = null;
    /** @type {string} Signature when {@link #_floorKeysCache} remains valid */
    this._floorKeysSigCache = '';

    /** @type {Record<string, unknown>} Last-seen UI params (dirty detection) */
    this._lastParams = {};
    /** @type {object} Inputs that affect the shadow RT; drives cache + throttle */
    this._renderState = {
      time: 0,
      sunAz: null,
      sunEl: null,
      driverLen: null,
      driverSoft: null,
      driverSmear: null,
      rtWidth: 0,
      rtHeight: 0,
      floorKeys: '',
      recvUuid: null,
      fallbackUuid: null,
      outdoorsUuid: null,
      dynTexVersion: -1,
      winTexVersion: -1,
      dloStrength: -1,
      dloEnabled: null,
      vbX: 0,
      vbY: 0,
      vbZ: 0,
      vbW: 0,
      srX: 0,
      srY: 0,
      srZ: 0,
      srW: 0,
      sdimX: 0,
      sdimY: 0,
      sw: 0,
      sh: 0,
      outdoorsRoute: null,
      outdoorsKey: null,
      floorIdUuid: null,
      outdoorsUuid0: null,
      outdoorsUuid1: null,
      outdoorsUuid2: null,
      outdoorsUuid3: null,
      floorCacheVersion: 0,
    };
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
          parameters: [
            'opacity',
            'shadowStrengthBoost',
            'length',
            'softness',
            'smear',
            'resolutionScale',
            'penumbra',
            'shadowCurve',
            'blurRadius',
            'contactShadowPreserve',
            'contactSharpBlendLow',
            'contactSharpBlendHigh',
            'shadowEdgeInflatePx'
          ]
        }
      ],
      parameters: {
        opacity: {
          type: 'slider',
          label: 'Opacity',
          min: 0.0,
          max: 1.0,
          step: 0.01,
          default: 0.3
        },
        shadowStrengthBoost: {
          type: 'slider',
          label: 'Strength boost',
          min: 1.0,
          max: 10.0,
          step: 0.05,
          default: 1,
          advanced: true,
          tooltip: 'Extra darkening beyond opacity (×1 matches older behavior; use up to ×10 when shadows look too faint).'
        },
        length: {
          type: 'slider',
          label: 'Length',
          min: 0.0,
          max: 0.6,
          step: 0.005,
          default: 0.075,
          tooltip:
            'Peak shadow length at dawn/dusk (~400 px at default). Scales toward zero at solar noon and midnight.',
        },
        softness: {
          type: 'slider',
          label: 'Softness',
          min: 0.5,
          max: 8.0,
          step: 0.1,
          default: 8,
          tooltip: 'Lateral spread per ray step; grows toward the shadow tip for a softer umbra away from walls.'
        },
        smear: {
          type: 'slider',
          label: 'Smear',
          min: 0.0,
          max: 1.0,
          step: 0.01,
          default: 0.65,
          advanced: true,
          tooltip: 'Stretches and softens the shadow tail along the sun direction (higher = more smeared, painterly falloff).'
        },
        resolutionScale: {
          type: 'slider',
          label: 'Resolution',
          min: 1.0,
          max: 2.0,
          step: 0.05,
          default: 2,
          advanced: true,
        },
        penumbra: {
          type: 'slider',
          label: 'Penumbra',
          min: 0.0,
          max: 1.0,
          step: 0.01,
          default: 0.85,
          advanced: true,
          tooltip: 'How quickly the shadow softens and lightens along its length (away from the building).'
        },
        shadowCurve: {
          type: 'slider',
          label: 'Shadow Curve',
          min: 0.5,
          max: 1.6,
          step: 0.01,
          default: 1.15,
          advanced: true,
          tooltip: 'Gamma on integrated shadow strength; lower = gentler fade into light.'
        },
        blurRadius: {
          type: 'slider',
          label: 'Blur',
          min: 0.0,
          max: 4.0,
          step: 0.05,
          default: 3.0,
          advanced: true,
        },
        contactShadowPreserve: {
          type: 'slider',
          label: 'Contact preserve',
          min: 0.0,
          max: 1.0,
          step: 0.02,
          default: 0.15,
          advanced: true,
          tooltip:
            'Blurs outward without eating the caster edge: merges pre-blur strength where the footprint is darkest, full blur where it fades. Lower = softer contact.'
        },
        contactSharpBlendLow: {
          type: 'slider',
          label: 'Contact blend (low)',
          min: 0.0,
          max: 0.35,
          step: 0.005,
          default: 0.06,
          advanced: true,
          tooltip: 'Lower bound for where pre-blur strength starts to dominate (shadow strength gamma). Raise slightly if fringe looks too crunchy.'
        },
        contactSharpBlendHigh: {
          type: 'slider',
          label: 'Contact blend (high)',
          min: 0.2,
          max: 0.98,
          step: 0.01,
          default: 0.58,
          advanced: true,
          tooltip: 'Upper bound toward full contact sharpness inside the silhouette. Lower to pull softness closer to walls.'
        },
        shadowEdgeInflatePx: {
          type: 'slider',
          label: 'Edge inflate (px)',
          min: 0.0,
          max: 8.0,
          step: 0.05,
          default: 0.5,
          advanced: true,
          tooltip:
            'Expands shadow strength slightly in the shadow buffer (in RT pixels) so coverage tucks under the footprint and hides bright rim lines. 0 = off.'
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

  /** @returns {import('three').Texture|null} Floor-0-only lit factor (multi-floor level 0 pass). */
  get groundOnlyLitTexture() {
    return this._groundOnlyLitTarget?.texture ?? null;
  }

  /**
   * Lit factor for a single receiver floor (multi-floor per-level lighting).
   * @param {import('three').WebGLRenderer} renderer
   * @param {number} floorIndex
   * @returns {import('three').Texture|null}
   */
  renderLitForSingleFloor(renderer, floorIndex) {
    const idx = Math.max(0, Math.min(3, Math.floor(Number(floorIndex))));
    const litTarget = this._perFloorLitTargets[idx]
      ?? (idx === 0 ? this._groundOnlyLitTarget : null)
      ?? this._litScratchTarget;
    if (this._perFloorLitLastFillSerial[idx] === this._perFloorLitCacheSerial) {
      const cached = litTarget?.texture ?? null;
      if (cached) return cached;
    }
    if (!litTarget) return null;
    return this._renderSingleFloorLit(renderer, idx, litTarget);
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
        uHasDynSceneRect: { value: 0.0 },
        tFloorId: { value: null },
        uHasFloorId: { value: 0.0 },
        uFloorIdFlipY: { value: 1.0 },
        tOutdoors0: { value: null },
        tOutdoors1: { value: null },
        tOutdoors2: { value: null },
        tOutdoors3: { value: null },
        uHasOutdoors0: { value: 0.0 },
        uHasOutdoors1: { value: 0.0 },
        uHasOutdoors2: { value: 0.0 },
        uHasOutdoors3: { value: 0.0 },
        uOutdoors0FlipY: { value: 0.0 },
        uOutdoors1FlipY: { value: 0.0 },
        uOutdoors2FlipY: { value: 0.0 },
        uOutdoors3FlipY: { value: 0.0 },
        uReceiverFloorIndex: { value: -1.0 },
      },
      vertexShader: `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = vec4(position.xy, 0.0, 1.0);
        }
      `,
      fragmentShader: `${FLOOR_ID_OUTDOORS_RECEIVER_GLSL}
        uniform sampler2D uOutdoorsMask;
        uniform float uHasMask;
        uniform float uOutdoorsMaskFlipY;
        uniform sampler2D uReceiverOutdoorsMask;
        uniform float uHasReceiverMask;
        uniform float uReceiverOutdoorsMaskFlipY;
        uniform sampler2D tFloorId;
        uniform float uHasFloorId;
        uniform float uFloorIdFlipY;
        uniform sampler2D tOutdoors0;
        uniform sampler2D tOutdoors1;
        uniform sampler2D tOutdoors2;
        uniform sampler2D tOutdoors3;
        uniform float uHasOutdoors0;
        uniform float uHasOutdoors1;
        uniform float uHasOutdoors2;
        uniform float uHasOutdoors3;
        uniform float uOutdoors0FlipY;
        uniform float uOutdoors1FlipY;
        uniform float uOutdoors2FlipY;
        uniform float uOutdoors3FlipY;
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
        uniform float uReceiverFloorIndex;
        varying vec2 vUv;

        float readOutdoorsByFloor(float floorIdx, vec2 uv) {
          if (floorIdx < 0.5) {
            return uHasOutdoors0 > 0.5
              ? msa_readAlphaAwareOutdoors(tOutdoors0, uv, uOutdoors0FlipY)
              : 1.0;
          }
          if (floorIdx < 1.5) {
            return uHasOutdoors1 > 0.5
              ? msa_readAlphaAwareOutdoors(tOutdoors1, uv, uOutdoors1FlipY)
              : 1.0;
          }
          if (floorIdx < 2.5) {
            return uHasOutdoors2 > 0.5
              ? msa_readAlphaAwareOutdoors(tOutdoors2, uv, uOutdoors2FlipY)
              : 1.0;
          }
          return uHasOutdoors3 > 0.5
            ? msa_readAlphaAwareOutdoors(tOutdoors3, uv, uOutdoors3FlipY)
            : 1.0;
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
          if (uReceiverFloorIndex >= 0.0) {
            return readOutdoorsByFloor(clamp(uReceiverFloorIndex, 0.0, 3.0), uv);
          }
          if (uHasFloorId > 0.5) {
            return msa_readFloorIdOutdoors(
              uv,
              tFloorId,
              uHasFloorId,
              uFloorIdFlipY,
              tOutdoors0,
              tOutdoors1,
              tOutdoors2,
              tOutdoors3,
              uHasOutdoors0,
              uHasOutdoors1,
              uHasOutdoors2,
              uHasOutdoors3,
              uOutdoors0FlipY,
              uOutdoors1FlipY,
              uOutdoors2FlipY,
              uOutdoors3FlipY
            );
          }
          if (uHasReceiverMask < 0.5) return readOutdoorsMask(uv);
          vec2 suv = clamp(uv, 0.0, 1.0);
          if (uReceiverOutdoorsMaskFlipY > 0.5) {
            suv.y = 1.0 - suv.y;
          }
          vec4 m = texture2D(uReceiverOutdoorsMask, suv);
          return clamp(mix(1.0, m.r, m.a), 0.0, 1.0);
        }

        float sampleCasterIndoor(vec2 uv, float receiverOutdoorGate) {
          float casterOutdoors = readOutdoorsMask(uv);
          return (1.0 - casterOutdoors) * receiverOutdoorGate;
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

          // Directional ray integration: lateral penumbra grows with distance along
          // the tail; separable blur pass still softens the composite field.
          vec2 ortho = vec2(-dir.y, dir.x);
          float smearAmount = clamp(uSmear, 0.0, 1.0);
          float penumbraAmount = clamp(uPenumbra, 0.0, 1.0);
          float accum = 0.0;
          float weightSum = 0.0;
          float peakHit = 0.0;
          float spreadBase = 0.28 + 0.62 * smearAmount;

          // Per-pixel jitter breaks banding from fixed step counts; blur pass smooths residual noise.
          float rayJitter = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));

          const int RAY_STEPS = 24;
          for (int i = 0; i < RAY_STEPS; i++) {
            float t = (float(i) + rayJitter) / float(RAY_STEPS);
            float spreadT = mix(t, t * t, spreadBase);
            spreadT = mix(spreadT, t * t * t, smearAmount * 0.42);
            vec2 centerUv = vUv + (baseOffsetUv * spreadT);

            float sigma = max(uSoftness, 0.5) * mix(0.65, 3.4, (t * t) + (0.72 * penumbraAmount * t));
            float lateral = sigma * maskTexel.x * mix(1.0, 2.25, penumbraAmount);
            float distanceFade = mix(1.22, 0.34, pow(t, 0.82));

            float c0 = sampleCasterIndoor(centerUv, receiverOutdoorGate);
            float c1 = sampleCasterIndoor(centerUv + ortho * lateral, receiverOutdoorGate);
            float c2 = sampleCasterIndoor(centerUv - ortho * lateral, receiverOutdoorGate);
            float c3 = sampleCasterIndoor(centerUv + ortho * lateral * 2.0, receiverOutdoorGate);
            float c4 = sampleCasterIndoor(centerUv - ortho * lateral * 2.0, receiverOutdoorGate);
            float stepHit = c0 * 0.34 + c1 * 0.18 + c2 * 0.18 + c3 * 0.15 + c4 * 0.15;
            peakHit = max(peakHit, stepHit);

            float stepWeight = mix(1.38, 0.58, t) * distanceFade;
            accum += stepHit * stepWeight;
            weightSum += stepWeight;
          }

          float integrated = (weightSum > 0.0) ? (accum / weightSum) : 0.0;
          float strength = mix(integrated, peakHit, 0.2 + 0.5 * smearAmount);
          strength = smoothstep(0.0, 1.0, clamp(strength, 0.0, 1.0));
          float curve = max(uShadowCurve, 0.01);
          strength = pow(strength, mix(curve * 1.12, curve * 0.78, penumbraAmount));
          if ((uHasDynamicLight > 0.5 || uHasWindowLight > 0.5) && uDynamicLightShadowOverrideEnabled > 0.5 && uHasDynSceneRect > 0.5) {
            vec2 dynUv = clamp(sceneUvToDynScreenUv(vUv), vec2(0.0), vec2(1.0));
            float dynI = 0.0;
            if (uHasDynamicLight > 0.5) {
              vec3 dyn = texture2D(tDynamicLight, dynUv).rgb;
              dynI = max(dynI, clamp(max(dyn.r, max(dyn.g, dyn.b)), 0.0, 1.0));
            }
            if (uHasWindowLight > 0.5) {
              vec3 win = texture2D(tWindowLight, vUv).rgb;
              dynI = max(dynI, clamp(max(win.r, max(win.g, win.b)), 0.0, 1.0));
            }
            float dynPresence = smoothstep(0.28, 0.92, dynI);
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
        tSharpStrength: { value: null },
        uContactShadowPreserve: { value: this.params.contactShadowPreserve ?? 1 },
        uContactSharpBlendLow: { value: this.params.contactSharpBlendLow ?? 0.04 },
        uContactSharpBlendHigh: { value: this.params.contactSharpBlendHigh ?? 0.78 },
        uOpacity: { value: this.params.opacity },
        uShadowStrengthBoost: { value: this.params.shadowStrengthBoost ?? 1 },
        uShadowEdgeInflatePx: { value: this.params.shadowEdgeInflatePx ?? 0 },
        uStrengthTexelSize: { value: new THREE.Vector2(1 / 1024, 1 / 1024) }
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
        uniform sampler2D tSharpStrength;
        uniform float uContactShadowPreserve;
        uniform float uContactSharpBlendLow;
        uniform float uContactSharpBlendHigh;
        uniform float uOpacity;
        uniform float uShadowStrengthBoost;
        uniform float uShadowEdgeInflatePx;
        uniform vec2 uStrengthTexelSize;
        varying vec2 vUv;

        float mergedStrength(vec2 suv) {
          float sBlur = clamp(texture2D(tStrength, suv).r, 0.0, 1.0);
          float sSharp = clamp(texture2D(tSharpStrength, suv).r, 0.0, 1.0);
          float preserve = clamp(uContactShadowPreserve, 0.0, 1.0);
          float lo = min(uContactSharpBlendLow, uContactSharpBlendHigh - 1e-4);
          float hi = max(uContactSharpBlendHigh, lo + 1e-4);
          float edgeW = smoothstep(lo, hi, sSharp);
          return mix(sBlur, sSharp, preserve * edgeW);
        }

        void main() {
          vec2 duv = max(uStrengthTexelSize * max(uShadowEdgeInflatePx, 0.0), vec2(0.0));
          float s = mergedStrength(clamp(vUv, vec2(0.001), vec2(0.999)));
          float infl = clamp(uShadowEdgeInflatePx, 0.0, 32.0);
          if (infl > 1e-6) {
            vec2 dd = duv * vec2(0.70710678);
            vec2 e = vec2(0.001);
            vec2 ee = vec2(0.999);
            vec2 suv;
            suv = clamp(vUv + vec2(duv.x, 0.0), e, ee); s = max(s, mergedStrength(suv));
            suv = clamp(vUv - vec2(duv.x, 0.0), e, ee); s = max(s, mergedStrength(suv));
            suv = clamp(vUv + vec2(0.0, duv.y), e, ee); s = max(s, mergedStrength(suv));
            suv = clamp(vUv - vec2(0.0, duv.y), e, ee); s = max(s, mergedStrength(suv));
            suv = clamp(vUv + vec2(dd.x, dd.y), e, ee); s = max(s, mergedStrength(suv));
            suv = clamp(vUv + vec2(dd.x, -dd.y), e, ee); s = max(s, mergedStrength(suv));
            suv = clamp(vUv + vec2(-dd.x, dd.y), e, ee); s = max(s, mergedStrength(suv));
            suv = clamp(vUv - vec2(dd.x, dd.y), e, ee); s = max(s, mergedStrength(suv));
          }
          float boost = clamp(uShadowStrengthBoost, 1.0, 10.0);
          float darkening = clamp(s * clamp(uOpacity, 0.0, 1.0) * boost, 0.0, 1.0);
          float factor = 1.0 - darkening;
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

          // 9-tap separable Gaussian (wider kernel than 5-tap; fewer boxy gaps at high uRadius).
          float s = texture2D(tInput, vUv).r * 0.2270270270;
          s += texture2D(tInput, vUv + stepUv * 1.0).r * 0.1945945946;
          s += texture2D(tInput, vUv - stepUv * 1.0).r * 0.1945945946;
          s += texture2D(tInput, vUv + stepUv * 2.0).r * 0.1216216216;
          s += texture2D(tInput, vUv - stepUv * 2.0).r * 0.1216216216;
          s += texture2D(tInput, vUv + stepUv * 3.0).r * 0.0540540541;
          s += texture2D(tInput, vUv - stepUv * 3.0).r * 0.0540540541;
          s += texture2D(tInput, vUv + stepUv * 4.0).r * 0.0162162162;
          s += texture2D(tInput, vUv - stepUv * 4.0).r * 0.0162162162;

          gl_FragColor = vec4(vec3(clamp(s, 0.0, 1.0)), 1.0);
        }
      `,
      depthTest: false,
      depthWrite: false,
      transparent: false,
      blending: THREE.NoBlending,
    });
    this._blurMaterial.toneMapped = false;

    this._copyMaterial = new THREE.ShaderMaterial({
      uniforms: {
        tMap: { value: null },
      },
      vertexShader: `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = vec4(position.xy, 0.0, 1.0);
        }
      `,
      fragmentShader: `
        uniform sampler2D tMap;
        varying vec2 vUv;
        void main() {
          gl_FragColor = texture2D(tMap, vUv);
        }
      `,
      depthTest: false,
      depthWrite: false,
      transparent: false,
      blending: THREE.NoBlending,
    });
    this._copyMaterial.toneMapped = false;

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

    if (!this._sharpHoldTarget) {
      this._sharpHoldTarget = new THREE.WebGLRenderTarget(rtWidth, rtHeight, {
        minFilter: THREE.LinearFilter,
        magFilter: THREE.LinearFilter,
        format: THREE.RGBAFormat,
        type: THREE.UnsignedByteType,
        depthBuffer: false,
        stencilBuffer: false,
      });
    } else {
      this._sharpHoldTarget.setSize(rtWidth, rtHeight);
    }

    if (this._projectMaterial?.uniforms?.uTexelSize) {
      this._projectMaterial.uniforms.uTexelSize.value.set(1 / rtWidth, 1 / rtHeight);
    }
    if (this._blurMaterial?.uniforms?.uTexelSize) {
      this._blurMaterial.uniforms.uTexelSize.value.set(1 / rtWidth, 1 / rtHeight);
    }

    this._ensurePerFloorLitTargets(rtWidth, rtHeight);
    this._invalidatePerFloorLitCache();
    this._invalidateShadowRenderCache();
    // Never wipe groundOnlyLit / per-floor lit RTs on resize — PaintedShadowEffectV2
    // does not clear them; clearing floor-0 here left all-white targets when the
    // render cache skipped on the same frame.
    this._clearShadowTargetToWhite(this.renderer, { includeGroundOnlyLit: false });
  }

  /**
   * @param {number} rtWidth
   * @param {number} rtHeight
   * @private
   */
  _ensurePerFloorLitTargets(rtWidth, rtHeight) {
    const THREE = window.THREE;
    if (!THREE || !rtWidth || !rtHeight) return;
    const w = Math.max(1, rtWidth | 0);
    const h = Math.max(1, rtHeight | 0);
    const rtOpts = {
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      format: THREE.RGBAFormat,
      type: THREE.UnsignedByteType,
      depthBuffer: false,
      stencilBuffer: false,
    };
    if (!this._groundOnlyLitTarget) {
      this._groundOnlyLitTarget = new THREE.WebGLRenderTarget(w, h, rtOpts);
    } else {
      this._groundOnlyLitTarget.setSize(w, h);
    }
    this._perFloorLitTargets[0] = this._groundOnlyLitTarget;
    if (!this._litScratchTarget) {
      this._litScratchTarget = new THREE.WebGLRenderTarget(w, h, rtOpts);
    } else {
      this._litScratchTarget.setSize(w, h);
    }
    for (let i = 1; i <= 3; i++) {
      if (!this._perFloorLitTargets[i]) {
        this._perFloorLitTargets[i] = new THREE.WebGLRenderTarget(w, h, rtOpts);
      } else {
        this._perFloorLitTargets[i].setSize(w, h);
      }
    }
  }

  /** @private */
  _invalidatePerFloorLitCache() {
    for (let i = 0; i < 4; i++) this._perFloorLitLastFillSerial[i] = 0;
  }

  /**
   * @param {object} compositor
   * @param {number} receiverFloorIndex
   * @returns {string[]}
   * @private
   */
  _computeSourceFloorKeysForReceiver(compositor, receiverFloorIndex) {
    const recvIdx = Number.isFinite(Number(receiverFloorIndex))
      ? Math.max(0, Math.floor(Number(receiverFloorIndex)))
      : 0;
    const ctx = window.MapShine?.activeLevelContext ?? null;
    const activeKey = (ctx && Number.isFinite(Number(ctx.bottom)) && Number.isFinite(Number(ctx.top)))
      ? `${ctx.bottom}:${ctx.top}`
      : null;
    const activeBottom = Number(ctx?.bottom);

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
    const floors = floorStack?.getFloors?.() ?? [];
    const keys = [];
    const seen = new Set();
    const pushKey = (key) => {
      if (!key || seen.has(key)) return;
      if (!compositor.getFloorTexture(key, 'outdoors')) return;
      seen.add(key);
      keys.push(key);
    };

    if (Array.isArray(floors) && floors.length > 0) {
      for (const floor of floors) {
        if (!Number.isFinite(floor?.index) || floor.index < recvIdx) continue;
        const ck = floor?.compositorKey != null ? String(floor.compositorKey) : '';
        if (ck) pushKey(ck);
        const b = Number(floor?.elevationMin);
        const t = Number(floor?.elevationMax);
        if (Number.isFinite(b) && Number.isFinite(t)) {
          pushKey(`${b}:${t}`);
        }
      }
    }

    if (keys.length === 0 && activeKey) {
      pushKey(activeKey);
    }

    if (keys.length === 0 && cachedEntries.length > 0) {
      cachedEntries.sort((a, b) => a.bottom - b.bottom);
      if (Number.isFinite(activeBottom)) {
        const filtered = cachedEntries
          .filter((entry) => entry.bottom >= activeBottom)
          .map((entry) => entry.key);
        if (filtered.length > 0) return filtered;
      }
      if (floors.length <= 1 || recvIdx <= 0) {
        return cachedEntries.map((entry) => entry.key);
      }
    }

    const skipGroundGlobalFallback = floors.length > 1 && recvIdx > 0;
    if (keys.length === 0 && (floors.length <= 1 || recvIdx <= 0)) {
      pushKey('ground');
    }

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

    if (keys.length === 0 && activeKey && compositor && !seen.has(activeKey)) {
      seen.add(activeKey);
      keys.push(activeKey);
    }

    return keys;
  }

  /**
   * @param {object} compositor
   * @param {string|null|undefined} floorKey
   * @returns {import('three').Texture|null}
   * @private
   */
  _resolveOutdoorsTextureForFloorKey(compositor, floorKey) {
    if (!compositor || floorKey == null || floorKey === '') return null;
    const key = String(floorKey);
    // Scene-aligned GPU compose RT (matches PaintedShadowEffectV2). Authored bundle
    // meta is tile/map space and misaligns in the building-shadow projector pass.
    const gpuTex = compositor._floorCache?.get?.(key)?.get?.('outdoors')?.texture ?? null;
    if (gpuTex) return gpuTex;
    if (typeof compositor.ensureSceneSpaceOutdoorsForFloor === 'function') {
      const baked = compositor.ensureSceneSpaceOutdoorsForFloor(key, canvas?.scene ?? null);
      if (baked) return baked;
    }
    return compositor.getFloorTexture?.(key, 'outdoors')
      ?? resolveAuthoredOutdoorsForFloorKey(compositor, key)
      ?? null;
  }

  /**
   * Promote bundle-only lower-band _Outdoors into scene-space GPU RTs before shadow projection.
   * @param {object} compositor
   * @private
   */
  _ensureStackFloorOutdoorsGpu(compositor) {
    if (!compositor || typeof compositor.ensureSceneSpaceOutdoorsForFloor !== 'function') return;
    const floorCount = Number(window.MapShine?.floorStack?.getFloors?.()?.length ?? 0);
    if (floorCount <= 1) return;
    const scene = canvas?.scene ?? null;
    const visibleKeys = new Set(
      (window.MapShine?.floorStack?.getVisibleFloors?.() ?? [])
        .map((f) => (f?.compositorKey != null ? String(f.compositorKey) : ''))
        .filter(Boolean),
    );
    for (const floor of window.MapShine?.floorStack?.getFloors?.() ?? []) {
      const ck = floor?.compositorKey != null ? String(floor.compositorKey) : '';
      if (!ck) continue;
      const idx = Number(floor?.index);
      if (Number.isFinite(idx) && idx > 0 && !visibleKeys.has(ck)) continue;
      if (compositor._floorCache?.get?.(ck)?.get?.('outdoors')?.texture) continue;
      try {
        compositor.ensureSceneSpaceOutdoorsForFloor(ck, scene);
      } catch (_) {}
    }
  }

  /**
   * Populate {@link #_outdoorsMasks} from FloorStack + authored bundle masks (not only GPU RT cache).
   * @param {object} compositor
   * @returns {(import('three').Texture|null)[]}
   * @private
   */
  _syncOutdoorsMaskSlots(compositor) {
    this._outdoorsMasks = [null, null, null, null];
    this._floorIdTex = compositor?.floorIdTarget?.texture ?? null;
    if (!compositor) return this._outdoorsMasks;
    this._ensureStackFloorOutdoorsGpu(compositor);
    try {
      const floors = window.MapShine?.floorStack?.getFloors?.() ?? [];
      for (const floor of floors) {
        const idx = Number(floor?.index);
        if (!Number.isFinite(idx) || idx < 0 || idx > 3) continue;
        const ck = floor?.compositorKey != null ? String(floor.compositorKey) : '';
        let tex = ck ? this._resolveOutdoorsTextureForFloorKey(compositor, ck) : null;
        if (!tex) {
          const b = Number(floor?.elevationMin);
          const t = Number(floor?.elevationMax);
          if (Number.isFinite(b) && Number.isFinite(t)) {
            tex = this._resolveOutdoorsTextureForFloorKey(compositor, `${b}:${t}`);
          }
        }
        this._outdoorsMasks[idx] = tex ?? this._outdoorsMasks[idx] ?? null;
      }
      const { textures: recvSlots, floorIdTex } = collectOutdoorsTexturesByFloorIndex(compositor);
      if (floorIdTex) this._floorIdTex = floorIdTex;
      for (let i = 0; i < 4; i++) {
        if (!this._outdoorsMasks[i] && recvSlots[i]) {
          this._outdoorsMasks[i] = recvSlots[i];
        }
      }
    } catch (_) {}
    return this._outdoorsMasks;
  }

  /**
   * Caster outdoors textures for floors at/above the receiver index (deduped by uuid).
   * @param {object} compositor
   * @param {number} receiverIdx
   * @returns {import('three').Texture[]}
   * @private
   */
  _resolveCasterTexturesForReceiver(compositor, receiverIdx) {
    const recvIdx = Math.max(0, Math.floor(Number(receiverIdx)));
    const floors = window.MapShine?.floorStack?.getFloors?.() ?? [];
    const seen = new Set();
    /** @type {import('three').Texture[]} */
    const textures = [];
    const pushTex = (tex) => {
      if (!tex?.uuid || seen.has(tex.uuid)) return;
      seen.add(tex.uuid);
      textures.push(tex);
    };
    for (const floor of floors) {
      const idx = Number(floor?.index);
      if (!Number.isFinite(idx) || idx < recvIdx) continue;
      const ck = floor?.compositorKey != null ? String(floor.compositorKey) : '';
      if (ck) pushTex(this._resolveOutdoorsTextureForFloorKey(compositor, ck));
      const b = Number(floor?.elevationMin);
      const t = Number(floor?.elevationMax);
      if (Number.isFinite(b) && Number.isFinite(t)) {
        pushTex(this._resolveOutdoorsTextureForFloorKey(compositor, `${b}:${t}`));
      }
    }
    return textures;
  }

  /**
   * @param {object} compositor
   * @private
   */
  _bindOutdoorsSlotUniforms(compositor) {
    if (!this._projectMaterial?.uniforms || !compositor) return;
    const pu = this._projectMaterial.uniforms;
    const slots = this._syncOutdoorsMaskSlots(compositor);
    pu.tFloorId.value = this._floorIdTex;
    pu.uHasFloorId.value = this._floorIdTex ? 1.0 : 0.0;
    pu.uFloorIdFlipY.value = 1.0;
    for (let i = 0; i < 4; i++) {
      const t = slots[i] ?? null;
      pu[`tOutdoors${i}`].value = t;
      pu[`uHasOutdoors${i}`].value = t ? 1.0 : 0.0;
      pu[`uOutdoors${i}FlipY`].value = t?.flipY ? 1.0 : 0.0;
    }
  }

  /**
   * @param {number} floorIndex
   * @returns {boolean}
   * @private
   */
  _hasOutdoorsMaskForFloor(floorIndex) {
    const idx = Number(floorIndex);
    if (!Number.isFinite(idx) || idx < 0 || idx > 3) return false;
    return !!this._outdoorsMasks?.[idx];
  }

  /**
   * Project + blur + invert into a lit-factor RT for one receiver floor.
   * @param {import('three').WebGLRenderer} renderer
   * @param {string[]} floorKeys
   * @param {import('three').Texture|null} fallbackMask
   * @param {number} receiverFloorIndex
   * @param {import('three').WebGLRenderTarget} litTarget
   * @param {object} compositor
   * @returns {import('three').Texture|null}
   * @private
   */
  _renderShadowFactorToTarget(renderer, floorKeys, fallbackMask, receiverFloorIndex, litTarget, compositor) {
    const THREE = window.THREE;
    if (!THREE || !renderer || !litTarget || !this._projectMaterial || !this._invertMaterial || !this._scene || !this._quad) {
      return null;
    }

    const pu = this._projectMaterial.uniforms;
    const prevRecvIdx = pu.uReceiverFloorIndex.value;
    pu.uReceiverFloorIndex.value = Number.isFinite(Number(receiverFloorIndex))
      ? Math.max(0, Math.min(3, Math.floor(Number(receiverFloorIndex))))
      : -1.0;

    const prevTarget = renderer.getRenderTarget();
    const prevAutoClear = renderer.autoClear;

    renderer.setRenderTarget(this._strengthTarget);
    renderer.setClearColor(0x000000, 1);
    renderer.clear();
    renderer.autoClear = false;

    this._quad.material = this._projectMaterial;
    let drewAny = false;
    const recvIdx = Number(receiverFloorIndex);
    const perFloorCasters = Number.isFinite(recvIdx) && recvIdx >= 0;
    const casterTextures = perFloorCasters
      ? this._resolveCasterTexturesForReceiver(compositor, recvIdx)
      : [];

    if (casterTextures.length > 0) {
      for (const maskTex of casterTextures) {
        pu.uOutdoorsMask.value = maskTex;
        pu.uHasMask.value = 1.0;
        pu.uOutdoorsMaskFlipY.value = maskTex?.flipY ? 1.0 : 0.0;
        renderer.render(this._scene, this._camera);
        drewAny = true;
      }
    } else {
      for (const key of floorKeys) {
        if (key === 'full-outdoors') {
          pu.uOutdoorsMask.value = null;
          pu.uHasMask.value = 0.0;
          pu.uOutdoorsMaskFlipY.value = 0.0;
          renderer.render(this._scene, this._camera);
          drewAny = true;
          continue;
        }
        const maskTex = key === 'bundle'
          ? fallbackMask
          : this._resolveOutdoorsTextureForFloorKey(compositor, key)
            ?? compositor.getFloorTexture?.(key, 'outdoors');
        if (!maskTex) continue;
        pu.uOutdoorsMask.value = maskTex;
        pu.uHasMask.value = 1.0;
        pu.uOutdoorsMaskFlipY.value = maskTex?.flipY ? 1.0 : 0.0;
        renderer.render(this._scene, this._camera);
        drewAny = true;
      }
    }

    if (!drewAny && fallbackMask) {
      pu.uOutdoorsMask.value = fallbackMask;
      pu.uHasMask.value = 1.0;
      pu.uOutdoorsMaskFlipY.value = fallbackMask?.flipY ? 1.0 : 0.0;
      renderer.render(this._scene, this._camera);
      drewAny = true;
    }

    if (!drewAny) {
      pu.uOutdoorsMask.value = null;
      pu.uHasMask.value = 0.0;
      pu.uOutdoorsMaskFlipY.value = 0.0;
      renderer.render(this._scene, this._camera);
      drewAny = true;
    }

    const blurRadius = this._getEffectiveBlurRadius();
    const useBlur = !!this._blurMaterial && !!this._blurTarget && blurRadius > 0.01;
    let finalStrengthTex = this._strengthTarget.texture;

    const contactP = Number(this.params.contactShadowPreserve ?? 1);
    const preserveContact =
      !!this._sharpHoldTarget &&
      !!this._copyMaterial &&
      Number.isFinite(contactP) &&
      contactP > 1e-4;

    if (useBlur) {
      this._quad.material = this._blurMaterial;
      let blurSrc = this._strengthTarget.texture;

      if (preserveContact) {
        this._quad.material = this._copyMaterial;
        this._copyMaterial.uniforms.tMap.value = this._strengthTarget.texture;
        renderer.setRenderTarget(this._sharpHoldTarget);
        renderer.setClearColor(0x000000, 1);
        renderer.clear();
        renderer.render(this._scene, this._camera);
        blurSrc = this._sharpHoldTarget.texture;
        this._quad.material = this._blurMaterial;
      }

      this._blurMaterial.uniforms.tInput.value = blurSrc;
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
    if (this._invertMaterial.uniforms.uStrengthTexelSize) {
      const sw = Math.max(1, this._strengthTarget.width | 0);
      const sh = Math.max(1, this._strengthTarget.height | 0);
      this._invertMaterial.uniforms.uStrengthTexelSize.value.set(1 / sw, 1 / sh);
    }
    this._invertMaterial.uniforms.tStrength.value = finalStrengthTex;
    if (this._invertMaterial.uniforms.tSharpStrength) {
      const sharpTex = (preserveContact && useBlur && this._sharpHoldTarget?.texture)
        ? this._sharpHoldTarget.texture
        : finalStrengthTex;
      this._invertMaterial.uniforms.tSharpStrength.value = sharpTex;
    }
    renderer.setRenderTarget(litTarget);
    renderer.setClearColor(0xffffff, 1);
    renderer.clear();
    renderer.render(this._scene, this._camera);

    pu.uReceiverFloorIndex.value = prevRecvIdx;
    renderer.autoClear = prevAutoClear;
    renderer.setRenderTarget(prevTarget);

    return litTarget.texture ?? null;
  }

  /**
   * @param {import('three').WebGLRenderer} renderer
   * @param {number} floorIndex
   * @param {import('three').WebGLRenderTarget} litTarget
   * @returns {import('three').Texture|null}
   * @private
   */
  _renderSingleFloorLit(renderer, floorIndex, litTarget) {
    const idx = Math.max(0, Math.min(3, Math.floor(Number(floorIndex))));
    const compositor = window.MapShine?.sceneComposer?._sceneMaskCompositor ?? null;
    if (!compositor) return this.shadowFactorTexture ?? null;

    this.update(null);
    this._bindOutdoorsSlotUniforms(compositor);

    const floorCount = Number(window.MapShine?.floorStack?.getFloors?.()?.length ?? 0);
    const allowFallbackMask = floorCount <= 1;
    let fallbackMask = allowFallbackMask ? (this._outdoorsMask ?? null) : null;
    if (allowFallbackMask && !fallbackMask) {
      fallbackMask = resolveCompositorOutdoorsTexture(
        compositor,
        window.MapShine?.activeLevelContext ?? null,
        {
          skipGroundFallback: this._skipGroundAndBundleFallbackForUpperMultiFloor(),
          allowBundleFallback: !this._skipGroundAndBundleFallbackForUpperMultiFloor(),
        },
      ).texture ?? null;
    }

    return this._renderShadowFactorToTarget(
      renderer,
      [],
      fallbackMask,
      idx,
      litTarget,
      compositor,
    );
  }

  update(_timeInfo) {
    if (!this._projectMaterial) return;

    this._updateSunDirection();

    const u = this._projectMaterial.uniforms;
    u.uLength.value = resolveBakeRayLength(this, this._getEffectiveRayLength());
    u.uSoftness.value = this.params.softness * (Number(this._driverShadowSoftnessScale) || 1.0);
    u.uSmear.value = resolveBakeSmear(
      this,
      Math.max(0, Number(this.params.smear) || 0)
        * Math.max(0, Number(this._driverShadowSmearScale) || 1.0),
    );
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
    const iu = this._invertMaterial?.uniforms;
    if (iu?.uShadowStrengthBoost) {
      const b = Number(this.params.shadowStrengthBoost);
      iu.uShadowStrengthBoost.value = Number.isFinite(b)
        ? Math.max(1.0, Math.min(10.0, b))
        : 1.0;
    }
    if (iu?.uContactShadowPreserve) {
      const p = Number(this.params.contactShadowPreserve);
      iu.uContactShadowPreserve.value = Number.isFinite(p) ? Math.max(0.0, Math.min(1.0, p)) : 1.0;
    }
    if (iu?.uContactSharpBlendLow && iu?.uContactSharpBlendHigh) {
      let lo = Number(this.params.contactSharpBlendLow);
      let hi = Number(this.params.contactSharpBlendHigh);
      if (!Number.isFinite(lo)) lo = 0.04;
      if (!Number.isFinite(hi)) hi = 0.78;
      if (hi <= lo + 1e-4) hi = lo + 1e-4;
      lo = Math.max(0.0, Math.min(0.999, lo));
      hi = Math.max(lo + 1e-4, Math.min(1.0, hi));
      iu.uContactSharpBlendLow.value = lo;
      iu.uContactSharpBlendHigh.value = hi;
    }
    if (iu?.uShadowEdgeInflatePx) {
      const inf = Number(this.params.shadowEdgeInflatePx);
      iu.uShadowEdgeInflatePx.value = Number.isFinite(inf) ? Math.max(0.0, Math.min(32.0, inf)) : 0.0;
    }
    if (this._blurMaterial?.uniforms?.uRadius) {
      this._blurMaterial.uniforms.uRadius.value = this._getEffectiveBlurRadius();
    }
  }

  setSunAngles(azimuthDeg, elevationDeg) {
    this._sunAzimuthDeg = Number(azimuthDeg);
    this._sunElevationDeg = Number(elevationDeg);
  }

  setDynamicLightOverride(payload = null) {
    this._dynamicLightOverride = payload && typeof payload === 'object' ? payload : null;
  }

  setDriver(driverState = null) {
    if (!driverState) return;
    this.setSunAngles(driverState.sun?.azimuthDeg, driverState.sun?.elevationDeg);
    this.setDynamicLightOverride(driverState.dynamicLightOverride ?? null);
    // Phase 5: driver-derived softness scales every directional producer from
    // the same cloud-cover response while preserving the artist-authored base.
    if (Number.isFinite(Number(driverState.tuning?.shadowSoftnessScale))) {
      this._driverShadowSoftnessScale = Number(driverState.tuning.shadowSoftnessScale);
    }
    if (Number.isFinite(Number(driverState.tuning?.shadowLengthScale))) {
      this._driverShadowLengthScale = Number(driverState.tuning.shadowLengthScale);
    }
    if (Number.isFinite(Number(driverState.tuning?.shadowSmearScale))) {
      this._driverShadowSmearScale = Number(driverState.tuning.shadowSmearScale);
    }
  }

  /**
   * Time-of-day length: peaks near ~400 mask px at dawn/dusk (default slider), ~0 at noon/midnight.
   * @returns {number}
   */
  _getEffectiveRayLength() {
    const rawSlider = Number(this.params?.length);
    const base = Number.isFinite(rawSlider) ? rawSlider : BUILDING_SHADOW_DEFAULT_LENGTH;
    const artistScale = base / BUILDING_SHADOW_DEFAULT_LENGTH;
    const timeW = Number.isFinite(Number(this._driverShadowLengthScale))
      ? Math.max(0.0, Math.min(1.0, Number(this._driverShadowLengthScale)))
      : 1.0;
    return BUILDING_SHADOW_PEAK_U_LENGTH * artistScale * timeW;
  }

  /**
   * Post-projector blur radius; scales up when dawn/dusk lengthens shadows so the tail stays smooth.
   * @returns {number}
   */
  _getEffectiveBlurRadius() {
    const base = Number(this.params.blurRadius ?? 0);
    if (!Number.isFinite(base) || base <= 0.01) return 0;
    const effLen = this._getEffectiveRayLength();
    const peak = BUILDING_SHADOW_PEAK_U_LENGTH;
    const lenT = peak > 1e-6 ? Math.min(2.0, effLen / peak) : 0;
    return Math.min(4.0, base * (1.0 + lenT * 0.45));
  }

  /**
   * Align with {@link FloorCompositor#_resolveOutdoorsMask}: never use lowest-band ground
   * (or scene background bundle) as a stand-in _Outdoors source while viewing an upper
   * floor in a multi-floor stack — that masks the real upper-band mask and kills shadows.
   * @returns {boolean}
   */
  /**
   * Mutate pre-allocated {@link #_healthDiagnostics} (avoids per-frame GC).
   * @param {Record<string, unknown>} fields
   */
  _patchHealthDiagnostics(fields) {
    const h = this._healthDiagnostics;
    for (const key of Object.keys(fields)) {
      const value = fields[key];
      if (key === 'floorKeys' && Array.isArray(value)) {
        h.floorKeys.length = 0;
        for (let i = 0; i < value.length; i++) h.floorKeys.push(value[i]);
      } else {
        h[key] = value;
      }
    }
  }

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

  /** Force next {@link #render} to run GPU passes (e.g. after clearing shadowTarget). */
  _invalidateShadowRenderCache() {
    this._renderState.time = 0;
  }

  /** @param {number} v @param {number} step */
  _quantizeForCache(v, step) {
    if (!Number.isFinite(v) || step <= 0) return 0;
    return Math.round(v / step) * step;
  }

  /** @param {number|null|undefined} a @param {number|null|undefined} b @param {number} eps */
  _numChanged(a, b, eps) {
    const na = Number(a);
    const nb = Number(b);
    if (!Number.isFinite(na) && !Number.isFinite(nb)) return false;
    if (!Number.isFinite(na) || !Number.isFinite(nb)) return true;
    return Math.abs(na - nb) > eps;
  }

  /**
   * Snap camera view bounds so sub-texel camera jitter does not bust the cache.
   * @param {{x:number,y:number,z:number,w:number}|null|undefined} vb
   * @returns {{x:number,y:number,z:number,w:number}|null}
   */
  _quantizeViewBoundsForCache(vb) {
    if (!vb) return null;
    const step = BUILDING_SHADOW_VIEW_BOUNDS_QUANTIZE;
    return {
      x: this._quantizeForCache(vb.x, step),
      y: this._quantizeForCache(vb.y, step),
      z: this._quantizeForCache(vb.z, step),
      w: this._quantizeForCache(vb.w, step),
    };
  }

  /**
   * @param {number} now
   * @param {object} snap
   */
  _commitRenderState(now, snap) {
    const rs = this._renderState;
    rs.time = now;
    rs.sunAz = snap.sunAz;
    rs.sunEl = snap.sunEl;
    rs.driverLen = snap.driverLen;
    rs.driverSoft = snap.driverSoft;
    rs.driverSmear = snap.driverSmear;
    rs.rtWidth = snap.rtWidth;
    rs.rtHeight = snap.rtHeight;
    rs.floorKeys = snap.floorKeys;
    rs.recvUuid = snap.recvUuid;
    rs.fallbackUuid = snap.fallbackUuid;
    rs.outdoorsUuid = snap.outdoorsUuid;
    rs.dynTexVersion = snap.dynTexVersion;
    rs.winTexVersion = snap.winTexVersion;
    rs.dloStrength = snap.dloStrength;
    rs.dloEnabled = snap.dloEnabled;
    rs.sw = snap.sw;
    rs.sh = snap.sh;
    rs.vbX = snap.vbX;
    rs.vbY = snap.vbY;
    rs.vbZ = snap.vbZ;
    rs.vbW = snap.vbW;
    rs.srX = snap.srX;
    rs.srY = snap.srY;
    rs.srZ = snap.srZ;
    rs.srW = snap.srW;
    rs.sdimX = snap.sdimX;
    rs.sdimY = snap.sdimY;
    rs.outdoorsRoute = snap.outdoorsRoute;
    rs.outdoorsKey = snap.outdoorsKey;
    rs.floorIdUuid = snap.floorIdUuid;
    rs.outdoorsUuid0 = snap.outdoorsUuid0;
    rs.outdoorsUuid1 = snap.outdoorsUuid1;
    rs.outdoorsUuid2 = snap.outdoorsUuid2;
    rs.outdoorsUuid3 = snap.outdoorsUuid3;
    rs.floorCacheVersion = snap.floorCacheVersion;
  }

  /**
   * @param {string[]} floorKeys
   * @param {THREE.Texture|null} receiverMaskTex
   * @param {THREE.Texture|null} fallbackMask
   * @param {{route:string|null, resolvedKey:string|null}|null} [outdoorResolve]
   * @param {object|null} [compositor]
   * @returns {boolean}
   */
  _buildRenderSnapshot(floorKeys, receiverMaskTex, fallbackMask, outdoorResolve = null, compositor = null) {
    const keysStr = floorKeys ? floorKeys.join('|') : '';
    const dlo = this._dynamicLightOverride;
    const dynTex = dlo?.texture ?? null;
    const winTex = dlo?.windowTexture ?? null;
    const vbQ = this._quantizeViewBoundsForCache(dlo?.viewBounds);
    const sr = dlo?.sceneRect;
    const sdim = dlo?.sceneDimensions;
    const dims = canvas?.dimensions;
    const sw = dims?.sceneWidth || dims?.width || 1;
    const sh = dims?.sceneHeight || dims?.height || 1;
    const slots = compositor ? this._syncOutdoorsMaskSlots(compositor) : this._outdoorsMasks;
    let floorCacheVersion = 0;
    try {
      floorCacheVersion = Number(compositor?.getFloorCacheVersion?.() ?? 0);
    } catch (_) {}

    return {
      sunAz: this._sunAzimuthDeg,
      sunEl: this._sunElevationDeg,
      driverLen: this._driverShadowLengthScale,
      driverSoft: this._driverShadowSoftnessScale,
      driverSmear: this._driverShadowSmearScale,
      rtWidth: this._strengthTarget?.width,
      rtHeight: this._strengthTarget?.height,
      floorKeys: keysStr,
      recvUuid: receiverMaskTex?.uuid ?? null,
      fallbackUuid: fallbackMask?.uuid ?? null,
      outdoorsUuid: this._outdoorsMask?.uuid ?? null,
      dynTexVersion: dynTex ? dynTex.version : -1,
      winTexVersion: winTex ? winTex.version : -1,
      dloStrength: dlo?.strength ?? -1,
      dloEnabled: dlo?.enabled !== false,
      sw,
      sh,
      vbX: vbQ?.x ?? 0,
      vbY: vbQ?.y ?? 0,
      vbZ: vbQ?.z ?? 0,
      vbW: vbQ?.w ?? 0,
      srX: sr?.x ?? 0,
      srY: sr?.y ?? 0,
      srZ: sr?.z ?? 0,
      srW: sr?.w ?? 0,
      sdimX: sdim?.x ?? 0,
      sdimY: sdim?.y ?? 0,
      outdoorsRoute: outdoorResolve?.route ?? null,
      outdoorsKey: outdoorResolve?.resolvedKey ?? null,
      floorIdUuid: this._floorIdTex?.uuid ?? null,
      outdoorsUuid0: slots?.[0]?.uuid ?? null,
      outdoorsUuid1: slots?.[1]?.uuid ?? null,
      outdoorsUuid2: slots?.[2]?.uuid ?? null,
      outdoorsUuid3: slots?.[3]?.uuid ?? null,
      floorCacheVersion,
    };
  }

  /**
   * Hard dirty = rebuild immediately. Soft dirty = sun/driver/viewBounds/tex.version (throttled).
   * @param {object} snap
   * @returns {{hard:boolean, soft:boolean}}
   */
  _classifyRenderDirty(snap) {
    const rs = this._renderState;
    let hard = false;
    let soft = false;

    if (
      rs.rtWidth !== snap.rtWidth ||
      rs.rtHeight !== snap.rtHeight ||
      rs.floorKeys !== snap.floorKeys ||
      rs.recvUuid !== snap.recvUuid ||
      rs.fallbackUuid !== snap.fallbackUuid ||
      rs.outdoorsUuid !== snap.outdoorsUuid ||
      rs.dloEnabled !== snap.dloEnabled ||
      rs.sw !== snap.sw ||
      rs.sh !== snap.sh ||
      rs.outdoorsRoute !== snap.outdoorsRoute ||
      rs.outdoorsKey !== snap.outdoorsKey ||
      rs.floorIdUuid !== snap.floorIdUuid ||
      rs.outdoorsUuid0 !== snap.outdoorsUuid0 ||
      rs.outdoorsUuid1 !== snap.outdoorsUuid1 ||
      rs.outdoorsUuid2 !== snap.outdoorsUuid2 ||
      rs.outdoorsUuid3 !== snap.outdoorsUuid3 ||
      rs.floorCacheVersion !== snap.floorCacheVersion
    ) {
      hard = true;
    }

    if (this._numChanged(rs.dloStrength, snap.dloStrength, 1e-5)) hard = true;

    if (
      this._numChanged(rs.sunAz, snap.sunAz, BUILDING_SHADOW_SUN_EPS_DEG) ||
      this._numChanged(rs.sunEl, snap.sunEl, BUILDING_SHADOW_SUN_EPS_DEG) ||
      this._numChanged(rs.driverLen, snap.driverLen, BUILDING_SHADOW_DRIVER_EPS) ||
      this._numChanged(rs.driverSoft, snap.driverSoft, BUILDING_SHADOW_DRIVER_EPS) ||
      this._numChanged(rs.driverSmear, snap.driverSmear, BUILDING_SHADOW_DRIVER_EPS)
    ) {
      soft = true;
    }

    if (
      rs.vbX !== snap.vbX ||
      rs.vbY !== snap.vbY ||
      rs.vbZ !== snap.vbZ ||
      rs.vbW !== snap.vbW ||
      rs.srX !== snap.srX ||
      rs.srY !== snap.srY ||
      rs.srZ !== snap.srZ ||
      rs.srW !== snap.srW ||
      rs.sdimX !== snap.sdimX ||
      rs.sdimY !== snap.sdimY ||
      rs.dynTexVersion !== snap.dynTexVersion ||
      rs.winTexVersion !== snap.winTexVersion
    ) {
      soft = true;
    }

    return { hard, soft };
  }

  /**
   * Returns true when shadow inputs changed or the throttle window elapsed.
   * @param {string[]} floorKeys
   * @param {THREE.Texture|null} receiverMaskTex
   * @param {THREE.Texture|null} fallbackMask
   * @param {{route:string|null, resolvedKey:string|null}|null} [outdoorResolve]
   * @returns {boolean}
   */
  _shouldRender(floorKeys, receiverMaskTex, fallbackMask, outdoorResolve = null, compositor = null) {
    const now = performance.now();

    for (const k in this.params) {
      if (this.params[k] !== this._lastParams[k]) {
        this._lastParams[k] = this.params[k];
        this._commitRenderState(now, this._buildRenderSnapshot(floorKeys, receiverMaskTex, fallbackMask, outdoorResolve, compositor));
        return true;
      }
    }

    const snap = this._buildRenderSnapshot(floorKeys, receiverMaskTex, fallbackMask, outdoorResolve, compositor);
    const { hard, soft } = this._classifyRenderDirty(snap);

    const dlo = this._dynamicLightOverride;
    const hasDynamicLights =
      (dlo?.texture || dlo?.windowTexture) &&
      snap.dloEnabled &&
      this.params.dynamicLightShadowOverrideEnabled !== false;
    const throttleMs = hasDynamicLights
      ? BUILDING_SHADOW_THROTTLE_DYNAMIC_MS
      : BUILDING_SHADOW_THROTTLE_STATIC_MS;
    const safetyMs = hasDynamicLights
      ? BUILDING_SHADOW_SAFETY_DYNAMIC_MS
      : BUILDING_SHADOW_SAFETY_STATIC_MS;
    const elapsed = now - this._renderState.time;

    if (hard) {
      this._commitRenderState(now, snap);
      return true;
    }

    if (soft && elapsed >= throttleMs) {
      this._commitRenderState(now, snap);
      return true;
    }

    if (elapsed >= safetyMs) {
      this._commitRenderState(now, snap);
      return true;
    }

    return false;
  }

  render(renderer, camera) {
    if (camera) this.mainCamera = camera;
    if (!renderer || !this._projectMaterial || !this._invertMaterial || !this._scene || !this._quad || !this.shadowTarget || !this._strengthTarget) {
      return;
    }

    if (!this.params.enabled) {
      this._patchHealthDiagnostics({
        timestamp: Date.now(),
        paramsEnabled: false,
        compositorPresent: false,
        drewAny: false,
        floorKeys: [],
        floorKeyCount: 0,
        note: 'Building shadows disabled',
      });
      this._invalidateShadowRenderCache();
      this._invalidatePerFloorLitCache();
      this._clearShadowTargetToWhite(renderer);
      return;
    }

    const sc = window.MapShine?.sceneComposer;
    const compositor = sc?._sceneMaskCompositor;
    if (!compositor) {
      this._patchHealthDiagnostics({
        timestamp: Date.now(),
        paramsEnabled: true,
        compositorPresent: false,
        drewAny: false,
        floorKeys: [],
        floorKeyCount: 0,
        note: 'GpuSceneMaskCompositor missing',
      });
      this._invalidateShadowRenderCache();
      this._invalidatePerFloorLitCache();
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

    const receiverMaskTex = this._resolveReceiverMaskTexture(compositor);
    this._syncOutdoorsMaskSlots(compositor);

    if (!this._shouldRender(floorKeys, receiverMaskTex, fallbackMask, outdoorResolve, compositor)) {
      const rs = this._renderState;
      const usedBundleFallback = floorKeys.includes('bundle') || (outdoorResolve.route === 'bundle');
      const usedFullOutdoorsFallback = floorKeys.includes('full-outdoors');
      const keyedDrewSim = floorKeys.length > 0 && !usedFullOutdoorsFallback;

      this._patchHealthDiagnostics({
        timestamp: Date.now(),
        paramsEnabled: true,
        compositorPresent: true,
        floorKeys,
        floorKeyCount: floorKeys.length,
        syncOutdoorsMaskUuid: this._outdoorsMask?.uuid ?? null,
        fallbackUsed: !keyedDrewSim && !!fallbackMask,
        fallbackMaskUuid: (!keyedDrewSim && fallbackMask) ? (fallbackMask?.uuid ?? null) : null,
        bundleFallbackUsed: usedBundleFallback,
        fullOutdoorsFallbackUsed: usedFullOutdoorsFallback,
        outdoorsResolveRoute: rs.outdoorsRoute ?? outdoorResolve.route,
        outdoorsResolveKey: rs.outdoorsKey ?? outdoorResolve.resolvedKey,
        drewAny: true,
        receiverMaskUuid: receiverMaskTex?.uuid ?? null,
        shadowFactorTextureUuid: this.shadowTarget?.texture?.uuid ?? null,
        dynamicLightOverrideBound: !!(this._dynamicLightOverride?.texture || this._dynamicLightOverride?.windowTexture),
        note: 'Cached render (optimization)',
      });
      return;
    }

    this.update(null);

    if (this._projectMaterial?.uniforms) {
      const pu = this._projectMaterial.uniforms;
      pu.uReceiverOutdoorsMask.value = receiverMaskTex;
      pu.uHasReceiverMask.value = receiverMaskTex ? 1.0 : 0.0;
      pu.uReceiverOutdoorsMaskFlipY.value = receiverMaskTex?.flipY ? 1.0 : 0.0;
      this._bindOutdoorsSlotUniforms(compositor);
    }

    const multiFloor = floorCount > 1;
    const usedBundleFallback = floorKeys.includes('bundle') || (outdoorResolve.route === 'bundle');
    const usedFullOutdoorsFallback = floorKeys.includes('full-outdoors');
    const stackIndices = [...new Set(
      (window.MapShine?.floorStack?.getFloors?.() ?? [])
        .map((f) => Number(f?.index))
        .filter((i) => Number.isFinite(i) && i >= 0 && i <= 3),
    )].sort((a, b) => a - b);

    if (!multiFloor) {
      this._renderShadowFactorToTarget(
        renderer,
        floorKeys,
        fallbackMask,
        -1,
        this.shadowTarget,
        compositor,
      );
    } else {
      this._perFloorLitCacheSerial++;
      const serial = this._perFloorLitCacheSerial;

      for (const fi of stackIndices) {
        const litTarget = this._perFloorLitTargets[fi]
          ?? (fi === 0 ? this._groundOnlyLitTarget : null);
        if (!litTarget) continue;
        const fb = fi === 0 ? fallbackMask : null;
        this._renderShadowFactorToTarget(renderer, [], fb, fi, litTarget, compositor);
        this._perFloorLitLastFillSerial[fi] = serial;
      }

      // Combined shadowTarget is unused in multi-floor lighting; groundOnlyLitTarget
      // must stay intact — FloorCompositor binds it for level 0 (see PaintedShadowEffectV2).
      this._clearShadowTargetToWhite(renderer, { includeGroundOnlyLit: false });
    }

    this._patchHealthDiagnostics({
      timestamp: Date.now(),
      paramsEnabled: true,
      compositorPresent: true,
      floorKeys,
      floorKeyCount: floorKeys.length,
      syncOutdoorsMaskUuid: this._outdoorsMask?.uuid ?? null,
      fallbackUsed: !!fallbackMask && floorKeys.length === 0,
      fallbackMaskUuid: fallbackMask?.uuid ?? null,
      bundleFallbackUsed: usedBundleFallback,
      fullOutdoorsFallbackUsed: usedFullOutdoorsFallback,
      outdoorsResolveRoute: outdoorResolve.route,
      outdoorsResolveKey: outdoorResolve.resolvedKey,
      drewAny: true,
      receiverMaskUuid: receiverMaskTex?.uuid ?? null,
      shadowFactorTextureUuid: multiFloor
        ? (this._groundOnlyLitTarget?.texture?.uuid ?? null)
        : (this.shadowTarget?.texture?.uuid ?? null),
      dynamicLightOverrideBound: !!(this._dynamicLightOverride?.texture || this._dynamicLightOverride?.windowTexture),
      multiFloorSkipCombined: multiFloor,
      note: null,
    });
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
    return resolveReceiverOutdoorsMaskTexture(compositor, this._outdoorsMask ?? null);
  }

  _maybeWarmFloorMaskCache(compositor, floorCount) {
    if (!compositor) return;
    if (isFloorPreloadSuppressedAfterLevelChange()) return;
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
    const throttleMs = floorCount <= 1 ? 3500 : 4000;
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
    let x = Math.max(1, Math.round(width * scale * INTERNAL_SHADOW_DOWNSAMPLE));
    let y = Math.max(1, Math.round(height * scale * INTERNAL_SHADOW_DOWNSAMPLE));
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
    const sun2d = resolveEffectShadowSun2D({
      azimuthDeg: this._sunAzimuthDeg,
      elevationDeg: this._sunElevationDeg,
      previousDir: this.sunDir,
    });
    this.sunDir = writeEffectSunDir(this.sunDir, sun2d, THREE);
  }

  /**
   * @param {import('three').WebGLRenderer|null} renderer
   * @param {{ includeGroundOnlyLit?: boolean }} [options]
   */
  _clearShadowTargetToWhite(renderer, options = {}) {
    if (!renderer) return;
    const includeGroundOnlyLit = options.includeGroundOnlyLit !== false;
    const prevTarget = renderer.getRenderTarget();
    const targets = [
      this.shadowTarget,
      this._litScratchTarget,
    ].filter(Boolean);
    if (includeGroundOnlyLit && this._groundOnlyLitTarget) {
      targets.push(this._groundOnlyLitTarget);
    }
    for (const rt of targets) {
      renderer.setRenderTarget(rt);
      renderer.setClearColor(0xffffff, 1);
      renderer.clear();
    }
    renderer.setRenderTarget(prevTarget);
  }

  dispose() {
    this._floorKeysCache = null;
    this._floorKeysSigCache = '';
    this._invalidatePerFloorLitCache();
    try { this._strengthTarget?.dispose(); } catch (_) {}
    try { this.shadowTarget?.dispose(); } catch (_) {}
    try { this._blurTarget?.dispose(); } catch (_) {}
    try { this._sharpHoldTarget?.dispose(); } catch (_) {}
    try { this._groundOnlyLitTarget?.dispose(); } catch (_) {}
    try { this._litScratchTarget?.dispose(); } catch (_) {}
    for (let i = 1; i <= 3; i++) {
      try { this._perFloorLitTargets[i]?.dispose?.(); } catch (_) {}
      this._perFloorLitTargets[i] = null;
    }
    try { this._projectMaterial?.dispose(); } catch (_) {}
    try { this._invertMaterial?.dispose(); } catch (_) {}
    try { this._blurMaterial?.dispose(); } catch (_) {}
    try { this._copyMaterial?.dispose(); } catch (_) {}
    try { this._quad?.geometry?.dispose(); } catch (_) {}

    this._strengthTarget = null;
    this.shadowTarget = null;
    this._blurTarget = null;
    this._sharpHoldTarget = null;
    this._groundOnlyLitTarget = null;
    this._litScratchTarget = null;
    this._perFloorLitTargets = [null, null, null, null];
    this._perFloorLitLastFillSerial = [0, 0, 0, 0];
    this._perFloorLitCacheSerial = 0;
    this._outdoorsMasks = [null, null, null, null];
    this._floorIdTex = null;
    this._projectMaterial = null;
    this._invertMaterial = null;
    this._blurMaterial = null;
    this._copyMaterial = null;
    this._quad = null;
    this._scene = null;
    this._camera = null;

    log.info('BuildingShadowsEffectV2 disposed');
  }
}
