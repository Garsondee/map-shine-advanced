/**
 * @fileoverview V2 Specular Effect — per-tile additive specular overlays.
 *
 * HEALTH-WIRING BADGE (Map Shine Breaker Box):
 * If you change outdoors / roof-map binding, per-floor mask resolution, or overlay
 * lifecycle, update HealthEvaluator contracts for `SpecularEffectV2` and keep
 * `_healthDiagnostics` in `render()` accurate for Breaker Box diagnostics.
 *
 * Architecture:
 *   For each tile that has a `_Specular` mask, this effect creates an additive
 *   overlay mesh positioned identically to the albedo tile but at a slightly
 *   higher Z. The overlay uses a custom ShaderMaterial with AdditiveBlending
 *   so specular light is naturally composited on top of the albedo.
 *
 *   Floor isolation is handled entirely by the FloorRenderBus visibility
 *   system — overlay meshes are registered with the bus via addEffectOverlay()
 *   and automatically hidden/shown when setVisibleFloors() is called.
 *
 * V1 → V2 cleanup:
 *   - No EffectMaskRegistry subscription (masks loaded directly per tile)
 *   - No floor-presence gate (bus visibility handles floor isolation)
 *   - No depth-pass occlusion; background/tile specular uses tileStackedOverlayOrder
 *     so overlays interleave with albedo (upper tiles occlude lower specular).
 *   - No base mesh mode (always per-tile overlays with additive blending)
 *   - No dual-pass occluder + color mesh (single additive mesh per tile)
 *   - Shader split into separate module (specular-shader.js)
 *
 * @module compositor-v2/effects/SpecularEffectV2
 */

import { createLogger } from '../../core/log.js';
import { weatherController } from '../../core/WeatherController.js';
import { probeMaskFile } from '../../assets/loader.js';
import {
  tileHasLevelsRange,
  readTileLevelsFlags,
  getViewedLevelBackgroundSrc,
} from '../../foundry/levels-scene-flags.js';
import Coordinates from '../../utils/coordinates.js';
import { getTileBusPlaneSizeAndMirror, getTileVisualCenterFoundryXY } from '../../scene/tile-manager.js';
import { getVertexShader, getFragmentShader } from './specular-shader.js';

const log = createLogger('SpecularEffectV2');

// Z offset above the albedo tile for specular overlays.
// Must be small enough to stay within the same floor's Z band (1.0 per floor)
// but large enough to consistently render on top of the albedo tile.
const SPECULAR_Z_OFFSET = 0.1;

import { tileStackedOverlayOrder } from '../LayerOrderPolicy.js';

// Intra-band delta for specular overlays relative to their tile.
const SPECULAR_EFFECT_DELTA = 1;

// Maximum number of dynamic lights the shader supports (compile-time constant).
const MAX_LIGHTS = 64;

/**
 * Parallel async map with a fixed worker pool. Used so `probeMaskFile` does not
 * run strictly one-after-another across hundreds of tiles (which exceeds the
 * FloorCompositor populate race during heavy FilePicker / mask discovery).
 *
 * @template T, R
 * @param {T[]} items
 * @param {number} limit
 * @param {(item: T, index: number) => Promise<R>} fn
 * @returns {Promise<R[]>}
 */
async function mapWithConcurrency(items, limit, fn) {
  if (!items.length) return [];
  const cap = Math.max(1, Math.min(limit, items.length));
  const results = new Array(items.length);
  let next = 0;

  async function worker() {
    for (;;) {
      const i = next++;
      if (i >= items.length) break;
      results[i] = await fn(items[i], i);
    }
  }

  await Promise.all(Array.from({ length: cap }, () => worker()));
  return results;
}

/** How many `probeMaskFile` calls run at once during populate. */
const SPECULAR_MASK_PROBE_CONCURRENCY = 8;

/** Yield to the browser so sockets/timers stay healthy on huge maps. */
async function yieldPopulateEventLoop() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

// ─── SpecularEffectV2 ────────────────────────────────────────────────────────

