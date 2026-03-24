/**
 * @fileoverview V2 Fire Sparks Effect — per-floor particle systems from _Fire masks.
 *
 * HEALTH-WIRING BADGE (Map Shine Breaker Box):
 * If you change this effect's lifecycle, floor-state activation, particle
 * registration, or dependency bindings, you MUST update HealthEvaluator
 * contracts/wiring for `FireEffectV2` to prevent silent failures.
 *
 * Architecture:
 *   Owns a three.quarks BatchedRenderer added to the FloorRenderBus scene.
 *   For each tile with a `_Fire` mask, scans the mask on the CPU to build spawn
 *   point lists, then creates fire + ember + smoke particle systems. Systems are
 *   grouped by floor index. Floor isolation is achieved by swapping active
 *   systems in/out of the BatchedRenderer on floor change.
 *
 * V1 → V2 cleanup:
 *   - No EffectMaskRegistry / GpuSceneMaskCompositor (masks loaded per tile)
 *   - No MapPointsManager integration (mask-only fire sources)
 *   - No V1 EffectBase / RenderLayers dependency
 *   - Clean floor isolation via system swapping (no floor-presence gate)
 *   - Behaviors extracted into fire-behaviors.js for reuse
 *
 * @module compositor-v2/effects/FireEffectV2
 */

import { createLogger } from '../../core/log.js';
import { weatherController } from '../../core/WeatherController.js';
import { probeMaskFile } from '../../assets/loader.js';
import { tileHasLevelsRange, readTileLevelsFlags } from '../../foundry/levels-scene-flags.js';
import { SmartWindBehavior } from '../../particles/SmartWindBehavior.js';
import {
  FireMaskShape,
  FlameLifecycleBehavior,
  EmberLifecycleBehavior,
  SmokeLifecycleBehavior,
  FireSpinBehavior,
  ParticleTimeScaledBehavior,
  generateFirePoints,
} from './fire-behaviors.js';
import {
  ParticleSystem as QuarksParticleSystem,
  BatchedRenderer,
  IntervalValue,
  ColorRange,
  Vector4,
  RenderMode,
  ApplyForce,
  ConstantValue,
  SizeOverLife,
  PiecewiseBezier,
  Bezier,
  CurlNoiseField,
} from '../../libs/three.quarks.module.js';

const log = createLogger('FireEffectV2');

// Ground Z for the bus scene (matches FloorRenderBus GROUND_Z).
const GROUND_Z = 1000;

// Keep render-order math aligned with FloorRenderBus floor bands.
const RENDER_ORDER_PER_FLOOR = 10000;
const OVERHEAD_OFFSET = 5000;
const FIRE_RENDER_ORDER_BASE = OVERHEAD_OFFSET - 4;
const FIRE_RENDER_ORDER_ABOVE_OVERHEAD_BASE = 9955;

// Spatial bucket size for splitting large fire masks into smaller emitters (px).
const BUCKET_SIZE = 2000;

const FIRE_MASK_FORMATS = ['webp', 'png', 'jpg', 'jpeg'];
const REBUILD_PARAM_KEYS = [
  'fireSizeMin', 'fireSizeMax', 'fireLifeMin', 'fireLifeMax',
  'emberSizeMin', 'emberSizeMax', 'emberLifeMin', 'emberLifeMax',
  'smokeEnabled', 'smokeSizeMin', 'smokeSizeMax', 'smokeLifeMin', 'smokeLifeMax',
  'smokeSizeGrowth', 'smokeSizeOverLife',
];
const REBUILD_PARAM_SET = new Set(REBUILD_PARAM_KEYS);

// ─── FireEffectV2 ────────────────────────────────────────────────────────────

