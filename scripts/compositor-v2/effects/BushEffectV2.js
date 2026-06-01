/**
 * @fileoverview V2 Bush Effect — animated bush canopy overlay driven by _Bush masks.
 *
 * Archetype: Bus Overlay (Per-Tile Mesh)
 * - One ShaderMaterial overlay per tile/background with a _Bush mask.
 * - Overlay meshes are registered into FloorRenderBus so floor visibility is handled by the bus.
 * - No dependencies on V1 EffectBase / EffectMaskRegistry / TileEffectBindingManager.
 */

import { createLogger } from '../../core/log.js';
import { probeMaskFile } from '../../assets/loader.js';
import {
  tileHasLevelsRange,
  readTileLevelsFlags,
  resolveV14NativeDocFloorIndexMin,
  getVisibleLevelBackgroundLayers,
  resolveV14BackgroundFloorIndexForSrc,
} from '../../foundry/levels-scene-flags.js';
import { weatherController } from '../../core/WeatherController.js';
import { resolveEffectShadowSun2D } from '../shadow-system/ShadowSunDirection.js';
import {
  bushOverlayRenderOrders,
  tileAlbedoOrder,
} from '../LayerOrderPolicy.js';
import {
  applyVegetationAboveWaterLayer,
  overlayWorldBounds,
  resolveWorldViewBounds,
  tileBoundsIntersectView,
  cameraViewBoundsSignature,
  resolveVegetationEdgeSafetyBounds,
  vegetationEdgeSafetyBoundsSignature,
} from './vegetation-overlay-runtime.js';
import {
  VEGETATION_CLOUD_SHADOW_DEFAULTS,
  VEGETATION_CLOUD_SHADOW_UNIFORM_GLSL,
  VEGETATION_CLOUD_SHADOW_APPLY_GLSL,
  VEGETATION_CLOUD_SHADOW_CONTROL_SCHEMA,
  createVegetationCloudShadowUniforms,
  applyVegetationCloudShadowParamsToUniforms,
  syncVegetationCloudShadowUniforms,
} from './vegetation-cloud-shadow.js';
import {
  VEGETATION_LANDSCAPE_LIGHTNING_DEFAULTS,
  VEGETATION_LANDSCAPE_LIGHTNING_CONTROL_SCHEMA,
  VEGETATION_LANDSCAPE_LIGHTNING_UNIFORM_GLSL,
  VEGETATION_LANDSCAPE_LIGHTNING_APPLY_GLSL,
  createVegetationLandscapeLightningUniforms,
  createVegetationShadowLightningUniforms,
  applyVegetationLandscapeLightningParamsToUniforms,
  syncVegetationLandscapeLightningForEffect,
  linkVegetationLandscapeLightningUniforms,
} from './vegetation-landscape-lightning.js';

const log = createLogger('BushEffectV2');

const GROUND_Z = 1000;
const BUSH_Z_OFFSET = 0.12; // above albedo within same floor band

export class BushEffectV2 {
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

    /** @type {THREE.TextureLoader|null} */
    this._loader = null;

    /**
     * Overlay entries keyed by tileId.
     * @type {Map<string, {mesh: THREE.Mesh, shadowMesh: THREE.Mesh, material: THREE.ShaderMaterial, shadowMaterial: THREE.ShaderMaterial, floorIndex: number}>}
     */
    this._overlays = new Map();
    /** @type {number|null} */
    this._lastVisibilityFloorIndex = null;
    /** @type {string} */
    this._viewBoundsSignature = '';
    /** @type {{ minX: number, minY: number, maxX: number, maxY: number }|null} */
    this._cachedViewBounds = null;
    /** World-unit margin so wind distortion at tile edges still draws while panning. */
    this._viewCullPadding = 192;
    /** @type {object|null} Last populate geometry snapshot for edge-safety fallback. */
    this._lastFoundrySceneData = null;
    /** @type {string} Cached {@link vegetationEdgeSafetyBoundsSignature} */
    this._edgeSafetyBoundsSignature = '';

    /** @type {Set<string>} */
    this._negativeCache = new Set();

    /** @type {object|null} */
    this._sharedUniforms = null;

    // Derived-alpha support (some Bush masks can be authored as opaque RGB).
    /** @type {Map<string, boolean>} */
    this._deriveAlphaByTileId = new Map();

    // Temporal state (smoothed wind coupling)
    this._currentWindSpeed = 0.0;
    this._windFieldPhase = 0.0;
    this._wavePhase = 0.0;
    this._flutterPhase = 0.0;
    this._lastFrameTime = 0.0;

    // Public params (mirrors V1 schema / defaults)
    this.params = {
      enabled: true,
      textureStatus: 'Searching...',
      intensity: 1.0,

      // -- Wind Physics --
      windSpeedGlobal: 0.23,
      windRampSpeed: 0.74,
      gustFrequency: 0.01,
      gustSpeed: 0.5246,
      waveSpatialFrequency: 0.0018,
      waveTravelSpeed: 0.85,
      waveSharpness: 2.2,
      waveInfluence: 0.65,
      ambientMotion: 0.1,
      rustleFloorScale: 0.25,
      flutterBaseDrive: 0.3,
      flutterWindStart: 0.0,
      flutterWindFull: 0.12,
      flutterLowWindBoost: 1.35,
      flutterLowWindFadeEnd: 0.35,
      flutterGustFloor: 0.35,
      bendMinStrength: 0.2,
      bendWindStart: 0.22,
      bendWindFull: 0.78,
      minRustleSpeed: 0.04,
      edgeFadeStart: 0.03,
      edgeFadeEnd: 0.14,

      // -- Bush Movement --
      branchBend: 0.012,
      elasticity: 0.89,

      // -- Leaf Flutter --
      flutterIntensity: 0.0005,
      flutterSpeed: 1.19,
      flutterScale: 0.02,

      // -- Color --
      exposure: 0.0,
      brightness: 0.0,
      contrast: 1.0,
      saturation: 1.0,
      temperature: 0.0,
      tint: 0.0,

      // Canopy shadow (offset sample + blur in fragment shader)
      shadowOpacity: 0.5,
      shadowLength: 0.01,
      shadowSoftness: 0.5,

      ...VEGETATION_CLOUD_SHADOW_DEFAULTS,
      ...VEGETATION_LANDSCAPE_LIGHTNING_DEFAULTS,
    };

