/**
 * @fileoverview V2 Specular Effect — per-tile additive specular overlays.
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
 *   - No depth-pass occlusion (Z-ordering handles tile stacking)
 *   - No base mesh mode (always per-tile overlays with additive blending)
 *   - No dual-pass occluder + color mesh (single additive mesh per tile)
 *   - Shader split into separate module (specular-shader.js)
 *
 * @module compositor-v2/effects/SpecularEffectV2
 */

import { createLogger } from '../../core/log.js';
import { weatherController } from '../../core/WeatherController.js';
import { probeMaskFile } from '../../assets/loader.js';
import { tileHasLevelsRange, readTileLevelsFlags } from '../../foundry/levels-scene-flags.js';
import Coordinates from '../../utils/coordinates.js';
import { getVertexShader, getFragmentShader } from './specular-shader.js';

const log = createLogger('SpecularEffectV2');

// Z offset above the albedo tile for specular overlays.
// Must be small enough to stay within the same floor's Z band (1.0 per floor)
// but large enough to consistently render on top of the albedo tile.
const SPECULAR_Z_OFFSET = 0.1;

// Maximum number of dynamic lights the shader supports (compile-time constant).
const MAX_LIGHTS = 64;

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

    // Foundry hook IDs for light tracking.
    this._hookIds = {};

    // Effect parameters — same defaults as V1 for visual parity.
    this.params = {
      intensity: 0.53,
      roughness: 0.0,
      lightDirection: { x: 0.6, y: 0.4, z: 0.7 },
      lightColor: { r: 1.0, g: 1.0, b: 1.0 },

      // Multi-layer stripe system
      stripeEnabled: true,
      stripeBlendMode: 0,
      parallaxStrength: 1.5,
      stripeMaskThreshold: 0.1,
      worldPatternScale: 3072.0,

      // Layer 1
      stripe1Enabled: true,
      stripe1Frequency: 11.0,
      stripe1Speed: 0,
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
      stripe2Speed: 0,
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
      stripe3Speed: 0,
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
      cloudSpecularIntensity: 0.37,

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

  get enabled() { return this._enabled; }
  set enabled(v) {
    this._enabled = v;
    if (this._sharedUniforms?.uEffectEnabled) {
      this._sharedUniforms.uEffectEnabled.value = v;
    }
  }

  // ── UI schema (moved from V1 SpecularEffect) ─────────────────────────────

  static getControlSchema() {
    return {
      enabled: true,
      groups: [
        { name: 'status', label: 'Effect Status', type: 'inline', parameters: ['textureStatus'] },
        { name: 'material', label: 'Material Properties', type: 'inline', parameters: ['intensity', 'roughness'] },
        { name: 'stripe-settings', label: 'Stripe Settings', type: 'inline', separator: true, parameters: ['stripeEnabled', 'stripeBlendMode', 'parallaxStrength', 'stripeMaskThreshold', 'worldPatternScale'] },
        { name: 'layer1', label: 'Layer 1', type: 'folder', separator: true, expanded: false, parameters: ['stripe1Enabled', 'stripe1Frequency', 'stripe1Speed', 'stripe1Angle', 'stripe1Width', 'stripe1Intensity', 'stripe1Parallax', 'stripe1Wave', 'stripe1Gaps', 'stripe1Softness'] },
        { name: 'layer2', label: 'Layer 2', type: 'folder', expanded: false, parameters: ['stripe2Enabled', 'stripe2Frequency', 'stripe2Speed', 'stripe2Angle', 'stripe2Width', 'stripe2Intensity', 'stripe2Parallax', 'stripe2Wave', 'stripe2Gaps', 'stripe2Softness'] },
        { name: 'layer3', label: 'Layer 3', type: 'folder', expanded: false, parameters: ['stripe3Enabled', 'stripe3Frequency', 'stripe3Speed', 'stripe3Angle', 'stripe3Width', 'stripe3Intensity', 'stripe3Parallax', 'stripe3Wave', 'stripe3Gaps', 'stripe3Softness'] },
        { name: 'sparkle', label: 'Micro Sparkle', type: 'folder', expanded: false, parameters: ['sparkleEnabled', 'sparkleIntensity', 'sparkleScale', 'sparkleSpeed'] },
        { name: 'outdoor-cloud-specular', label: 'Outdoor Cloud Specular', type: 'folder', expanded: false, parameters: ['outdoorCloudSpecularEnabled', 'outdoorStripeBlend', 'cloudSpecularIntensity'] },
        { name: 'wet-surface', label: 'Wet Surface (Rain)', type: 'folder', expanded: false, parameters: ['wetSpecularEnabled', 'wetInputBrightness', 'wetInputGamma', 'wetSpecularContrast', 'wetBlackPoint', 'wetWhitePoint', 'wetSpecularIntensity', 'wetOutputMax', 'wetOutputGamma'] },
        { name: 'frost-glaze', label: 'Frost / Ice Glaze', type: 'folder', expanded: false, parameters: ['frostGlazeEnabled', 'frostThreshold', 'frostIntensity', 'frostTintStrength'] },
        { name: 'dynamic-light-tint', label: 'Dynamic Light Tinting', type: 'folder', expanded: false, parameters: ['dynamicLightTintEnabled', 'dynamicLightTintStrength'] },
        { name: 'wind-driven-stripes', label: 'Wind-Driven Stripes', type: 'folder', expanded: false, parameters: ['windDrivenStripesEnabled', 'windStripeInfluence'] },
        { name: 'building-shadow-suppression', label: 'Building Shadow Suppression', type: 'folder', expanded: false, parameters: ['buildingShadowSuppressionEnabled', 'buildingShadowSuppressionStrength'] }
      ],
      parameters: {
        hasSpecularMask: { type: 'boolean', default: true },
        textureStatus: { type: 'string', label: 'Mask Status', default: 'Checking...', readonly: true },
        intensity: { type: 'slider', label: 'Specular Intensity', min: 0, max: 2, step: 0.01, default: 0.53, throttle: 100 },
        roughness: { type: 'slider', label: 'Roughness', min: 0, max: 1, step: 0.01, default: 0.0, throttle: 100 },
        stripeEnabled: { type: 'boolean', label: 'Enable Stripes', default: true },
        stripeBlendMode: { type: 'list', label: 'Stripe Blend Mode', options: { 'Add': 0, 'Multiply': 1, 'Screen': 2, 'Overlay': 3 }, default: 0 },
        stripeMaskThreshold: { type: 'slider', label: 'Stripe Brightness Threshold', min: 0, max: 1, step: 0.01, default: 0.1, throttle: 100 },
        worldPatternScale: { type: 'slider', label: 'Specular World Scale', min: 256, max: 8192, step: 16, default: 3072, throttle: 100 },
        parallaxStrength: { type: 'slider', label: 'Parallax Strength', min: 0, max: 2, step: 0.1, default: 1.5, throttle: 100 },
        stripe1Enabled: { type: 'boolean', label: 'Layer 1 Enabled', default: true },
        stripe1Frequency: { type: 'slider', label: 'Layer 1 Frequency', min: 0.5, max: 20, step: 0.5, default: 11.0, throttle: 100 },
        stripe1Speed: { type: 'slider', label: 'Layer 1 Speed', min: -1, max: 1, step: 0.001, default: 0, throttle: 100 },
        stripe1Angle: { type: 'slider', label: 'Layer 1 Angle', min: 0, max: 360, step: 1, default: 115, throttle: 100 },
        stripe1Width: { type: 'slider', label: 'Layer 1 Width', min: 0, max: 1, step: 0.01, default: 0.21, throttle: 100 },
        stripe1Intensity: { type: 'slider', label: 'Layer 1 Intensity', min: 0, max: 5, step: 0.01, default: 5.0, throttle: 100 },
        stripe1Parallax: { type: 'slider', label: 'Layer 1 Parallax', min: -2, max: 2, step: 0.1, default: 0.2, throttle: 100 },
        stripe1Wave: { type: 'slider', label: 'Layer 1 Wave', min: 0, max: 2, step: 0.1, default: 1.7, throttle: 100 },
        stripe1Gaps: { type: 'slider', label: 'Layer 1 Gaps', min: 0, max: 1, step: 0.01, default: 0.31, throttle: 100 },
        stripe1Softness: { type: 'slider', label: 'Layer 1 Softness', min: 0, max: 5, step: 0.01, default: 2.14, throttle: 100 },
        stripe2Enabled: { type: 'boolean', label: 'Layer 2 Enabled', default: true },
        stripe2Frequency: { type: 'slider', label: 'Layer 2 Frequency', min: 0.5, max: 20, step: 0.5, default: 15.5, throttle: 100 },
        stripe2Speed: { type: 'slider', label: 'Layer 2 Speed', min: -1, max: 1, step: 0.001, default: 0, throttle: 100 },
        stripe2Angle: { type: 'slider', label: 'Layer 2 Angle', min: 0, max: 360, step: 1, default: 111, throttle: 100 },
        stripe2Width: { type: 'slider', label: 'Layer 2 Width', min: 0, max: 1, step: 0.01, default: 0.38, throttle: 100 },
        stripe2Intensity: { type: 'slider', label: 'Layer 2 Intensity', min: 0, max: 5, step: 0.01, default: 5.0, throttle: 100 },
        stripe2Parallax: { type: 'slider', label: 'Layer 2 Parallax', min: -2, max: 2, step: 0.1, default: 0.1, throttle: 100 },
        stripe2Wave: { type: 'slider', label: 'Layer 2 Wave', min: 0, max: 2, step: 0.1, default: 1.6, throttle: 100 },
        stripe2Gaps: { type: 'slider', label: 'Layer 2 Gaps', min: 0, max: 1, step: 0.01, default: 0.5, throttle: 100 },
        stripe2Softness: { type: 'slider', label: 'Layer 2 Softness', min: 0, max: 5, step: 0.01, default: 3.93, throttle: 100 },
        stripe3Enabled: { type: 'boolean', label: 'Layer 3 Enabled', default: true },
        stripe3Frequency: { type: 'slider', label: 'Layer 3 Frequency', min: 0.5, max: 20, step: 0.5, default: 5.0, throttle: 100 },
        stripe3Speed: { type: 'slider', label: 'Layer 3 Speed', min: -1, max: 1, step: 0.001, default: 0, throttle: 100 },
        stripe3Angle: { type: 'slider', label: 'Layer 3 Angle', min: 0, max: 360, step: 1, default: 162, throttle: 100 },
        stripe3Width: { type: 'slider', label: 'Layer 3 Width', min: 0, max: 1, step: 0.01, default: 0.09, throttle: 100 },
        stripe3Intensity: { type: 'slider', label: 'Layer 3 Intensity', min: 0, max: 5, step: 0.01, default: 5.0, throttle: 100 },
        stripe3Parallax: { type: 'slider', label: 'Layer 3 Parallax', min: -2, max: 2, step: 0.1, default: -0.1, throttle: 100 },
        stripe3Wave: { type: 'slider', label: 'Layer 3 Wave', min: 0, max: 2, step: 0.1, default: 0.4, throttle: 100 },
        stripe3Gaps: { type: 'slider', label: 'Layer 3 Gaps', min: 0, max: 1, step: 0.01, default: 0.37, throttle: 100 },
        stripe3Softness: { type: 'slider', label: 'Layer 3 Softness', min: 0, max: 5, step: 0.01, default: 3.44, throttle: 100 },
        sparkleEnabled: { type: 'boolean', label: 'Enable Sparkle', default: false },
        sparkleIntensity: { type: 'slider', label: 'Sparkle Intensity', min: 0, max: 2, step: 0.01, default: 0.95, throttle: 100 },
        sparkleScale: { type: 'slider', label: 'Sparkle Scale', min: 100, max: 10000, step: 1, default: 2460, throttle: 100 },
        sparkleSpeed: { type: 'slider', label: 'Sparkle Speed', min: 0, max: 5, step: 0.01, default: 1.38, throttle: 100 },
        outdoorCloudSpecularEnabled: { type: 'boolean', label: 'Enable Cloud Specular', default: true },
        outdoorStripeBlend: { type: 'slider', label: 'Outdoor Stripe Blend', min: 0, max: 1, step: 0.01, default: 0.8, throttle: 100 },
        cloudSpecularIntensity: { type: 'slider', label: 'Cloud Specular Intensity', min: 0, max: 3, step: 0.01, default: 3.0, throttle: 100 },
        wetSpecularEnabled: { type: 'boolean', label: 'Enable Wet Surface', default: true },
        wetSpecularThreshold: { type: 'slider', label: 'Rain Threshold', min: 0, max: 1, step: 0.01, default: 0.5, throttle: 100 },
        wetInputBrightness: { type: 'slider', label: 'Input Brightness', min: -0.5, max: 0.5, step: 0.01, default: 0.0, throttle: 100 },
        wetInputGamma: { type: 'slider', label: 'Input Gamma', min: 0.1, max: 3.0, step: 0.01, default: 1.0, throttle: 100 },
        wetSpecularContrast: { type: 'slider', label: 'Input Contrast', min: 1, max: 10, step: 0.1, default: 3.0, throttle: 100 },
        wetBlackPoint: { type: 'slider', label: 'Black Point', min: 0.0, max: 1.0, step: 0.01, default: 0.2, throttle: 100 },
        wetWhitePoint: { type: 'slider', label: 'White Point', min: 0.0, max: 1.0, step: 0.01, default: 1.0, throttle: 100 },
        wetSpecularIntensity: { type: 'slider', label: 'Output Intensity', min: 0, max: 5, step: 0.01, default: 1.5, throttle: 100 },
        wetOutputMax: { type: 'slider', label: 'Output Max (Clamp)', min: 0.0, max: 3.0, step: 0.01, default: 1.0, throttle: 100 },
        wetOutputGamma: { type: 'slider', label: 'Output Gamma', min: 0.1, max: 3.0, step: 0.01, default: 1.0, throttle: 100 },
        frostGlazeEnabled: { type: 'boolean', label: 'Enable Frost Glaze', default: true },
        frostThreshold: { type: 'slider', label: 'Freeze Threshold', min: 0, max: 1, step: 0.01, default: 0.55, throttle: 100 },
        frostIntensity: { type: 'slider', label: 'Frost Intensity', min: 0, max: 3, step: 0.01, default: 1.2, throttle: 100 },
        frostTintStrength: { type: 'slider', label: 'Blue Tint Strength', min: 0, max: 1, step: 0.01, default: 0.4, throttle: 100 },
        dynamicLightTintEnabled: { type: 'boolean', label: 'Enable Light Tinting', default: true },
        dynamicLightTintStrength: { type: 'slider', label: 'Tint Strength', min: 0, max: 1, step: 0.01, default: 0.6, throttle: 100 },
        windDrivenStripesEnabled: { type: 'boolean', label: 'Enable Wind Stripes', default: true },
        windStripeInfluence: { type: 'slider', label: 'Wind Influence', min: 0, max: 1, step: 0.01, default: 0.5, throttle: 100 },
        buildingShadowSuppressionEnabled: { type: 'boolean', label: 'Enable Shadow Suppression', default: true },
        buildingShadowSuppressionStrength: { type: 'slider', label: 'Suppression Strength', min: 0, max: 1, step: 0.01, default: 0.8, throttle: 100 }
      }
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

    const floors = window.MapShine?.floorStack?.getFloors() ?? [];
    const worldH = foundrySceneData?.height ?? 0;

    // Sync all existing lights on scene load.
    this._syncAllLights();

    let overlayCount = 0;

    // ── Process scene background image ────────────────────────────────────
    // The background is not in canvas.scene.tiles.contents — it's handled
    // separately by FloorRenderBus as __bg_image__. Check for its _Specular
    // mask and create an overlay if found.
    const bgSrc = canvas?.scene?.background?.src ?? '';
    if (bgSrc) {
      const dotIdx = bgSrc.lastIndexOf('.');
      const bgBasePath = dotIdx > 0 ? bgSrc.substring(0, dotIdx) : bgSrc;
      const bgSpecResult = await probeMaskFile(bgBasePath, '_Specular');

      if (bgSpecResult?.path) {
        const bgRoughResult = await probeMaskFile(bgBasePath, '_Roughness');
        const bgNormalResult = await probeMaskFile(bgBasePath, '_Normal');

        // Background geometry: scene rect in world space.
        const sceneW = foundrySceneData?.sceneWidth ?? foundrySceneData?.width ?? 0;
        const sceneH = foundrySceneData?.sceneHeight ?? foundrySceneData?.height ?? 0;
        const sceneX = foundrySceneData?.sceneX ?? 0;
        const sceneY = foundrySceneData?.sceneY ?? 0;
        const centerX = sceneX + sceneW / 2;
        const centerY = worldH - (sceneY + sceneH / 2);

        // Background is always floor 0, Z just above the bg image plane.
        const GROUND_Z = 1000;
        const z = GROUND_Z - 1 + SPECULAR_Z_OFFSET;

        this._createOverlay('__bg_image__', 0, {
          specularUrl: bgSpecResult.path,
          roughnessUrl: bgRoughResult?.path ?? null,
          normalUrl: bgNormalResult?.path ?? null,
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

    for (const tileDoc of tileDocs) {
      const src = tileDoc?.texture?.src ?? tileDoc?.img ?? '';
      if (!src) continue;

      const tileId = tileDoc.id ?? tileDoc._id;
      if (!tileId) continue;

      // Extract base path (without extension) for mask probing.
      const dotIdx = src.lastIndexOf('.');
      const basePath = dotIdx > 0 ? src.substring(0, dotIdx) : src;

      // Probe for _Specular mask. Skip tile if not found.
      const specResult = await probeMaskFile(basePath, '_Specular');
      if (!specResult?.path) continue;

      // Also probe for optional _Roughness and _Normal masks.
      const roughResult = await probeMaskFile(basePath, '_Roughness');
      const normalResult = await probeMaskFile(basePath, '_Normal');

      // Resolve floor index for this tile.
      const floorIndex = this._resolveFloorIndex(tileDoc, floors);

      // Compute tile geometry in world space (same logic as FloorRenderBus).
      const tileW = tileDoc.width ?? 0;
      const tileH = tileDoc.height ?? 0;
      const centerX = (tileDoc.x ?? 0) + tileW / 2;
      const centerY = worldH - ((tileDoc.y ?? 0) + tileH / 2);
      const rotation = typeof tileDoc.rotation === 'number'
        ? (tileDoc.rotation * Math.PI) / 180 : 0;

      // Z position: same floor Z as the albedo tile + small offset.
      const GROUND_Z = 1000;
      const z = GROUND_Z + floorIndex + SPECULAR_Z_OFFSET;

      this._createOverlay(tileId, floorIndex, {
        specularUrl: specResult.path,
        roughnessUrl: roughResult?.path ?? null,
        normalUrl: normalResult?.path ?? null,
        albedoUrl: src,
        centerX, centerY, z, tileW, tileH, rotation,
      });

      overlayCount++;
    }

    const totalCount = overlayCount;
    log.info(`SpecularEffectV2 populated: ${totalCount} overlay(s) (${bgSrc ? '1 bg + ' : ''}${overlayCount - (bgSrc && overlayCount > 0 ? 1 : 0)} tiles)`);
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
          this._windAccumX += dx * ws * timeInfo.delta * 0.01;
          this._windAccumY += dy * ws * timeInfo.delta * 0.01;
        }
      }
    } catch (_) { /* WeatherController may not be ready */ }

    u.uRainWetness.value = rainWetness;
    u.uFrostLevel.value = frostLevel;
    u.uWindAccum.value.set(this._windAccumX, this._windAccumY);

    // ── Effect parameters ─────────────────────────────────────────────────
    u.uEffectEnabled.value = this._enabled;
    u.uSpecularIntensity.value = this.params.intensity;
    u.uRoughness.value = this.params.roughness;

    u.uLightDirection.value.set(
      this.params.lightDirection.x,
      this.params.lightDirection.y,
      this.params.lightDirection.z
    ).normalize();
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
    if (!this._initialized || !this._sharedUniforms || this._overlays.size === 0) return;
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

    // ── Cloud shadow texture ──────────────────────────────────────────────
    // V2: CloudEffectV2 lives under EffectComposer._floorCompositorV2.
    try {
      const v2Cloud = window.MapShine?.effectComposer?._floorCompositorV2?._cloudEffect;
      const cloud = v2Cloud;
      const cloudTex = (cloud?.enabled)
        ? (cloud.cloudShadowTexture ?? cloud.cloudShadowTarget?.texture ?? null)
        : null;
      u.uHasCloudShadowMap.value = !!cloudTex;
      u.uCloudShadowMap.value = cloudTex || this._fallbackBlack;
    } catch (_) {
      u.uHasCloudShadowMap.value = false;
      u.uCloudShadowMap.value = this._fallbackBlack;
    }

    // ── Roof / outdoor mask ───────────────────────────────────────────────
    try {
      const roofTex = weatherController?.roofMap || null;
      u.uRoofMap.value = roofTex || this._fallbackBlack;
      u.uRoofMaskEnabled.value = roofTex ? 1.0 : 0.0;
    } catch (_) {
      u.uRoofMap.value = this._fallbackBlack;
      u.uRoofMaskEnabled.value = 0.0;
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
      entry.material.dispose();
      entry.mesh.geometry.dispose();
      // Dispose per-tile textures (albedo, specular, roughness, normal).
      for (const key of ['uAlbedoMap', 'uSpecularMap', 'uRoughnessMap', 'uNormalMap']) {
        const tex = entry.material.uniforms[key]?.value;
        if (tex && tex !== this._fallbackBlack && tex !== this._fallbackWhite) {
          tex.dispose();
        }
      }
    }
    this._overlays.clear();
    this._lights.clear();
  }

  /**
   * Full dispose — call on scene teardown.
   */
  dispose() {
    this.clear();
    this._unregisterLightHooks();
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
   * @private
   */
  _createOverlay(tileId, floorIndex, opts) {
    const THREE = window.THREE;
    const {
      specularUrl, roughnessUrl, normalUrl, albedoUrl,
      centerX, centerY, z, tileW, tileH, rotation,
    } = opts;

    // Create material with shared uniforms + per-tile texture uniforms.
    // THREE.UniformsUtils.clone() deep-copies value objects, so we manually
    // reference the shared uniforms and only create new entries for per-tile data.
    const perTileUniforms = {
      uAlbedoMap:      { value: this._fallbackWhite },
      uSpecularMap:    { value: this._fallbackBlack },
      uRoughnessMap:   { value: this._fallbackBlack },
      uNormalMap:      { value: this._fallbackBlack },
      uHasRoughnessMap: { value: false },
      uHasNormalMap:    { value: false },
    };

    // Merge shared + per-tile uniforms. Shared uniforms are referenced (not cloned)
    // so updating _sharedUniforms propagates to all materials automatically.
    const uniforms = { ...this._sharedUniforms, ...perTileUniforms };

    const material = new THREE.ShaderMaterial({
      uniforms,
      vertexShader: getVertexShader(),
      fragmentShader: getFragmentShader(MAX_LIGHTS),
      transparent: true,
      depthWrite: false,
      depthTest: false,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
    });

    const geometry = new THREE.PlaneGeometry(tileW, tileH);
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = `SpecV2_${tileId}`;
    mesh.frustumCulled = false;
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

    // Ensure the specular overlay renders immediately above its corresponding
    // albedo tile in the FloorRenderBus scene. The bus uses renderOrder to
    // guarantee deterministic stacking for transparent materials.
    try {
      const baseOrder = Number(baseEntry?.mesh?.renderOrder);
      if (Number.isFinite(baseOrder)) {
        mesh.renderOrder = baseOrder + 1;
      }
    } catch (_) {}

    // Register with the bus so floor visibility is handled automatically.
    let attached = false;
    if (canAttachToTileRoot && typeof this._renderBus?.addTileAttachedOverlay === 'function') {
      attached = this._renderBus.addTileAttachedOverlay(tileId, `${tileId}_specular`, mesh, floorIndex) === true;
    }
    if (!attached) {
      this._renderBus.addEffectOverlay(`${tileId}_specular`, mesh, floorIndex);
    }
    this._overlays.set(tileId, { mesh, material, floorIndex });

    // Load textures asynchronously via THREE.TextureLoader.
    const loader = new THREE.TextureLoader();

    // Albedo (needed by wet specular to derive reflectivity from grayscale).
    loader.load(albedoUrl, (tex) => {
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.flipY = true;
      tex.needsUpdate = true;
      if (this._overlays.has(tileId)) {
        material.uniforms.uAlbedoMap.value = tex;
      }
    }, undefined, (err) => log.warn(`Failed to load albedo for ${tileId}:`, err));

    // Specular mask.
    loader.load(specularUrl, (tex) => {
      tex.flipY = true;
      tex.needsUpdate = true;
      if (this._overlays.has(tileId)) {
        material.uniforms.uSpecularMap.value = tex;
      }
    }, undefined, (err) => log.warn(`Failed to load specular mask for ${tileId}:`, err));

    // Optional roughness.
    if (roughnessUrl) {
      loader.load(roughnessUrl, (tex) => {
        tex.flipY = true;
        tex.needsUpdate = true;
        if (this._overlays.has(tileId)) {
          material.uniforms.uRoughnessMap.value = tex;
          material.uniforms.uHasRoughnessMap.value = true;
        }
      }, undefined, (err) => log.warn(`Failed to load roughness for ${tileId}:`, err));
    }

    // Optional normal map.
    if (normalUrl) {
      loader.load(normalUrl, (tex) => {
        tex.flipY = true;
        tex.needsUpdate = true;
        if (this._overlays.has(tileId)) {
          material.uniforms.uNormalMap.value = tex;
          material.uniforms.uHasNormalMap.value = true;
        }
      }, undefined, (err) => log.warn(`Failed to load normal for ${tileId}:`, err));
    }
  }

  // ── Private: Shared uniforms ───────────────────────────────────────────────

  /** @private */
  _buildSharedUniforms() {
    const THREE = window.THREE;
    this._sharedUniforms = {
      uEffectEnabled: { value: this._enabled },

      uSpecularIntensity: { value: this.params.intensity },
      uRoughness: { value: this.params.roughness },
      uLightDirection: { value: new THREE.Vector3(0.6, 0.4, 0.7).normalize() },
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

      // Roof / outdoor mask
      uRoofMap: { value: this._fallbackBlack },
      uRoofMaskEnabled: { value: 0 },
      uSceneBounds: { value: new THREE.Vector4(0, 0, 1, 1) },

      // Cloud shadow
      uHasCloudShadowMap: { value: false },
      uCloudShadowMap: { value: this._fallbackBlack },
      uScreenSize: { value: new THREE.Vector2(1, 1) },

      // Foundry environment
      uDarknessLevel: { value: 0 },
      uAmbientDaylight: { value: new THREE.Color(1, 1, 1) },
      uAmbientDarkness: { value: new THREE.Color(0.14, 0.14, 0.28) },
      uAmbientBrightest: { value: new THREE.Color(1, 1, 1) },

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
        apply(colors.ambientBrightest, u.uAmbientBrightest.value);
      }
    } catch (_) { /* canvas may not be ready */ }
  }

  // ── Private: Floor resolution ──────────────────────────────────────────────

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