export class FireEffectV2 {
  /**
   * @param {import('../FloorRenderBus.js').FloorRenderBus} renderBus
   */
  constructor(renderBus) {
    this._renderBus = renderBus;
    this._enabled = true;
    this._initialized = false;

    // Cache for direct mask probing so we don't repeatedly 404-spam hosted setups.
    // Key: basePathWithSuffix (no extension). Value: { url, image } or null when missing.
    this._directMaskCache = new Map();

    /** @type {BatchedRenderer|null} three.quarks batch renderer */
    this._batchRenderer = null;

    /**
     * Per-floor cached system sets. Key: floorIndex.
     * Value: { systems: QuarksParticleSystem[], emberSystems: [], smokeSystems: [] }
     * @type {Map<number, object>}
     */
    this._floorStates = new Map();

    /**
     * Set of floor indices whose systems are currently in the BatchedRenderer.
     * The bus shows all floors <= maxFloorIndex, so fire must do the same.
     * @type {Set<number>}
     */
    this._activeFloors = new Set();

    /** @type {THREE.Texture|null} Fire sprite texture */
    this._fireTexture = null;
    /** @type {THREE.Texture|null} Ember/smoke sprite texture */
    this._emberTexture = null;
    /** @type {Promise<void>|null} Resolves when sprite textures are loaded */
    this._texturesReady = null;
    /** @type {object|null} Last foundrySceneData used to populate systems */
    this._lastPopulateSceneData = null;
    /** @type {string} Last structural settings signature used for built systems */
    this._structuralSignature = '';
    /** @type {Promise<void>|null} In-flight async rebuild promise */
    this._rebuildInFlight = null;
    /** @type {boolean} Whether another rebuild should run after current one */
    this._rebuildQueued = false;

    // Effect parameters — same defaults as V1 for visual parity.
    this.params = {
      enabled: true,
      globalFireRate: 20,
      fireHeight: 66,
      fireSize: 18.0,
      emberRate: 0.8,
      windInfluence: 4.5,
      fireSizeMin: 64,
      fireSizeMax: 154,
      fireLifeMin: 2.8,
      fireLifeMax: 6,
      fireSpinEnabled: true,
      fireSpinSpeedMin: 0.2,
      fireSpinSpeedMax: 1,
      fireTemperature: 0,
      flameTextureOpacity: 1,
      flameTextureBrightness: 2.15,
      flameTextureScaleX: 1,
      flameTextureScaleY: 1,
      flameTextureOffsetX: 0,
      flameTextureOffsetY: 0,
      flameTextureRotation: 0,
      flameTextureFlipX: true,
      flameTextureFlipY: true,
      emberSizeMin: 5,
      emberSizeMax: 17,
      emberLifeMin: 6.6,
      emberLifeMax: 12,
      fireUpdraft: 7.05,
      emberUpdraft: 1.45,
      fireCurlStrength: 1.95,
      emberCurlStrength: 6.65,
      weatherPrecipKill: 0.5,
      weatherWindKill: 0.5,
      timeScale: 3,
      lightIntensity: 5,
      indoorLifeScale: 0.7,
      indoorTimeScale: 0.2,
      flamePeakOpacity: 0.5,
      coreEmission: 5,
      flameBrightnessFloor: 0.75,
      emberEmission: 2,
      emberPeakOpacity: 0.9,
      smokeEnabled: true,
      smokeRatio: 1.7,
      smokeOpacity: 0.27,
      smokeColorWarmth: 0.59,
      smokeColorBrightness: 0.35,
      smokeDarknessResponse: 0.8,
      smokeSizeMin: 200,
      smokeSizeMax: 400,
      smokeSizeGrowth: 10,
      smokeSizeOverLife: 10,
      smokeLifeMin: 10,
      smokeLifeMax: 11,
      smokeUpdraft: 1.1,
      smokeTurbulence: 0.4,
      smokeWindInfluence: 0.1,
      smokeAlphaStart: 0,
      smokeAlphaPeak: 0.5,
      smokeAlphaEnd: 1,
      // Gradient-over-lifespan: colour and emission tracks.
      // When non-null with ≥2 stops, the gradient overrides the legacy COOL/WARM blend.
      // Legacy warmth/brightness sliders remain in effect whenever gradient is null.
      smokeColorGradient: [
        { t: 0, r: 0.9, g: 0.45, b: 0.1 },
        { t: 0.1061011893408639, r: 0.44, g: 0.38, b: 0.32 },
        { t: 0.24895833219800675, r: 0.36, g: 0.34, b: 0.32 },
        { t: 1, r: 0, g: 0, b: 0 },
      ],
      smokeEmissionGradient: [
        { t: 0, r: 1, g: 1, b: 0 },
        { t: 0.034351663531208235, r: 1, g: 0.4885711669921875, b: 0 },
        { t: 0.22172437617346613, r: 0.04, g: 0.04, b: 0.04 },
        { t: 0.34935507220794615, r: 1, g: 0.5742854527064736, b: 0 },
        { t: 0.4756279846315714, r: 0.0345205563107544, g: 0.0345205563107544, b: 0.0345205563107544 },
        { t: 1, r: 0, g: 0, b: 0 },
      ],
      heatDistortionEnabled: true,
      heatDistortionIntensity: 0.05,
      heatDistortionFrequency: 20.0,
      heatDistortionSpeed: 3.0,
      heatDistortionEdgeSoftness: 1.0,
    };

    log.debug('FireEffectV2 created');
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  get enabled() { return this._enabled; }
  set enabled(v) {
    this._enabled = !!v;
    if (this.params && Object.prototype.hasOwnProperty.call(this.params, 'enabled')) {
      this.params.enabled = this._enabled;
    }
  }

  /**
   * Apply a runtime parameter change coming from the UI callback bridge.
   * Structural parameters trigger a full particle-system rebuild; dynamic
   * parameters continue to update live in _updateSystemParams/behaviors.
   * @param {string} paramId
   * @param {*} value
   */
  applyParamChange(paramId, value) {
    if (!this.params || !Object.prototype.hasOwnProperty.call(this.params, paramId)) return;
    this.params[paramId] = value;
    if (REBUILD_PARAM_SET.has(paramId)) {
      this._queueRebuild();
    }
  }

  // ── UI schema (moved from V1 FireSparksEffect) ───────────────────────────

  static getControlSchema() {
    return {
      enabled: true,
      groups: [
        { name: 'flames', label: 'Flames', type: 'folder', expanded: false, parameters: ['globalFireRate', 'fireHeight', 'fireTemperature', 'flamePeakOpacity', 'coreEmission', 'flameBrightnessFloor', 'fireSizeMin', 'fireSizeMax', 'fireLifeMin', 'fireLifeMax', 'fireSpinEnabled', 'fireSpinSpeedMin', 'fireSpinSpeedMax', 'fireUpdraft', 'fireCurlStrength'] },
        { name: 'flame-texture', label: 'Flame Texture', type: 'folder', expanded: false, parameters: ['flameTextureOpacity', 'flameTextureBrightness', 'flameTextureScaleX', 'flameTextureScaleY', 'flameTextureOffsetX', 'flameTextureOffsetY', 'flameTextureRotation', 'flameTextureFlipX', 'flameTextureFlipY'] },
        { name: 'embers', label: 'Embers', type: 'folder', expanded: false, parameters: ['emberRate', 'emberEmission', 'emberPeakOpacity', 'emberSizeMin', 'emberSizeMax', 'emberLifeMin', 'emberLifeMax', 'emberUpdraft', 'emberCurlStrength'] },
        { name: 'smoke', label: 'Smoke', type: 'folder', expanded: true, parameters: ['smokeEnabled', 'smokeRatio', 'smokeOpacity', 'smokeColorWarmth', 'smokeColorBrightness', 'smokeDarknessResponse', 'smokeColorGradient', 'smokeEmissionGradient', 'smokeAlphaStart', 'smokeAlphaPeak', 'smokeAlphaEnd', 'smokeSizeMin', 'smokeSizeMax', 'smokeSizeOverLife', 'smokeLifeMin', 'smokeLifeMax', 'smokeUpdraft', 'smokeTurbulence', 'smokeWindInfluence'] },
        { name: 'environment', label: 'Environment', type: 'folder', expanded: false, parameters: ['windInfluence', 'timeScale', 'lightIntensity', 'indoorLifeScale', 'indoorTimeScale', 'weatherPrecipKill', 'weatherWindKill'] },
        { name: 'heat-distortion', label: 'Heat Distortion', type: 'folder', expanded: false, parameters: ['heatDistortionEnabled', 'heatDistortionIntensity', 'heatDistortionFrequency', 'heatDistortionSpeed', 'heatDistortionEdgeSoftness'] }
      ],
      parameters: {
        enabled: { type: 'checkbox', label: 'Fire Enabled', default: true },
        globalFireRate: { type: 'slider', label: 'Global Intensity', min: 0.0, max: 20.0, step: 0.1, default: 20 },
        fireHeight: { type: 'slider', label: 'Height', min: 1.0, max: 600.0, step: 1.0, default: 66 },
        fireTemperature: { type: 'slider', label: 'Temperature', min: 0.0, max: 1.0, step: 0.05, default: 0 },
        flamePeakOpacity: { type: 'slider', label: 'Peak Opacity', min: 0.0, max: 1.0, step: 0.01, default: 0.5 },
        coreEmission: { type: 'slider', label: 'Core Emission (HDR)', min: 0.5, max: 5.0, step: 0.1, default: 5 },
        flameBrightnessFloor: { type: 'slider', label: 'Mask Brightness Floor', min: 0.0, max: 1.5, step: 0.01, default: 0.75 },
        fireSizeMin: { type: 'slider', label: 'Size Min', min: 1.0, max: 150.0, step: 1.0, default: 64 },
        fireSizeMax: { type: 'slider', label: 'Size Max', min: 1.0, max: 200.0, step: 1.0, default: 154 },
        fireLifeMin: { type: 'slider', label: 'Life Min (s)', min: 0.1, max: 6.0, step: 0.05, default: 2.8 },
        fireLifeMax: { type: 'slider', label: 'Life Max (s)', min: 0.1, max: 6.0, step: 0.05, default: 6 },
        fireSpinEnabled: { type: 'checkbox', label: 'Spin Enabled', default: true },
        fireSpinSpeedMin: { type: 'slider', label: 'Spin Speed Min', min: 0.0, max: 50.0, step: 0.1, default: 0.2 },
        fireSpinSpeedMax: { type: 'slider', label: 'Spin Speed Max', min: 0.0, max: 50.0, step: 0.1, default: 1 },
        fireUpdraft: { type: 'slider', label: 'Updraft', min: 0.0, max: 12.0, step: 0.05, default: 7.05 },
        fireCurlStrength: { type: 'slider', label: 'Curl Strength', min: 0.0, max: 12.0, step: 0.05, default: 1.95 },
        flameTextureOpacity: { type: 'slider', label: 'Opacity', min: 0.0, max: 1.0, step: 0.01, default: 1 },
        flameTextureBrightness: { type: 'slider', label: 'Brightness', min: 0.0, max: 3.0, step: 0.01, default: 2.15 },
        flameTextureScaleX: { type: 'slider', label: 'Scale X', min: 0.05, max: 4.0, step: 0.05, default: 1.0 },
        flameTextureScaleY: { type: 'slider', label: 'Scale Y', min: 0.05, max: 4.0, step: 0.05, default: 1.0 },
        flameTextureOffsetX: { type: 'slider', label: 'Offset X', min: -1.0, max: 1.0, step: 0.01, default: 0.0 },
        flameTextureOffsetY: { type: 'slider', label: 'Offset Y', min: -1.0, max: 1.0, step: 0.01, default: 0.0 },
        flameTextureRotation: { type: 'slider', label: 'Rotation (rad)', min: -3.14, max: 3.14, step: 0.01, default: 0.0 },
        flameTextureFlipX: { type: 'checkbox', label: 'Flip X', default: true },
        flameTextureFlipY: { type: 'checkbox', label: 'Flip Y', default: true },
        emberRate: { type: 'slider', label: 'Density', min: 0.0, max: 5.0, step: 0.1, default: 0.8 },
        emberEmission: { type: 'slider', label: 'Emission (HDR)', min: 0.5, max: 5.0, step: 0.1, default: 2 },
        emberPeakOpacity: { type: 'slider', label: 'Peak Opacity', min: 0.0, max: 1.0, step: 0.01, default: 0.9 },
        emberSizeMin: { type: 'slider', label: 'Size Min', min: 1.0, max: 40.0, step: 1.0, default: 5 },
        emberSizeMax: { type: 'slider', label: 'Size Max', min: 1.0, max: 60.0, step: 1.0, default: 17 },
        emberLifeMin: { type: 'slider', label: 'Life Min (s)', min: 0.1, max: 8.0, step: 0.1, default: 6.6 },
        emberLifeMax: { type: 'slider', label: 'Life Max (s)', min: 0.1, max: 12.0, step: 0.1, default: 12.0 },
        emberUpdraft: { type: 'slider', label: 'Updraft', min: 0.0, max: 12.0, step: 0.05, default: 1.45 },
        emberCurlStrength: { type: 'slider', label: 'Curl Strength', min: 0.0, max: 12.0, step: 0.05, default: 6.65 },
        smokeEnabled: { type: 'checkbox', label: 'Enable Smoke', default: true },
        smokeRatio: { type: 'slider', label: 'Emission Density', min: 0.0, max: 3.0, step: 0.05, default: 1.7 },
        smokeOpacity: { type: 'slider', label: 'Peak Opacity', min: 0.0, max: 1.0, step: 0.01, default: 0.27 },
        // Legacy colour controls — used when smokeColorGradient is null.
        smokeColorWarmth: { type: 'slider', label: 'Color Warmth', min: 0.0, max: 1.0, step: 0.01, default: 0.59 },
        smokeColorBrightness: { type: 'slider', label: 'Brightness', min: 0.05, max: 2.0, step: 0.01, default: 0.35 },
        smokeDarknessResponse: { type: 'slider', label: 'Darkness Response', min: 0.0, max: 1.0, step: 0.01, default: 0.8 },
        // Colour-over-life gradient. When set, overrides the warmth/brightness sliders.
        smokeColorGradient: {
          type: 'gradient',
          label: 'Colour Over Life',
          default: [
            { t: 0, r: 0.9, g: 0.45, b: 0.1 },
            { t: 0.1061011893408639, r: 0.44, g: 0.38, b: 0.32 },
            { t: 0.24895833219800675, r: 0.36, g: 0.34, b: 0.32 },
            { t: 1, r: 0, g: 0, b: 0 },
          ]
        },
        // Emission (additive glow) gradient. Black = no emission; colour = tinted glow.
        smokeEmissionGradient: {
          type: 'gradient',
          label: 'Emission (Glow) Over Life',
          default: [
            { t: 0, r: 1, g: 1, b: 0 },
            { t: 0.034351663531208235, r: 1, g: 0.4885711669921875, b: 0 },
            { t: 0.22172437617346613, r: 0.04, g: 0.04, b: 0.04 },
            { t: 0.34935507220794615, r: 1, g: 0.5742854527064736, b: 0 },
            { t: 0.4756279846315714, r: 0.0345205563107544, g: 0.0345205563107544, b: 0.0345205563107544 },
            { t: 1, r: 0, g: 0, b: 0 },
          ]
        },
        smokeSizeMin: { type: 'slider', label: 'Size Min', min: 1.0, max: 200.0, step: 1.0, default: 200 },
        smokeSizeMax: { type: 'slider', label: 'Size Max', min: 1.0, max: 400.0, step: 1.0, default: 400 },
        smokeSizeGrowth: { type: 'slider', label: 'Size Growth (Legacy)', min: 1.0, max: 10.0, step: 0.1, default: 10, hidden: true },
        smokeSizeOverLife: { type: 'slider', label: 'Size Over Life', min: 1.0, max: 10.0, step: 0.1, default: 10 },
        smokeLifeMin: { type: 'slider', label: 'Life Min (s)', min: 0.1, max: 10.0, step: 0.1, default: 10 },
        smokeLifeMax: { type: 'slider', label: 'Life Max (s)', min: 0.1, max: 15.0, step: 0.1, default: 11 },
        smokeUpdraft: { type: 'slider', label: 'Updraft', min: 0.0, max: 20.0, step: 0.1, default: 1.1 },
        smokeTurbulence: { type: 'slider', label: 'Turbulence', min: 0.0, max: 5.0, step: 0.05, default: 0.4 },
        smokeWindInfluence: { type: 'slider', label: 'Wind Influence', min: 0.0, max: 10.0, step: 0.1, default: 0.1 },
        smokeAlphaStart: { type: 'slider', label: 'Alpha Ramp Start', min: 0.0, max: 1.0, step: 0.01, default: 0 },
        smokeAlphaPeak: { type: 'slider', label: 'Alpha Peak', min: 0.0, max: 1.0, step: 0.01, default: 0.5 },
        smokeAlphaEnd: { type: 'slider', label: 'Alpha Fade End', min: 0.0, max: 1.0, step: 0.01, default: 1.0 },
        windInfluence: { type: 'slider', label: 'Wind Influence', min: 0.0, max: 5.0, step: 0.1, default: 4.5 },
        timeScale: { type: 'slider', label: 'Time Scale', min: 0.1, max: 3.0, step: 0.05, default: 3.0 },
        lightIntensity: { type: 'slider', label: 'Light Intensity', min: 0.0, max: 5.0, step: 0.1, default: 5.0 },
        indoorLifeScale: { type: 'slider', label: 'Indoor Life Scale', min: 0.05, max: 1.0, step: 0.05, default: 0.7 },
        indoorTimeScale: { type: 'slider', label: 'Indoor Time Scale', min: 0.05, max: 1.0, step: 0.05, default: 0.2 },
        weatherPrecipKill: { type: 'slider', label: 'Rain Kill Strength', min: 0.0, max: 5.0, step: 0.05, default: 0.5 },
        weatherWindKill: { type: 'slider', label: 'Wind Kill Strength', min: 0.0, max: 5.0, step: 0.05, default: 0.5 },
        heatDistortionEnabled: { type: 'checkbox', label: 'Enable Heat Haze', default: true },
        heatDistortionIntensity: { type: 'slider', label: 'Intensity', min: 0.0, max: 0.05, step: 0.001, default: 0.05 },
        heatDistortionFrequency: { type: 'slider', label: 'Frequency', min: 1.0, max: 20.0, step: 0.5, default: 20.0 },
        heatDistortionSpeed: { type: 'slider', label: 'Speed', min: 0.1, max: 3.0, step: 0.1, default: 3.0 },
        heatDistortionEdgeSoftness: { type: 'slider', label: 'Edge Softness', min: 0.4, max: 3.0, step: 0.05, default: 1.0 }
      }
    };
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  initialize() {
    if (this._initialized) return;
    const THREE = window.THREE;
    if (!THREE) { log.warn('initialize: THREE not available'); return; }

    // Create a dedicated BatchedRenderer for V2 fire particles.
    this._batchRenderer = new BatchedRenderer();
    // IMPORTANT (V2): FloorRenderBus tiles use very large renderOrder values
    // (floorIndex * 10000 + sort). If we keep the quarks renderer at ~50 it will
    // render BEFORE tiles and get fully overwritten by tile draws.
    // Fire should sit under overhead tiles by default, but above regular tiles
    // on the active floor band.
    this._batchRenderer.renderOrder = OVERHEAD_OFFSET - 1;
    this._batchRenderer.frustumCulled = false;
    // Keep fire strictly in the main world pass (layer 0). If this object is also
    // on OVERLAY_THREE_LAYER it gets drawn again in FloorCompositor's late overlay
    // pass, which makes ground fire appear above overhead tiles.
    try {
      if (this._batchRenderer.layers && typeof this._batchRenderer.layers.set === 'function') {
        this._batchRenderer.layers.set(0);
      }
    } catch (_) {}

    // Start loading sprite textures (populate() will await this).
    this._texturesReady = this._loadTextures();

    this._initialized = true;
    log.info('FireEffectV2 initialized');
  }

  /**
   * Populate fire systems for all tiles with _Fire masks.
   * Groups spawn points by floor index. Call after FloorRenderBus.populate().
   *
   * @param {object} foundrySceneData - Scene geometry data
   */
  async populate(foundrySceneData) {
    log.info('FireEffectV2.populate() called, initialized=' + this._initialized);
    if (!this._initialized) { log.warn('populate: not initialized'); return; }
    this._lastPopulateSceneData = foundrySceneData ?? this._lastPopulateSceneData;
    this.clear();

    // Wait for fire/ember sprite textures to load before creating systems.
    if (this._texturesReady) {
      log.info('Waiting for fire textures to load...');
      await this._texturesReady;
      log.info('Fire textures loaded, continuing populate');
    }

    const floors = window.MapShine?.floorStack?.getFloors() ?? [];
    const d = canvas?.dimensions;
    if (!d) { log.warn('populate: no canvas dimensions'); return; }
    log.info(`populate: canvas dimensions OK, scene ${d.sceneWidth}x${d.sceneHeight}`);

    const sceneWidth = d.sceneWidth || d.width;
    const sceneHeight = d.sceneHeight || d.height;
    // Foundry scene origin (top-left, Y-down) — used for tile UV → scene UV conversion.
    const foundrySceneX = d.sceneX || 0;
    const foundrySceneY = d.sceneY || 0;
    // Three.js scene origin (Y-up) — used by FireMaskShape to position particles.
    const sceneX = foundrySceneX;
    const sceneY = (d.height || sceneHeight) - foundrySceneY - sceneHeight;

    // Collect fire points per floor from all tiles AND background.
    // Key: floorIndex, Value: {points: Float32Array[]}
    const floorFireData = new Map();

    // ── Process background image first (if it has a _Fire mask) ──────────────
    const bgSrc = canvas?.scene?.background?.src;
    log.info(`populate: checking background src=${bgSrc}`);
    if (bgSrc) {
      const dotIdx = bgSrc.lastIndexOf('.');
      const bgBasePath = dotIdx > 0 ? bgSrc.substring(0, dotIdx) : bgSrc;

      log.info(`  probing for _Fire mask at: ${bgBasePath}`);
      let image = null;
      let resolvedPath = null;
      const fireResult = await probeMaskFile(bgBasePath, '_Fire');
      log.info(`  probeMaskFile result: ${fireResult?.path ?? 'null'}`);
      if (fireResult?.path) {
        resolvedPath = fireResult.path;
        log.info(`  loading image from: ${resolvedPath}`);
        image = await this._loadImage(resolvedPath);
      }
      // probeMaskFile already checked all formats and cached the result.
      // No need for fallback GET probing - it just causes 404 spam.

      log.info(`  image loaded: ${image ? `${image.width}x${image.height}` : 'null'}`);
      if (image) {
        log.info(`  calling generateFirePoints with threshold=0.01`);
        const bgLocalPoints = generateFirePoints(image, 0.01);
        log.info(`  generateFirePoints returned: ${bgLocalPoints ? `${bgLocalPoints.length / 3} points` : 'null'}`);
        if (bgLocalPoints && bgLocalPoints.length > 0) {
          log.info(`  background _Fire mask: found ${bgLocalPoints.length / 3} points from ${image.width}x${image.height} image`);
          // Background fills the entire scene rect.
          const bgX = foundrySceneX;
          const bgY = foundrySceneY;
          const bgW = sceneWidth;
          const bgH = sceneHeight;

          const sceneGlobalPoints = new Float32Array(bgLocalPoints.length);
          for (let i = 0; i < bgLocalPoints.length; i += 3) {
            const foundryPx = bgX + bgLocalPoints[i] * bgW;
            const foundryPy = bgY + bgLocalPoints[i + 1] * bgH;
            sceneGlobalPoints[i]     = (foundryPx - foundrySceneX) / sceneWidth;
            sceneGlobalPoints[i + 1] = (foundryPy - foundrySceneY) / sceneHeight;
            sceneGlobalPoints[i + 2] = bgLocalPoints[i + 2]; // brightness unchanged
          }

          // Background is always floor 0.
          const floorIndex = 0;
          if (!floorFireData.has(floorIndex)) {
            floorFireData.set(floorIndex, { pointArrays: [] });
          }
          floorFireData.get(floorIndex).pointArrays.push(sceneGlobalPoints);
          log.info(`  background → floor ${floorIndex}, ${sceneGlobalPoints.length / 3} fire points (scene ${bgW}x${bgH})`);
        }
      }
    }

    // ── Process tiles ─────────────────────────────────────────────────────────
    const tileDocs = canvas?.scene?.tiles?.contents ?? [];

    for (const tileDoc of tileDocs) {
      const src = tileDoc?.texture?.src ?? tileDoc?.img ?? '';
      if (!src) continue;

      const tileId = tileDoc.id ?? tileDoc._id;
      if (!tileId) continue;

      const dotIdx = src.lastIndexOf('.');
      const basePath = dotIdx > 0 ? src.substring(0, dotIdx) : src;

      let image = null;
      const fireResult = await probeMaskFile(basePath, '_Fire');
      if (fireResult?.path) {
        image = await this._loadImage(fireResult.path);
      }
      // probeMaskFile already checked all formats and cached the result.
      // No need for fallback GET probing - it just causes 404 spam.
      if (!image) continue;

      const tileLocalPoints = generateFirePoints(image, 0.01);
      if (!tileLocalPoints || tileLocalPoints.length === 0) continue;

      // Convert tile-local UVs → scene-global UVs.
      // generateFirePoints returns (u, v, brightness) in tile image space [0..1].
      // We remap to scene-global UV using the tile's Foundry position and size.
      const tileX = Number(tileDoc.x) || 0;
      const tileY = Number(tileDoc.y) || 0;
      const tileW = Number(tileDoc.width) || 1;
      const tileH = Number(tileDoc.height) || 1;

      const sceneGlobalPoints = new Float32Array(tileLocalPoints.length);
      for (let i = 0; i < tileLocalPoints.length; i += 3) {
        // Tile-local UV → Foundry world pixel → scene-global UV.
        const foundryPx = tileX + tileLocalPoints[i] * tileW;
        const foundryPy = tileY + tileLocalPoints[i + 1] * tileH;
        sceneGlobalPoints[i]     = (foundryPx - foundrySceneX) / sceneWidth;
        sceneGlobalPoints[i + 1] = (foundryPy - foundrySceneY) / sceneHeight;
        sceneGlobalPoints[i + 2] = tileLocalPoints[i + 2]; // brightness unchanged
      }

      // Resolve floor index.
      const floorIndex = this._resolveFloorIndex(tileDoc, floors);
      if (!floorFireData.has(floorIndex)) {
        floorFireData.set(floorIndex, { pointArrays: [] });
      }
      floorFireData.get(floorIndex).pointArrays.push(sceneGlobalPoints);
      log.info(`  tile '${tileId}' → floor ${floorIndex}, ${sceneGlobalPoints.length / 3} fire points (tile ${tileW}x${tileH} at ${tileX},${tileY})`);
    }

    // Build particle systems per floor.
    let totalSystems = 0;
    for (const [floorIndex, { pointArrays }] of floorFireData) {
      // Merge all point arrays for this floor into one.
      const totalLen = pointArrays.reduce((sum, arr) => sum + arr.length, 0);
      const merged = new Float32Array(totalLen);
      let offset = 0;
      for (const arr of pointArrays) {
        merged.set(arr, offset);
        offset += arr.length;
      }

      const state = this._buildFloorSystems(
        merged, sceneWidth, sceneHeight, sceneX, sceneY, floorIndex
      );
      this._floorStates.set(floorIndex, state);
      totalSystems += state.systems.length + state.emberSystems.length + state.smokeSystems.length;
    }

    // Add the BatchedRenderer to the bus scene so it renders in the same pass.
    // We add it directly to the bus's internal scene via the overlay API.
    // The batch renderer is a single mesh — we register it at floor 0 but
    // manage its content (active systems) ourselves on floor change.
    if (this._batchRenderer) {
      this._renderBus.addEffectOverlay('__fire_batch__', this._batchRenderer, 0);
      log.info(`FireEffectV2: BatchedRenderer added to bus scene, parent=${this._batchRenderer.parent?.type}`);
    }

    // Activate the current floor's systems.
    this._activateCurrentFloor();

    log.info(`FireEffectV2 populated: ${floorFireData.size} floor(s), ${totalSystems} system(s), floorStates keys=[${[...this._floorStates.keys()]}]`);
    
    // Diagnostic: log first few fire points to verify they're in valid world space
    if (floorFireData.size > 0) {
      const firstFloor = floorFireData.entries().next().value;
      if (firstFloor && firstFloor[1]?.pointArrays?.[0]) {
        const pts = firstFloor[1].pointArrays[0];
        log.info(`  First 3 fire points (u,v,brightness): [${pts.slice(0,9).join(', ')}]`);
      }
    }

    this._structuralSignature = this._computeStructuralSignature();
  }

  /**
   * Per-frame update. Steps the BatchedRenderer simulation.
   * @param {{ elapsed: number, delta: number }} timeInfo
   */
  update(timeInfo) {
    if (!this._initialized || !this._batchRenderer || !this._enabled) return;

    // Step WeatherController so weather state is current.
    try {
      if (weatherController && !weatherController.initialized && typeof weatherController.initialize === 'function') {
        void weatherController.initialize();
      }
      if (weatherController && typeof weatherController.update === 'function') {
        weatherController.update(timeInfo);
      }
    } catch (_) {}

    // Compute dt for three.quarks (matches V1 time scaling).
    const deltaSec = typeof timeInfo.delta === 'number' ? timeInfo.delta : 0.016;
    const clampedDelta = Math.min(deltaSec, 0.1);
    const simSpeed = (weatherController && typeof weatherController.simulationSpeed === 'number')
      ? weatherController.simulationSpeed : 2.0;
    const dt = clampedDelta * 0.001 * 750 * simSpeed;

    // Update per-frame emission rates based on params.
    this._updateSystemParams();

    // Step the BatchedRenderer.
    try {
      this._batchRenderer.update(dt);
    } catch (err) {
      log.warn('FireEffectV2: BatchedRenderer.update threw, skipping frame:', err);
    }
  }

  /**
   * Called when the visible floor range changes. Activates all floors up to
   * maxFloorIndex (matching the bus's setVisibleFloors behaviour).
   * @param {number} maxFloorIndex
   */
  onFloorChange(maxFloorIndex) {
    if (!this._initialized) return;

    // Re-anchor fire draw order to the currently visible floor band so particles
    // render below overhead tiles instead of globally on top of all tile layers.
    this._updateBatchRenderOrder(maxFloorIndex);

    // Determine which floors should be active.
    const desired = new Set();
    for (const idx of this._floorStates.keys()) {
      if (idx <= maxFloorIndex) desired.add(idx);
    }

    // Deactivate floors that should no longer be visible.
    for (const idx of this._activeFloors) {
      if (!desired.has(idx)) this._deactivateFloor(idx);
    }
    // Activate floors that are newly visible.
    for (const idx of desired) {
      if (!this._activeFloors.has(idx)) this._activateFloor(idx);
    }

    log.info(`onFloorChange(${maxFloorIndex}): desired=[${[...desired]}] prev=[${[...this._activeFloors]}] states=[${[...this._floorStates.keys()]}]`);
    this._activeFloors = desired;
  }

  // ── Cleanup ────────────────────────────────────────────────────────────────

  clear() {
    // Deactivate all active floors.
    for (const idx of this._activeFloors) {
      this._deactivateFloor(idx);
    }
    this._activeFloors.clear();

    // Dispose all floor states.
    for (const [, state] of this._floorStates) {
      this._disposeFloorState(state);
    }
    this._floorStates.clear();

    // Remove batch renderer from bus.
    this._renderBus.removeEffectOverlay('__fire_batch__');

    this._structuralSignature = '';
  }

  dispose() {
    this.clear();
    this._fireTexture?.dispose();
    this._emberTexture?.dispose();
    this._fireTexture = null;
    this._emberTexture = null;
    this._batchRenderer = null;
    this._initialized = false;
    log.info('FireEffectV2 disposed');
  }

  // ── Private: System building ───────────────────────────────────────────────

  /**
   * Build fire + ember + smoke systems from merged points for a single floor.
   * Points are spatially bucketed for culling efficiency.
   * @private
   */
  _buildFloorSystems(points, sceneW, sceneH, sceneX, sceneY, floorIndex) {
    const state = { systems: [], emberSystems: [], smokeSystems: [] };
    const totalCount = points.length / 3;
    if (totalCount === 0) return state;

    // Spatial bucketing.
    const buckets = new Map();
    for (let i = 0; i < points.length; i += 3) {
      const u = points[i];
      const v = points[i + 1];
      const b = points[i + 2];
      if (!Number.isFinite(u) || !Number.isFinite(v) || !Number.isFinite(b) || b <= 0) continue;
      const worldX = sceneX + u * sceneW;
      const worldY = sceneY + (1.0 - v) * sceneH;
      const bx = Math.floor(worldX / BUCKET_SIZE);
      const by = Math.floor(worldY / BUCKET_SIZE);
      const key = `${bx},${by}`;
      let arr = buckets.get(key);
      if (!arr) { arr = []; buckets.set(key, arr); }
      arr.push(u, v, b);
    }

    for (const [, arr] of buckets) {
      if (arr.length < 3) continue;
      const bucketPoints = new Float32Array(arr);
      const weight = totalCount > 0 ? (bucketPoints.length / 3 / totalCount) : 1.0;
      // V2 bus layering contract:
      // - Tiles are placed at Z = GROUND_Z + floorIndex
      // - Effects should follow the same scheme to avoid clipping / depth issues.
      // Use a small offset above the floor plane so particles aren't Z-fighting.
      const shape = new FireMaskShape(
        bucketPoints, sceneW, sceneH, sceneX, sceneY,
        this, GROUND_Z + (Number(floorIndex) || 0), 0.55
      );

      // Fire system.
      const fireSys = this._createFireSystem(shape, weight, floorIndex);
      if (fireSys) state.systems.push(fireSys);

      // Ember system.
      const emberSys = this._createEmberSystem(shape, weight, floorIndex);
      if (emberSys) state.emberSystems.push(emberSys);

      // Smoke system.
      if (this.params.smokeEnabled) {
        const smokeSys = this._createSmokeSystem(shape, weight, floorIndex);
        if (smokeSys) state.smokeSystems.push(smokeSys);
      }
    }

    return state;
  }

  /** @private */
  _createFireSystem(shape, weight, floorIndex) {
    const THREE = window.THREE;
    if (!THREE) return null;

    const material = new THREE.MeshBasicMaterial({
      map: this._fireTexture,
      transparent: true,
      depthWrite: false,
      depthTest: false,
      blending: THREE.AdditiveBlending,
      color: 0xffffff,
      side: THREE.DoubleSide,
    });
    material.toneMapped = false;

    const p = this.params;
    const timeScale = Math.max(0.1, p.timeScale ?? 1.0);
    const lifeMin = Math.max(0.01, (p.fireLifeMin ?? 0.6) / timeScale);
    const lifeMax = Math.max(lifeMin, (p.fireLifeMax ?? 1.2) / timeScale);
    const sizeMin = Math.max(0.1, p.fireSizeMin ?? 19);
    const sizeMax = Math.max(sizeMin, p.fireSizeMax ?? 170);

    const flameLifecycle = new FlameLifecycleBehavior(this);
    const sizeOverLife = new SizeOverLife(new PiecewiseBezier([
      [new Bezier(0.3, 0.9, 1.0, 1.1), 0],
      [new Bezier(1.1, 1.0, 0.7, 0.4), 0.5],
    ]));
    const buoyancy = new ApplyForce(new THREE.Vector3(0, 0, 1), new ConstantValue(p.fireHeight * 0.125));
    const windForce = new SmartWindBehavior();
    const turbulence = new CurlNoiseField(
      new THREE.Vector3(150, 150, 50),
      new THREE.Vector3(80, 80, 30),
      1.5
    );

    const system = new QuarksParticleSystem({
      duration: 1,
      looping: true,
      startLife: new IntervalValue(lifeMin, lifeMax),
      startSpeed: new ConstantValue(0),
      startSize: new IntervalValue(sizeMin, sizeMax),
      startColor: new ColorRange(new Vector4(1, 1, 1, 1), new Vector4(1, 1, 1, 1)),
      worldSpace: true,
      maxParticles: 10000,
      emissionOverTime: new IntervalValue(10.0 * weight, 20.0 * weight),
      shape,
      material,
      renderMode: RenderMode.BillBoard,
      renderOrder: this._computeParticleRenderOrder(floorIndex, 0),
      uTileCount: 1,
      vTileCount: 1,
      startTileIndex: new ConstantValue(0),
      startRotation: new IntervalValue(0, Math.PI * 2),
      behaviors: [windForce, buoyancy, turbulence, new FireSpinBehavior(), sizeOverLife, flameLifecycle],
    });

    system.userData = {
      windForce,
      ownerEffect: this,
      updraftForce: buoyancy,
      baseUpdraftMag: p.fireHeight * 0.125,
      turbulence,
      baseCurlStrength: new THREE.Vector3(80, 80, 30),
      _msEmissionScale: weight,
    };

    // Start the system so it becomes active and emits particles.
    if (typeof system.play === 'function') system.play();

    return system;
  }

  /** @private */
  _createEmberSystem(shape, weight, floorIndex) {
    const THREE = window.THREE;
    if (!THREE) return null;

    const material = new THREE.MeshBasicMaterial({
      map: this._emberTexture,
      transparent: true,
      blending: THREE.AdditiveBlending,
      color: 0xffffff,
      depthWrite: false,
      depthTest: false,
    });
    material.toneMapped = false;

    const p = this.params;
    const timeScale = Math.max(0.1, p.timeScale ?? 1.0);
    const lifeMin = Math.max(0.01, (p.emberLifeMin ?? 1.5) / timeScale);
    const lifeMax = Math.max(lifeMin, (p.emberLifeMax ?? 3.0) / timeScale);
    const sizeMin = Math.max(0.1, p.emberSizeMin ?? 5);
    const sizeMax = Math.max(sizeMin, p.emberSizeMax ?? 17);

    const emberLifecycle = new EmberLifecycleBehavior(this);
    const buoyancy = new ApplyForce(new THREE.Vector3(0, 0, 1), new ConstantValue(p.fireHeight * 0.4));
    const windForce = new SmartWindBehavior();
    const emberCurlStrength = new THREE.Vector3(150, 150, 50);
    const turbulence = new CurlNoiseField(new THREE.Vector3(30, 30, 30), emberCurlStrength.clone(), 4.0);
    const emberSizeOverLife = new SizeOverLife(new PiecewiseBezier([
      [new Bezier(1.0, 0.85, 0.5, 0.2), 0],
    ]));

    const system = new QuarksParticleSystem({
      duration: 1,
      looping: true,
      startLife: new IntervalValue(lifeMin, lifeMax),
      startSpeed: new ConstantValue(0),
      startSize: new IntervalValue(sizeMin, sizeMax),
      startColor: new ColorRange(new Vector4(1, 1, 1, 1), new Vector4(1, 1, 1, 1)),
      worldSpace: true,
      maxParticles: 2000,
      emissionOverTime: new IntervalValue(
        (5.0 * p.emberRate) * weight,
        (10.0 * p.emberRate) * weight
      ),
      shape,
      material,
      renderMode: RenderMode.BillBoard,
      renderOrder: this._computeParticleRenderOrder(floorIndex, 1),
      behaviors: [
        new ParticleTimeScaledBehavior(buoyancy),
        windForce,
        new ParticleTimeScaledBehavior(turbulence),
        emberSizeOverLife,
        emberLifecycle,
      ],
    });

    system.userData = {
      windForce,
      ownerEffect: this,
      updraftForce: buoyancy,
      baseUpdraftMag: p.fireHeight * 0.4,
      turbulence,
      baseCurlStrength: emberCurlStrength.clone(),
      isEmber: true,
      _msEmissionScale: weight,
    };

    // Start the system so it becomes active and emits particles.
    if (typeof system.play === 'function') system.play();

    return system;
  }

  /** @private */
  _createSmokeSystem(shape, weight, floorIndex) {
    const THREE = window.THREE;
    if (!THREE) return null;

    const p = this.params;
    const material = new THREE.MeshBasicMaterial({
      map: this._emberTexture,
      transparent: true,
      blending: THREE.NormalBlending,
      color: 0xffffff,
      depthWrite: false,
      depthTest: false,
      side: THREE.DoubleSide,
    });
    material.toneMapped = false;

    const timeScale = Math.max(0.1, p.timeScale ?? 1.0);
    const lifeMin = Math.max(0.01, (p.smokeLifeMin ?? 0.9) / timeScale);
    const lifeMax = Math.max(lifeMin, (p.smokeLifeMax ?? 3.0) / timeScale);
    const sizeMin = Math.max(1.0, p.smokeSizeMin ?? 183);
    const sizeMax = Math.max(sizeMin, p.smokeSizeMax ?? 400);
    const smokeRatio = Math.max(0.0, p.smokeRatio ?? 0.3);

    const smokeLifecycle = new SmokeLifecycleBehavior(this);
    const smokeUpdraftMag = Math.max(0.0, p.smokeUpdraft ?? 2.5);
    const smokeUpdraft = new ApplyForce(new THREE.Vector3(0, 0, 1), new ConstantValue(smokeUpdraftMag));
    const windForce = new SmartWindBehavior();
    const smokeTurbMult = Math.max(0.0, p.smokeTurbulence ?? 1.0);
    const smokeCurlStrengthBase = new THREE.Vector3(200 * smokeTurbMult, 200 * smokeTurbMult, 80 * smokeTurbMult);
    const turbulence = new CurlNoiseField(new THREE.Vector3(100, 100, 40), smokeCurlStrengthBase.clone(), 2.0);

    const system = new QuarksParticleSystem({
      duration: 1,
      looping: true,
      startLife: new IntervalValue(lifeMin, lifeMax),
      startSpeed: new ConstantValue(0),
      startSize: new IntervalValue(sizeMin, sizeMax),
      startColor: new ColorRange(new Vector4(1, 1, 1, 1), new Vector4(1, 1, 1, 1)),
      worldSpace: true,
      maxParticles: 3000,
      emissionOverTime: new IntervalValue(
        10.0 * weight * smokeRatio * 0.5,
        20.0 * weight * smokeRatio * 0.8
      ),
      shape,
      material,
      renderMode: RenderMode.BillBoard,
      renderOrder: this._computeParticleRenderOrder(floorIndex, 2),
      startRotation: new IntervalValue(0, Math.PI * 2),
      behaviors: [windForce, smokeUpdraft, turbulence, new FireSpinBehavior(), smokeLifecycle],
    });

    system.userData = {
      windForce,
      ownerEffect: this,
      updraftForce: smokeUpdraft,
      baseUpdraftMag: smokeUpdraftMag,
      turbulence,
      baseCurlStrength: new THREE.Vector3(200, 200, 80),
      isSmoke: true,
      _msEmissionScale: weight,
    };

    // Start the system so it becomes active and emits particles.
    if (typeof system.play === 'function') system.play();

    return system;
  }

  // ── Private: Floor switching ───────────────────────────────────────────────

  /** Activate all floors up to the current active floor. @private */
  _activateCurrentFloor() {
    const floorStack = window.MapShine?.floorStack;
    const activeFloor = floorStack?.getActiveFloor();
    // Default to 0 (ground floor only) if active floor not available.
    // Using Infinity would attempt to activate all possible floor indices.
    const maxFloorIndex = Number.isFinite(activeFloor?.index) ? activeFloor.index : 0;
    log.info(`FireEffectV2: _activateCurrentFloor called, activeFloor=${JSON.stringify(activeFloor)}, maxFloorIndex=${maxFloorIndex}`);
    this.onFloorChange(maxFloorIndex);
  }

  /** Keep batched particle draw order aligned with the active floor band. @private */
  _updateBatchRenderOrder(maxFloorIndex) {
    if (!this._batchRenderer) return;
    const safeFloorIndex = Number.isFinite(Number(maxFloorIndex)) ? Number(maxFloorIndex) : 0;
    const floorBandStart = safeFloorIndex * RENDER_ORDER_PER_FLOOR;
    // Upper-floor fire should sit above same-floor overhead tiles so it cannot
    // appear visually "under" the active upper level.
    const base = safeFloorIndex > 0 ? FIRE_RENDER_ORDER_ABOVE_OVERHEAD_BASE : (OVERHEAD_OFFSET - 1);
    this._batchRenderer.renderOrder = floorBandStart + base;
  }

  /**
   * Compute particle-system render order within a floor band.
   * Must stay below OVERHEAD_OFFSET so ground fire cannot sort above roof tiles.
   * @private
   */
  _computeParticleRenderOrder(floorIndex, typeOffset = 0) {
    const safeFloorIndex = Number.isFinite(Number(floorIndex)) ? Number(floorIndex) : 0;
    const floorBandStart = safeFloorIndex * RENDER_ORDER_PER_FLOOR;
    const safeTypeOffset = Math.max(0, Math.min(2, Number(typeOffset) || 0));
    const base = safeFloorIndex > 0 ? FIRE_RENDER_ORDER_ABOVE_OVERHEAD_BASE : FIRE_RENDER_ORDER_BASE;
    return floorBandStart + base + safeTypeOffset;
  }

  /** Add a floor's systems to the BatchedRenderer + scene. @private */
  _activateFloor(floorIndex) {
    const state = this._floorStates.get(floorIndex);
    if (!state || !this._batchRenderer) {
      log.warn(`FireEffectV2: _activateFloor(${floorIndex}) failed - state=${!!state}, batchRenderer=${!!this._batchRenderer}`);
      return;
    }

    const allSystems = [...state.systems, ...state.emberSystems, ...state.smokeSystems];
    log.info(`FireEffectV2: activating floor ${floorIndex} with ${allSystems.length} systems (${state.systems.length} fire, ${state.emberSystems.length} ember, ${state.smokeSystems.length} smoke)`);
    
    for (const sys of allSystems) {
      try { 
        this._batchRenderer.addSystem(sys);
      } catch (err) {
        log.warn(`  addSystem() failed:`, err);
      }
      // Emitters must be in the scene graph for three.quarks to update their
      // world matrices. Adding them as children of the BatchedRenderer (which
      // is already in the bus scene) achieves this without exposing the bus's
      // private scene reference.
      if (sys.emitter) {
        try {
          this._batchRenderer.add(sys.emitter);
        } catch (err) {
          log.warn(`  Failed to add emitter:`, err);
        }
      }
    }
  }

  /** Remove a specific floor's systems from the BatchedRenderer. @private */
  _deactivateFloor(floorIndex) {
    if (!this._batchRenderer) return;
    const state = this._floorStates.get(floorIndex);
    if (!state) return;

    const allSystems = [...state.systems, ...state.emberSystems, ...state.smokeSystems];
    for (const sys of allSystems) {
      try { this._batchRenderer.deleteSystem(sys); } catch (_) {}
      if (sys.emitter) this._batchRenderer.remove(sys.emitter);
    }
    log.debug(`FireEffectV2: deactivated floor ${floorIndex}`);
  }

  /** Dispose all systems in a floor state. @private */
  _disposeFloorState(state) {
    const allSystems = [...state.systems, ...state.emberSystems, ...state.smokeSystems];
    for (const sys of allSystems) {
      try {
        if (this._batchRenderer) this._batchRenderer.deleteSystem(sys);
      } catch (_) {}
      if (sys.emitter && this._batchRenderer) {
        this._batchRenderer.remove(sys.emitter);
      }
      // Dispose material.
      try { sys.material?.dispose(); } catch (_) {}
    }
    state.systems.length = 0;
    state.emberSystems.length = 0;
    state.smokeSystems.length = 0;
  }

  // ── Private: Per-frame param sync ──────────────────────────────────────────

  /** Update emission rates, updraft, curl based on current params. @private */
  _updateSystemParams() {
    const p = this.params;
    const globalRate = Math.max(0.0, p.globalFireRate ?? 1.0);

    for (const [, state] of this._floorStates) {
      // Fire systems.
      for (const sys of state.systems) {
        if (!sys?.userData) continue;
        const w = sys.userData._msEmissionScale ?? 1.0;
        if (sys.emissionOverTime) {
          sys.emissionOverTime.a = 10.0 * w * globalRate;
          sys.emissionOverTime.b = 20.0 * w * globalRate;
        }
        // Updraft.
        const ud = sys.userData.updraftForce;
        if (ud?.magnitude) ud.magnitude.value = (p.fireHeight ?? 10) * 0.125 * (p.fireUpdraft ?? 1.0);
        // Curl turbulence.
        const turb = sys.userData.turbulence;
        const baseCurl = sys.userData.baseCurlStrength;
        if (turb?.force && baseCurl) {
          const cs = p.fireCurlStrength ?? 1.0;
          turb.force.set(baseCurl.x * cs, baseCurl.y * cs, baseCurl.z * cs);
        }
        // Wind influence.
        const wf = sys.userData.windForce;
        if (wf && sys.userData) sys.userData.windInfluence = p.windInfluence ?? 1.0;
      }

      // Ember systems.
      for (const sys of state.emberSystems) {
        if (!sys?.userData) continue;
        const w = sys.userData._msEmissionScale ?? 1.0;
        if (sys.emissionOverTime) {
          sys.emissionOverTime.a = 5.0 * (p.emberRate ?? 1.0) * w * globalRate;
          sys.emissionOverTime.b = 10.0 * (p.emberRate ?? 1.0) * w * globalRate;
        }
        const ud = sys.userData.updraftForce;
        if (ud?.magnitude) ud.magnitude.value = (p.fireHeight ?? 10) * 0.4 * (p.emberUpdraft ?? 1.0);
        const turb = sys.userData.turbulence;
        const baseCurl = sys.userData.baseCurlStrength;
        if (turb?.force && baseCurl) {
          const cs = p.emberCurlStrength ?? 1.0;
          turb.force.set(baseCurl.x * cs, baseCurl.y * cs, baseCurl.z * cs);
        }
      }

      // Smoke systems.
      for (const sys of state.smokeSystems) {
        if (!sys?.userData) continue;
        const w = sys.userData._msEmissionScale ?? 1.0;
        const smokeRatio = Math.max(0.0, p.smokeRatio ?? 0.3);
        if (sys.emissionOverTime) {
          sys.emissionOverTime.a = 10.0 * w * smokeRatio * 0.5 * globalRate;
          sys.emissionOverTime.b = 20.0 * w * smokeRatio * 0.8 * globalRate;
        }
        const ud = sys.userData.updraftForce;
        if (ud?.magnitude) ud.magnitude.value = Math.max(0.0, p.smokeUpdraft ?? 2.5);
        const turb = sys.userData.turbulence;
        const baseCurl = sys.userData.baseCurlStrength;
        if (turb?.force && baseCurl) {
          const cs = Math.max(0.0, p.smokeTurbulence ?? 1.0);
          turb.force.set(baseCurl.x * cs, baseCurl.y * cs, baseCurl.z * cs);
        }
        if (sys.userData) sys.userData.windInfluence = p.smokeWindInfluence ?? 1.0;
      }
    }
  }

  // ── Private: Texture loading ───────────────────────────────────────────────

  /**
   * Load fire and ember sprite textures. Returns a promise that resolves
   * when both are loaded so populate() can safely reference them.
   * @returns {Promise<void>}
   * @private
   */
  _loadTextures() {
    const THREE = window.THREE;
    if (!THREE) return Promise.resolve();
    const loader = new THREE.TextureLoader();

    const fireP = new Promise((resolve) => {
      loader.load('modules/map-shine-advanced/assets/flame.webp', (tex) => {
        tex.minFilter = THREE.LinearFilter;
        tex.magFilter = THREE.LinearFilter;
        tex.generateMipmaps = false;
        tex.needsUpdate = true;
        this._fireTexture = tex;
        resolve();
      }, undefined, () => { log.warn('Failed to load flame.webp'); resolve(); });
    });

    const emberP = new Promise((resolve) => {
      loader.load('modules/map-shine-advanced/assets/particle.webp', (tex) => {
        tex.minFilter = THREE.LinearFilter;
        tex.magFilter = THREE.LinearFilter;
        tex.generateMipmaps = false;
        tex.needsUpdate = true;
        this._emberTexture = tex;
        resolve();
      }, undefined, () => { log.warn('Failed to load particle.webp'); resolve(); });
    });

    return Promise.all([fireP, emberP]).then(() => {
      log.info('Fire textures loaded');
    });
  }

  /**
   * Load an image from URL and return the HTMLImageElement.
   * @private
   */
  _loadImage(url) {
    return this._loadImageInternal(url, { suppressWarn: false });
  }

  /**
   * @param {string} url
   * @param {{ suppressWarn?: boolean }} [opts]
   * @returns {Promise<HTMLImageElement|null>}
   * @private
   */
  _loadImageInternal(url, opts = {}) {
    return new Promise((resolve) => {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => resolve(img);
      img.onerror = () => {
        if (!opts?.suppressWarn) log.warn(`Failed to load fire mask image: ${url}`);
        resolve(null);
      };
      img.src = url;
    });
  }

  /**
   * Try loading a mask image by probing common formats via Image() GET.
   * This intentionally avoids FilePicker and HEAD probing, which can fail on
   * some hosted setups even when GET succeeds.
   *
   * @param {string} basePathWithSuffix - e.g. "modules/foo/bar_Map_Fire" (no extension)
   * @returns {Promise<{ url: string, image: HTMLImageElement } | null>}
   * @private
   */
  async _tryLoadMaskImage(basePathWithSuffix, opts = {}) {
    if (!basePathWithSuffix) return null;
    const formats = Array.isArray(opts?.formats) && opts.formats.length ? opts.formats : FIRE_MASK_FORMATS;
    const cacheKey = `${basePathWithSuffix}::${formats.join(',')}`;

    if (this._directMaskCache?.has(cacheKey)) {
      return this._directMaskCache.get(cacheKey);
    }

    for (const ext of formats) {
      const url = `${basePathWithSuffix}.${ext}`;
      const img = await this._loadImageInternal(url, { suppressWarn: true });
      if (img) {
        const hit = { url, image: img };
        this._directMaskCache.set(cacheKey, hit);
        return hit;
      }
    }

    this._directMaskCache.set(cacheKey, null);
    return null;
  }

  // ── Private: Floor resolution ──────────────────────────────────────────────

  /** Same logic as SpecularEffectV2 and FloorRenderBus. @private */
  _resolveFloorIndex(tileDoc, floors) {
    if (!floors || floors.length <= 1) return 0;
    if (tileHasLevelsRange(tileDoc)) {
      const flags = readTileLevelsFlags(tileDoc);
      const tileBottom = Number(flags.rangeBottom);
      const tileTop = Number(flags.rangeTop);
      const topFinite = Number.isFinite(tileTop);
      const tileMid = topFinite ? ((tileBottom + tileTop) / 2) : tileBottom;

      // Prefer anchoring by the tile's bottom elevation (Levels-authoritative).
      // This avoids misrouting open-ended ranges and boundary-aligned ranges to
      // the lower floor band.
      if (Number.isFinite(tileBottom)) {
        for (let i = 0; i < floors.length; i++) {
          const f = floors[i];
          const isLast = i === floors.length - 1;
          if (tileBottom >= f.elevationMin && (tileBottom < f.elevationMax || (isLast && tileBottom <= f.elevationMax))) {
            return i;
          }
        }
      }

      if (Number.isFinite(tileMid)) {
        for (let i = 0; i < floors.length; i++) {
          const f = floors[i];
          const isLast = i === floors.length - 1;
          if (tileMid >= f.elevationMin && (tileMid < f.elevationMax || (isLast && tileMid <= f.elevationMax))) {
            return i;
          }
        }
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

  /** Get the elevation offset for a floor index (for Z positioning). @private */
  _resolveFloorElevation(floorIndex, floors) {
    if (!floors || floorIndex >= floors.length) return 0;
    const f = floors[floorIndex];
    return f?.elevationMin ?? 0;
  }

  /** @private */
  _computeStructuralSignature() {
    const p = this.params || {};
    return REBUILD_PARAM_KEYS.map((k) => `${k}:${Number(p[k] ?? 0).toFixed(4)}`).join('|');
  }

  /** @private */
  _queueRebuild() {
    if (this._rebuildInFlight) {
      this._rebuildQueued = true;
      return;
    }

    const sceneData = this._lastPopulateSceneData;
    if (!sceneData) return;

    this._rebuildInFlight = this.populate(sceneData)
      .catch((err) => {
        log.warn('FireEffectV2: runtime rebuild failed', err);
      })
      .finally(() => {
        this._rebuildInFlight = null;
        if (this._rebuildQueued) {
          this._rebuildQueued = false;
          this._queueRebuild();
        }
      });
  }
}