export class SpecularEffectV2 {
  /**
   * @param {import('../FloorRenderBus.js').FloorRenderBus} renderBus
   */
  constructor(renderBus) {
    /** @type {import('../FloorRenderBus.js').FloorRenderBus} */
    this._renderBus = renderBus;

    /** @type {boolean} */
    this._enabled = true;

    /** @type {boolean} */
    this._initialized = false;

    /**
     * Per-tile overlay entries. Key: tileId.
     * @type {Map<string, {mesh: THREE.Mesh, material: THREE.ShaderMaterial, floorIndex: number}>}
     */
    this._overlays = new Map();

    /**
     * Tracked Foundry ambient lights for dynamic specular.
     * Key: light document ID. Value: parsed light data.
     * @type {Map<string, {position: THREE.Vector3, color: {r:number,g:number,b:number}, radius: number, dim: number, attenuation: number}>}
     */
    this._lights = new Map();

    /**
     * Shared uniforms object — all overlay materials reference the SAME uniform
     * value objects. Updating a value here updates every overlay in one step
     * (no per-material loop needed for most uniforms).
     * @type {object|null}
     */
    this._sharedUniforms = null;

    // Fallback textures (1x1 black/white) for shader sampler safety.
    /** @type {THREE.DataTexture|null} */
    this._fallbackBlack = null;
    /** @type {THREE.DataTexture|null} */
    this._fallbackWhite = null;

    // Wind accumulation state (integrated from WeatherController each frame).
    this._windAccumX = 0;
    this._windAccumY = 0;

    // Deferred shader compilation state
    /** @type {boolean} True when heavy shader has been compiled */
    this._realShaderCompiled = false;
    /** @type {THREE.ShaderMaterial|null} Template material for post-compile overlay clones */
    this._compiledBaseMaterial = null;
    /** @type {boolean} True when real shader compilation is in progress */
    this._shaderCompilePending = false;
    /** @type {Array<{tileId: string, opts: object}>} Pending overlay creations waiting for shader */
    this._pendingOverlays = [];
    /** @type {number} Count of deferred compile failures */
    this._shaderCompileFailures = 0;
    /** @type {string|null} Last deferred compile error */
    this._lastShaderCompileError = null;

    // Foundry hook IDs for light tracking.
    this._hookIds = {};

    /**
     * Last-frame diagnostics for Map Shine Breaker Box (updated in render()).
     * @type {object|null}
     */
    this._healthDiagnostics = null;

    // Effect parameters — same defaults as V1 for visual parity (minus retired unused fields).
    this.params = {
      enabled: true,
      textureStatus: 'Searching...',
      intensity: 0.4,
      lightColor: { r: 1.0, g: 1.0, b: 1.0 },

      // Multi-layer stripe system
      stripeEnabled: true,
      stripeBlendMode: 0,
      parallaxStrength: 1.5,
      stripeMaskThreshold: 0.1,
      worldPatternScale: 5808.0,

      // Layer 1
      stripe1Enabled: true,
      stripe1Frequency: 11.0,
      stripe1Speed: 0.05,
      stripe1Angle: 115.0,
      stripe1Width: 0.21,
      stripe1Intensity: 5.0,
      stripe1Parallax: 0.2,
      stripe1Wave: 1.7,
      stripe1Gaps: 0.31,
      stripe1Softness: 2.14,

      // Layer 2
      stripe2Enabled: true,
      stripe2Frequency: 15.5,
      stripe2Speed: 0.04,
      stripe2Angle: 111.0,
      stripe2Width: 0.38,
      stripe2Intensity: 5.0,
      stripe2Parallax: 0.1,
      stripe2Wave: 1.6,
      stripe2Gaps: 0.5,
      stripe2Softness: 3.93,

      // Layer 3
      stripe3Enabled: true,
      stripe3Frequency: 5.0,
      stripe3Speed: 0.03,
      stripe3Angle: 162.0,
      stripe3Width: 0.09,
      stripe3Intensity: 5.0,
      stripe3Parallax: -0.1,
      stripe3Wave: 0.4,
      stripe3Gaps: 0.37,
      stripe3Softness: 3.44,

      // Micro Sparkle
      sparkleEnabled: false,
      sparkleIntensity: 0.95,
      sparkleScale: 2460,
      sparkleSpeed: 1.38,

      // Outdoor Cloud Specular
      outdoorCloudSpecularEnabled: true,
      outdoorStripeBlend: 0.8,
      cloudSpecularIntensity: 3.0,

      // Wet Surface (Rain)
      wetSpecularEnabled: true,
      wetInputBrightness: 0.0,
      wetInputGamma: 1.0,
      wetSpecularContrast: 3.0,
      wetBlackPoint: 0.2,
      wetWhitePoint: 1.0,
      wetSpecularIntensity: 1.5,
      wetOutputMax: 1.0,
      wetOutputGamma: 1.0,
      wetBaseSheen: 0.3,
      wetWindRippleStrength: 1.0,

      // Frost / Ice Glaze
      frostGlazeEnabled: true,
      frostThreshold: 0.55,
      frostIntensity: 1.2,
      frostTintStrength: 0.4,

      // Dynamic Light Color Tinting
      dynamicLightTintEnabled: true,
      dynamicLightTintStrength: 0.6,

      // Wind-Driven Stripe Animation
      windDrivenStripesEnabled: true,
      windStripeInfluence: 0.5,

      // Building Shadow Suppression
      buildingShadowSuppressionEnabled: true,
      buildingShadowSuppressionStrength: 0.8,
    };

    log.debug('SpecularEffectV2 created');
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /**
   * Snapshot for Breaker Box / export: specular overlays + _Outdoors binding state.
   * Populated each frame while overlays exist; null if never rendered or cleared.
   * @returns {object|null}
   */
  getHealthDiagnostics() {
    const d = this._healthDiagnostics;
    if (!d) return null;
    return {
      ...d,
      floors: [...(d.floors || [])],
      outdoorsSlots: [...(d.outdoorsSlots || [])],
      overlayByFloor: d.overlayByFloor && typeof d.overlayByFloor === 'object'
        ? { ...d.overlayByFloor }
        : d.overlayByFloor,
      outdoorsFloorIdxHistogram: d.outdoorsFloorIdxHistogram && typeof d.outdoorsFloorIdxHistogram === 'object'
        ? { ...d.outdoorsFloorIdxHistogram }
        : d.outdoorsFloorIdxHistogram,
      wetCloudOutdoorFactor: d.wetCloudOutdoorFactor && typeof d.wetCloudOutdoorFactor === 'object'
        ? { ...d.wetCloudOutdoorFactor }
        : d.wetCloudOutdoorFactor,
      activeFloorOutdoors: d.activeFloorOutdoors && typeof d.activeFloorOutdoors === 'object'
        ? { ...d.activeFloorOutdoors }
        : d.activeFloorOutdoors,
    };
  }

  get enabled() { return this._enabled; }
  set enabled(v) {
    const next = !!v;
    this._enabled = next;
    this.params.enabled = next;
    if (this._sharedUniforms?.uEffectEnabled) {
      this._sharedUniforms.uEffectEnabled.value = next;
    }
    this._syncOverlayVisibility();
  }

  /**
   * Floor visibility changes do not always trigger a full repopulate immediately.
   * Keep the background specular overlay aligned with the newly active floor so
   * per-floor outdoors sampling and bus visibility remain correct across level switches.
   * @param {number} maxFloorIndex
   */
  onFloorChange(maxFloorIndex) {
    const nextFloor = Math.max(0, Math.min(3, Number(maxFloorIndex) || 0));
    this._rebindBackgroundOverlayFloor(nextFloor);
  }

  // ── UI schema (moved from V1 SpecularEffect) ─────────────────────────────

  static getControlSchema() {
    const white = { r: 1, g: 1, b: 1 };
    return {
      enabled: true,
      help: {
        title: 'Metallic / specular (tile overlays)',
        summary: [
          'Draws **additive shine** on top of map tiles (and the scene background) wherever a matching **`_Specular`** texture exists beside the art.',
          'Stripes, sparkles, rain wetness, frost, outdoor/cloud response, and Foundry lights all multiply into that mask — there is no separate PBR roughness or normal-map path.',
          'Uses one overlay mesh per masked tile, rendered through the floor bus so level visibility stays correct.',
          'Performance scales with how many `_Specular` overlays exist and how busy the stripe/sparkle math is; heavy maps benefit from fewer stripe layers or lower intensities.',
          'Settings are stored on the scene (not World Based).',
        ].join('\n\n'),
        glossary: {
          'Mask status': 'Whether the scene found at least one `_Specular` texture after load.',
          Intensity: 'Overall strength of the shine pass.',
          'Specular tint': 'Color multiplied into highlights (white keeps the map neutral).',
          'World scale': 'How large world-space stripe patterns are — higher = bigger, calmer bands.',
          'Outdoor blend': 'How much outdoor areas mix stripe modulation with cloud-lit specular.',
          'Wet surface': 'Rain-driven sheen from albedo brightness, strongest on outdoor pixels.',
          'Building shadow suppression': 'Pulls specular down where the building shadow map is dark.',
        },
      },
      presetApplyDefaults: true,
      groups: [
        {
          name: 'status',
          label: 'Status',
          type: 'folder',
          expanded: true,
          parameters: ['textureStatus'],
        },
        {
          name: 'look',
          label: 'Look',
          type: 'folder',
          expanded: true,
          parameters: ['intensity', 'lightColor'],
        },
        {
          name: 'stripes',
          label: 'Stripes',
          type: 'folder',
          expanded: true,
          parameters: [
            'stripeEnabled', 'stripeBlendMode', 'parallaxStrength', 'stripeMaskThreshold', 'worldPatternScale',
          ],
        },
        {
          name: 'layer1',
          label: 'Stripe layer 1',
          type: 'folder',
          expanded: false,
          parameters: [
            'stripe1Enabled', 'stripe1Frequency', 'stripe1Speed', 'stripe1Angle', 'stripe1Width', 'stripe1Intensity',
            'stripe1Parallax', 'stripe1Wave', 'stripe1Gaps', 'stripe1Softness',
          ],
        },
        {
          name: 'layer2',
          label: 'Stripe layer 2',
          type: 'folder',
          expanded: false,
          parameters: [
            'stripe2Enabled', 'stripe2Frequency', 'stripe2Speed', 'stripe2Angle', 'stripe2Width', 'stripe2Intensity',
            'stripe2Parallax', 'stripe2Wave', 'stripe2Gaps', 'stripe2Softness',
          ],
        },
        {
          name: 'layer3',
          label: 'Stripe layer 3',
          type: 'folder',
          expanded: false,
          parameters: [
            'stripe3Enabled', 'stripe3Frequency', 'stripe3Speed', 'stripe3Angle', 'stripe3Width', 'stripe3Intensity',
            'stripe3Parallax', 'stripe3Wave', 'stripe3Gaps', 'stripe3Softness',
          ],
        },
        {
          name: 'sparkle',
          label: 'Micro sparkle',
          type: 'folder',
          expanded: false,
          parameters: ['sparkleEnabled', 'sparkleIntensity', 'sparkleScale', 'sparkleSpeed'],
        },
        {
          name: 'outdoorCloud',
          label: 'Outdoor & clouds',
          type: 'folder',
          expanded: false,
          parameters: ['outdoorCloudSpecularEnabled', 'outdoorStripeBlend', 'cloudSpecularIntensity'],
        },
        {
          name: 'wet',
          label: 'Wet surface (rain)',
          type: 'folder',
          expanded: false,
          parameters: [
            'wetSpecularEnabled', 'wetInputBrightness', 'wetInputGamma', 'wetSpecularContrast', 'wetBlackPoint', 'wetWhitePoint',
            'wetSpecularIntensity', 'wetOutputMax', 'wetOutputGamma', 'wetBaseSheen', 'wetWindRippleStrength',
          ],
        },
        {
          name: 'frost',
          label: 'Frost / ice',
          type: 'folder',
          expanded: false,
          parameters: ['frostGlazeEnabled', 'frostThreshold', 'frostIntensity', 'frostTintStrength'],
        },
        {
          name: 'lightTint',
          label: 'Dynamic light tint',
          type: 'folder',
          expanded: false,
          parameters: ['dynamicLightTintEnabled', 'dynamicLightTintStrength'],
        },
        {
          name: 'windStripes',
          label: 'Wind-linked stripes',
          type: 'folder',
          expanded: false,
          parameters: ['windDrivenStripesEnabled', 'windStripeInfluence'],
        },
        {
          name: 'buildingShadow',
          label: 'Building shadow suppression',
          type: 'folder',
          expanded: false,
          parameters: ['buildingShadowSuppressionEnabled', 'buildingShadowSuppressionStrength'],
        },
      ],
      parameters: {
        textureStatus: {
          type: 'string',
          label: 'Mask status',
          default: 'Searching...',
          readonly: true,
          tooltip: 'Updated when the scene loads: whether any `_Specular` mask was found for tiles or the background.',
        },
        intensity: {
          type: 'slider',
          label: 'Intensity',
          min: 0,
          max: 2,
          step: 0.01,
          default: 0.4,
          throttle: 100,
          tooltip: 'Master strength of the additive specular pass.',
        },
        lightColor: {
          type: 'color',
          colorType: 'float',
          label: 'Specular tint',
          default: { ...white },
          tooltip: 'Tint multiplied into specular highlights (linear 0–1 per channel).',
        },
        stripeEnabled: {
          type: 'boolean',
          label: 'Stripes on',
          default: true,
          tooltip: 'Animated stripe bands modulate shine in world space.',
        },
        stripeBlendMode: {
          type: 'list',
          label: 'Layer blend',
          options: { Add: 0, Multiply: 1, Screen: 2, Overlay: 3 },
          default: 0,
          tooltip: 'How stripe layers 2–3 combine with layer 1.',
        },
        stripeMaskThreshold: {
          type: 'slider',
          label: 'Brightness gate',
          min: 0,
          max: 1,
          step: 0.01,
          default: 0.1,
          throttle: 100,
          tooltip: 'Stripes only where the specular mask is brighter than this (reduces shine in dark mask areas).',
        },
        worldPatternScale: {
          type: 'slider',
          label: 'World scale (px)',
          min: 256,
          max: 16384,
          step: 16,
          default: 5808,
          throttle: 100,
          tooltip: 'Size of world-space stripe pattern — larger values stretch bands wider.',
        },
        parallaxStrength: {
          type: 'slider',
          label: 'Parallax',
          min: 0,
          max: 2,
          step: 0.1,
          default: 1.5,
          throttle: 100,
          tooltip: 'How much the camera shifts stripe coordinates (depth illusion).',
        },
        stripe1Enabled: { type: 'boolean', label: 'On', default: true },
        stripe1Frequency: { type: 'slider', label: 'Frequency', min: 0.5, max: 20, step: 0.5, default: 11.0, throttle: 100, tooltip: 'How often bands repeat.' },
        stripe1Speed: { type: 'slider', label: 'Speed', min: -1, max: 1, step: 0.001, default: 0.05, throttle: 100, tooltip: 'Scroll speed along the pattern (outdoors only when _Outdoors mask is bound).' },
        stripe1Angle: { type: 'slider', label: 'Angle (°)', min: 0, max: 360, step: 1, default: 115, throttle: 100, tooltip: 'Band direction in degrees.' },
        stripe1Width: { type: 'slider', label: 'Width', min: 0, max: 1, step: 0.01, default: 0.21, throttle: 100, tooltip: 'Thickness of each bright band.' },
        stripe1Intensity: { type: 'slider', label: 'Strength', min: 0, max: 5, step: 0.01, default: 5.0, throttle: 100, tooltip: 'How strong this layer is before blending.' },
        stripe1Parallax: { type: 'slider', label: 'Parallax mix', min: -2, max: 2, step: 0.1, default: 0.2, throttle: 100, tooltip: 'Per-layer parallax weight vs global parallax.' },
        stripe1Wave: { type: 'slider', label: 'Wave', min: 0, max: 2, step: 0.1, default: 1.7, throttle: 100, tooltip: 'Waviness along the bands.' },
        stripe1Gaps: { type: 'slider', label: 'Gaps', min: 0, max: 1, step: 0.01, default: 0.31, throttle: 100, tooltip: 'Noise-driven breaks in the bands.' },
        stripe1Softness: { type: 'slider', label: 'Softness', min: 0, max: 5, step: 0.01, default: 2.14, throttle: 100, tooltip: 'Edge softness of each band.' },
        stripe2Enabled: { type: 'boolean', label: 'On', default: true },
        stripe2Frequency: { type: 'slider', label: 'Frequency', min: 0.5, max: 20, step: 0.5, default: 15.5, throttle: 100, tooltip: 'How often bands repeat.' },
        stripe2Speed: { type: 'slider', label: 'Speed', min: -1, max: 1, step: 0.001, default: 0.04, throttle: 100, tooltip: 'Scroll speed along the pattern (outdoors only when _Outdoors mask is bound).' },
        stripe2Angle: { type: 'slider', label: 'Angle (°)', min: 0, max: 360, step: 1, default: 111, throttle: 100, tooltip: 'Band direction in degrees.' },
        stripe2Width: { type: 'slider', label: 'Width', min: 0, max: 1, step: 0.01, default: 0.38, throttle: 100, tooltip: 'Thickness of each bright band.' },
        stripe2Intensity: { type: 'slider', label: 'Strength', min: 0, max: 5, step: 0.01, default: 5.0, throttle: 100, tooltip: 'How strong this layer is before blending.' },
        stripe2Parallax: { type: 'slider', label: 'Parallax mix', min: -2, max: 2, step: 0.1, default: 0.1, throttle: 100, tooltip: 'Per-layer parallax weight vs global parallax.' },
        stripe2Wave: { type: 'slider', label: 'Wave', min: 0, max: 2, step: 0.1, default: 1.6, throttle: 100, tooltip: 'Waviness along the bands.' },
        stripe2Gaps: { type: 'slider', label: 'Gaps', min: 0, max: 1, step: 0.01, default: 0.5, throttle: 100, tooltip: 'Noise-driven breaks in the bands.' },
        stripe2Softness: { type: 'slider', label: 'Softness', min: 0, max: 5, step: 0.01, default: 3.93, throttle: 100, tooltip: 'Edge softness of each band.' },
        stripe3Enabled: { type: 'boolean', label: 'On', default: true },
        stripe3Frequency: { type: 'slider', label: 'Frequency', min: 0.5, max: 20, step: 0.5, default: 5.0, throttle: 100, tooltip: 'How often bands repeat.' },
        stripe3Speed: { type: 'slider', label: 'Speed', min: -1, max: 1, step: 0.001, default: 0.03, throttle: 100, tooltip: 'Scroll speed along the pattern (outdoors only when _Outdoors mask is bound).' },
        stripe3Angle: { type: 'slider', label: 'Angle (°)', min: 0, max: 360, step: 1, default: 162, throttle: 100, tooltip: 'Band direction in degrees.' },
        stripe3Width: { type: 'slider', label: 'Width', min: 0, max: 1, step: 0.01, default: 0.09, throttle: 100, tooltip: 'Thickness of each bright band.' },
        stripe3Intensity: { type: 'slider', label: 'Strength', min: 0, max: 5, step: 0.01, default: 5.0, throttle: 100, tooltip: 'How strong this layer is before blending.' },
        stripe3Parallax: { type: 'slider', label: 'Parallax mix', min: -2, max: 2, step: 0.1, default: -0.1, throttle: 100, tooltip: 'Per-layer parallax weight vs global parallax.' },
        stripe3Wave: { type: 'slider', label: 'Wave', min: 0, max: 2, step: 0.1, default: 0.4, throttle: 100, tooltip: 'Waviness along the bands.' },
        stripe3Gaps: { type: 'slider', label: 'Gaps', min: 0, max: 1, step: 0.01, default: 0.37, throttle: 100, tooltip: 'Noise-driven breaks in the bands.' },
        stripe3Softness: { type: 'slider', label: 'Softness', min: 0, max: 5, step: 0.01, default: 3.44, throttle: 100, tooltip: 'Edge softness of each band.' },
        sparkleEnabled: { type: 'boolean', label: 'Sparkle on', default: false, tooltip: 'Tiny glints on top of stripe modulation.' },
        sparkleIntensity: { type: 'slider', label: 'Strength', min: 0, max: 2, step: 0.01, default: 0.95, throttle: 100, tooltip: 'Brightness of sparkle cells.' },
        sparkleScale: { type: 'slider', label: 'Density', min: 100, max: 10000, step: 1, default: 2460, throttle: 100, tooltip: 'Higher = smaller, busier sparkles.' },
        sparkleSpeed: { type: 'slider', label: 'Twinkle speed', min: 0, max: 5, step: 0.01, default: 1.38, throttle: 100, tooltip: 'How fast sparkles blink.' },
        outdoorCloudSpecularEnabled: { type: 'boolean', label: 'Cloud specular', default: true, tooltip: 'Brighten outdoor specular where the cloud shadow map says “lit”. Requires cloud shadows from the cloud effect.' },
        outdoorStripeBlend: { type: 'slider', label: 'Outdoor stripe mix', min: 0, max: 1, step: 0.01, default: 0.8, throttle: 100, tooltip: 'How much `_Outdoors` reduces stripe modulation (outdoor areas stay punchier).' },
        cloudSpecularIntensity: { type: 'slider', label: 'Cloud lit boost', min: 0, max: 3, step: 0.01, default: 3, throttle: 100, tooltip: 'Extra additive specular on sunlit outdoor pixels from the cloud pass.' },
        wetSpecularEnabled: { type: 'boolean', label: 'Wet sheen', default: true, tooltip: 'Rain wetness (from weather) adds sheen from albedo brightness.' },
        wetInputBrightness: { type: 'slider', label: 'Input lift', min: -0.5, max: 0.5, step: 0.01, default: 0.0, throttle: 100, tooltip: 'Brightness bias before wet mask extraction.' },
        wetInputGamma: { type: 'slider', label: 'Input gamma', min: 0.1, max: 3.0, step: 0.01, default: 1.0, throttle: 100, tooltip: 'Gamma on albedo grayscale before contrast.' },
        wetSpecularContrast: { type: 'slider', label: 'Input contrast', min: 1, max: 10, step: 0.1, default: 3.0, throttle: 100, tooltip: 'Contrast of the wet mask source.' },
        wetBlackPoint: { type: 'slider', label: 'Black point', min: 0.0, max: 1.0, step: 0.01, default: 0.2, throttle: 100, tooltip: 'Floor for wet mask smoothstep.' },
        wetWhitePoint: { type: 'slider', label: 'White point', min: 0.0, max: 1.0, step: 0.01, default: 1.0, throttle: 100, tooltip: 'Ceiling for wet mask smoothstep.' },
        wetSpecularIntensity: { type: 'slider', label: 'Wet strength', min: 0, max: 5, step: 0.01, default: 1.5, throttle: 100, tooltip: 'How bright the wet layer is after processing.' },
        wetOutputMax: { type: 'slider', label: 'Wet clamp', min: 0.0, max: 3.0, step: 0.01, default: 1.0, throttle: 100, tooltip: 'Hard cap on wet specular RGB.' },
        wetOutputGamma: { type: 'slider', label: 'Wet output gamma', min: 0.1, max: 3.0, step: 0.01, default: 1.0, throttle: 100, tooltip: 'Gamma after clamp (1 = linear).' },
        wetBaseSheen: { type: 'slider', label: 'Outdoor baseline', min: 0.0, max: 2.0, step: 0.01, default: 0.3, throttle: 100, tooltip: 'Minimum wet modulation outdoors so rain still reads when stripes/clouds are subtle.' },
        wetWindRippleStrength: { type: 'slider', label: 'Wind ripple', min: 0.0, max: 3.0, step: 0.01, default: 1.0, throttle: 100, tooltip: 'Animated ripple on wet outdoor surfaces from wind integration.' },
        frostGlazeEnabled: { type: 'boolean', label: 'Frost on', default: true, tooltip: 'Ice glaze on specular when freeze level passes the threshold.' },
        frostThreshold: { type: 'slider', label: 'Freeze threshold', min: 0, max: 1, step: 0.01, default: 0.55, throttle: 100, tooltip: 'Weather freeze level must pass this before frost ramps in.' },
        frostIntensity: { type: 'slider', label: 'Frost strength', min: 0, max: 3, step: 0.01, default: 1.2, throttle: 100, tooltip: 'Brightness of the frost pass.' },
        frostTintStrength: { type: 'slider', label: 'Blue tint', min: 0, max: 1, step: 0.01, default: 0.4, throttle: 100, tooltip: 'How icy-blue the frost appears.' },
        dynamicLightTintEnabled: { type: 'boolean', label: 'Tint from lights', default: true, tooltip: 'Shift specular tint toward the strongest nearby Foundry light color.' },
        dynamicLightTintStrength: { type: 'slider', label: 'Tint mix', min: 0, max: 1, step: 0.01, default: 0.6, throttle: 100, tooltip: 'How far specular tint follows dynamic lights vs the base tint above.' },
        windDrivenStripesEnabled: { type: 'boolean', label: 'Wind-linked motion', default: true, tooltip: 'Integrates weather wind (direction × speed): shifts specular stripe UVs outdoors-only, plus wet-surface ripple sampling.' },
        windStripeInfluence: { type: 'slider', label: 'Wind amount', min: 0, max: 1, step: 0.01, default: 0.5, throttle: 100, tooltip: 'Scales accumulated wind drift on outdoor stripes and wet ripple strength.' },
        buildingShadowSuppressionEnabled: { type: 'boolean', label: 'Suppress in shadow', default: true, tooltip: 'Reduce specular where the building shadow map is dark.' },
        buildingShadowSuppressionStrength: { type: 'slider', label: 'Shadow mix', min: 0, max: 1, step: 0.01, default: 0.8, throttle: 100, tooltip: 'How strongly building shadows multiply specular down.' },
      },
      presets: {
        Gentle: {
          intensity: 0.22,
          outdoorStripeBlend: 0.45,
          cloudSpecularIntensity: 1.4,
          stripe1Intensity: 3.2,
          stripe2Intensity: 3.2,
          stripe3Intensity: 3.2,
          lightColor: { ...white },
        },
        'Rainy sheen': {
          wetSpecularIntensity: 2.1,
          wetBaseSheen: 0.55,
          outdoorStripeBlend: 0.92,
          wetWindRippleStrength: 1.35,
          lightColor: { ...white },
        },
        'Calmer stripes': {
          stripe1Intensity: 3.0,
          stripe2Intensity: 3.0,
          stripe3Intensity: 3.0,
          sparkleEnabled: false,
          parallaxStrength: 1.0,
          lightColor: { ...white },
        },
      },
    };
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  /**
   * Initialize the effect. Call after the FloorRenderBus is initialized.
   */
  initialize() {
    if (this._initialized) return;
    const THREE = window.THREE;
    if (!THREE) { log.warn('initialize: THREE not available'); return; }

    this._buildFallbackTextures();
    this._buildSharedUniforms();
    this._registerLightHooks();

    this._initialized = true;
    log.info('SpecularEffectV2 initialized');
  }

  /**
   * Populate specular overlays for all tiles in the scene.
   * Call after FloorRenderBus.populate() so tile geometry is already built.
   *
   * For each tile, probes for `_Specular` mask. If found, creates an overlay
   * mesh with the specular shader and registers it with the bus.
   *
   * @param {object} foundrySceneData - Scene geometry data from SceneComposer
   */
  async populate(foundrySceneData) {
    if (!this._initialized) { log.warn('populate: not initialized'); return; }
    this.clear();
    this._syncOverlayVisibility();

    const floors = window.MapShine?.floorStack?.getFloors() ?? [];
    const activeFloor = window.MapShine?.floorStack?.getActiveFloor?.() ?? null;
    const activeFloorIndex = Number.isFinite(Number(activeFloor?.index))
      ? Number(activeFloor.index)
      : 0;
    const worldH = foundrySceneData?.height ?? 0;

    // Sync all existing lights on scene load.
    this._syncAllLights();

    let overlayCount = 0;

    // ── Process scene background image ────────────────────────────────────
    // The background is not in canvas.scene.tiles.contents — it's handled
    // separately by FloorRenderBus as __bg_image__. Check for its _Specular
    // mask and create an overlay if found.
    const bgSrc = getViewedLevelBackgroundSrc(canvas?.scene) ?? canvas?.scene?.background?.src ?? '';
    if (bgSrc) {
      const dotIdx = bgSrc.lastIndexOf('.');
      const bgBasePath = dotIdx > 0 ? bgSrc.substring(0, dotIdx) : bgSrc;
      const bgSpecResult = await probeMaskFile(bgBasePath, '_Specular');

      if (bgSpecResult?.path) {
        // Background geometry: scene rect in world space.
        const sceneW = foundrySceneData?.sceneWidth ?? foundrySceneData?.width ?? 0;
        const sceneH = foundrySceneData?.sceneHeight ?? foundrySceneData?.height ?? 0;
        const sceneX = foundrySceneData?.sceneX ?? 0;
        const sceneY = foundrySceneData?.sceneY ?? 0;
        const centerX = sceneX + sceneW / 2;
        const centerY = worldH - (sceneY + sceneH / 2);

        // In multi-floor scenes the viewed level background belongs to the
        // active floor band, not always floor 0.
        const bgFloorIndex = floors.length > 1 ? Math.max(0, Math.min(3, activeFloorIndex)) : 0;

        // Keep background below tile plane within its floor band.
        const GROUND_Z = 1000;
        const z = GROUND_Z + bgFloorIndex - 1 + SPECULAR_Z_OFFSET;

        await this._createOverlay('__bg_image__', bgFloorIndex, {
          specularUrl: bgSpecResult.path,
          albedoUrl: bgSrc,
          centerX, centerY, z,
          tileW: sceneW, tileH: sceneH, rotation: 0,
        });

        overlayCount++;
        log.info(`SpecularEffectV2: created background overlay (${sceneW}x${sceneH})`);
      }
    }

    // ── Process placed tiles ──────────────────────────────────────────────
    const tileDocs = canvas?.scene?.tiles?.contents ?? [];
    const candidates = [];
    for (const tileDoc of tileDocs) {
      const src = tileDoc?.texture?.src ?? tileDoc?.img ?? '';
      if (!src) continue;

      const tileId = tileDoc.id ?? tileDoc._id;
      if (!tileId) continue;

      const dotIdx = src.lastIndexOf('.');
      const basePath = dotIdx > 0 ? src.substring(0, dotIdx) : src;
      candidates.push({ tileDoc, tileId, basePath, src });
    }

    log.warn(
      `[POPULATE] SpecularEffectV2: parallel _Specular probe | tileCandidates=${candidates.length} | concurrency=${SPECULAR_MASK_PROBE_CONCURRENCY}`,
    );

    const probeRows = await mapWithConcurrency(
      candidates,
      SPECULAR_MASK_PROBE_CONCURRENCY,
      async ({ tileDoc, tileId, basePath, src }) => {
        const specResult = await probeMaskFile(basePath, '_Specular');
        return { tileDoc, tileId, basePath, src, specResult };
      },
    );

    let tilesWithSpecular = 0;
    for (let i = 0; i < probeRows.length; i++) {
      const row = probeRows[i];
      if (!row.specResult?.path) continue;

      const { tileDoc, tileId, src } = row;

      const floorIndex = this._resolveFloorIndex(tileDoc, floors);

      const { dispW: tileW, dispH: tileH, signX: planeSignX, signY: planeSignY } = getTileBusPlaneSizeAndMirror(tileDoc);
      const { cx: cxf, cy: cyf } = getTileVisualCenterFoundryXY(tileDoc);
      const centerX = cxf;
      const centerY = worldH - cyf;
      const rotation = typeof tileDoc.rotation === 'number'
        ? (tileDoc.rotation * Math.PI) / 180 : 0;

      const GROUND_Z = 1000;
      const z = GROUND_Z + floorIndex + SPECULAR_Z_OFFSET;

      await this._createOverlay(tileId, floorIndex, {
        specularUrl: row.specResult.path,
        albedoUrl: src,
        centerX, centerY, z, tileW, tileH, rotation, planeSignX, planeSignY,
      });

      overlayCount++;
      tilesWithSpecular++;

      if (tilesWithSpecular % 24 === 0) {
        await yieldPopulateEventLoop();
      }
    }

    const totalCount = overlayCount;
    this.params.textureStatus = totalCount > 0
      ? 'Ready (_Specular mask found)'
      : 'Inactive (no _Specular mask)';
    log.info(`SpecularEffectV2 populated: ${totalCount} overlay(s) (${bgSrc ? '1 bg + ' : ''}${overlayCount - (bgSrc && overlayCount > 0 ? 1 : 0)} tiles)`);

    // DEFERRED: Compile real shader after all overlays created with passthrough materials
    if (totalCount > 0 && !this._realShaderCompiled && !this._shaderCompilePending) {
      // Use setTimeout to allow populate() to complete and UI to update
      setTimeout(() => this._compileRealShaderForOverlays(), 0);
    }
    this._syncOverlayVisibility();
  }

  /**
   * Wrapper to create overlay - calls async _createOverlayMesh.
   * @private
   */
  async _createOverlay(tileId, floorIndex, opts) {
    await this._createOverlayMesh(tileId, { ...opts, floorIndex });
  }

  /**
   * Per-frame update. Syncs all time-varying uniforms (weather, params, lights).
   * @param {{ elapsed: number, delta: number }} timeInfo
   */
  update(timeInfo) {
    if (!this._initialized || !this._sharedUniforms) return;
    const u = this._sharedUniforms;

    // ── Time ──────────────────────────────────────────────────────────────
    u.uTime.value = timeInfo.elapsed;

    // ── Weather state ─────────────────────────────────────────────────────
    let rainWetness = 0;
    let frostLevel = 0;
    try {
      const weather = weatherController?.getCurrentState?.();
      if (weather) {
        rainWetness = Math.max(0, Math.min(1, weather.wetness ?? 0));

        // Frost ramp
        if (this.params.frostGlazeEnabled) {
          const ft = this.params.frostThreshold;
          const fl = weather.freezeLevel ?? 0;
          frostLevel = Math.min(1, Math.max(0, (fl - ft) / Math.max(0.001, 1 - ft)));
        }

        // Wind accumulation
        if (this.params.windDrivenStripesEnabled) {
          const ws = weather.windSpeed ?? 0;
          const wd = weather.windDirection;
          const dx = (wd && typeof wd.x === 'number') ? wd.x : 1;
          const dy = (wd && typeof wd.y === 'number') ? wd.y : 0;
          const motionDelta = (typeof timeInfo?.motionDelta === 'number')
            ? timeInfo.motionDelta
            : (typeof timeInfo?.delta === 'number' ? timeInfo.delta : 0.016);
          this._windAccumX += dx * ws * motionDelta * 0.01;
          this._windAccumY += dy * ws * motionDelta * 0.01;
        }
      }
    } catch (_) { /* WeatherController may not be ready */ }

    u.uRainWetness.value = rainWetness;
    u.uFrostLevel.value = frostLevel;
    u.uWindAccum.value.set(this._windAccumX, this._windAccumY);

    // ── Effect parameters ─────────────────────────────────────────────────
    u.uEffectEnabled.value = this._enabled;
    u.uSpecularIntensity.value = this.params.intensity;

    u.uLightColor.value.set(
      this.params.lightColor.r,
      this.params.lightColor.g,
      this.params.lightColor.b
    );

    // Stripe globals
    u.uStripeEnabled.value = this.params.stripeEnabled;
    u.uStripeBlendMode.value = this.params.stripeBlendMode;
    u.uParallaxStrength.value = this.params.parallaxStrength;
    u.uStripeMaskThreshold.value = this.params.stripeMaskThreshold;
    u.uWorldPatternScale.value = this.params.worldPatternScale;

    // Per-layer stripe params
    for (let i = 1; i <= 3; i++) {
      u[`uStripe${i}Enabled`].value = this.params[`stripe${i}Enabled`];
      u[`uStripe${i}Frequency`].value = this.params[`stripe${i}Frequency`];
      u[`uStripe${i}Speed`].value = this.params[`stripe${i}Speed`];
      u[`uStripe${i}Angle`].value = this.params[`stripe${i}Angle`];
      u[`uStripe${i}Width`].value = this.params[`stripe${i}Width`];
      u[`uStripe${i}Intensity`].value = this.params[`stripe${i}Intensity`];
      u[`uStripe${i}Parallax`].value = this.params[`stripe${i}Parallax`];
      u[`uStripe${i}Wave`].value = this.params[`stripe${i}Wave`];
      u[`uStripe${i}Gaps`].value = this.params[`stripe${i}Gaps`];
      u[`uStripe${i}Softness`].value = this.params[`stripe${i}Softness`];
    }

    // Sparkle
    u.uSparkleEnabled.value = this.params.sparkleEnabled;
    u.uSparkleIntensity.value = this.params.sparkleIntensity;
    u.uSparkleScale.value = this.params.sparkleScale;
    u.uSparkleSpeed.value = this.params.sparkleSpeed;

    // Outdoor cloud specular
    u.uOutdoorCloudSpecularEnabled.value = this.params.outdoorCloudSpecularEnabled;
    u.uOutdoorStripeBlend.value = this.params.outdoorStripeBlend;
    u.uCloudSpecularIntensity.value = this.params.cloudSpecularIntensity;

    // Wet surface
    u.uWetSpecularEnabled.value = this.params.wetSpecularEnabled;
    u.uWetInputBrightness.value = this.params.wetInputBrightness;
    u.uWetInputGamma.value = this.params.wetInputGamma;
    u.uWetSpecularContrast.value = this.params.wetSpecularContrast;
    u.uWetBlackPoint.value = this.params.wetBlackPoint;
    u.uWetWhitePoint.value = this.params.wetWhitePoint;
    u.uWetSpecularIntensity.value = this.params.wetSpecularIntensity;
    u.uWetOutputMax.value = this.params.wetOutputMax;
    u.uWetOutputGamma.value = this.params.wetOutputGamma;
    u.uWetBaseSheen.value = this.params.wetBaseSheen;
    u.uWetWindRippleStrength.value = this.params.wetWindRippleStrength;

    // Frost
    u.uFrostGlazeEnabled.value = this.params.frostGlazeEnabled;
    u.uFrostIntensity.value = this.params.frostIntensity;
    u.uFrostTintStrength.value = this.params.frostTintStrength;

    // Dynamic light tinting
    u.uDynamicLightTintEnabled.value = this.params.dynamicLightTintEnabled;
    u.uDynamicLightTintStrength.value = this.params.dynamicLightTintStrength;

    // Wind
    u.uWindDrivenStripesEnabled.value = this.params.windDrivenStripesEnabled;
    u.uWindStripeInfluence.value = this.params.windStripeInfluence;

    // Building shadows
    u.uBuildingShadowSuppressionEnabled.value = this.params.buildingShadowSuppressionEnabled;
    u.uBuildingShadowSuppressionStrength.value = this.params.buildingShadowSuppressionStrength;

    // ── Foundry darkness + ambient ────────────────────────────────────────
    this._updateEnvironmentUniforms();
  }

  /**
   * Per-frame render pass. Binds camera and external textures.
   * @param {THREE.WebGLRenderer} renderer
   * @param {THREE.Camera} camera
   */
  render(renderer, camera) {
    if (!this._initialized || !this._sharedUniforms) return;
    if (this._overlays.size === 0) {
      this._healthDiagnostics = {
        timestamp: Date.now(),
        overlayCount: 0,
        note: 'No specular overlays — no _Specular tiles or populate() not run.',
      };
      return;
    }
    const THREE = window.THREE;
    const u = this._sharedUniforms;

    // ── Camera ────────────────────────────────────────────────────────────
    if (isFinite(camera.position.x) && isFinite(camera.position.y)) {
      u.uCameraPosition.value.copy(camera.position);
      u.uCameraOffset.value.set(camera.position.x, camera.position.y);
    }

    // ── Screen size ───────────────────────────────────────────────────────
    const size = renderer.getDrawingBufferSize(new THREE.Vector2());
    u.uScreenSize.value.set(size.x, size.y);

    // ── Scene bounds (Foundry → Three Y-up) ──────────────────────────────
    const d = canvas?.dimensions;
    if (d) {
      const rect = d.sceneRect;
      const sx = rect?.x ?? d.sceneX ?? 0;
      const syFoundry = rect?.y ?? d.sceneY ?? 0;
      const sw = rect?.width ?? d.sceneWidth ?? d.width ?? 1;
      const sh = rect?.height ?? d.sceneHeight ?? d.height ?? 1;
      const worldH = d.height ?? (syFoundry + sh);
      const syWorld = worldH - (syFoundry + sh);
      u.uSceneBounds.value.set(sx, syWorld, sw, sh);
    }

    // ── Unified shadow texture ────────────────────────────────────────────
    // Prefer ShadowManagerV2 output; fall back to CloudEffectV2 for compatibility.
    try {
      const floorComp = window.MapShine?.effectComposer?._floorCompositorV2;
      const manager = floorComp?._shadowManagerEffect ?? null;
      const cloud = floorComp?._cloudEffect ?? null;
      const shadowTex = manager?.combinedShadowTexture
        ?? ((cloud?.enabled) ? (cloud.cloudShadowTexture ?? cloud.cloudShadowTarget?.texture ?? null) : null);
      u.uHasCloudShadowMap.value = !!shadowTex;
      u.uCloudShadowMap.value = shadowTex || this._fallbackBlack;
    } catch (_) {
      u.uHasCloudShadowMap.value = false;
      u.uCloudShadowMap.value = this._fallbackBlack;
    }

    // ── Roof / outdoor mask ───────────────────────────────────────────────
    // Multi-floor: sample GpuSceneMaskCompositor per-floor _Outdoors (same source as
    // CloudEffectV2). Legacy single-floor / no compositor: weatherController.roofMap.
    try {
      const compositor = window.MapShine?.gpuSceneMaskCompositor
        ?? window.MapShine?.sceneComposer?._sceneMaskCompositor;
      const floorStackFloors = window.MapShine?.floorStack?.getFloors?.() ?? [];
      /** @type {(THREE.Texture|null)[]} */
      const perFloorTex = [null, null, null, null];
      /** @type {(string|null)[]} */
      const resolvedKeys = [null, null, null, null];
      let usePerFloor = false;
      if (compositor && floorStackFloors.length > 1) {
        for (const floor of floorStackFloors) {
          const idx = Number(floor?.index);
          if (!Number.isFinite(idx) || idx < 0 || idx > 3) continue;
          const meta = this._resolveOutdoorsTextureForFloorWithMeta(compositor, floor);
          perFloorTex[idx] = meta.texture;
          resolvedKeys[idx] = meta.resolvedKey;
          if (meta.texture) usePerFloor = true;
        }
      }

      const fw = this._fallbackWhite;
      u.uUsePerFloorOutdoors.value = usePerFloor ? 1.0 : 0.0;
      if (usePerFloor) {
        u.uRoofMap0.value = perFloorTex[0] ?? fw;
        u.uRoofMap1.value = perFloorTex[1] ?? fw;
        u.uRoofMap2.value = perFloorTex[2] ?? fw;
        u.uRoofMap3.value = perFloorTex[3] ?? fw;
        const anyTex = perFloorTex.find((t) => !!t) ?? null;
        u.uOutdoorsMaskFlipY.value = anyTex?.flipY ? 1.0 : 0.0;
      } else {
        u.uRoofMap0.value = fw;
        u.uRoofMap1.value = fw;
        u.uRoofMap2.value = fw;
        u.uRoofMap3.value = fw;
        u.uOutdoorsMaskFlipY.value = 0.0;
      }

      // Single-floor: FloorCompositor pushes _Outdoors into weatherController.roofMap, but
      // registry races or missed sync can leave roofMap null while GpuSceneMaskCompositor
      // already has a texture — mirror _resolveOutdoorsMask key order so specular still binds.
      const roofTexWeather = weatherController?.roofMap || null;
      let roofTex = roofTexWeather;
      /** @type {string|null} */
      let singleFloorRoofSource = roofTexWeather ? 'weatherController' : null;
      /** @type {{ step: string, hit: boolean, key?: string|null, uuid?: string|null, note?: string }[]} */
      const singleFloorOutdoorsAttempts = [];
      const recordAttempt = (step, tex, key = null, note = null) => {
        singleFloorOutdoorsAttempts.push({
          step,
          hit: !!tex,
          key: key != null ? String(key) : null,
          uuid: tex?.uuid ?? null,
          note: note ? String(note) : null,
        });
      };
      recordAttempt('weatherController.roofMap', roofTexWeather, null);
      if (!usePerFloor && !roofTex && compositor) {
        const activeFloorForRoof = window.MapShine?.floorStack?.getActiveFloor?.() ?? null;
        // Reuse floor-band resolver so single-floor can still hit sibling keys
        // when active compositor key does not match _floorMeta key exactly.
        if (activeFloorForRoof) {
          const resolved = this._resolveOutdoorsTextureForFloorWithMeta(compositor, activeFloorForRoof);
          roofTex = resolved.texture ?? null;
          recordAttempt(
            'compositor.resolveFloorBand(activeFloor)',
            roofTex,
            resolved.resolvedKey ?? activeFloorForRoof?.compositorKey ?? null
          );
          if (roofTex) singleFloorRoofSource = `compositorFloorBand:${resolved.resolvedKey || 'active'}`;
        }
        if (!roofTex) {
          const ctx = window.MapShine?.activeLevelContext;
          const b = Number(ctx?.bottom);
          const t = Number(ctx?.top);
          if (Number.isFinite(b) && Number.isFinite(t)) {
            const ctxBand = {
              compositorKey: `${b}:${t}`,
              elevationMin: b,
              elevationMax: t,
            };
            const resolvedCtx = this._resolveOutdoorsTextureForFloorWithMeta(compositor, ctxBand);
            roofTex = resolvedCtx.texture ?? null;
            recordAttempt(
              'compositor.resolveFloorBand(levelContext)',
              roofTex,
              resolvedCtx.resolvedKey ?? `${b}:${t}`
            );
            if (roofTex) singleFloorRoofSource = `compositorLevelContext:${resolvedCtx.resolvedKey || `${b}:${t}`}`;
          }
        }
        if (!roofTex) {
          const cak = compositor._activeFloorKey ?? null;
          if (cak) {
            roofTex = compositor.getFloorTexture?.(String(cak), 'outdoors') ?? null;
            recordAttempt('compositor._activeFloorKey', roofTex, String(cak));
            if (roofTex) singleFloorRoofSource = `compositorInternalActiveKey:${String(cak)}`;
          }
        }
        if (!roofTex) {
          roofTex = compositor.getGroundFloorMaskTexture?.('outdoors') ?? null;
          recordAttempt('compositor.getGroundFloorMaskTexture', roofTex, 'ground');
          if (roofTex) singleFloorRoofSource = 'compositorGroundFloor';
        }
        if (!roofTex) {
          const bundleMask = window.MapShine?.sceneComposer?.currentBundle?.masks
            ?.find?.((m) => (m?.id ?? m?.type) === 'outdoors')
            ?.texture ?? null;
          roofTex = bundleMask;
          recordAttempt('sceneComposer.currentBundle.outdoors', roofTex, 'bundle');
          if (roofTex) singleFloorRoofSource = 'sceneComposerBundle';
        }
        if (!roofTex) {
          const mmMask = window.MapShine?.maskManager?.getTexture?.('outdoors.scene') ?? null;
          roofTex = mmMask;
          recordAttempt('maskManager.getTexture(outdoors.scene)', roofTex, 'outdoors.scene');
          if (roofTex) singleFloorRoofSource = 'maskManager.outdoors.scene';
        }
        if (!roofTex) {
          const regMask = window.MapShine?.effectMaskRegistry?.getMask?.('outdoors') ?? null;
          roofTex = regMask;
          recordAttempt('effectMaskRegistry.getMask(outdoors)', roofTex, 'outdoors');
          if (roofTex) singleFloorRoofSource = 'effectMaskRegistry.outdoors';
        }
      }

      if (!usePerFloor && roofTex) {
        u.uOutdoorsMaskFlipY.value = roofTex.flipY ? 1.0 : 0.0;
      }

      u.uRoofMap.value = roofTex || this._fallbackBlack;
      u.uRoofMaskEnabled.value = (usePerFloor || roofTex) ? 1.0 : 0.0;

      const overlayByFloor = {};
      /** @type {Record<string, number>} */
      const overlayMaterialKinds = {};
      let overlaysWithShaderUniforms = 0;
      /** @type {Record<string, number>} */
      const outdoorsFloorIdxHistogram = {};
      for (const [, ent] of this._overlays) {
        const fi = Number(ent.floorIndex) || 0;
        overlayByFloor[fi] = (overlayByFloor[fi] || 0) + 1;
        const mk = String(ent.material?.type || 'UnknownMaterial');
        overlayMaterialKinds[mk] = (overlayMaterialKinds[mk] || 0) + 1;
        if (ent.material?.uniforms?.uSpecularMap && ent.material?.uniforms?.uAlbedoMap) {
          overlaysWithShaderUniforms++;
        }
        const ufi = ent.material?.uniforms?.uOutdoorsFloorIdx?.value;
        const hk = String(Number.isFinite(Number(ufi)) ? Number(ufi) : fi);
        outdoorsFloorIdxHistogram[hk] = (outdoorsFloorIdxHistogram[hk] || 0) + 1;
      }
      const activeFloor = window.MapShine?.floorStack?.getActiveFloor?.() ?? null;
      const afi = Number.isFinite(Number(activeFloor?.index)) ? Number(activeFloor.index) : null;
      const texSize = (tex) => {
        if (!tex) return null;
        const w = Number(tex.image?.width ?? tex.source?.data?.width ?? 0) || null;
        const h = Number(tex.image?.height ?? tex.source?.data?.height ?? 0) || null;
        return w && h ? `${w}×${h}` : null;
      };
      const outdoorsSlots = [0, 1, 2, 3].map((i) => ({
        slot: i,
        textureUuid: usePerFloor
          ? (perFloorTex[i]?.uuid ?? null)
          : (i === 0 ? (roofTex?.uuid ?? null) : null),
        textureSize: usePerFloor
          ? texSize(perFloorTex[i])
          : (i === 0 ? texSize(roofTex) : null),
        resolvedCompositorKey: resolvedKeys[i],
        binding: usePerFloor
          ? (perFloorTex[i] && perFloorTex[i] !== fw ? 'compositorOutdoors' : 'fallbackWhite')
          : (i === 0
            ? (roofTex
              ? (roofTexWeather ? 'legacyWeatherRoofMap' : `singleFloor_${singleFloorRoofSource || 'compositor'}`)
              : 'none')
            : 'unusedSingleFloor'),
        isFallbackWhite: !!(usePerFloor && (perFloorTex[i] === fw || !perFloorTex[i])),
      }));
      const activeTex = (afi != null && afi >= 0 && afi <= 3)
        ? (usePerFloor ? perFloorTex[afi] : (afi === 0 ? roofTex : null))
        : null;
      const activeUsesRealOutdoors = usePerFloor
        ? !!(activeTex && activeTex !== fw)
        : !!roofTex;
      const activeFloorOutdoors = (afi != null && afi >= 0 && afi <= 3)
        ? {
          activeFloorIndex: afi,
          activeCompositorKey: activeFloor?.compositorKey ?? null,
          slotIndex: afi,
          resolvedCompositorKey: resolvedKeys[afi],
          binding: outdoorsSlots[afi]?.binding ?? null,
          textureUuid: usePerFloor
            ? (perFloorTex[afi]?.uuid ?? null)
            : (afi === 0 ? (roofTex?.uuid ?? null) : null),
          textureSize: usePerFloor ? texSize(perFloorTex[afi]) : (afi === 0 ? texSize(roofTex) : null),
          usesRealCompositorTexture: activeUsesRealOutdoors,
          matchesFallbackWhiteTexture: usePerFloor && (!activeTex || activeTex === fw),
          singleFloorRoofSource: !usePerFloor ? singleFloorRoofSource : null,
        }
        : null;
      /** @type {string} */
      let activeOutdoorsMaskStatus = 'unknown';
      if (usePerFloor) {
        if (afi == null || afi < 0 || afi > 3) activeOutdoorsMaskStatus = 'unknown_active_floor';
        else if (activeUsesRealOutdoors) activeOutdoorsMaskStatus = 'valid_compositor_outdoors';
        else activeOutdoorsMaskStatus = 'broken_fallback_white_treated_as_full_outdoor';
      } else if (roofTex) {
        activeOutdoorsMaskStatus = roofTexWeather ? 'legacy_weather_roof_map' : 'single_floor_compositor_uRoofMap';
      } else {
        activeOutdoorsMaskStatus = 'single_floor_no_roof_map';
      }
      const wetCloudOutdoorFactor = {
        note: 'Wet specular, outdoor cloud specular, stripe outdoor mix, frost outdoor term, and wind ripple all multiply by outdoorFactor in the shader.',
        outdoorCloudSpecularEnabled: !!u.uOutdoorCloudSpecularEnabled?.value,
        outdoorStripeBlend: Number(u.uOutdoorStripeBlend?.value),
        cloudSpecularIntensity: Number(u.uCloudSpecularIntensity?.value),
        wetSpecularEnabled: !!u.uWetSpecularEnabled?.value,
        rainWetnessUniform: Number(u.uRainWetness?.value),
        wetSpecularIntensity: Number(u.uWetSpecularIntensity?.value),
        wetBaseSheen: Number(u.uWetBaseSheen?.value),
        wetWindRippleStrength: Number(u.uWetWindRippleStrength?.value),
        stripeEnabled: !!u.uStripeEnabled?.value,
        frostGlazeEnabled: !!u.uFrostGlazeEnabled?.value,
        buildingShadowSuppressionEnabled: !!u.uBuildingShadowSuppressionEnabled?.value,
      };
      this._healthDiagnostics = {
        timestamp: Date.now(),
        overlayCount: this._overlays.size,
        realShaderCompiled: this._realShaderCompiled,
        shaderCompilePending: this._shaderCompilePending,
        shaderCompileFailures: this._shaderCompileFailures || 0,
        lastShaderCompileError: this._lastShaderCompileError ?? null,
        overlayByFloor,
        overlayMaterialKinds,
        overlaysWithShaderUniforms,
        outdoorsFloorIdxHistogram,
        compositorPresent: !!compositor,
        floorStackCount: floorStackFloors.length,
        activeFloorIndex: afi,
        activeCompositorKey: activeFloor?.compositorKey ?? null,
        shaderOutdoorsMode: usePerFloor ? 'perFloorTextureArray' : 'legacySingle_uRoofMap',
        activeOutdoorsMaskStatus,
        decodeOutdoorsHint: 'Shader decodeOutdoorsMaskSample: max(rgb)*a; (0,0,0,0) => 1.0 (untreated). fallbackWhite RGB=1 => full outdoor.',
        usePerFloor,
        roofMaskEnabled: Number(u.uRoofMaskEnabled.value),
        usePerFloorOutdoorsUniform: Number(u.uUsePerFloorOutdoors.value),
        outdoorsMaskFlipY: Number(u.uOutdoorsMaskFlipY.value),
        weatherRoofMapUuid: roofTexWeather?.uuid ?? null,
        specularRoofMapUuid: roofTex?.uuid ?? null,
        singleFloorRoofSource: !usePerFloor ? singleFloorRoofSource : null,
        singleFloorOutdoorsAttempts: !usePerFloor ? singleFloorOutdoorsAttempts : [],
        legacyRoofMapBound: !!roofTex,
        floors: floorStackFloors.map((f) => ({
          index: f.index,
          compositorKey: f.compositorKey,
          elevationMin: f.elevationMin,
          elevationMax: f.elevationMax,
        })),
        outdoorsSlots,
        activeFloorOutdoors,
        wetCloudOutdoorFactor,
      };
    } catch (err) {
      const fw = this._fallbackWhite;
      u.uRoofMap.value = this._fallbackBlack;
      u.uRoofMaskEnabled.value = 0.0;
      u.uUsePerFloorOutdoors.value = 0.0;
      u.uOutdoorsMaskFlipY.value = 0.0;
      u.uRoofMap0.value = fw;
      u.uRoofMap1.value = fw;
      u.uRoofMap2.value = fw;
      u.uRoofMap3.value = fw;
      this._healthDiagnostics = {
        timestamp: Date.now(),
        error: true,
        message: String(err?.message || err || 'roof mask bind failed'),
        overlayCount: this._overlays.size,
      };
    }

    // ── Building shadow texture ───────────────────────────────────────────
    // V2: BuildingShadowsEffectV2 provides shadowFactorTexture.
    // V1: BuildingShadowsEffect provides worldShadowTarget.
    try {
      const v2Bse = window.MapShine?.effectComposer?._floorCompositorV2?._buildingShadowEffect;
      const v1Bse = window.MapShine?.effectComposer?.effects?.get?.('building-shadows');
      const bse = v2Bse ?? v1Bse;
      const bsTex = (bse?.enabled)
        ? (bse.shadowFactorTexture ?? bse.worldShadowTarget?.texture ?? null)
        : null;
      u.uHasBuildingShadowMap.value = !!bsTex;
      u.uBuildingShadowMap.value = bsTex || this._fallbackBlack;
    } catch (_) {
      u.uHasBuildingShadowMap.value = false;
      u.uBuildingShadowMap.value = this._fallbackBlack;
    }

    // ── Token mask (screen-space) ─────────────────────────────────────────
    // Prevent floor specular overlays from brightening on top of tokens.
    // tokenMask.screen is authored in screen UV space (alpha=1 inside token silhouette).
    try {
      const mm = window.MapShine?.maskManager;
      let tokenMaskTex = mm?.getTexture?.('tokenMask.screen') ?? null;
      if (!tokenMaskTex) {
        tokenMaskTex = window.MapShine?.lightingEffect?.tokenMaskTarget?.texture ?? null;
      }
      u.uTokenMask.value = tokenMaskTex || this._fallbackBlack;
      u.uHasTokenMask.value = !!tokenMaskTex;
    } catch (_) {
      u.uTokenMask.value = this._fallbackBlack;
      u.uHasTokenMask.value = false;
    }
  }

  // ── Cleanup ────────────────────────────────────────────────────────────────

  /**
   * Remove all overlays without destroying the effect instance.
   */
  clear() {
    for (const [tileId, entry] of this._overlays) {
      this._renderBus.removeEffectOverlay(`${tileId}_specular`);
      const material = entry?.material ?? null;
      const uniforms = material?.uniforms ?? null;

      // MeshBasicMaterial bootstrap path has no shader uniforms.
      if (uniforms) {
        // Dispose per-tile textures (albedo, specular).
        for (const key of ['uAlbedoMap', 'uSpecularMap']) {
          const tex = uniforms[key]?.value;
          if (tex && tex !== this._fallbackBlack && tex !== this._fallbackWhite) {
            tex.dispose();
          }
        }
      }

      try { material?.dispose?.(); } catch (_) {}
      try { entry?.mesh?.geometry?.dispose?.(); } catch (_) {}
    }
    this._overlays.clear();
    this._lights.clear();
    this._healthDiagnostics = null;
    this.params.textureStatus = 'Inactive (no _Specular mask)';
  }

  /**
   * Remove one tile overlay (used when the tile image path changes).
   * @param {string} tileId
   * @private
   */
  _disposeOverlayEntry(tileId) {
    if (!tileId || tileId === '__bg_image__') return;
    const entry = this._overlays.get(tileId);
    if (!entry) return;
    this._renderBus.removeEffectOverlay(`${tileId}_specular`);
    const material = entry?.material ?? null;
    const uniforms = material?.uniforms ?? null;
    if (uniforms) {
      for (const key of ['uAlbedoMap', 'uSpecularMap']) {
        const tex = uniforms[key]?.value;
        if (tex && tex !== this._fallbackBlack && tex !== this._fallbackWhite) {
          try { tex.dispose(); } catch (_) {}
        }
      }
    }
    try { material?.dispose?.(); } catch (_) {}
    try { entry?.mesh?.geometry?.dispose?.(); } catch (_) {}
    this._overlays.delete(tileId);
  }

  /**
   * Re-probe `_Specular` and rebuild the overlay after `texture.src` changed on a tile.
   *
   * @param {object} tileDoc
   * @param {object|null} foundrySceneData
   */
  async refreshTileAfterTextureChange(tileDoc, foundrySceneData) {
    if (!this._initialized || !tileDoc) return;
    const tileId = tileDoc.id ?? tileDoc._id;
    if (!tileId || tileId === '__bg_image__') return;

    this._disposeOverlayEntry(tileId);

    const src = tileDoc?.texture?.src ?? tileDoc?.img ?? '';
    if (!src) return;

    const floors = window.MapShine?.floorStack?.getFloors?.() ?? [];
    const worldH = foundrySceneData?.height ?? (typeof canvas !== 'undefined' ? canvas?.dimensions?.height : 0) ?? 0;

    const dotIdx = src.lastIndexOf('.');
    const basePath = dotIdx > 0 ? src.substring(0, dotIdx) : src;
    const specResult = await probeMaskFile(basePath, '_Specular');
    if (!specResult?.path) return;

    const floorIndex = this._resolveFloorIndex(tileDoc, floors);
    const { dispW: tileW, dispH: tileH, signX: planeSignX, signY: planeSignY } = getTileBusPlaneSizeAndMirror(tileDoc);
    const { cx: cxf, cy: cyf } = getTileVisualCenterFoundryXY(tileDoc);
    const centerX = cxf;
    const centerY = worldH - cyf;
    const rotation = typeof tileDoc.rotation === 'number'
      ? (tileDoc.rotation * Math.PI) / 180 : 0;

    const GROUND_Z = 1000;
    const z = GROUND_Z + floorIndex + SPECULAR_Z_OFFSET;

    await this._createOverlay(tileId, floorIndex, {
      specularUrl: specResult.path,
      albedoUrl: src,
      centerX, centerY, z, tileW, tileH, rotation, planeSignX, planeSignY,
    });

    if (!this._realShaderCompiled && !this._shaderCompilePending) {
      setTimeout(() => this._compileRealShaderForOverlays(), 0);
    }
  }

  /**
   * Full dispose — call on scene teardown.
   */
  dispose() {
    this.clear();
    this._unregisterLightHooks();
    try { this._compiledBaseMaterial?.dispose?.(); } catch (_) {}
    this._compiledBaseMaterial = null;
    this._fallbackBlack?.dispose();
    this._fallbackWhite?.dispose();
    this._fallbackBlack = null;
    this._fallbackWhite = null;
    this._sharedUniforms = null;
    this._initialized = false;
    log.info('SpecularEffectV2 disposed');
  }

  // ── Private: Overlay creation ──────────────────────────────────────────────

  /**
   * Create a specular overlay mesh for a single tile.
   *
   * DEFERRED: Uses a minimal passthrough material initially, compiles real shader
   * on first render to prevent populate() hangs from ~1000+ line GLSL compilation.
   *
   * @private
   */
  async _createOverlayMesh(tileId, opts) {
    const {
      centerX, centerY, tileW, tileH, rotation, z, floorIndex,
      albedoUrl, specularUrl, planeSignX = 1, planeSignY = 1,
    } = opts;

    const THREE = window.THREE;
    const floorIdx = Math.min(3, Math.max(0, Number(floorIndex) || 0));

    let material;
    const canUseCompiledShader = !!(this._realShaderCompiled && this._compiledBaseMaterial && this._sharedUniforms);
    if (canUseCompiledShader) {
      // Repopulates after first successful compile must create overlays with the
      // already-compiled shader immediately; otherwise they remain black placeholders.
      const newUniforms = { ...this._sharedUniforms };
      newUniforms.uAlbedoMap = { value: this._fallbackWhite };
      newUniforms.uSpecularMap = { value: this._fallbackBlack };
      newUniforms.uTileOpacity = { value: 1.0 };
      newUniforms.uOutdoorsFloorIdx = { value: floorIdx };
      material = this._compiledBaseMaterial.clone();
      material.uniforms = newUniforms;

      const loader = new THREE.TextureLoader();
      if (albedoUrl) {
        loader.load(albedoUrl, (tex) => {
          tex.colorSpace = THREE.SRGBColorSpace;
          tex.flipY = true;
          tex.needsUpdate = true;
          if (this._overlays.has(tileId)) {
            material.uniforms.uAlbedoMap.value = tex;
          } else {
            try { tex.dispose?.(); } catch (_) {}
          }
        }, undefined, (err) => log.warn(`Failed to load albedo for ${tileId}:`, err));
      }
      if (specularUrl) {
        loader.load(specularUrl, (tex) => {
          tex.flipY = true;
          tex.needsUpdate = true;
          if (this._overlays.has(tileId)) {
            material.uniforms.uSpecularMap.value = tex;
          } else {
            try { tex.dispose?.(); } catch (_) {}
          }
        }, undefined, (err) => log.warn(`Failed to load specular mask for ${tileId}:`, err));
      }
    } else {
      // DEFERRED: Use MeshBasicMaterial (no shader compile) initially.
      // Real ShaderMaterial with full GLSL will be created and swapped in later
      // by _compileRealShaderForOverlays(). This prevents populate() hangs.
      //
      // IMPORTANT: placeholder must be visually neutral. A white additive fallback
      // can appear as a full-screen bright overlay if shader upgrade is delayed or
      // skipped (e.g. compile timeout/error). Use additive BLACK so the placeholder
      // contributes nothing until real textures/shader are bound.
      material = new THREE.MeshBasicMaterial({
        color: 0x000000,
        transparent: true,
        opacity: 1.0,
        depthWrite: false,
        depthTest: false,
        side: THREE.DoubleSide,
        blending: THREE.AdditiveBlending,
      });
      // Store texture URLs for later shader upgrade
      material._tempAlbedoUrl = albedoUrl;
      material._tempSpecularUrl = specularUrl;
      material._tempTileId = tileId;
    }

    const geometry = new THREE.PlaneGeometry(tileW, tileH);
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = `SpecV2_${tileId}`;
    mesh.frustumCulled = false;
    mesh.scale.set(
      Number.isFinite(planeSignX) && planeSignX !== 0 ? planeSignX : 1,
      Number.isFinite(planeSignY) && planeSignY !== 0 ? planeSignY : 1,
      1,
    );
    const baseEntry = this._renderBus?._tiles?.get?.(tileId);
    const canAttachToTileRoot = !!baseEntry && !String(tileId).startsWith('__');
    if (canAttachToTileRoot) {
      // Tile-attached overlays inherit tile runtime transforms from the bus root.
      mesh.position.set(0, 0, SPECULAR_Z_OFFSET);
      mesh.rotation.z = 0;
    } else {
      // Fallback path (e.g. scene background overlay): keep absolute transform.
      mesh.position.set(centerX, centerY, z);
      mesh.rotation.z = rotation;
    }

    // Same role band as the base mesh (+delta) so higher-sorted tiles draw later and
    // occlude background / lower-tile specular (see tileStackedOverlayOrder).
    try {
      const baseOrder = Number(baseEntry?.mesh?.renderOrder);
      if (Number.isFinite(baseOrder)) {
        mesh.renderOrder = tileStackedOverlayOrder(baseOrder, floorIndex, SPECULAR_EFFECT_DELTA);
      }
    } catch (_) {}

    // Register with the bus so floor visibility is handled automatically.
    let attached = false;
    if (canAttachToTileRoot && typeof this._renderBus?.addTileAttachedOverlay === 'function') {
      attached = this._renderBus.addTileAttachedOverlay(tileId, `${tileId}_specular`, mesh, floorIndex) === true;
    }
    if (!attached) {
      // Store for lazy shader upgrade
      this._pendingOverlays.push({ tileId, mesh, material, floorIdx });
    }

    if (!attached) {
      this._renderBus.addEffectOverlay(`${tileId}_specular`, mesh, floorIndex);
    }
    this._overlays.set(tileId, { mesh, material, floorIndex });
    this._syncOverlayVisibility();

    // Textures will be loaded after real shader is compiled.
    // Placeholder is additive black (neutral) until upgrade.
  }

  /**
   * Compile the real heavy specular shader once and upgrade all overlays.
   * DEFERRED: Only called after all overlays created with passthrough materials.
   * @private
   */
  async _compileRealShaderForOverlays() {
    if (this._realShaderCompiled || this._shaderCompilePending) return;
    this._shaderCompilePending = true;

    const THREE = window.THREE;
    if (!THREE) {
      this._shaderCompilePending = false;
      return;
    }

    const startMs = performance?.now?.() ?? Date.now();
    log.warn('SpecularEffectV2: compiling real shader (deferred from populate)...');

    try {
      // Build shared uniforms for real shader
      const sharedUniforms = this._buildSharedUniforms();
      if (!sharedUniforms || typeof sharedUniforms !== 'object') {
        throw new Error('SpecularEffectV2: failed to build shared uniforms for deferred shader compile');
      }

      // Create deferred ShaderMaterial without forced compile pass.
      // Forced compilation can timeout on large shaders and silently replace the
      // effect with fallback material (appears as "specular does nothing").
      const baseMaterial = new THREE.ShaderMaterial({
        uniforms: sharedUniforms,
        vertexShader: getVertexShader(),
        fragmentShader: getFragmentShader(MAX_LIGHTS),
        transparent: true,
        depthWrite: false,
        depthTest: false,
        side: THREE.DoubleSide,
        blending: THREE.AdditiveBlending,
      });
      const baseUniforms = baseMaterial?.uniforms ?? null;
      if (!baseMaterial?.isShaderMaterial || !baseUniforms?.uEffectEnabled) {
        throw new Error(
          'SpecularEffectV2: deferred shader material invalid/fallback; refusing to replace overlays with non-specular material'
        );
      }
      this._compiledBaseMaterial = baseMaterial;

      this._lastShaderCompileError = null;
      this._shaderCompileFailures = 0;
      this._realShaderCompiled = true;
      this._shaderCompilePending = false;

      // Upgrade all overlays with the new real shader material
      const loader = new THREE.TextureLoader();
      for (const [tileId, overlay] of this._overlays) {
        const oldMat = overlay.material;

        // Create new material with real shader
        const newUniforms = { ...sharedUniforms };
        // Set per-tile uniforms
        newUniforms.uAlbedoMap = { value: this._fallbackWhite };
        newUniforms.uSpecularMap = { value: this._fallbackBlack };
        newUniforms.uTileOpacity = { value: 1.0 };
        newUniforms.uOutdoorsFloorIdx = { value: overlay.floorIndex };

        const newMat = baseMaterial.clone();
        newMat.uniforms = newUniforms;

        // Swap material on mesh
        overlay.mesh.material = newMat;
        overlay.material = newMat;

        // Load textures now that shader is ready
        const albedoUrl = oldMat._tempAlbedoUrl;
        const specularUrl = oldMat._tempSpecularUrl;

        if (albedoUrl) {
          loader.load(albedoUrl, (tex) => {
            tex.colorSpace = THREE.SRGBColorSpace;
            tex.flipY = true;
            tex.needsUpdate = true;
            if (this._overlays.has(tileId)) {
              newMat.uniforms.uAlbedoMap.value = tex;
            }
          }, undefined, (err) => log.warn(`Failed to load albedo for ${tileId}:`, err));
        }

        if (specularUrl) {
          loader.load(specularUrl, (tex) => {
            tex.flipY = true;
            tex.needsUpdate = true;
            if (this._overlays.has(tileId)) {
              newMat.uniforms.uSpecularMap.value = tex;
            }
          }, undefined, (err) => log.warn(`Failed to load specular mask for ${tileId}:`, err));
        }

        // Dispose old MeshBasicMaterial
        oldMat.dispose();
      }

      this._syncOverlayVisibility();

      const elapsed = (performance?.now?.() ?? Date.now()) - startMs;
      log.warn(`[${elapsed.toFixed(0)}ms] SpecularEffectV2: real shader material attached for ${this._overlays.size} overlays`);
    } catch (err) {
      this._shaderCompilePending = false;
      this._realShaderCompiled = false;
      this._shaderCompileFailures = (this._shaderCompileFailures || 0) + 1;
      this._lastShaderCompileError = String(err?.message || err || 'unknown deferred compile error');
      log.error('SpecularEffectV2: unexpected error during deferred shader compile:', err);

      // Retry a few times in case scene resources were still warming up.
      if (this._overlays.size > 0 && this._shaderCompileFailures < 3) {
        setTimeout(() => this._compileRealShaderForOverlays(), 250);
      }
    }
  }

  /**
   * Specular overlays are bus-resident geometry. Disabling this effect must
   * explicitly hide those meshes, otherwise placeholders can still render.
   * @private
   */
  _syncOverlayVisibility() {
    const visible = !!(this._enabled && this.params?.enabled !== false);
    for (const [, entry] of this._overlays) {
      const mesh = entry?.mesh;
      if (!mesh) continue;
      mesh.visible = visible;
    }
  }

  /**
   * Move the background specular overlay to a different floor band and update
   * its shader floor index uniform so `_Outdoors` slot selection follows the
   * active floor.
   * @param {number} floorIndex
   * @private
   */
  _rebindBackgroundOverlayFloor(floorIndex) {
    const bg = this._overlays.get('__bg_image__');
    if (!bg?.mesh) return;
    const nextFloor = Math.max(0, Math.min(3, Number(floorIndex) || 0));
    const overlayKey = '__bg_image___specular';

    bg.floorIndex = nextFloor;

    // Background is absolute-positioned (not tile-attached); keep it in the
    // same floor Z band as the active floor.
    const GROUND_Z = 1000;
    bg.mesh.position.z = GROUND_Z + nextFloor - 1 + SPECULAR_Z_OFFSET;

    if (bg.material?.uniforms?.uOutdoorsFloorIdx) {
      bg.material.uniforms.uOutdoorsFloorIdx.value = nextFloor;
    }

    if (typeof this._renderBus?.removeEffectOverlay === 'function'
      && typeof this._renderBus?.addEffectOverlay === 'function') {
      this._renderBus.removeEffectOverlay(overlayKey);
      this._renderBus.addEffectOverlay(overlayKey, bg.mesh, nextFloor);
    }
    this._syncOverlayVisibility();
  }

  // ── Private: Shared uniforms ───────────────────────────────────────────────

  /** @private */
  _buildSharedUniforms() {
    const THREE = window.THREE;
    this._sharedUniforms = {
      uEffectEnabled: { value: this._enabled },

      uSpecularIntensity: { value: this.params.intensity },
      uLightColor: { value: new THREE.Vector3(1, 1, 1) },
      uCameraPosition: { value: new THREE.Vector3(0, 0, 100) },
      uCameraOffset: { value: new THREE.Vector2(0, 0) },
      uTime: { value: 0 },

      // Stripe globals
      uStripeEnabled: { value: this.params.stripeEnabled },
      uStripeBlendMode: { value: this.params.stripeBlendMode },
      uParallaxStrength: { value: this.params.parallaxStrength },
      uStripeMaskThreshold: { value: this.params.stripeMaskThreshold },
      uWorldPatternScale: { value: this.params.worldPatternScale },

      // Layer 1
      uStripe1Enabled: { value: this.params.stripe1Enabled },
      uStripe1Frequency: { value: this.params.stripe1Frequency },
      uStripe1Speed: { value: this.params.stripe1Speed },
      uStripe1Angle: { value: this.params.stripe1Angle },
      uStripe1Width: { value: this.params.stripe1Width },
      uStripe1Intensity: { value: this.params.stripe1Intensity },
      uStripe1Parallax: { value: this.params.stripe1Parallax },
      uStripe1Wave: { value: this.params.stripe1Wave },
      uStripe1Gaps: { value: this.params.stripe1Gaps },
      uStripe1Softness: { value: this.params.stripe1Softness },

      // Layer 2
      uStripe2Enabled: { value: this.params.stripe2Enabled },
      uStripe2Frequency: { value: this.params.stripe2Frequency },
      uStripe2Speed: { value: this.params.stripe2Speed },
      uStripe2Angle: { value: this.params.stripe2Angle },
      uStripe2Width: { value: this.params.stripe2Width },
      uStripe2Intensity: { value: this.params.stripe2Intensity },
      uStripe2Parallax: { value: this.params.stripe2Parallax },
      uStripe2Wave: { value: this.params.stripe2Wave },
      uStripe2Gaps: { value: this.params.stripe2Gaps },
      uStripe2Softness: { value: this.params.stripe2Softness },

      // Layer 3
      uStripe3Enabled: { value: this.params.stripe3Enabled },
      uStripe3Frequency: { value: this.params.stripe3Frequency },
      uStripe3Speed: { value: this.params.stripe3Speed },
      uStripe3Angle: { value: this.params.stripe3Angle },
      uStripe3Width: { value: this.params.stripe3Width },
      uStripe3Intensity: { value: this.params.stripe3Intensity },
      uStripe3Parallax: { value: this.params.stripe3Parallax },
      uStripe3Wave: { value: this.params.stripe3Wave },
      uStripe3Gaps: { value: this.params.stripe3Gaps },
      uStripe3Softness: { value: this.params.stripe3Softness },

      // Sparkle
      uSparkleEnabled: { value: this.params.sparkleEnabled },
      uSparkleIntensity: { value: this.params.sparkleIntensity },
      uSparkleScale: { value: this.params.sparkleScale },
      uSparkleSpeed: { value: this.params.sparkleSpeed },

      // Outdoor cloud specular
      uOutdoorCloudSpecularEnabled: { value: this.params.outdoorCloudSpecularEnabled },
      uOutdoorStripeBlend: { value: this.params.outdoorStripeBlend },
      uCloudSpecularIntensity: { value: this.params.cloudSpecularIntensity },

      // Wet surface
      uWetSpecularEnabled: { value: this.params.wetSpecularEnabled },
      uRainWetness: { value: 0 },
      uWetInputBrightness: { value: this.params.wetInputBrightness },
      uWetInputGamma: { value: this.params.wetInputGamma },
      uWetSpecularContrast: { value: this.params.wetSpecularContrast },
      uWetBlackPoint: { value: this.params.wetBlackPoint },
      uWetWhitePoint: { value: this.params.wetWhitePoint },
      uWetSpecularIntensity: { value: this.params.wetSpecularIntensity },
      uWetOutputMax: { value: this.params.wetOutputMax },
      uWetOutputGamma: { value: this.params.wetOutputGamma },
      uWetBaseSheen: { value: this.params.wetBaseSheen },
      uWetWindRippleStrength: { value: this.params.wetWindRippleStrength },

      // Roof / outdoor mask (legacy uRoofMap + optional per-floor compositor masks)
      uRoofMap: { value: this._fallbackBlack },
      uRoofMaskEnabled: { value: 0 },
      uSceneBounds: { value: new THREE.Vector4(0, 0, 1, 1) },
      uRoofMap0: { value: this._fallbackWhite },
      uRoofMap1: { value: this._fallbackWhite },
      uRoofMap2: { value: this._fallbackWhite },
      uRoofMap3: { value: this._fallbackWhite },
      uUsePerFloorOutdoors: { value: 0.0 },
      uOutdoorsMaskFlipY: { value: 0.0 },

      // Cloud shadow
      uHasCloudShadowMap: { value: false },
      uCloudShadowMap: { value: this._fallbackBlack },
      uScreenSize: { value: new THREE.Vector2(1, 1) },

      // Foundry environment
      uDarknessLevel: { value: 0 },
      uAmbientDaylight: { value: new THREE.Color(1, 1, 1) },
      uAmbientDarkness: { value: new THREE.Color(0.14, 0.14, 0.28) },

      // Dynamic lights
      numLights: { value: 0 },
      lightPosition: { value: new Float32Array(MAX_LIGHTS * 3) },
      lightColor: { value: new Float32Array(MAX_LIGHTS * 3) },
      lightConfig: { value: new Float32Array(MAX_LIGHTS * 4) },

      // Frost
      uFrostGlazeEnabled: { value: this.params.frostGlazeEnabled },
      uFrostLevel: { value: 0 },
      uFrostIntensity: { value: this.params.frostIntensity },
      uFrostTintStrength: { value: this.params.frostTintStrength },

      // Dynamic light tinting
      uDynamicLightTintEnabled: { value: this.params.dynamicLightTintEnabled },
      uDynamicLightTintStrength: { value: this.params.dynamicLightTintStrength },

      // Wind
      uWindDrivenStripesEnabled: { value: this.params.windDrivenStripesEnabled },
      uWindStripeInfluence: { value: this.params.windStripeInfluence },
      uWindAccum: { value: new THREE.Vector2(0, 0) },

      // Building shadows
      uBuildingShadowSuppressionEnabled: { value: this.params.buildingShadowSuppressionEnabled },
      uBuildingShadowSuppressionStrength: { value: this.params.buildingShadowSuppressionStrength },
      uHasBuildingShadowMap: { value: false },
      uBuildingShadowMap: { value: this._fallbackBlack },

      // Screen-space token mask (suppresses specular on top of token silhouettes)
      uHasTokenMask: { value: false },
      uTokenMask: { value: this._fallbackBlack },
    };
    return this._sharedUniforms;
  }

  // ── Private: Fallback textures ─────────────────────────────────────────────

  /** @private */
  _buildFallbackTextures() {
    const THREE = window.THREE;

    const blackData = new Uint8Array([0, 0, 0, 255]);
    this._fallbackBlack = new THREE.DataTexture(blackData, 1, 1, THREE.RGBAFormat);
    this._fallbackBlack.needsUpdate = true;
    this._fallbackBlack.minFilter = THREE.NearestFilter;
    this._fallbackBlack.magFilter = THREE.NearestFilter;

    const whiteData = new Uint8Array([255, 255, 255, 255]);
    this._fallbackWhite = new THREE.DataTexture(whiteData, 1, 1, THREE.RGBAFormat);
    this._fallbackWhite.needsUpdate = true;
    this._fallbackWhite.colorSpace = THREE.SRGBColorSpace;
    this._fallbackWhite.minFilter = THREE.NearestFilter;
    this._fallbackWhite.magFilter = THREE.NearestFilter;
  }

  // ── Private: Light management ──────────────────────────────────────────────

  /** @private */
  _registerLightHooks() {
    this._hookIds.create = Hooks.on('createAmbientLight', (doc) => {
      this._addLight(doc);
      this._updateLightUniforms();
    });
    this._hookIds.update = Hooks.on('updateAmbientLight', (doc) => {
      this._lights.delete(doc.id);
      this._addLight(doc);
      this._updateLightUniforms();
    });
    this._hookIds.delete = Hooks.on('deleteAmbientLight', (doc) => {
      this._lights.delete(doc.id);
      this._updateLightUniforms();
    });
  }

  /** @private */
  _unregisterLightHooks() {
    for (const [event, id] of Object.entries(this._hookIds)) {
      try { Hooks.off(`${event === 'create' ? 'createAmbientLight' : event === 'update' ? 'updateAmbientLight' : 'deleteAmbientLight'}`, id); }
      catch (_) {}
    }
    this._hookIds = {};
  }

  /** @private */
  _syncAllLights() {
    this._lights.clear();
    try {
      const lights = canvas?.lighting?.placeables ?? [];
      for (const light of lights) {
        this._addLight(light.document);
      }
      this._updateLightUniforms();
    } catch (_) {}
  }

  /** @private */
  _addLight(doc) {
    if (!doc?.id || this._lights.size >= MAX_LIGHTS) return;
    const config = doc.config;
    if (!config) return;

    // Parse light color.
    let r = 1, g = 1, b = 1;
    const colorInput = config.color;
    if (colorInput) {
      try {
        if (typeof colorInput === 'object' && colorInput.rgb) {
          [r, g, b] = colorInput.rgb;
        } else {
          const c = (foundry?.utils?.Color)
            ? foundry.utils.Color.from(colorInput)
            : new THREE.Color(colorInput);
          r = c.r; g = c.g; b = c.b;
        }
      } catch (_) {
        if (typeof colorInput === 'number') {
          r = ((colorInput >> 16) & 0xff) / 255;
          g = ((colorInput >> 8) & 0xff) / 255;
          b = (colorInput & 0xff) / 255;
        }
      }
    }

    const luminosity = config.luminosity ?? 0.5;
    const intensity = luminosity * 2.0;
    const dim = config.dim || 0;
    const bright = config.bright || 0;
    const radius = Math.max(dim, bright);
    if (radius === 0) return;

    const worldPos = Coordinates.toWorld(doc.x, doc.y);

    this._lights.set(doc.id, {
      position: worldPos,
      color: { r: r * intensity, g: g * intensity, b: b * intensity },
      radius,
      dim,
      attenuation: config.attenuation ?? 0.5,
    });
  }

  /** @private */
  _updateLightUniforms() {
    if (!this._sharedUniforms) return;
    const u = this._sharedUniforms;
    const posArr = u.lightPosition.value;
    const colArr = u.lightColor.value;
    const cfgArr = u.lightConfig.value;

    let idx = 0;
    for (const light of this._lights.values()) {
      if (idx >= MAX_LIGHTS) break;
      const i3 = idx * 3;
      const i4 = idx * 4;
      posArr[i3]     = light.position.x;
      posArr[i3 + 1] = light.position.y;
      posArr[i3 + 2] = light.position.z ?? 0;
      colArr[i3]     = light.color.r;
      colArr[i3 + 1] = light.color.g;
      colArr[i3 + 2] = light.color.b;
      cfgArr[i4]     = light.radius;
      cfgArr[i4 + 1] = light.dim;
      cfgArr[i4 + 2] = light.attenuation;
      cfgArr[i4 + 3] = 0;
      idx++;
    }
    u.numLights.value = idx;
  }

  // ── Private: Environment uniforms ──────────────────────────────────────────

  /** @private */
  _updateEnvironmentUniforms() {
    if (!this._sharedUniforms) return;
    const u = this._sharedUniforms;

    try {
      const scene = canvas?.scene;
      if (scene?.environment?.darknessLevel !== undefined) {
        let darkness = scene.environment.darknessLevel;
        const le = window.MapShine?.lightingEffect;
        if (le && typeof le.getEffectiveDarkness === 'function') {
          darkness = le.getEffectiveDarkness();
        }
        u.uDarknessLevel.value = darkness;
      }

      const colors = canvas?.environment?.colors;
      if (colors) {
        const apply = (src, target) => {
          if (!src || !target) return;
          let cr = 1, cg = 1, cb = 1;
          try {
            if (Array.isArray(src)) { [cr, cg, cb] = src; }
            else if (typeof src.r === 'number') { cr = src.r; cg = src.g; cb = src.b; }
            else if (typeof src.toArray === 'function') { [cr, cg, cb] = src.toArray(); }
          } catch (_) {}
          target.setRGB(cr, cg, cb);
        };
        apply(colors.ambientDaylight, u.uAmbientDaylight.value);
        apply(colors.ambientDarkness, u.uAmbientDarkness.value);
      }
    } catch (_) { /* canvas may not be ready */ }
  }

  // ── Private: Floor resolution ──────────────────────────────────────────────

  /**
   * @param {object} compositor
   * @param {{ compositorKey?: string, elevationMin?: number, elevationMax?: number }} floorBand
   * @returns {{ texture: THREE.Texture|null, resolvedKey: string|null }}
   * @private
   */
  _resolveOutdoorsTextureForFloorWithMeta(compositor, floorBand) {
    const empty = { texture: null, resolvedKey: null };
    if (!compositor || !floorBand) return empty;

    const tryKey = (k) => {
      if (k == null || k === '') return null;
      return compositor.getFloorTexture?.(String(k), 'outdoors') ?? null;
    };

    const b = Number(floorBand.elevationMin);
    const top = Number(floorBand.elevationMax);
    const ck = floorBand.compositorKey;

    // Try compositorKey first
    let t = tryKey(ck);
    if (t) return { texture: t, resolvedKey: String(ck) };

    // Try explicit band key
    if (Number.isFinite(b) && Number.isFinite(top)) {
      const bandKey = `${b}:${top}`;
      t = tryKey(bandKey);
      if (t) return { texture: t, resolvedKey: bandKey };
    }

    // Try to find ANY key in _floorMeta or _floorCache that matches this elevation
    if (!Number.isFinite(b)) return empty;

    /** @type {Set<string>} */
    const keySet = new Set();
    try {
      const meta = compositor._floorMeta;
      if (meta && typeof meta.keys === 'function') {
        for (const k of meta.keys()) keySet.add(String(k));
      }
    } catch (_) {}
    try {
      const cache = compositor._floorCache;
      if (cache && typeof cache.keys === 'function') {
        for (const k of cache.keys()) keySet.add(String(k));
      }
    } catch (_) {}

    const matching = [...keySet].filter((key) => {
      const kb = Number(String(key).split(':')[0]);
      return kb === b;
    }).sort();

    for (const key of matching) {
      t = tryKey(key);
      if (t) return { texture: t, resolvedKey: key };
    }

    return empty;
  }

  /**
   * @param {object} compositor
   * @param {object} floorBand
   * @returns {THREE.Texture|null}
   * @private
   */
  _resolveOutdoorsTextureForFloor(compositor, floorBand) {
    return this._resolveOutdoorsTextureForFloorWithMeta(compositor, floorBand).texture;
  }

  /**
   * Resolve which floor a tile belongs to. Same logic as FloorRenderBus.
   * @private
   */
  _resolveFloorIndex(tileDoc, floors) {
    if (!floors || floors.length <= 1) return 0;

    if (tileHasLevelsRange(tileDoc)) {
      const flags = readTileLevelsFlags(tileDoc);
      const tileBottom = Number(flags.rangeBottom);
      const tileTop = Number(flags.rangeTop);
      const tileMid = (tileBottom + tileTop) / 2;

      for (let i = 0; i < floors.length; i++) {
        const f = floors[i];
        if (tileMid >= f.elevationMin && tileMid < f.elevationMax) return i;
      }
      for (let i = 0; i < floors.length; i++) {
        const f = floors[i];
        if (tileBottom <= f.elevationMax && f.elevationMin <= tileTop) return i;
      }
    }

    const elev = Number.isFinite(Number(tileDoc?.elevation)) ? Number(tileDoc.elevation) : 0;
    for (let i = 0; i < floors.length; i++) {
      const f = floors[i];
      if (elev >= f.elevationMin && elev <= f.elevationMax) return i;
    }
    return 0;
  }
}