    log.debug('BushEffectV2 created');
  }

  get enabled() { return this._enabled; }
  set enabled(v) {
    this._enabled = !!v;
    this.params.enabled = this._enabled;
    this._viewBoundsMayHaveChanged();
    this._syncOverlayVisibility();
  }

  static getControlSchema() {
    return {
      enabled: true,
      help: {
        title: 'Bush canopy (_Bush masks)',
        summary: [
          'Animates **foliage-style motion** on tiles (and the scene background) that ship a matching **`_Bush`** texture next to the art.',
          'Weather **wind** drives gusts, traveling waves, branch bend, and leaf flutter. **Sun direction** (Foundry time or WeatherController) offsets a soft **canopy shadow** sample in the shader.',
          'One overlay per masked tile, registered on the floor bus so level visibility stays correct.',
          'Cost scales with overlay count; heavy motion uses more fragment work (shadow taps + distortion).',
          'Settings save with the scene (not World Based).',
        ].join('\n\n'),
        glossary: {
          'Mask status': 'Whether the scene found at least one `_Bush` texture after load.',
          Intensity: 'Overall strength of the bush layer (alpha and shadow contribution).',
          'Wind responsiveness': 'How quickly the effect catches up when scene wind speed changes.',
          'Rustle floor': 'Minimum motion when wind reads calm so bushes never look frozen.',
          'Canopy shadow': 'Darkening from a blurred, offset sample of the mask opposite the sun.',
          'Cloud shadows': 'Screen-space darkening from the cloud shadow map (same pass as ground tiles).',
          'Landscape lightning': 'HDR brightening on foliage during distant strikes (Map Shine Control lightning).',
          'Edge safety': 'Pulls motion and shadow down near scene edges to hide UV seams.',
        },
      },
      presetApplyDefaults: true,
      groups: [
        {
          name: 'status',
          label: 'Status',
          type: 'folder',
          advanced: true,
          expanded: true,
          parameters: ['textureStatus'],
        },
        {
          name: 'look',
          label: 'Look',
          type: 'folder',
          expanded: true,
          parameters: ['intensity'],
        },
        {
          name: 'wind',
          label: 'Wind & waves',
          type: 'folder',
          expanded: true,
          parameters: [
            'windSpeedGlobal', 'windRampSpeed', 'gustFrequency', 'gustSpeed',
            'waveSpatialFrequency', 'waveTravelSpeed', 'waveSharpness', 'waveInfluence', 'minRustleSpeed',
          ],
        },
        {
          name: 'branch',
          label: 'Branch motion',
          type: 'folder',
          advanced: true,
          expanded: false,
          parameters: ['branchBend', 'elasticity'],
        },
        {
          name: 'flutter',
          label: 'Leaf flutter',
          type: 'folder',
          advanced: true,
          expanded: false,
          parameters: ['flutterIntensity', 'flutterSpeed', 'flutterScale'],
        },
        {
          name: 'response',
          label: 'Response curves',
          type: 'folder',
          advanced: true,
          expanded: false,
          parameters: [
            'ambientMotion', 'rustleFloorScale',
            'flutterBaseDrive', 'flutterWindStart', 'flutterWindFull', 'flutterLowWindBoost', 'flutterLowWindFadeEnd', 'flutterGustFloor',
            'bendMinStrength', 'bendWindStart', 'bendWindFull',
          ],
        },
        {
          name: 'color',
          label: 'Color',
          type: 'folder',
          expanded: false,
          parameters: ['exposure', 'brightness', 'contrast', 'saturation', 'temperature', 'tint'],
        },
        {
          name: 'shadow',
          label: 'Canopy shadow',
          type: 'folder',
          advanced: true,
          expanded: false,
          parameters: ['shadowOpacity', 'shadowLength', 'shadowSoftness'],
        },
        {
          name: 'cloudShadow',
          label: 'Cloud shadows',
          type: 'folder',
          advanced: true,
          expanded: false,
          parameters: [
            'cloudShadowEnabled',
            'cloudShadowDarkenStrength',
            'cloudShadowDarkenCurve',
          ],
        },
        {
          name: 'landscapeLightning',
          label: 'Landscape lightning',
          type: 'folder',
          advanced: true,
          expanded: false,
          parameters: [
            'lightningVegetationEnabled',
            'lightningVegetationBrightnessBoost',
            'lightningVegetationContrastBoost',
            'lightningVegetationTintStrength',
          ],
        },
        {
          name: 'edges',
          label: 'Edge safety',
          type: 'folder',
          advanced: true,
          expanded: false,
          parameters: ['edgeFadeStart', 'edgeFadeEnd'],
        },
      ],
      parameters: {
        textureStatus: {
          type: 'string',
          label: 'Mask status',
          default: 'Searching...',
          readonly: true,
          tooltip: 'Updated when the scene loads: whether any `_Bush` mask was found.',
        },
        intensity: {
          type: 'slider',
          label: 'Intensity',
          min: 0.0,
          max: 2.0,
          step: 0.01,
          default: 1.0,
          throttle: 100,
          tooltip: 'Master strength of the bush layer and its shadow pass.',
        },
        windSpeedGlobal: {
          type: 'slider',
          label: 'Wind scale',
          min: 0.0,
          max: 3.0,
          step: 0.01,
          default: 0.23,
          throttle: 100,
          tooltip: 'Multiplies scene wind speed before driving motion.',
        },
        windRampSpeed: {
          type: 'slider',
          label: 'Wind catch-up',
          min: 0.1,
          max: 10.0,
          step: 0.05,
          default: 0.74,
          throttle: 100,
          tooltip: 'Higher = bush motion follows weather wind changes faster.',
        },
        gustFrequency: {
          type: 'slider',
          label: 'Gust frequency',
          min: 0.0,
          max: 0.05,
          step: 0.0001,
          default: 0.01,
          throttle: 100,
          tooltip: 'Spatial scale of the pseudo-gust noise field (higher values = tighter cells).',
        },
        gustSpeed: {
          type: 'slider',
          label: 'Gust travel',
          min: 0.0,
          max: 2.0,
          step: 0.01,
          default: 0.5246,
          throttle: 100,
          tooltip: 'How fast the gust field scrolls with wind.',
        },
        waveSpatialFrequency: {
          type: 'slider',
          label: 'Wave spacing',
          min: 0.0001,
          max: 0.01,
          step: 0.0001,
          default: 0.0018,
          throttle: 100,
          tooltip: 'How close together large wind waves are along the wind direction.',
        },
        waveTravelSpeed: {
          type: 'slider',
          label: 'Wave speed',
          min: 0.05,
          max: 4.0,
          step: 0.01,
          default: 0.85,
          throttle: 100,
          tooltip: 'Animation speed of the traveling wave carrier.',
        },
        waveSharpness: {
          type: 'slider',
          label: 'Wave sharpness',
          min: 0.5,
          max: 6.0,
          step: 0.05,
          default: 2.2,
          throttle: 100,
          tooltip: 'Exponent on the wave carrier — higher = crisper gust fronts.',
        },
        waveInfluence: {
          type: 'slider',
          label: 'Wave mix',
          min: 0.0,
          max: 1.0,
          step: 0.01,
          default: 0.65,
          throttle: 100,
          tooltip: 'How much the traveling wave modulates bend and flutter.',
        },
        ambientMotion: {
          type: 'slider',
          label: 'Ambient motion',
          min: 0.0,
          max: 0.35,
          step: 0.005,
          default: 0.1,
          throttle: 100,
          tooltip: 'Baseline motion added even when wind is calm.',
        },
        rustleFloorScale: {
          type: 'slider',
          label: 'Rustle floor scale',
          min: 0.0,
          max: 1.0,
          step: 0.01,
          default: 0.25,
          throttle: 100,
          tooltip: 'Scales the low-wind rustle floor (see Low-wind rustle).',
        },
        flutterBaseDrive: {
          type: 'slider',
          label: 'Flutter base drive',
          min: 0.0,
          max: 1.0,
          step: 0.01,
          default: 0.3,
          throttle: 100,
          tooltip: 'Minimum flutter response before wind ramps it up.',
        },
        flutterWindStart: {
          type: 'slider',
          label: 'Flutter wind start',
          min: 0.0,
          max: 0.4,
          step: 0.01,
          default: 0.0,
          throttle: 100,
          tooltip: 'Scene wind level where flutter begins to ramp.',
        },
        flutterWindFull: {
          type: 'slider',
          label: 'Flutter wind full',
          min: 0.01,
          max: 0.6,
          step: 0.01,
          default: 0.12,
          throttle: 100,
          tooltip: 'Scene wind level where flutter reaches full drive.',
        },
        flutterLowWindBoost: {
          type: 'slider',
          label: 'Low-wind flutter boost',
          min: 1.0,
          max: 2.5,
          step: 0.01,
          default: 1.35,
          throttle: 100,
          tooltip: 'Extra flutter multiplier when wind is barely moving.',
        },
        flutterLowWindFadeEnd: {
          type: 'slider',
          label: 'Boost fade end',
          min: 0.05,
          max: 1.0,
          step: 0.01,
          default: 0.35,
          throttle: 100,
          tooltip: 'Wind level where the low-wind boost has faded out.',
        },
        flutterGustFloor: {
          type: 'slider',
          label: 'Flutter gust floor',
          min: 0.0,
          max: 1.0,
          step: 0.01,
          default: 0.35,
          throttle: 100,
          tooltip: 'Minimum gust modulation applied to flutter in calm wind.',
        },
        bendMinStrength: {
          type: 'slider',
          label: 'Bend minimum',
          min: 0.0,
          max: 1.0,
          step: 0.01,
          default: 0.2,
          throttle: 100,
          tooltip: 'Floor on bend strength so branches still lean slightly in light wind.',
        },
        bendWindStart: {
          type: 'slider',
          label: 'Bend wind start',
          min: 0.0,
          max: 0.8,
          step: 0.01,
          default: 0.22,
          throttle: 100,
          tooltip: 'Wind level where branch bending starts ramping.',
        },
        bendWindFull: {
          type: 'slider',
          label: 'Bend wind full',
          min: 0.1,
          max: 1.0,
          step: 0.01,
          default: 0.78,
          throttle: 100,
          tooltip: 'Wind level where bend drive reaches full strength.',
        },
        minRustleSpeed: {
          type: 'slider',
          label: 'Low-wind rustle',
          min: 0.0,
          max: 0.6,
          step: 0.01,
          default: 0.04,
          throttle: 100,
          tooltip: 'Minimum effective wind speed for motion when the scene reports calm air.',
        },
        branchBend: {
          type: 'slider',
          label: 'Branch bend',
          min: 0.0,
          max: 0.05,
          step: 0.001,
          default: 0.012,
          throttle: 100,
          tooltip: 'How far UVs shift along wind when bending.',
        },
        elasticity: {
          type: 'slider',
          label: 'Springiness',
          min: 0.5,
          max: 5.0,
          step: 0.01,
          default: 0.89,
          throttle: 100,
          tooltip: 'Oscillation speed of the orbital sway term.',
        },
        flutterIntensity: {
          type: 'slider',
          label: 'Flutter amount',
          min: 0.0,
          max: 0.005,
          step: 0.0001,
          default: 0.0005,
          throttle: 100,
          tooltip: 'Strength of high-frequency leaf jitter.',
        },
        flutterSpeed: {
          type: 'slider',
          label: 'Flutter speed',
          min: 1.0,
          max: 20.0,
          step: 0.05,
          default: 1.19,
          throttle: 100,
          tooltip: 'How fast the flutter phase advances.',
        },
        flutterScale: {
          type: 'slider',
          label: 'Flutter scale',
          min: 0.005,
          max: 0.1,
          step: 0.001,
          default: 0.02,
          throttle: 100,
          tooltip: 'World-space scale of noise driving flutter.',
        },
        exposure: {
          type: 'slider',
          label: 'Exposure',
          min: -2.0,
          max: 2.0,
          step: 0.02,
          default: 0.0,
          throttle: 100,
          tooltip: 'Stops-style exposure before other color tweaks.',
        },
        brightness: {
          type: 'slider',
          label: 'Brightness',
          min: -0.5,
          max: 0.5,
          step: 0.01,
          default: 0.0,
          throttle: 100,
          tooltip: 'Linear offset after temperature/tint bias.',
        },
        contrast: {
          type: 'slider',
          label: 'Contrast',
          min: 0.5,
          max: 2.0,
          step: 0.01,
          default: 1.0,
          throttle: 100,
          tooltip: 'Contrast around mid gray.',
        },
        saturation: {
          type: 'slider',
          label: 'Saturation',
          min: 0.0,
          max: 2.0,
          step: 0.01,
          default: 1.0,
          throttle: 100,
          tooltip: '1 = unchanged; 0 = grayscale.',
        },
        temperature: {
          type: 'slider',
          label: 'Temperature',
          min: -1.0,
          max: 1.0,
          step: 0.01,
          default: 0.0,
          throttle: 100,
          tooltip: 'Warm/cool bias (pushes red vs blue).',
        },
        tint: {
          type: 'slider',
          label: 'Green/magenta',
          min: -1.0,
          max: 1.0,
          step: 0.01,
          default: 0.0,
          throttle: 100,
          tooltip: 'Shifts green vs magenta before brightness.',
        },
        shadowOpacity: {
          type: 'slider',
          label: 'Shadow strength',
          min: 0.0,
          max: 1.0,
          step: 0.01,
          default: 0.5,
          throttle: 100,
          tooltip: 'Opacity of the offset canopy shadow pass.',
        },
        shadowLength: {
          type: 'slider',
          label: 'Shadow offset',
          min: 0.0,
          max: 0.1,
          step: 0.001,
          default: 0.01,
          throttle: 100,
          tooltip: 'How far the shadow sample is pushed opposite the sun.',
        },
        shadowSoftness: {
          type: 'slider',
          label: 'Shadow softness',
          min: 0.5,
          max: 5.0,
          step: 0.05,
          default: 0.5,
          throttle: 100,
          tooltip: 'Blur radius of the multi-tap shadow sample.',
        },
        ...VEGETATION_CLOUD_SHADOW_CONTROL_SCHEMA,
        ...VEGETATION_LANDSCAPE_LIGHTNING_CONTROL_SCHEMA,
        edgeFadeStart: {
          type: 'slider',
          label: 'Edge fade start',
          min: 0.0,
          max: 0.2,
          step: 0.005,
          default: 0.03,
          throttle: 100,
          tooltip: 'Scene-edge band where motion begins to fall off.',
        },
        edgeFadeEnd: {
          type: 'slider',
          label: 'Edge fade end',
          min: 0.02,
          max: 0.4,
          step: 0.005,
          default: 0.14,
          throttle: 100,
          tooltip: 'Scene-edge distance where motion and shadow are fully suppressed.',
        },
      },
      presets: {
        Calm: {
          windSpeedGlobal: 0.12,
          gustSpeed: 0.35,
          waveInfluence: 0.42,
          flutterIntensity: 0.00035,
          branchBend: 0.008,
        },
        Windy: {
          windSpeedGlobal: 0.48,
          gustSpeed: 0.95,
          waveTravelSpeed: 1.15,
          branchBend: 0.018,
          waveSharpness: 2.6,
        },
        'Soft shadow': {
          shadowOpacity: 0.32,
          shadowLength: 0.007,
          shadowSoftness: 0.85,
        },
      },
    };
  }

  initialize() {
    const THREE = window.THREE;
    if (!THREE) return;
    this._loader = new THREE.TextureLoader();
    this._buildSharedUniforms();
    this._initialized = true;
    log.info('BushEffectV2 initialized');
  }

  /**
   * Scene rect for Foundry→Three Y flip: prefer sceneComposer snapshot, fall back to
   * `canvas.dimensions` when cold-load data is incomplete (matches refresh paths).
   * @param {object|null|undefined} foundrySceneData
   * @returns {{ worldH: number, sceneX: number, sceneY: number, sceneW: number, sceneH: number }}
   * @private
   */
  _resolvePopulateSceneGeometry(foundrySceneData) {
    const fd = foundrySceneData && typeof foundrySceneData === 'object' ? foundrySceneData : {};
    const d = typeof canvas !== 'undefined' ? canvas?.dimensions : null;
    const cw = Number(d?.width) || 0;
    const ch = Number(d?.height) || 0;
    let worldH = Number(fd.height) || 0;
    const sceneW0 = Number(fd.sceneWidth) || Number(fd.width) || cw || 0;
    const sceneH0 = Number(fd.sceneHeight) || Number(fd.height) || ch || 0;
    let sceneW = sceneW0;
    let sceneH = sceneH0;
    const sceneX = Number(fd.sceneX ?? 0) || 0;
    const sceneY = Number(fd.sceneY ?? 0) || 0;
    if (!worldH) worldH = ch || sceneH || 0;
    const rect = d?.sceneRect;
    if (rect && (!(sceneW > 0) || !(sceneH > 0))) {
      const rw = Number(rect.width) || 0;
      const rh = Number(rect.height) || 0;
      if (!(sceneW > 0) && rw > 0) sceneW = rw;
      if (!(sceneH > 0) && rh > 0) sceneH = rh;
    }
    return { worldH, sceneX, sceneY, sceneW, sceneH };
  }

  async populate(foundrySceneData) {
    if (!this._initialized) return;
    this.clear();

    this._lastFoundrySceneData = foundrySceneData ?? null;
    this._edgeSafetyBoundsSignature = '';
    this._syncSceneBoundsUniforms(true);

    const floors = window.MapShine?.floorStack?.getFloors() ?? [];
    const activeFloorIdxRaw = Number(window.MapShine?.floorStack?.getActiveFloor?.()?.index);
    const activeFloorIdx = Number.isFinite(activeFloorIdxRaw) ? activeFloorIdxRaw : 0;
    const { worldH, sceneX, sceneY, sceneW, sceneH } = this._resolvePopulateSceneGeometry(foundrySceneData);

    // Background overlays: prefer native scene.levels so every floor's authored
    // background can get a corresponding _Bush overlay regardless of current view.
    // Fallback to visible configured backgrounds for non-level scenes.
    const scene = canvas?.scene ?? null;
    const bgEntries = [];
    const floorIndexByLevelId = new Map();
    try {
      for (const f of floors) {
        const levelId = (f?.levelId != null) ? String(f.levelId) : '';
        const idx = Number(f?.index);
        if (!levelId || !Number.isFinite(idx)) continue;
        floorIndexByLevelId.set(levelId, idx);
      }
    } catch (_) {}
    try {
      const sortedLevels = scene?.levels?.sorted ?? [];
      if (Array.isArray(sortedLevels) && sortedLevels.length > 0) {
        for (let i = 0; i < sortedLevels.length; i += 1) {
          const level = sortedLevels[i];
          const src = String(level?.background?.src || '').trim();
          if (!src) continue;
          const levelId = (level?.id != null) ? String(level.id) : '';
          const mappedFloorIndex = levelId ? floorIndexByLevelId.get(levelId) : undefined;
          const floorIndex = Number.isFinite(Number(mappedFloorIndex))
            ? Number(mappedFloorIndex)
            : i;
          const keyIndex = Math.max(0, Math.floor(Number(level?.index)));
          const key = (keyIndex === 0) ? '__bg_image__' : `__bg_image__${keyIndex}`;
          if (Number.isFinite(activeFloorIdx) && floorIndex !== activeFloorIdx) continue;
          bgEntries.push({ src, floorIndex, key });
        }
      }
    } catch (_) {}
    if (bgEntries.length === 0) {
      const bgLayers = getVisibleLevelBackgroundLayers(scene);
      for (let i = 0; i < bgLayers.length; i += 1) {
        const src = String(bgLayers[i]?.src || '').trim();
        if (!src) continue;
        const floorIndex = resolveV14BackgroundFloorIndexForSrc(scene, src);
        if (Number.isFinite(activeFloorIdx) && floorIndex !== activeFloorIdx) continue;
        const key = floorIndex === 0 ? '__bg_image__' : `__bg_image__${floorIndex}`;
        bgEntries.push({ src, floorIndex, key });
      }
    }
    for (const bg of bgEntries) {
      const basePath = bg.src.replace(/\.[^.]+$/, '');
      const url = await this._probeMask(basePath, '_Bush');
      if (!url) continue;
      const centerX = sceneX + sceneW / 2;
      const centerY = worldH - (sceneY + sceneH / 2);
      const tileW = sceneW;
      const tileH = sceneH;
      const z = GROUND_Z - 1 + BUSH_Z_OFFSET;
      this._createOverlay(bg.key, bg.floorIndex, { url, centerX, centerY, z, tileW, tileH, rotation: 0 });
    }

    // Tiles
    const tileDocs = canvas?.scene?.tiles?.contents ?? [];
    for (const tileDoc of tileDocs) {
      const src = tileDoc?.texture?.src ?? tileDoc?.img ?? '';
      if (!src) continue;

      const basePath = src.replace(/\.[^.]+$/, '');
      const url = await this._probeMask(basePath, '_Bush');
      if (!url) continue;

      const floorIndex = this._resolveFloorIndex(tileDoc, floors);
      const tileW = Number(tileDoc?.width ?? 0);
      const tileH = Number(tileDoc?.height ?? 0);
      const centerX = Number(tileDoc?.x ?? 0) + tileW / 2;
      const centerY = worldH - (Number(tileDoc?.y ?? 0) + tileH / 2);
      const z = GROUND_Z + floorIndex + BUSH_Z_OFFSET;
      const rotation = typeof tileDoc?.rotation === 'number' ? (tileDoc.rotation * Math.PI) / 180 : 0;
      const tileId = tileDoc.id ?? tileDoc._id;
      if (!tileId) continue;

      this._createOverlay(tileId, floorIndex, { url, centerX, centerY, z, tileW, tileH, rotation });
    }

    const n = this._overlays.size;
    this.params.textureStatus = n > 0
      ? 'Ready (_Bush mask found)'
      : 'Inactive (no _Bush mask)';
    log.info(`BushEffectV2 populated: ${n} overlays`);
  }

  /**
   * Minimal uniform tick while the camera is panning — skips wind/weather CPU work.
   * @param {{ elapsed?: number, delta?: number, motionDelta?: number, time?: number }} timeInfo
   */
  updateNavigationLite(timeInfo) {
    if (!this._enabled || !this._initialized) return;
    const time = Number.isFinite(timeInfo?.elapsed)
      ? Number(timeInfo.elapsed)
      : Number(timeInfo?.time ?? 0);
    const delta = Number.isFinite(timeInfo?.motionDelta)
      ? Number(timeInfo.motionDelta)
      : (Number.isFinite(timeInfo?.delta) ? Number(timeInfo.delta) : 0.016);
    const phaseDelta = Math.min(0.25, Math.max(0.0, delta));
    this._windFieldPhase += phaseDelta * 0.16;
    this._wavePhase += phaseDelta * 0.2;
    this._flutterPhase += phaseDelta * 0.3;
    if (this._sharedUniforms) {
      this._sharedUniforms.uTime.value = time;
      this._sharedUniforms.uWindFieldPhase.value = this._windFieldPhase;
      this._sharedUniforms.uWavePhase.value = this._wavePhase;
      this._sharedUniforms.uFlutterPhase.value = this._flutterPhase;
    }
    const maxFloor = this._getSafeVisibleMaxFloorIndex();
    const floorChanged = maxFloor !== this._lastVisibilityFloorIndex;
    const viewChanged = this._viewBoundsMayHaveChanged();
    if (floorChanged) this._lastVisibilityFloorIndex = maxFloor;
    if (floorChanged || viewChanged) this._syncOverlayVisibility();
    this._lastFrameTime = time;
  }

  update(timeInfo) {
    if (!this._enabled || !this._initialized) return;

    const maxFloor = this._getSafeVisibleMaxFloorIndex();
    const floorChanged = maxFloor !== this._lastVisibilityFloorIndex;
    const viewChanged = this._viewBoundsMayHaveChanged();
    if (floorChanged) this._lastVisibilityFloorIndex = maxFloor;
    if (floorChanged || viewChanged) this._syncOverlayVisibility();

    const time = Number.isFinite(timeInfo?.elapsed)
      ? Number(timeInfo.elapsed)
      : Number(timeInfo?.time ?? 0);
    const delta = Number.isFinite(timeInfo?.motionDelta)
      ? Number(timeInfo.motionDelta)
      : (Number.isFinite(timeInfo?.delta)
      ? Number(timeInfo.delta)
      : 0.016);

    // Wind coupling — use WeatherController's smoothed state.
    const weather = weatherController?.currentState;
    const windDir = weather?.windDirection;
    const windSpeed01 = Number(weather?.windSpeed ?? 0);

    // Smooth wind speed to avoid snapping.
    const ramp = Math.max(0.001, Number(this.params.windRampSpeed ?? 1));
    const lerpT = Math.min(1.0, delta * ramp);
    this._currentWindSpeed = this._currentWindSpeed + (windSpeed01 - this._currentWindSpeed) * lerpT;

    const phaseDelta = Math.min(0.25, Math.max(0.0, delta));
    const rawWind = Math.max(0.0, Math.min(1.0, this._currentWindSpeed));
    const speed = Math.max(0.0, rawWind * Number(this.params.windSpeedGlobal ?? 0.0));
    const rustleFloor = Math.max(0.0, Number(this.params.minRustleSpeed ?? 0.0) * Math.max(0.0, Number(this.params.rustleFloorScale ?? 0.0)));
    const rustleSpeed = Math.max(speed, rustleFloor);
    const windFieldTravel = rawWind <= 0.0
      ? 0.16
      : (0.16 + (Math.max(0.16, Number(this.params.gustSpeed ?? 0.0)) - 0.16) * rawWind);
    this._windFieldPhase += phaseDelta * windFieldTravel * (0.2 + rawWind);
    this._wavePhase += phaseDelta * Math.max(0.0, Number(this.params.waveTravelSpeed ?? 0.0)) * (0.35 + rustleSpeed);
    this._flutterPhase += phaseDelta * Math.max(0.0, Number(this.params.flutterSpeed ?? 0.0)) * (0.85 + rustleSpeed);

    this._syncSceneBoundsUniforms();

    // Update shared uniforms.
    if (this._sharedUniforms) {
      this._sharedUniforms.uTime.value = time;
      this._sharedUniforms.uWindFieldPhase.value = this._windFieldPhase;
      this._sharedUniforms.uWavePhase.value = this._wavePhase;
      this._sharedUniforms.uFlutterPhase.value = this._flutterPhase;
      if (windDir && typeof windDir.x === 'number' && typeof windDir.y === 'number') {
        // Weather wind vectors are Foundry-space (Y-down); shader world is Three-space (Y-up).
        this._sharedUniforms.uWindDir.value.set(windDir.x, -windDir.y);
      }
      this._sharedUniforms.uWindSpeed.value = this._currentWindSpeed;

      // Params
      this._sharedUniforms.uIntensity.value = (this.params.intensity ?? 1.0);
      this._sharedUniforms.uWindSpeedGlobal.value = this.params.windSpeedGlobal;
      this._sharedUniforms.uGustFrequency.value = this.params.gustFrequency;
      this._sharedUniforms.uGustSpeed.value = this.params.gustSpeed;
      this._sharedUniforms.uWaveSpatialFrequency.value = this.params.waveSpatialFrequency;
      this._sharedUniforms.uWaveTravelSpeed.value = this.params.waveTravelSpeed;
      this._sharedUniforms.uWaveSharpness.value = this.params.waveSharpness;
      this._sharedUniforms.uWaveInfluence.value = this.params.waveInfluence;
      this._sharedUniforms.uAmbientMotion.value = this.params.ambientMotion;
      this._sharedUniforms.uRustleFloorScale.value = this.params.rustleFloorScale;
      this._sharedUniforms.uFlutterBaseDrive.value = this.params.flutterBaseDrive;
      this._sharedUniforms.uFlutterWindStart.value = this.params.flutterWindStart;
      this._sharedUniforms.uFlutterWindFull.value = this.params.flutterWindFull;
      this._sharedUniforms.uFlutterLowWindBoost.value = this.params.flutterLowWindBoost;
      this._sharedUniforms.uFlutterLowWindFadeEnd.value = this.params.flutterLowWindFadeEnd;
      this._sharedUniforms.uFlutterGustFloor.value = this.params.flutterGustFloor;
      this._sharedUniforms.uBendMinStrength.value = this.params.bendMinStrength;
      this._sharedUniforms.uBendWindStart.value = this.params.bendWindStart;
      this._sharedUniforms.uBendWindFull.value = this.params.bendWindFull;
      this._sharedUniforms.uMinRustleSpeed.value = this.params.minRustleSpeed;
      this._sharedUniforms.uEdgeFadeStart.value = this.params.edgeFadeStart;
      this._sharedUniforms.uEdgeFadeEnd.value = this.params.edgeFadeEnd;
      this._sharedUniforms.uBranchBend.value = this.params.branchBend;
      this._sharedUniforms.uElasticity.value = this.params.elasticity;
      this._sharedUniforms.uFlutterIntensity.value = this.params.flutterIntensity;
      this._sharedUniforms.uFlutterSpeed.value = this.params.flutterSpeed;
      this._sharedUniforms.uFlutterScale.value = this.params.flutterScale;
      this._sharedUniforms.uShadowSoftness.value = this.params.shadowSoftness * (Number(this._driverShadowSoftnessScale) || 1.0);

      this._sharedUniforms.uExposure.value = this.params.exposure;
      this._sharedUniforms.uBrightness.value = this.params.brightness;
      this._sharedUniforms.uContrast.value = this.params.contrast;
      this._sharedUniforms.uSaturation.value = this.params.saturation;
      this._sharedUniforms.uTemperature.value = this.params.temperature;
      this._sharedUniforms.uTint.value = this.params.tint;

      this._applyShadowDriverUniforms();
      applyVegetationCloudShadowParamsToUniforms(this._sharedUniforms, this.params);
      applyVegetationLandscapeLightningParamsToUniforms(this._sharedUniforms, this.params);
    }

    this._lastFrameTime = time;
  }

  /**
   * Bind CloudEffectV2 shadow map for canopy darkening (call after cloud render each frame).
   */
  syncCloudShadowUniforms() {
    if (!this._initialized || !this._sharedUniforms) return;
    syncVegetationCloudShadowUniforms(this._sharedUniforms, this.params);
  }

  /**
   * Bind landscape lightning flash from WeatherLightningEffectV2 (after its update each frame).
   */
  syncLandscapeLightningUniforms() {
    if (!this._initialized) return;
    syncVegetationLandscapeLightningForEffect(this);
  }

  onFloorChange(_maxFloorIndex) {
    this._lastVisibilityFloorIndex = null;
    this._viewBoundsMayHaveChanged();
    this._syncOverlayVisibility();
  }

  wantsContinuousRender() {
    return this._enabled && this._initialized && this._overlays.size > 0;
  }

  onResize(_w, _h) {
    this._edgeSafetyBoundsSignature = '';
    this._syncSceneBoundsUniforms();
  }

  clear() {
    for (const [tileId, entry] of this._overlays) {
      this._renderBus.removeEffectOverlay(`${tileId}_bush_shadow`);
      this._renderBus.removeEffectOverlay(`${tileId}_bush`);
      entry.material.dispose();
      entry.shadowMaterial.dispose();
      entry.mesh.geometry.dispose();
      const tex = entry.material.uniforms.uBushMask?.value;
      if (tex && tex.dispose) {
        try { tex.dispose(); } catch (_) {}
      }
    }
    this._overlays.clear();
    this._deriveAlphaByTileId.clear();
    this._lastFoundrySceneData = null;
    this._edgeSafetyBoundsSignature = '';
    this.params.textureStatus = 'Inactive (no _Bush mask)';
  }

  /**
   * @param {string} tileId
   * @private
   */
  _disposeSingleTileOverlay(tileId) {
    if (!tileId || String(tileId).startsWith('__bg_image__')) return;
    const entry = this._overlays.get(tileId);
    if (!entry) return;
    this._renderBus.removeEffectOverlay(`${tileId}_bush_shadow`);
    this._renderBus.removeEffectOverlay(`${tileId}_bush`);
    try { entry.material.dispose(); } catch (_) {}
    try { entry.shadowMaterial.dispose(); } catch (_) {}
    try { entry.mesh.geometry.dispose(); } catch (_) {}
    const tex = entry.material.uniforms.uBushMask?.value;
    if (tex && tex.dispose) {
      try { tex.dispose(); } catch (_) {}
    }
    this._overlays.delete(tileId);
    try { this._deriveAlphaByTileId.delete(tileId); } catch (_) {}
  }

  /**
   * Re-probe `_Bush` and rebuild the overlay after `texture.src` changed on a tile.
   *
   * @param {object} tileDoc
   * @param {object|null} foundrySceneData
   */
  async refreshTileAfterTextureChange(tileDoc, foundrySceneData) {
    if (!this._initialized || !tileDoc) return;
    const tileId = tileDoc.id ?? tileDoc._id;
    if (!tileId) return;

    this._disposeSingleTileOverlay(tileId);

    const src = tileDoc?.texture?.src ?? tileDoc?.img ?? '';
    if (!src) return;

    const floors = window.MapShine?.floorStack?.getFloors?.() ?? [];
    const worldH = Number(foundrySceneData?.height) || (typeof canvas !== 'undefined' ? Number(canvas?.dimensions?.height) || 0 : 0);

    const basePath = src.replace(/\.[^.]+$/, '');
    const url = await this._probeMask(basePath, '_Bush');
    if (!url) return;

    const floorIndex = this._resolveFloorIndex(tileDoc, floors);
    const tileW = Number(tileDoc?.width ?? 0);
    const tileH = Number(tileDoc?.height ?? 0);
    const centerX = Number(tileDoc?.x ?? 0) + tileW / 2;
    const centerY = worldH - (Number(tileDoc?.y ?? 0) + tileH / 2);
    const z = GROUND_Z + floorIndex + BUSH_Z_OFFSET;
    const rotation = typeof tileDoc?.rotation === 'number' ? (tileDoc.rotation * Math.PI) / 180 : 0;

    this._createOverlay(tileId, floorIndex, { url, centerX, centerY, z, tileW, tileH, rotation });
  }

  setBillboardShadowMode(enabled) {
    if (!this._sharedUniforms?.uBillboardShadowMode) return;
    this._sharedUniforms.uBillboardShadowMode.value = enabled ? 1.0 : 0.0;
  }

  /**
   * Screen-space tree canopy alpha used to suppress bush ground shadows on foliage.
   * @param {import('three').Texture|null} texture
   * @param {number} [width]
   * @param {number} [height]
   */
  setTreeCanopyOcclusionTexture(texture, width = 0, height = 0) {
    if (!this._sharedUniforms) return;
    this._sharedUniforms.uTreeCanopyOcclusion.value = texture ?? null;
    this._sharedUniforms.uHasTreeCanopyOcclusion.value = texture ? 1.0 : 0.0;
    const w = Number(width);
    const h = Number(height);
    if (Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0) {
      this._sharedUniforms.uScreenSize.value.set(w, h);
    }
  }

  /**
   * @returns {{mesh: import('three').Mesh, uniforms: object}[]}
   */
  collectBillboardShadowOverlayEntries() {
    if (!this._enabled || !this._initialized) return [];
    const out = [];
    for (const entry of this._overlays.values()) {
      if (!entry?.shadowMesh?.visible || !entry.shadowMaterial?.uniforms) continue;
      out.push({
        mesh: entry.shadowMesh,
        uniforms: entry.shadowMaterial.uniforms,
        material: entry.shadowMaterial,
      });
    }
    return out;
  }

  /**
   * Live bush canopy meshes for screen-space coverage (water specular / bloom mask).
   * @returns {{mesh: import('three').Mesh, material: import('three').Material}[]}
   */
  collectCanopyOcclusionEntries() {
    if (!this._enabled || !this._initialized) return [];
    const out = [];
    for (const entry of this._overlays.values()) {
      if (!entry?.mesh?.visible || !entry?.material) continue;
      out.push({
        mesh: entry.mesh,
        material: entry.material,
      });
    }
    return out;
  }

  dispose() {
    this.clear();
    this._loader = null;
    this._sharedUniforms = null;
    this._initialized = false;
    log.info('BushEffectV2 disposed');
  }

  // ── Private helpers ─────────────────────────────────────────────────────────

  _buildSharedUniforms() {
    const THREE = window.THREE;
    this._sharedUniforms = {
      uBushMask: { value: null },
      uTime: { value: 0.0 },
      uWindFieldPhase: { value: 0.0 },
      uWavePhase: { value: 0.0 },
      uFlutterPhase: { value: 0.0 },
      uWindDir: { value: new THREE.Vector2(1.0, 0.0) },
      uSunDir: { value: new THREE.Vector2(0.0, -1.0) },
      uWindSpeed: { value: 0.0 },
      uSceneMin: { value: new THREE.Vector2(0.0, 0.0) },
      uSceneMax: { value: new THREE.Vector2(1.0, 1.0) },

      uIntensity: { value: (this.params.intensity ?? 1.0) },
      uWindSpeedGlobal: { value: this.params.windSpeedGlobal },
      uGustFrequency: { value: this.params.gustFrequency },
      uGustSpeed: { value: this.params.gustSpeed },
      uWaveSpatialFrequency: { value: this.params.waveSpatialFrequency },
      uWaveTravelSpeed: { value: this.params.waveTravelSpeed },
      uWaveSharpness: { value: this.params.waveSharpness },
      uWaveInfluence: { value: this.params.waveInfluence },
      uAmbientMotion: { value: this.params.ambientMotion },
      uRustleFloorScale: { value: this.params.rustleFloorScale },
      uFlutterBaseDrive: { value: this.params.flutterBaseDrive },
      uFlutterWindStart: { value: this.params.flutterWindStart },
      uFlutterWindFull: { value: this.params.flutterWindFull },
      uFlutterLowWindBoost: { value: this.params.flutterLowWindBoost },
      uFlutterLowWindFadeEnd: { value: this.params.flutterLowWindFadeEnd },
      uFlutterGustFloor: { value: this.params.flutterGustFloor },
      uBendMinStrength: { value: this.params.bendMinStrength },
      uBendWindStart: { value: this.params.bendWindStart },
      uBendWindFull: { value: this.params.bendWindFull },
      uMinRustleSpeed: { value: this.params.minRustleSpeed },
      uEdgeFadeStart: { value: this.params.edgeFadeStart },
      uEdgeFadeEnd: { value: this.params.edgeFadeEnd },
      uBranchBend: { value: this.params.branchBend },
      uElasticity: { value: this.params.elasticity },
      uFlutterIntensity: { value: this.params.flutterIntensity },
      uFlutterSpeed: { value: this.params.flutterSpeed },
      uFlutterScale: { value: this.params.flutterScale },
      uShadowOpacity: { value: this.params.shadowOpacity },
      uShadowLength: { value: this.params.shadowLength },
      uShadowSoftness: { value: this.params.shadowSoftness },

      uBillboardShadowMode: { value: 0.0 },
      uShadowLitCapture: { value: 0.0 },
      uTreeCanopyOcclusion: { value: null },
      uHasTreeCanopyOcclusion: { value: 0.0 },
      uScreenSize: { value: new THREE.Vector2(1920, 1080) },

      uExposure: { value: this.params.exposure },
      uBrightness: { value: this.params.brightness },
      uContrast: { value: this.params.contrast },
      uSaturation: { value: this.params.saturation },
      uTemperature: { value: this.params.temperature },
      uTint: { value: this.params.tint },

      uDeriveAlpha: { value: 0.0 },
      ...createVegetationCloudShadowUniforms(THREE, this.params),
      ...createVegetationLandscapeLightningUniforms(THREE, this.params),
    };
  }

  async _probeMask(basePath, suffix) {
    if (!basePath || this._negativeCache.has(basePath)) return null;
    try {
      const res = await probeMaskFile(basePath, suffix);
      if (res?.path) return res.path;
      this._negativeCache.add(basePath);
      return null;
    } catch (err) {
      this._negativeCache.add(basePath);
      return null;
    }
  }

  _resolveFloorIndex(tileDoc, floors) {
    if (!floors || floors.length <= 1) return 0;

    // Prefer V14 native level assignment first. Legacy Levels ranges may still
    // exist on migrated content but not reflect the current native floor mapping.
    const v14Idx = resolveV14NativeDocFloorIndexMin(tileDoc, globalThis.canvas?.scene);
    if (v14Idx !== null) return v14Idx;

    if (tileHasLevelsRange(tileDoc)) {
      const flags = readTileLevelsFlags(tileDoc);
      const mid = (Number(flags.rangeBottom) + Number(flags.rangeTop)) / 2;
      for (let i = 0; i < floors.length; i++) {
        if (mid >= floors[i].elevationMin && mid <= floors[i].elevationMax) return i;
      }
    }
    const elev = Number.isFinite(Number(tileDoc?.elevation)) ? Number(tileDoc.elevation) : 0;
    for (let i = 0; i < floors.length; i++) {
      if (elev >= floors[i].elevationMin && elev <= floors[i].elevationMax) return i;
    }
    return 0;
  }

  /**
   * @param {boolean} [preferSnapshot=false] Use populate snapshot over stale canvas rect.
   * @private
   */
  _syncSceneBoundsUniforms(preferSnapshot = false) {
    if (!this._sharedUniforms) return;
    const bounds = resolveVegetationEdgeSafetyBounds(this._lastFoundrySceneData, { preferSnapshot });
    if (!bounds) return;
    const sig = vegetationEdgeSafetyBoundsSignature(bounds);
    if (sig === this._edgeSafetyBoundsSignature) return;
    this._edgeSafetyBoundsSignature = sig;
    this._sharedUniforms.uSceneMin.value.set(bounds.minX, bounds.minY);
    this._sharedUniforms.uSceneMax.value.set(bounds.maxX, bounds.maxY);
  }

  _syncSunDirectionUniform() {
    if (!this._sharedUniforms?.uSunDir?.value) return;
    if (this._driverSunDir) {
      this._sharedUniforms.uSunDir.value.set(this._driverSunDir.x, this._driverSunDir.y);
      return;
    }
    const sky = window.MapShine?.effectComposer?._floorCompositorV2?._skyColorEffect
      ?? window.MapShine?.floorCompositorV2?._skyColorEffect;
    const sun2d = resolveEffectShadowSun2D({
      azimuthDeg: sky?.currentSunAzimuthDeg,
      elevationDeg: sky?.currentSunElevationDeg,
    });
    this._sharedUniforms.uSunDir.value.set(sun2d.x, sun2d.y);
  }

  /**
   * Push ShadowDriverState sun + tuning into shared uniforms (also called from setDriver).
   * @private
   */
  _applyShadowDriverUniforms() {
    if (!this._sharedUniforms) return;
    this._syncSunDirectionUniform();
    const opScale = Math.max(0.0, Number(this._driverShadowOpacityScale) || 1.0);
    const lenScale = Math.max(0.05, Number(this._driverShadowLengthScale) || 1.0);
    const baseLen = Number(this.params.shadowLength ?? 0.01);
    const baseOp = Number(this.params.shadowOpacity ?? 0.5);
    this._sharedUniforms.uShadowLength.value = baseLen * lenScale;
    this._sharedUniforms.uShadowOpacity.value = Math.max(0.0, Math.min(1.0, baseOp * opScale));
  }

  setDriver(driverState = null) {
    const dir = driverState?.sun?.dir;
    const x = Number(dir?.x);
    const y = Number(dir?.y);
    this._driverSunDir = (Number.isFinite(x) && Number.isFinite(y)) ? { x, y } : null;
    if (Number.isFinite(Number(driverState?.tuning?.shadowSoftnessScale))) {
      this._driverShadowSoftnessScale = Number(driverState.tuning.shadowSoftnessScale);
    }
    if (Number.isFinite(Number(driverState?.tuning?.shadowOpacityScale))) {
      this._driverShadowOpacityScale = Number(driverState.tuning.shadowOpacityScale);
    }
    if (Number.isFinite(Number(driverState?.tuning?.shadowLengthScale))) {
      this._driverShadowLengthScale = Number(driverState.tuning.shadowLengthScale);
    }
    this._applyShadowDriverUniforms();
  }

  _createOverlay(tileId, floorIndex, opts) {
    const THREE = window.THREE;
    if (!THREE || !this._sharedUniforms) return;

    const { url, centerX, centerY, z, tileW, tileH, rotation } = opts;

    const uniforms = {
      ...this._sharedUniforms,
      uBushMask: { value: null },
      uDeriveAlpha: { value: 0.0 },
      uVegetationPass: { value: 2.0 },
    };
    const shadowUniforms = {
      ...this._sharedUniforms,
      ...createVegetationShadowLightningUniforms(THREE),
      uBushMask: { value: null },
      uDeriveAlpha: { value: 0.0 },
      uVegetationPass: { value: 1.0 },
    };
    linkVegetationLandscapeLightningUniforms(uniforms, this._sharedUniforms);

    const material = new THREE.ShaderMaterial({
      uniforms,
      vertexShader: /* glsl */`
        varying vec2 vUv;
        varying vec2 vWorldPos;
        void main() {
          vUv = uv;
          vec4 worldPos = modelMatrix * vec4(position, 1.0);
          vWorldPos = worldPos.xy;
          gl_Position = projectionMatrix * viewMatrix * worldPos;
        }
      `,
      fragmentShader: /* glsl */`
        uniform sampler2D uBushMask;
        uniform float uTime;
        uniform float uWindFieldPhase;
        uniform float uWavePhase;
        uniform float uFlutterPhase;
        uniform vec2  uWindDir;
        uniform vec2  uSunDir;
        uniform float uWindSpeed;
        uniform float uIntensity;

        uniform float uWindSpeedGlobal;
        uniform float uGustFrequency;
        uniform float uGustSpeed;
        uniform float uWaveSpatialFrequency;
        uniform float uWaveTravelSpeed;
        uniform float uWaveSharpness;
        uniform float uWaveInfluence;
        uniform float uAmbientMotion;
        uniform float uRustleFloorScale;
        uniform float uFlutterBaseDrive;
        uniform float uFlutterWindStart;
        uniform float uFlutterWindFull;
        uniform float uFlutterLowWindBoost;
        uniform float uFlutterLowWindFadeEnd;
        uniform float uFlutterGustFloor;
        uniform float uBendMinStrength;
        uniform float uBendWindStart;
        uniform float uBendWindFull;
        uniform float uMinRustleSpeed;
        uniform float uEdgeFadeStart;
        uniform float uEdgeFadeEnd;
        uniform float uBranchBend;
        uniform float uElasticity;
        uniform float uFlutterIntensity;
        uniform float uFlutterSpeed;
        uniform float uFlutterScale;
        uniform float uShadowOpacity;
        uniform float uShadowLength;
        uniform float uShadowSoftness;
        uniform float uBillboardShadowMode;
        uniform float uShadowLitCapture;
        uniform sampler2D uTreeCanopyOcclusion;
        uniform float uHasTreeCanopyOcclusion;
        uniform vec2  uScreenSize;
        uniform vec2  uSceneMin;
        uniform vec2  uSceneMax;

        uniform float uExposure;
        uniform float uBrightness;
        uniform float uContrast;
        uniform float uSaturation;
        uniform float uTemperature;
        uniform float uTint;

        uniform float uDeriveAlpha;
        uniform float uVegetationPass;
${VEGETATION_CLOUD_SHADOW_UNIFORM_GLSL}
${VEGETATION_LANDSCAPE_LIGHTNING_UNIFORM_GLSL}

        varying vec2 vUv;
        varying vec2 vWorldPos;

        float hash(vec2 p) {
          return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453);
        }

        float noise(vec2 p) {
          vec2 i = floor(p);
          vec2 f = fract(p);
          vec2 u = f * f * (3.0 - 2.0 * f);
          return mix(
            mix(hash(i + vec2(0.0,0.0)), hash(i + vec2(1.0,0.0)), u.x),
            mix(hash(i + vec2(0.0,1.0)), hash(i + vec2(1.0,1.0)), u.x),
            u.y
          );
        }

        float msLuminance(vec3 c) {
          return dot(c, vec3(0.2126, 0.7152, 0.0722));
        }

        vec3 applyCC(vec3 color) {
          color *= pow(2.0, uExposure);
          float t = uTemperature;
          float g = uTint;
          color.r += t * 0.1; color.b -= t * 0.1; color.g += g * 0.1;
          color += vec3(uBrightness);
          color = (color - 0.5) * uContrast + 0.5;
          float l = msLuminance(color);
          color = mix(vec3(l), color, uSaturation);
          return color;
        }

        float safeAlpha(vec4 s) {
          float a = s.a;
          if (uDeriveAlpha > 0.5 && a > 0.99) {
            float lum    = dot(s.rgb, vec3(0.2126, 0.7152, 0.0722));
            float maxC   = max(s.r, max(s.g, s.b));
            float minC   = min(s.r, min(s.g, s.b));
            float chroma = maxC - minC;
            float isBright = step(0.85, lum);
            float isDesat  = 1.0 - step(0.06, chroma);
            float bg = isBright * isDesat;
            a *= (1.0 - bg);
          }
          return a;
        }

        void main() {
          vec2 windDir = normalize(uWindDir);
          if (length(windDir) < 0.01) windDir = vec2(1.0, 0.0);

          float rawWind = clamp(uWindSpeed, 0.0, 1.0);
          float speed = max(0.0, rawWind * uWindSpeedGlobal);
          float rustleFloor = max(0.0, uMinRustleSpeed * max(0.0, uRustleFloorScale));
          float rustleSpeed = max(speed, rustleFloor);
          float flutterDrive = uFlutterBaseDrive + (1.0 - uFlutterBaseDrive)
                            * smoothstep(uFlutterWindStart, max(uFlutterWindStart + 1e-4, uFlutterWindFull), rawWind);
          float bendDrive = smoothstep(uBendWindStart, max(uBendWindStart + 1e-4, uBendWindFull), rawWind);
          float ambientMotion = uAmbientMotion;
          float effectiveSpeed = ambientMotion + rustleSpeed;

          // Continuous speed-coupled wind pressure field (traveling across map)
          // to avoid binary gust behavior and keep response wind-speed driven.
          float windFieldFrequency = mix(0.0003, max(0.0003, uGustFrequency), rawWind);
          vec2 windFieldPos = vWorldPos * windFieldFrequency;
          vec2 windFieldScroll = windDir * uWindFieldPhase;
          float windField = noise(windFieldPos - windFieldScroll);
          float windPulse = mix(0.65, 1.28, smoothstep(0.08, 0.92, windField));
          windPulse *= (0.35 + 0.65 * rawWind);

          float waveCoord = dot(vWorldPos, windDir);
          float wavePhase = waveCoord * uWaveSpatialFrequency - uWavePhase;
          float waveCarrier = 0.5 + 0.5 * sin(wavePhase);
          float waveFront = pow(clamp(waveCarrier, 0.0, 1.0), max(0.1, uWaveSharpness));
          float waveMod = mix(1.0, waveFront, clamp(uWaveInfluence, 0.0, 1.0));

          vec2 perpDir = vec2(-windDir.y, windDir.x);
          float orbitPhase = uTime * uElasticity + (windField * 5.0);
          float orbitSway = sin(orbitPhase);

          float bendStrength = (uBendMinStrength + (1.0 - uBendMinStrength) * rawWind) * bendDrive;
          float pushMagnitude = windPulse * uBranchBend * effectiveSpeed * waveMod * bendStrength;
          float swayMagnitude = orbitSway * (uBranchBend * 0.4) * effectiveSpeed * (0.5 + 0.5 * windPulse) * (0.65 + 0.35 * waveMod) * bendStrength;
          float crossSwayMagnitude = swayMagnitude * 0.16;

          float noiseVal = noise(vWorldPos * uFlutterScale);
          float flutterPhase = uFlutterPhase + noiseVal * 6.28;
          float flutter = sin(flutterPhase);
          float lowWindBoost = mix(uFlutterLowWindBoost, 1.0, smoothstep(0.04, max(0.041, uFlutterLowWindFadeEnd), rawWind));
          float legacyFlutterFloor = clamp(uFlutterGustFloor, 0.0, 1.0);
          float flutterWindPulse = mix(legacyFlutterFloor, 1.0, clamp(windPulse, 0.0, 1.0));
          float flutterMagnitude = flutter * uFlutterIntensity * flutterWindPulse * lowWindBoost * flutterDrive * (0.6 + 0.4 * waveMod);
          vec2 flutterVec = (windDir * flutterMagnitude) + (perpDir * (flutterMagnitude * 0.1));

          vec2 distortion = (windDir * pushMagnitude)
                          + (windDir * swayMagnitude)
                          + (perpDir * crossSwayMagnitude)
                          + flutterVec;

          vec2 sceneSpan = max(uSceneMax - uSceneMin, vec2(1e-3));
          vec2 sceneUv = clamp((vWorldPos - uSceneMin) / sceneSpan, 0.0, 1.0);
          float edgeDist = min(min(sceneUv.x, 1.0 - sceneUv.x), min(sceneUv.y, 1.0 - sceneUv.y));
          float edgeFade = smoothstep(0.0, max(uEdgeFadeStart + 1e-4, uEdgeFadeEnd), edgeDist);
          distortion *= edgeFade;

          // Pass 1: ground shadow — multi-tap blur only on the shadow mesh.
          if (uVegetationPass < 1.5) {
            vec2 shadowDir = normalize(vec2(uSunDir.x, -uSunDir.y));
            if (length(shadowDir) < 0.01) shadowDir = -windDir;
            vec2 shadowOffset = shadowDir * uShadowLength;
            float shadowBlur = max(0.0001, uShadowSoftness * 0.0008);
            vec2 shadowBaseUv = vUv - distortion - shadowOffset;
            vec2 step1 = vec2(shadowBlur);
            vec2 step2 = step1 * 2.0;

            float shadowAccum = 0.0;
            float shadowWeight = 0.0;

            float tap = safeAlpha(texture2D(uBushMask, shadowBaseUv));
            shadowAccum += tap * 0.24;
            shadowWeight += 0.24;

            tap = safeAlpha(texture2D(uBushMask, shadowBaseUv + vec2( step1.x,  step1.y)));
            shadowAccum += tap * 0.12;
            shadowWeight += 0.12;
            tap = safeAlpha(texture2D(uBushMask, shadowBaseUv + vec2(-step1.x,  step1.y)));
            shadowAccum += tap * 0.12;
            shadowWeight += 0.12;
            tap = safeAlpha(texture2D(uBushMask, shadowBaseUv + vec2( step1.x, -step1.y)));
            shadowAccum += tap * 0.12;
            shadowWeight += 0.12;
            tap = safeAlpha(texture2D(uBushMask, shadowBaseUv + vec2(-step1.x, -step1.y)));
            shadowAccum += tap * 0.12;
            shadowWeight += 0.12;

            tap = safeAlpha(texture2D(uBushMask, shadowBaseUv + vec2( step2.x, 0.0)));
            shadowAccum += tap * 0.07;
            shadowWeight += 0.07;
            tap = safeAlpha(texture2D(uBushMask, shadowBaseUv + vec2(-step2.x, 0.0)));
            shadowAccum += tap * 0.07;
            shadowWeight += 0.07;
            tap = safeAlpha(texture2D(uBushMask, shadowBaseUv + vec2(0.0,  step2.y)));
            shadowAccum += tap * 0.07;
            shadowWeight += 0.07;
            tap = safeAlpha(texture2D(uBushMask, shadowBaseUv + vec2(0.0, -step2.y)));
            shadowAccum += tap * 0.07;
            shadowWeight += 0.07;

            tap = safeAlpha(texture2D(uBushMask, shadowBaseUv + vec2( step2.x,  step2.y)));
            shadowAccum += tap * 0.04;
            shadowWeight += 0.04;
            tap = safeAlpha(texture2D(uBushMask, shadowBaseUv + vec2(-step2.x,  step2.y)));
            shadowAccum += tap * 0.04;
            shadowWeight += 0.04;
            tap = safeAlpha(texture2D(uBushMask, shadowBaseUv + vec2( step2.x, -step2.y)));
            shadowAccum += tap * 0.04;
            shadowWeight += 0.04;
            tap = safeAlpha(texture2D(uBushMask, shadowBaseUv + vec2(-step2.x, -step2.y)));
            shadowAccum += tap * 0.04;
            shadowWeight += 0.04;

            float shadowA = (shadowWeight > 0.0) ? (shadowAccum / shadowWeight) : 0.0;
            if (uBillboardShadowMode > 0.5) shadowA = 0.0;
            shadowA *= clamp(uShadowOpacity, 0.0, 1.0) * uIntensity * edgeFade;

            if (uHasTreeCanopyOcclusion > 0.5) {
              vec2 screenUv = gl_FragCoord.xy / max(uScreenSize, vec2(1.0));
              float treeBlock = clamp(texture2D(uTreeCanopyOcclusion, screenUv).a, 0.0, 1.0);
              shadowA *= (1.0 - treeBlock);
            }
            if (uShadowLitCapture > 0.5) {
              float texA = safeAlpha(texture2D(uBushMask, vUv - distortion));
              float lit = clamp(1.0 - shadowA, 0.0, 1.0);
              lit = mix(lit, 1.0, clamp(texA * uIntensity, 0.0, 1.0));
              gl_FragColor = vec4(lit, lit, lit, 1.0);
              return;
            }
            if (shadowA <= 0.001) discard;
            gl_FragColor = vec4(0.0, 0.0, 0.0, shadowA);
            return;
          }

          // Pass 2: canopy — single mask sample (distortion only, no shadow taps).
          vec4 bushSample = texture2D(uBushMask, vUv - distortion);
          float texA = safeAlpha(bushSample);
          float mainAlpha = texA * uIntensity;
          if (mainAlpha <= 0.001) discard;

          float ccDelta = abs(uExposure) + abs(uBrightness) + abs(uContrast - 1.0)
                        + abs(uSaturation - 1.0) + abs(uTemperature) + abs(uTint);
          vec3 c = bushSample.rgb;
          if (ccDelta > 0.0001) c = applyCC(c);
          c *= texA;
${VEGETATION_LANDSCAPE_LIGHTNING_APPLY_GLSL}
${VEGETATION_CLOUD_SHADOW_APPLY_GLSL}
          gl_FragColor = vec4(c, mainAlpha);
        }
      `,
      transparent: true,
      premultipliedAlpha: true,
      depthWrite: false,
      depthTest: false,
      side: THREE.DoubleSide,
      blending: THREE.NormalBlending,
    });

    const shadowMaterial = new THREE.ShaderMaterial({
      uniforms: shadowUniforms,
      vertexShader: material.vertexShader,
      fragmentShader: material.fragmentShader,
      transparent: true,
      premultipliedAlpha: true,
      depthWrite: false,
      depthTest: false,
      side: THREE.DoubleSide,
      blending: THREE.NormalBlending,
    });

    const geometry = new THREE.PlaneGeometry(tileW, tileH);
    const shadowMesh = new THREE.Mesh(geometry, shadowMaterial);
    const mesh = new THREE.Mesh(geometry, material);
    shadowMesh.name = `BushV2Shadow_${tileId}`;
    mesh.name = `BushV2_${tileId}`;
    shadowMesh.frustumCulled = true;
    mesh.frustumCulled = true;
    shadowMesh.userData = shadowMesh.userData || {};
    mesh.userData = mesh.userData || {};
    shadowMesh.userData.floorIndex = floorIndex;
    mesh.userData.floorIndex = floorIndex;
    shadowMesh.position.set(centerX, centerY, z);
    mesh.position.set(centerX, centerY, z);
    shadowMesh.rotation.z = rotation;
    mesh.rotation.z = rotation;

    this._applyBushOverlayRenderOrders(shadowMesh, mesh, floorIndex, tileId);
    applyVegetationAboveWaterLayer(shadowMesh, {});
    applyVegetationAboveWaterLayer(mesh, {});

    this._renderBus.addEffectOverlay(`${tileId}_bush_shadow`, shadowMesh, floorIndex);
    this._renderBus.addEffectOverlay(`${tileId}_bush`, mesh, floorIndex);
    const bounds = overlayWorldBounds(centerX, centerY, tileW, tileH);
    this._overlays.set(tileId, { mesh, shadowMesh, material, shadowMaterial, floorIndex, bounds });
    this._viewBoundsMayHaveChanged();
    this._syncOverlayVisibility();

    // Load mask texture.
    this._loader.load(url, (tex) => {
      tex.flipY = true;
      // Bush masks carry visible color data, so sample in sRGB for correct contrast.
      if ('colorSpace' in tex && THREE?.SRGBColorSpace) tex.colorSpace = THREE.SRGBColorSpace;
      else if ('encoding' in tex && THREE?.sRGBEncoding) tex.encoding = THREE.sRGBEncoding;
      tex.needsUpdate = true;
      if (this._overlays.has(tileId)) {
        material.uniforms.uBushMask.value = tex;
        shadowMaterial.uniforms.uBushMask.value = tex;
        const derive = this._detectDerivedAlpha(tex);
        this._deriveAlphaByTileId.set(tileId, derive);
        material.uniforms.uDeriveAlpha.value = derive ? 1.0 : 0.0;
        shadowMaterial.uniforms.uDeriveAlpha.value = derive ? 1.0 : 0.0;
        try {
          const entry = this._overlays.get(tileId);
          if (entry?.shadowMesh && entry?.mesh) {
            this._applyBushOverlayRenderOrders(entry.shadowMesh, entry.mesh, floorIndex, tileId);
          }
        } catch (_) {}
      } else {
        try { tex.dispose(); } catch (_) {}
      }
    }, undefined, (err) => {
      log.warn(`BushEffectV2: failed to load mask for ${tileId}: ${url}`, err);
    });
  }

  _detectDerivedAlpha(texture) {
    try {
      const img = texture?.image;
      if (!img) return false;

      const sampleSize = 64;
      const canvasEl = document.createElement('canvas');
      canvasEl.width = sampleSize;
      canvasEl.height = sampleSize;
      const ctx = canvasEl.getContext('2d');
      if (!ctx) return false;
      ctx.drawImage(img, 0, 0, sampleSize, sampleSize);
      const data = ctx.getImageData(0, 0, sampleSize, sampleSize).data;
      for (let i = 3; i < data.length; i += 4) {
        if (data[i] < 250) return false;
      }
      return true;
    } catch (_err) {
      return false;
    }
  }

  _getSafeVisibleMaxFloorIndex() {
    const busIdx = Number(this._renderBus?._visibleMaxFloorIndex);
    const activeIdx = Number(window.MapShine?.floorStack?.getActiveFloor?.()?.index);
    if (Number.isFinite(busIdx)) return busIdx;
    if (Number.isFinite(activeIdx)) return activeIdx;
    return 0;
  }

  _applyBushOverlayRenderOrders(shadowM, canopyM, floorIndex, tileId) {
    try {
      const fi = Number.isFinite(Number(floorIndex)) ? Math.max(0, Number(floorIndex)) : 0;
      let baseOrder = 0;
      const isBgPlane = /^__bg_image__(?:|[1-9]\d*)$/.test(String(tileId));
      if (isBgPlane) {
        baseOrder = tileAlbedoOrder(fi, 0);
      } else {
        const baseEntry = this._renderBus?._tiles?.get?.(tileId);
        const fromTile = Number(baseEntry?.mesh?.renderOrder);
        if (Number.isFinite(fromTile)) baseOrder = fromTile;
      }
      const { shadowOrder, canopyOrder } = bushOverlayRenderOrders(baseOrder, fi);
      shadowM.renderOrder = shadowOrder;
      canopyM.renderOrder = canopyOrder;
    } catch (_) {}
  }

  /**
   * @returns {boolean}
   * @private
   */
  _viewBoundsMayHaveChanged() {
    const cam = window.MapShine?.sceneComposer?.camera;
    const sig = cameraViewBoundsSignature(cam);
    if (sig === this._viewBoundsSignature) return false;
    this._viewBoundsSignature = sig;
    this._cachedViewBounds = resolveWorldViewBounds(
      cam,
      window.MapShine?.sceneComposer ?? null,
      this._viewCullPadding,
    );
    return true;
  }

  /**
   * Floor + camera view culling for overlay meshes.
   * @private
   */
  _syncOverlayVisibility() {
    const maxFloor = this._getSafeVisibleMaxFloorIndex();
    const view = this._cachedViewBounds;
    for (const entry of this._overlays.values()) {
      const floorOk = this._enabled && Number(entry.floorIndex) <= maxFloor;
      const viewOk = !view || tileBoundsIntersectView(entry.bounds, view);
      const visible = floorOk && viewOk;
      if (entry?.mesh) {
        entry.mesh.visible = visible;
        applyVegetationAboveWaterLayer(entry.mesh, {});
      }
      if (entry?.shadowMesh) {
        entry.shadowMesh.visible = visible;
        applyVegetationAboveWaterLayer(entry.shadowMesh, {});
      }
    }
  }
}
