/**
 * @fileoverview V2 Tree Effect — animated high-canopy overlay driven by _Tree masks.
 *
 * Archetype: Bus Overlay (Per-Tile Mesh)
 * - One ShaderMaterial overlay per tile/background with a _Tree mask.
 * - Overlay meshes are registered into FloorRenderBus so floor visibility is handled by the bus.
 * - No dependencies on V1 EffectBase / EffectMaskRegistry / TileEffectBindingManager.
 */

import { createLogger } from '../../core/log.js';
import { probeMaskFile } from '../../assets/loader.js';
import { tileHasLevelsRange, readTileLevelsFlags } from '../../foundry/levels-scene-flags.js';
import { weatherController } from '../../core/WeatherController.js';

import {
  GROUND_Z,
  RENDER_ORDER_PER_FLOOR,
  effectAboveOverheadOrder,
  FLOOR_OVERHEAD_FX_OFFSET,
} from '../LayerOrderPolicy.js';

const log = createLogger('TreeEffectV2');

const TREE_Z_OFFSET = 0.18;

export class TreeEffectV2 {
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
     * @type {Map<string, {mesh: THREE.Mesh, material: THREE.ShaderMaterial, floorIndex: number}>}
     */
    this._overlays = new Map();

    /** @type {Set<string>} */
    this._negativeCache = new Set();

    /** @type {object|null} */
    this._sharedUniforms = null;

    // Derived-alpha support (some Tree masks might be opaque with white background)
    /** @type {Map<string, boolean>} */
    this._deriveAlphaByTileId = new Map();

    /** @type {Map<string, {width:number, height:number, data:Uint8ClampedArray}>} */
    this._alphaSampleByTileId = new Map();

    // Temporal state (smoothed wind coupling)
    this._currentWindSpeed = 0.0;
    this._lastFrameTime = 0.0;
    this._hoverHidden = false;
    this._hoverFadeInProgress = false;
    this._worldSamplePoint = null;
    this._localSamplePoint = null;

    // Public params (mirrors V1 schema / defaults)
    this.params = {
      enabled: true,
      textureStatus: 'Searching...',
      intensity: 1.0,

      // -- Wind Physics --
      windSpeedGlobal: 0.05666,
      windRampSpeed: 1.49174,
      gustFrequency: 0.0022,
      gustSpeed: 0.15,
      waveSpatialFrequency: 0.0014,
      waveTravelSpeed: 0.7,
      waveSharpness: 2.0,
      waveInfluence: 0.6,
      ambientMotion: 0.07,
      rustleFloorScale: 0.25,
      flutterBaseDrive: 0.1,
      flutterWindStart: 0.0,
      flutterWindFull: 0.12,
      flutterLowWindBoost: 1.67,
      flutterLowWindFadeEnd: 0.37,
      flutterGustFloor: 0.49,
      bendMinStrength: 0.19,
      bendWindStart: 0.22,
      bendWindFull: 0.78,
      turbulence: 1.06,
      turbulenceScale: 0.00146,
      minRustleSpeed: 0.12347,
      edgeFadeStart: 0.0,
      edgeFadeEnd: 0.04,

      // -- Tree Movement --
      branchBend: 0.072,
      elasticity: 1.38,

      // -- Leaf Flutter --
      flutterIntensity: 0.0007,
      flutterSpeed: 6.64492,
      flutterScale: 0.02351,

      // -- Color --
      exposure: 0.0,
      brightness: 0.0,
      contrast: 1.0,
      saturation: 1.0,
      temperature: 0.0,
      tint: 0.0,

      // Canopy shadow (offset sample + blur in fragment shader)
      shadowOpacity: 0.5,
      shadowLength: 0.02,
      shadowSoftness: 1.42,
    };

    log.debug('TreeEffectV2 created');
  }

  get enabled() { return this._enabled; }
  set enabled(v) {
    this._enabled = !!v;
    this.params.enabled = this._enabled;
    for (const entry of this._overlays.values()) {
      entry.mesh.visible = this._enabled;
    }
  }

  static getControlSchema() {
    return {
      enabled: true,
      help: {
        title: 'Tree canopy (_Tree masks)',
        summary: [
          'Animates **high-canopy motion** on tiles (and the scene background) that ship a matching **`_Tree`** texture next to the art.',
          'Like **Bush**, weather **wind** drives waves, bend, and flutter; trees add **turbulence** noise on top. **Sun direction** (sky / overhead / time) feeds a soft **canopy shadow** pass.',
          'Render order is tuned so canopies sit above bushes/specular on the same floor.',
          'Cost scales with overlay count and shadow taps; reduce shadow softness or intensity on heavy maps.',
          'Settings save with the scene (not World Based).',
        ].join('\n\n'),
        glossary: {
          'Mask status': 'Whether the scene found at least one `_Tree` texture after load.',
          Turbulence: 'Extra high-frequency wobble mixed into distortion (trees only).',
          'Canopy shadow': 'Darkening from a blurred, offset sample of the mask opposite the sun.',
          'Hover fade': 'When token hover-hide is active, trees can fade via runtime uniform (not a Tweakpane slider).',
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
          parameters: ['intensity'],
        },
        {
          name: 'wind',
          label: 'Wind & waves',
          type: 'folder',
          expanded: true,
          parameters: [
            'windSpeedGlobal', 'windRampSpeed', 'gustFrequency', 'gustSpeed',
            'waveSpatialFrequency', 'waveTravelSpeed', 'waveSharpness', 'waveInfluence',
            'turbulence', 'turbulenceScale', 'minRustleSpeed',
          ],
        },
        {
          name: 'branch',
          label: 'Branch motion',
          type: 'folder',
          expanded: false,
          parameters: ['branchBend', 'elasticity'],
        },
        {
          name: 'flutter',
          label: 'Leaf flutter',
          type: 'folder',
          expanded: false,
          parameters: ['flutterIntensity', 'flutterSpeed', 'flutterScale'],
        },
        {
          name: 'response',
          label: 'Response curves',
          type: 'folder',
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
          expanded: false,
          parameters: ['shadowOpacity', 'shadowLength', 'shadowSoftness'],
        },
        {
          name: 'edges',
          label: 'Edge safety',
          type: 'folder',
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
          tooltip: 'Updated when the scene loads: whether any `_Tree` mask was found.',
        },
        intensity: {
          type: 'slider',
          label: 'Intensity',
          min: 0.0,
          max: 2.0,
          step: 0.01,
          default: 1.0,
          throttle: 100,
          tooltip: 'Master strength of the tree layer and its shadow pass.',
        },
        windSpeedGlobal: {
          type: 'slider',
          label: 'Wind scale',
          min: 0.0,
          max: 3.0,
          step: 0.001,
          default: 0.05666,
          throttle: 100,
          tooltip: 'Multiplies scene wind speed before driving motion.',
        },
        windRampSpeed: {
          type: 'slider',
          label: 'Wind catch-up',
          min: 0.1,
          max: 10.0,
          step: 0.05,
          default: 1.49174,
          throttle: 100,
          tooltip: 'Higher = canopy motion follows weather wind changes faster.',
        },
        gustFrequency: {
          type: 'slider',
          label: 'Gust frequency',
          min: 0.0,
          max: 0.05,
          step: 0.0001,
          default: 0.0022,
          throttle: 100,
          tooltip: 'Spatial scale of the pseudo-gust noise field.',
        },
        gustSpeed: {
          type: 'slider',
          label: 'Gust travel',
          min: 0.0,
          max: 2.0,
          step: 0.01,
          default: 0.15,
          throttle: 100,
          tooltip: 'How fast the gust field scrolls with wind.',
        },
        waveSpatialFrequency: {
          type: 'slider',
          label: 'Wave spacing',
          min: 0.0001,
          max: 0.01,
          step: 0.0001,
          default: 0.0014,
          throttle: 100,
          tooltip: 'Spacing of large wind waves along the wind direction.',
        },
        waveTravelSpeed: {
          type: 'slider',
          label: 'Wave speed',
          min: 0.05,
          max: 4.0,
          step: 0.01,
          default: 0.7,
          throttle: 100,
          tooltip: 'Animation speed of the traveling wave carrier.',
        },
        waveSharpness: {
          type: 'slider',
          label: 'Wave sharpness',
          min: 0.5,
          max: 6.0,
          step: 0.05,
          default: 2.0,
          throttle: 100,
          tooltip: 'Exponent on the wave carrier — higher = crisper gust fronts.',
        },
        waveInfluence: {
          type: 'slider',
          label: 'Wave mix',
          min: 0.0,
          max: 1.0,
          step: 0.01,
          default: 0.6,
          throttle: 100,
          tooltip: 'How much the traveling wave modulates bend and flutter.',
        },
        turbulence: {
          type: 'slider',
          label: 'Turbulence',
          min: 0.0,
          max: 2.0,
          step: 0.01,
          default: 1.06,
          throttle: 100,
          tooltip: 'Strength of extra procedural chop layered on wind distortion.',
        },
        turbulenceScale: {
          type: 'slider',
          label: 'Turbulence scale',
          min: 0.00005,
          max: 0.003,
          step: 0.00001,
          default: 0.00146,
          throttle: 100,
          tooltip: 'World-space frequency of the turbulence noise.',
        },
        ambientMotion: {
          type: 'slider',
          label: 'Ambient motion',
          min: 0.0,
          max: 0.35,
          step: 0.005,
          default: 0.07,
          throttle: 100,
          tooltip: 'Baseline motion when wind is calm.',
        },
        rustleFloorScale: {
          type: 'slider',
          label: 'Rustle floor scale',
          min: 0.0,
          max: 1.0,
          step: 0.01,
          default: 0.25,
          throttle: 100,
          tooltip: 'Scales the low-wind rustle floor.',
        },
        flutterBaseDrive: {
          type: 'slider',
          label: 'Flutter base drive',
          min: 0.0,
          max: 1.0,
          step: 0.01,
          default: 0.1,
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
          default: 1.67,
          throttle: 100,
          tooltip: 'Extra flutter when wind is barely moving.',
        },
        flutterLowWindFadeEnd: {
          type: 'slider',
          label: 'Boost fade end',
          min: 0.05,
          max: 1.0,
          step: 0.01,
          default: 0.37,
          throttle: 100,
          tooltip: 'Wind level where the low-wind boost has faded out.',
        },
        flutterGustFloor: {
          type: 'slider',
          label: 'Flutter gust floor',
          min: 0.0,
          max: 1.0,
          step: 0.01,
          default: 0.49,
          throttle: 100,
          tooltip: 'Minimum gust modulation on flutter in calm wind.',
        },
        bendMinStrength: {
          type: 'slider',
          label: 'Bend minimum',
          min: 0.0,
          max: 1.0,
          step: 0.01,
          default: 0.19,
          throttle: 100,
          tooltip: 'Floor on bend strength in light wind.',
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
          default: 0.12347,
          throttle: 100,
          tooltip: 'Minimum effective wind speed when the scene reports calm air.',
        },
        branchBend: {
          type: 'slider',
          label: 'Branch bend',
          min: 0.0,
          max: 0.1,
          step: 0.001,
          default: 0.072,
          throttle: 100,
          tooltip: 'How far UVs shift along wind when bending.',
        },
        elasticity: {
          type: 'slider',
          label: 'Springiness',
          min: 0.5,
          max: 5.0,
          step: 0.01,
          default: 1.38,
          throttle: 100,
          tooltip: 'Oscillation speed of the orbital sway term.',
        },
        flutterIntensity: {
          type: 'slider',
          label: 'Flutter amount',
          min: 0.0,
          max: 0.005,
          step: 0.0001,
          default: 0.0007,
          throttle: 100,
          tooltip: 'Strength of high-frequency leaf jitter.',
        },
        flutterSpeed: {
          type: 'slider',
          label: 'Flutter speed',
          min: 1.0,
          max: 20.0,
          step: 0.05,
          default: 6.64492,
          throttle: 100,
          tooltip: 'How fast the flutter phase advances.',
        },
        flutterScale: {
          type: 'slider',
          label: 'Flutter scale',
          min: 0.005,
          max: 0.1,
          step: 0.0001,
          default: 0.02351,
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
          tooltip: 'Warm/cool bias (red vs blue).',
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
          max: 0.2,
          step: 0.001,
          default: 0.02,
          throttle: 100,
          tooltip: 'How far the shadow sample is pushed opposite the sun.',
        },
        shadowSoftness: {
          type: 'slider',
          label: 'Shadow softness',
          min: 0.5,
          max: 10.0,
          step: 0.05,
          default: 1.42,
          throttle: 100,
          tooltip: 'Blur radius of the multi-tap shadow sample.',
        },
        edgeFadeStart: {
          type: 'slider',
          label: 'Edge fade start',
          min: 0.0,
          max: 0.2,
          step: 0.005,
          default: 0.0,
          throttle: 100,
          tooltip: 'Scene-edge band where motion begins to fall off.',
        },
        edgeFadeEnd: {
          type: 'slider',
          label: 'Edge fade end',
          min: 0.02,
          max: 0.4,
          step: 0.005,
          default: 0.04,
          throttle: 100,
          tooltip: 'Scene-edge distance where motion and shadow are fully suppressed.',
        },
      },
      presets: {
        Calm: {
          windSpeedGlobal: 0.03,
          turbulence: 0.55,
          flutterIntensity: 0.00045,
          branchBend: 0.045,
        },
        Windy: {
          windSpeedGlobal: 0.11,
          gustSpeed: 0.42,
          waveTravelSpeed: 1.05,
          turbulence: 1.35,
          branchBend: 0.09,
        },
        'Soft shadow': {
          shadowOpacity: 0.35,
          shadowLength: 0.014,
          shadowSoftness: 2.0,
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
    log.info('TreeEffectV2 initialized');
  }

  async populate(foundrySceneData) {
    if (!this._initialized) return;
    this.clear();

    const floors = window.MapShine?.floorStack?.getFloors() ?? [];
    const worldH = Number(foundrySceneData?.height) || 0;

    // Background first
    const bgSrc = canvas?.scene?.background?.src ?? '';
    if (bgSrc) {
      const basePath = bgSrc.replace(/\.[^.]+$/, '');
      const url = await this._probeMask(basePath, '_Tree');
      if (url) {
        const centerX = Number(foundrySceneData?.sceneX ?? 0) + Number(foundrySceneData?.sceneWidth ?? 0) / 2;
        const centerY = worldH - (Number(foundrySceneData?.sceneY ?? 0) + Number(foundrySceneData?.sceneHeight ?? 0) / 2);
        const tileW = Number(foundrySceneData?.sceneWidth ?? 0);
        const tileH = Number(foundrySceneData?.sceneHeight ?? 0);
        const z = GROUND_Z - 1 + TREE_Z_OFFSET;
        this._createOverlay('__bg_image__', 0, { url, centerX, centerY, z, tileW, tileH, rotation: 0 });
      }
    }

    // Tiles
    const tileDocs = canvas?.scene?.tiles?.contents ?? [];
    for (const tileDoc of tileDocs) {
      const src = tileDoc?.texture?.src ?? tileDoc?.img ?? '';
      if (!src) continue;

      const basePath = src.replace(/\.[^.]+$/, '');
      const url = await this._probeMask(basePath, '_Tree');
      if (!url) continue;

      const floorIndex = this._resolveFloorIndex(tileDoc, floors);
      const tileW = Number(tileDoc?.width ?? 0);
      const tileH = Number(tileDoc?.height ?? 0);
      const centerX = Number(tileDoc?.x ?? 0) + tileW / 2;
      const centerY = worldH - (Number(tileDoc?.y ?? 0) + tileH / 2);
      const z = GROUND_Z + floorIndex + TREE_Z_OFFSET;
      const rotation = typeof tileDoc?.rotation === 'number' ? (tileDoc.rotation * Math.PI) / 180 : 0;
      const tileId = tileDoc.id ?? tileDoc._id;
      if (!tileId) continue;

      this._createOverlay(tileId, floorIndex, { url, centerX, centerY, z, tileW, tileH, rotation });
    }

    const n = this._overlays.size;
    this.params.textureStatus = n > 0
      ? 'Ready (_Tree mask found)'
      : 'Inactive (no _Tree mask)';
    log.info(`TreeEffectV2 populated: ${n} overlays`);
  }

  update(timeInfo) {
    if (!this._enabled || !this._initialized) return;

    const time = Number.isFinite(timeInfo?.elapsed)
      ? Number(timeInfo.elapsed)
      : Number(timeInfo?.time ?? 0);
    const delta = Number.isFinite(timeInfo?.motionDelta)
      ? Number(timeInfo.motionDelta)
      : (Number.isFinite(timeInfo?.delta)
      ? Number(timeInfo.delta)
      : 0.016);

    const weather = weatherController?.currentState;
    const windDir = weather?.windDirection;
    const windSpeed01 = Number(weather?.windSpeed ?? 0);

    const ramp = Math.max(0.001, Number(this.params.windRampSpeed ?? 1));
    const lerpT = Math.min(1.0, delta * ramp);
    this._currentWindSpeed = this._currentWindSpeed + (windSpeed01 - this._currentWindSpeed) * lerpT;

    this._syncSceneBoundsUniforms();

    if (this._sharedUniforms) {
      this._sharedUniforms.uTime.value = time;
      if (windDir && typeof windDir.x === 'number' && typeof windDir.y === 'number') {
        // Weather wind vectors are Foundry-space (Y-down); shader world is Three-space (Y-up).
        this._sharedUniforms.uWindDir.value.set(windDir.x, -windDir.y);
      }
      this._sharedUniforms.uWindSpeed.value = this._currentWindSpeed;

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
      this._sharedUniforms.uTurbulence.value = this.params.turbulence;
      this._sharedUniforms.uTurbulenceScale.value = this.params.turbulenceScale;
      this._sharedUniforms.uMinRustleSpeed.value = this.params.minRustleSpeed;
      this._sharedUniforms.uEdgeFadeStart.value = this.params.edgeFadeStart;
      this._sharedUniforms.uEdgeFadeEnd.value = this.params.edgeFadeEnd;
      this._sharedUniforms.uBranchBend.value = this.params.branchBend;
      this._sharedUniforms.uElasticity.value = this.params.elasticity;
      this._sharedUniforms.uFlutterIntensity.value = this.params.flutterIntensity;
      this._sharedUniforms.uFlutterSpeed.value = this.params.flutterSpeed;
      this._sharedUniforms.uFlutterScale.value = this.params.flutterScale;
      this._sharedUniforms.uShadowOpacity.value = this.params.shadowOpacity;
      this._sharedUniforms.uShadowLength.value = this.params.shadowLength;
      this._sharedUniforms.uShadowSoftness.value = this.params.shadowSoftness;

      this._sharedUniforms.uExposure.value = this.params.exposure;
      this._sharedUniforms.uBrightness.value = this.params.brightness;
      this._sharedUniforms.uContrast.value = this.params.contrast;
      this._sharedUniforms.uSaturation.value = this.params.saturation;
      this._sharedUniforms.uTemperature.value = this.params.temperature;
      this._sharedUniforms.uTint.value = this.params.tint;

      this._syncSunDirectionUniform();
    }

    const tileManager = window.MapShine?.tileManager;
    let hoverFadeInProgress = false;
    for (const [tileId, entry] of this._overlays) {
      const hoverUniform = entry?.material?.uniforms?.uHoverFade;
      if (!hoverUniform) continue;

      const hoverHidden = this._hoverHidden || !!tileManager?.getTileSpriteData?.(tileId)?.hoverHidden;
      const targetFade = hoverHidden ? 0.0 : 1.0;
      const currentFade = Number.isFinite(hoverUniform.value) ? hoverUniform.value : targetFade;
      const diff = targetFade - currentFade;
      const absDiff = Math.abs(diff);

      if (absDiff <= 0.0005) {
        hoverUniform.value = targetFade;
        continue;
      }
      hoverFadeInProgress = true;

      const maxStep = delta / 2.0;
      const step = Math.sign(diff) * Math.min(absDiff, maxStep);
      hoverUniform.value = currentFade + step;
    }
    this._hoverFadeInProgress = hoverFadeInProgress;

    this._lastFrameTime = time;
  }

  onFloorChange(_maxFloorIndex) {
    // Bus overlay visibility is handled by FloorRenderBus.setVisibleFloors().
  }

  wantsContinuousRender() {
    return this._enabled && this._initialized && this._overlays.size > 0;
  }

  setHoverHidden(hidden) {
    this._hoverHidden = !!hidden;
  }

  /**
   * True while tree canopy reveal/hide is active or still fading.
   * @returns {boolean}
   */
  isHoverRevealActive() {
    return !!this._hoverHidden || !!this._hoverFadeInProgress;
  }

  getHoverMeshes() {
    const meshes = [];
    const backgroundMeshes = [];
    for (const [tileId, entry] of this._overlays) {
      if (!entry?.mesh) continue;
      if (tileId?.startsWith('__')) {
        backgroundMeshes.push(entry.mesh);
      } else {
        meshes.push(entry.mesh);
      }
    }
    // Prefer per-tile canopy overlays. If none exist, fall back to background
    // overlays so scenes that only use background _Tree masks still support
    // hover-hide behavior.
    return meshes.length > 0 ? meshes : backgroundMeshes;
  }

  /**
   * Returns true when a ray hit UV is visually opaque for that tree mask texel.
   * @param {{x:number,y:number}|null|undefined} uv
   * @param {THREE.Object3D|null} hitObject
   * @returns {boolean}
   */
  isUvOpaque(uv, hitObject = null) {
    if (!uv || !Number.isFinite(uv.x) || !Number.isFinite(uv.y)) return false;

    const tileId = hitObject?.userData?.mapShineTreeTileId || null;
    if (!tileId) return false;

    return this._sampleTileAlphaAtUv(tileId, uv);
  }

  /**
   * Option B path: sample canopy mask opacity from a world XY point, independent
   * from mesh raycast hit/UV reliability.
   *
   * @param {number} worldX
   * @param {number} worldY
   * @returns {boolean}
   */
  isWorldPointOpaque(worldX, worldY) {
    if (!Number.isFinite(worldX) || !Number.isFinite(worldY)) return false;

    const THREE = window.THREE;
    if (!THREE) return false;

    if (!this._worldSamplePoint) this._worldSamplePoint = new THREE.Vector3();
    if (!this._localSamplePoint) this._localSamplePoint = new THREE.Vector3();

    this._worldSamplePoint.set(worldX, worldY, 0.0);

    let topTileId = null;
    let topUv = null;
    let topOrder = -Infinity;
    let topWorldZ = -Infinity;

    let hasNonBackgroundOverlay = false;
    for (const [tileId] of this._overlays) {
      if (!tileId?.startsWith('__')) {
        hasNonBackgroundOverlay = true;
        break;
      }
    }

    for (const [tileId, entry] of this._overlays) {
      if (hasNonBackgroundOverlay && tileId?.startsWith('__')) continue;
      const mesh = entry?.mesh;
      const geometry = mesh?.geometry;
      const params = geometry?.parameters;
      if (!mesh || !params) continue;

      const w = Number(params.width ?? 0);
      const h = Number(params.height ?? 0);
      if (!(w > 0 && h > 0)) continue;

      this._localSamplePoint.copy(this._worldSamplePoint);
      mesh.worldToLocal(this._localSamplePoint);

      const halfW = w * 0.5;
      const halfH = h * 0.5;
      const lx = this._localSamplePoint.x;
      const ly = this._localSamplePoint.y;
      if (lx < -halfW || lx > halfW || ly < -halfH || ly > halfH) continue;

      const u = (lx + halfW) / w;
      const v = (ly + halfH) / h;
      const order = Number.isFinite(mesh.renderOrder) ? mesh.renderOrder : 0;
      const worldZ = Number.isFinite(mesh.position?.z) ? mesh.position.z : 0;
      if (order > topOrder || (order === topOrder && worldZ > topWorldZ)) {
        topOrder = order;
        topWorldZ = worldZ;
        topTileId = tileId;
        topUv = { x: u, y: v };
      }
    }

    if (!topTileId || !topUv) return false;
    return this._sampleTileAlphaAtUv(topTileId, topUv);
  }

  _sampleTileAlphaAtUv(tileId, uv) {
    if (!tileId || !uv || !Number.isFinite(uv.x) || !Number.isFinite(uv.y)) return false;

    const sample = this._alphaSampleByTileId.get(tileId);
    if (!sample?.data || !Number.isFinite(sample.width) || !Number.isFinite(sample.height)) {
      // Fallback: if CPU-side alpha sampling is unavailable (e.g. CORS-tainted image
      // readback), still allow canopy hover-hide to engage when the ray intersects
      // the canopy mesh. This preserves expected UX over silently disabling fade.
      return true;
    }

    const u = Math.min(0.999999, Math.max(0.0, uv.x));
    const v = Math.min(0.999999, Math.max(0.0, uv.y));
    const px = Math.min(sample.width - 1, Math.max(0, Math.floor(u * sample.width)));
    // Texture is uploaded with flipY=true, so invert V for CPU-side lookup.
    const py = Math.min(sample.height - 1, Math.max(0, Math.floor((1.0 - v) * sample.height)));
    const idx = (py * sample.width + px) * 4;
    const r = sample.data[idx] ?? 0;
    const g = sample.data[idx + 1] ?? 0;
    const b = sample.data[idx + 2] ?? 0;
    const a = sample.data[idx + 3] ?? 0;

    if (this._deriveAlphaByTileId.get(tileId)) {
      const lum = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255.0;
      const maxC = Math.max(r, g, b) / 255.0;
      const minC = Math.min(r, g, b) / 255.0;
      const chroma = maxC - minC;
      const isBright = lum >= 0.85;
      const isDesat = chroma < 0.06;
      const bg = (isBright && isDesat) ? 1.0 : 0.0;
      const derivedAlpha = (a / 255.0) * (1.0 - bg);
      return derivedAlpha > 0.08;
    }

    return (a / 255.0) > 0.08;
  }

  onResize(_w, _h) {
    // No RTs.
  }

  clear() {
    for (const [tileId, entry] of this._overlays) {
      this._renderBus.removeEffectOverlay(`${tileId}_tree`);
      entry.material.dispose();
      entry.mesh.geometry.dispose();
      const tex = entry.material.uniforms.uTreeMask?.value;
      if (tex && tex.dispose) {
        try { tex.dispose(); } catch (_) {}
      }
    }
    this._overlays.clear();
    this._deriveAlphaByTileId.clear();
    this._alphaSampleByTileId.clear();
    this.params.textureStatus = 'Inactive (no _Tree mask)';
  }

  dispose() {
    this.clear();
    this._loader = null;
    this._sharedUniforms = null;
    this._initialized = false;
    log.info('TreeEffectV2 disposed');
  }

  // ── Private helpers ─────────────────────────────────────────────────────────

  _buildSharedUniforms() {
    const THREE = window.THREE;
    this._sharedUniforms = {
      uTreeMask: { value: null },
      uTime: { value: 0.0 },
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
      uTurbulence: { value: this.params.turbulence },
      uTurbulenceScale: { value: this.params.turbulenceScale },
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

      uExposure: { value: this.params.exposure },
      uBrightness: { value: this.params.brightness },
      uContrast: { value: this.params.contrast },
      uSaturation: { value: this.params.saturation },
      uTemperature: { value: this.params.temperature },
      uTint: { value: this.params.tint },

      uDeriveAlpha: { value: 0.0 },
    };
  }

  async _probeMask(basePath, suffix) {
    if (!basePath || this._negativeCache.has(basePath)) return null;
    try {
      const res = await probeMaskFile(basePath, suffix);
      if (res?.path) return res.path;
      this._negativeCache.add(basePath);
      return null;
    } catch (_err) {
      this._negativeCache.add(basePath);
      return null;
    }
  }

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
      const includeUpperBound = i === floors.length - 1;
      if (elev >= f.elevationMin && (includeUpperBound ? elev <= f.elevationMax : elev < f.elevationMax)) {
        return i;
      }
    }
    return 0;
  }

  _syncSceneBoundsUniforms() {
    if (!this._sharedUniforms) return;
    const dims = canvas?.dimensions;
    const sceneRect = dims?.sceneRect;
    if (!sceneRect) return;

    const canvasHeight = Number(dims?.height ?? 0);
    const sceneX = Number(sceneRect.x ?? 0);
    const sceneY = Number(sceneRect.y ?? 0);
    const sceneW = Number(sceneRect.width ?? 0);
    const sceneH = Number(sceneRect.height ?? 0);

    // Scene rect is Foundry-space (Y-down); shader world positions are Three-space (Y-up).
    const minY = canvasHeight - (sceneY + sceneH);
    const maxY = canvasHeight - sceneY;

    this._sharedUniforms.uSceneMin.value.set(sceneX, minY);
    this._sharedUniforms.uSceneMax.value.set(sceneX + sceneW, maxY);
  }

  _syncSunDirectionUniform() {
    if (!this._sharedUniforms?.uSunDir?.value) return;

    let x = 0.0;
    let y = -1.0;

    // Prefer the same sun azimuth source used by FloorCompositor-driven effects.
    const sky = window.MapShine?.effectComposer?._floorCompositorV2?._skyColorEffect;
    const overhead = window.MapShine?.effectComposer?._floorCompositorV2?._overheadShadowEffect;
    const latitude = Number(overhead?.params?.sunLatitude ?? 0.1);
    const lat = Math.max(0.0, Math.min(1.0, latitude));

    if (Number.isFinite(Number(sky?.currentSunAzimuthDeg))) {
      const azimuthRad = Number(sky.currentSunAzimuthDeg) * (Math.PI / 180.0);
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
      const azimuth = (t - 0.5) * Math.PI;
      x = -Math.sin(azimuth);
      y = -Math.cos(azimuth) * lat;
    }

    this._sharedUniforms.uSunDir.value.set(x, y);
  }

  _createOverlay(tileId, floorIndex, opts) {
    const THREE = window.THREE;
    if (!THREE || !this._sharedUniforms) return;

    const { url, centerX, centerY, z, tileW, tileH, rotation } = opts;

    const uniforms = {
      ...this._sharedUniforms,
      uTreeMask: { value: null },
      uDeriveAlpha: { value: 0.0 },
      uHoverFade: { value: 1.0 },
    };

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
        uniform sampler2D uTreeMask;
        uniform float uTime;
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
        uniform float uTurbulence;
        uniform float uTurbulenceScale;
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
        uniform vec2  uSceneMin;
        uniform vec2  uSceneMax;

        uniform float uExposure;
        uniform float uBrightness;
        uniform float uContrast;
        uniform float uSaturation;
        uniform float uTemperature;
        uniform float uTint;

        uniform float uDeriveAlpha;
        uniform float uHoverFade;

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

          // Build a continuous, speed-driven wind pressure field that travels across
          // the map with wind direction. This replaces gust-special branching with
          // a single coherent wind response signal.
          float windFieldFrequency = mix(0.00025, max(0.00025, uGustFrequency), rawWind);
          float windFieldTravel = mix(0.18, max(0.18, uGustSpeed), rawWind);
          vec2 windFieldPos = vWorldPos * windFieldFrequency;
          vec2 windFieldScroll = windDir * uTime * windFieldTravel * (0.2 + rawWind);
          float windField = noise(windFieldPos - windFieldScroll);
          float windPulse = mix(0.65, 1.3, smoothstep(0.08, 0.92, windField));
          windPulse *= (0.35 + 0.65 * rawWind);

          float waveCoord = dot(vWorldPos, windDir);
          float wavePhase = waveCoord * uWaveSpatialFrequency - uTime * uWaveTravelSpeed * (0.35 + rustleSpeed);
          float waveCarrier = 0.5 + 0.5 * sin(wavePhase);
          float waveFront = pow(clamp(waveCarrier, 0.0, 1.0), max(0.1, uWaveSharpness));
          float waveMod = mix(1.0, waveFront, clamp(uWaveInfluence, 0.0, 1.0));

          vec2 perpDir = vec2(-windDir.y, windDir.x);
          float orbitPhase = uTime * uElasticity + (windField * 5.0);
          float orbitSway = sin(orbitPhase);

          float bendStrength = (uBendMinStrength + (1.0 - uBendMinStrength) * rawWind) * bendDrive;
          float pushMagnitude = windPulse * uBranchBend * effectiveSpeed * waveMod * bendStrength;
          float swayMagnitude = orbitSway * (uBranchBend * 0.4) * effectiveSpeed * (0.5 + 0.5 * windPulse) * (0.65 + 0.35 * waveMod) * bendStrength;
          float crossSwayMagnitude = swayMagnitude * 0.18;

          float turbulenceStrength = max(0.0, uTurbulence);
          float turbulenceScale = max(0.00001, uTurbulenceScale);
          vec2 turbulencePos = vWorldPos * turbulenceScale;
          float turbulenceFieldA = noise(turbulencePos + vec2(uTime * 0.27, -uTime * 0.19));
          float turbulenceFieldB = noise((turbulencePos * 1.9) - vec2(uTime * 0.61, uTime * 0.47));
          float turbulenceSigned = ((turbulenceFieldA * 0.65 + turbulenceFieldB * 0.35) - 0.5) * 2.0;
          float turbulenceGustCoupling = 0.45 + 0.55 * windPulse;
          float turbulenceMagnitude = turbulenceStrength * effectiveSpeed * turbulenceGustCoupling * (0.55 + 0.45 * waveMod);
          vec2 turbulenceVec = (windDir * (turbulenceSigned * uBranchBend * 0.85 * turbulenceMagnitude))
                             + (perpDir * (((turbulenceFieldB - 0.5) * 2.0) * uBranchBend * 0.15 * turbulenceMagnitude));

          float noiseVal = noise(vWorldPos * uFlutterScale);
          float flutterPhase = uTime * uFlutterSpeed * (0.85 + rustleSpeed) + noiseVal * 6.28;
          float flutter = sin(flutterPhase);
          float lowWindBoost = mix(uFlutterLowWindBoost, 1.0, smoothstep(0.04, max(0.041, uFlutterLowWindFadeEnd), rawWind));
          float legacyFlutterFloor = clamp(uFlutterGustFloor, 0.0, 1.0);
          float flutterWindPulse = mix(legacyFlutterFloor, 1.0, clamp(windPulse, 0.0, 1.0));
          float flutterMagnitude = flutter * uFlutterIntensity * flutterWindPulse * lowWindBoost * flutterDrive * (0.6 + 0.4 * waveMod);
          vec2 flutterVec = (windDir * flutterMagnitude) + (perpDir * (flutterMagnitude * 0.12));

          vec2 distortion = (windDir * pushMagnitude)
                          + (windDir * swayMagnitude)
                          + (perpDir * crossSwayMagnitude)
                          + turbulenceVec
                          + flutterVec;

          vec2 sceneSpan = max(uSceneMax - uSceneMin, vec2(1e-3));
          vec2 sceneUv = clamp((vWorldPos - uSceneMin) / sceneSpan, 0.0, 1.0);
          float edgeDist = min(min(sceneUv.x, 1.0 - sceneUv.x), min(sceneUv.y, 1.0 - sceneUv.y));
          float edgeFade = smoothstep(0.0, max(uEdgeFadeStart + 1e-4, uEdgeFadeEnd), edgeDist);
          distortion *= edgeFade;

          vec2 shadowDir = normalize(vec2(uSunDir.x, -uSunDir.y));
          if (length(shadowDir) < 0.01) shadowDir = -windDir;
          // Tree canopy shadow should not appear as a detached offset blob.
          // Keep the soft shadow lobe centered on canopy pixels.
          vec2 shadowOffset = vec2(0.0);
          float shadowBlur = max(0.0001, uShadowSoftness * 0.0008);
          vec2 shadowBaseUv = vUv - distortion - shadowOffset;
          vec2 step1 = vec2(shadowBlur);
          vec2 step2 = step1 * 2.0;

          // Kawase-style multi-ring taps: center + near diagonals + far axis + far diagonals.
          float shadowAccum = 0.0;
          float shadowWeight = 0.0;

          float tap = safeAlpha(texture2D(uTreeMask, shadowBaseUv));
          shadowAccum += tap * 0.24;
          shadowWeight += 0.24;

          tap = safeAlpha(texture2D(uTreeMask, shadowBaseUv + vec2( step1.x,  step1.y)));
          shadowAccum += tap * 0.12;
          shadowWeight += 0.12;
          tap = safeAlpha(texture2D(uTreeMask, shadowBaseUv + vec2(-step1.x,  step1.y)));
          shadowAccum += tap * 0.12;
          shadowWeight += 0.12;
          tap = safeAlpha(texture2D(uTreeMask, shadowBaseUv + vec2( step1.x, -step1.y)));
          shadowAccum += tap * 0.12;
          shadowWeight += 0.12;
          tap = safeAlpha(texture2D(uTreeMask, shadowBaseUv + vec2(-step1.x, -step1.y)));
          shadowAccum += tap * 0.12;
          shadowWeight += 0.12;

          tap = safeAlpha(texture2D(uTreeMask, shadowBaseUv + vec2( step2.x, 0.0)));
          shadowAccum += tap * 0.07;
          shadowWeight += 0.07;
          tap = safeAlpha(texture2D(uTreeMask, shadowBaseUv + vec2(-step2.x, 0.0)));
          shadowAccum += tap * 0.07;
          shadowWeight += 0.07;
          tap = safeAlpha(texture2D(uTreeMask, shadowBaseUv + vec2(0.0,  step2.y)));
          shadowAccum += tap * 0.07;
          shadowWeight += 0.07;
          tap = safeAlpha(texture2D(uTreeMask, shadowBaseUv + vec2(0.0, -step2.y)));
          shadowAccum += tap * 0.07;
          shadowWeight += 0.07;

          tap = safeAlpha(texture2D(uTreeMask, shadowBaseUv + vec2( step2.x,  step2.y)));
          shadowAccum += tap * 0.04;
          shadowWeight += 0.04;
          tap = safeAlpha(texture2D(uTreeMask, shadowBaseUv + vec2(-step2.x,  step2.y)));
          shadowAccum += tap * 0.04;
          shadowWeight += 0.04;
          tap = safeAlpha(texture2D(uTreeMask, shadowBaseUv + vec2( step2.x, -step2.y)));
          shadowAccum += tap * 0.04;
          shadowWeight += 0.04;
          tap = safeAlpha(texture2D(uTreeMask, shadowBaseUv + vec2(-step2.x, -step2.y)));
          shadowAccum += tap * 0.04;
          shadowWeight += 0.04;

          float shadowA = (shadowWeight > 0.0) ? (shadowAccum / shadowWeight) : 0.0;
          // Fade tree shadow contribution together with canopy hover fade to avoid
          // detached "dark ghost" shapes when the canopy is hidden.
          shadowA *= clamp(uShadowOpacity, 0.0, 1.0) * uIntensity * edgeFade * clamp(uHoverFade, 0.0, 1.0);

          vec4 treeSample = texture2D(uTreeMask, vUv - distortion);
          float texA = safeAlpha(treeSample);
          float mainAlpha = texA * uIntensity * clamp(uHoverFade, 0.0, 1.0);
          // Prevent soft shadow bloom from extending beyond canopy edges.
          // Gate shadow contribution by local canopy coverage.
          float canopyGate = smoothstep(0.03, 0.35, clamp(mainAlpha, 0.0, 1.0));
          float shadowOnlyAlpha = shadowA * (1.0 - clamp(mainAlpha, 0.0, 1.0)) * canopyGate;
          float a = clamp(mainAlpha + shadowOnlyAlpha, 0.0, 1.0);
          if (a <= 0.001) discard;

          float ccDelta = abs(uExposure) + abs(uBrightness) + abs(uContrast - 1.0)
                        + abs(uSaturation - 1.0) + abs(uTemperature) + abs(uTint);
          vec3 c = treeSample.rgb;
          if (ccDelta > 0.0001) c = applyCC(c);
          // Kill white fringe: filtering blends RGB from empty/white texels while alpha
          // drops; scaling by coverage makes premultiplied output match the mask energy.
          c *= texA;
          float ih = uIntensity * clamp(uHoverFade, 0.0, 1.0);
          gl_FragColor = vec4(c * ih, clamp(a, 0.0, 1.0));
        }
      `,
      transparent: true,
      premultipliedAlpha: true,
      depthWrite: false,
      depthTest: false,
      side: THREE.DoubleSide,
      blending: THREE.NormalBlending,
    });

    const geometry = new THREE.PlaneGeometry(tileW, tileH);
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = `TreeV2_${tileId}`;
    mesh.frustumCulled = false;
    mesh.userData = mesh.userData || {};
    mesh.userData.mapShineTreeTileId = tileId;
    mesh.position.set(centerX, centerY, z);
    mesh.rotation.z = rotation;

    try {
      // Trees are above-overhead (canopy over rooftops).
      mesh.renderOrder = effectAboveOverheadOrder(floorIndex, 200);
    } catch (_) {}

    this._renderBus.addEffectOverlay(`${tileId}_tree`, mesh, floorIndex);
    this._overlays.set(tileId, { mesh, material, floorIndex });

    // Load mask texture.
    this._loader.load(url, (tex) => {
      tex.flipY = true;
      // Tree masks carry visible color data, so sample in sRGB for correct contrast.
      if ('colorSpace' in tex && THREE?.SRGBColorSpace) tex.colorSpace = THREE.SRGBColorSpace;
      else if ('encoding' in tex && THREE?.sRGBEncoding) tex.encoding = THREE.sRGBEncoding;
      tex.needsUpdate = true;
      if (this._overlays.has(tileId)) {
        material.uniforms.uTreeMask.value = tex;
        const derive = this._detectDerivedAlpha(tex);
        this._deriveAlphaByTileId.set(tileId, derive);
        material.uniforms.uDeriveAlpha.value = derive ? 1.0 : 0.0;
        this._cacheAlphaSamples(tileId, tex);
      } else {
        try { tex.dispose(); } catch (_) {}
      }
    }, undefined, (err) => {
      log.warn(`TreeEffectV2: failed to load mask for ${tileId}: ${url}`, err);
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

  _cacheAlphaSamples(tileId, texture) {
    try {
      const img = texture?.image;
      if (!img) return;

      const width = Number(img.naturalWidth || img.videoWidth || img.width || 0);
      const height = Number(img.naturalHeight || img.videoHeight || img.height || 0);
      if (!(width > 0 && height > 0)) return;

      const canvasEl = document.createElement('canvas');
      canvasEl.width = width;
      canvasEl.height = height;
      const ctx = canvasEl.getContext('2d');
      if (!ctx) return;
      ctx.drawImage(img, 0, 0, width, height);
      const data = ctx.getImageData(0, 0, width, height).data;
      this._alphaSampleByTileId.set(tileId, { width, height, data });
    } catch (_) {}
  }
}
