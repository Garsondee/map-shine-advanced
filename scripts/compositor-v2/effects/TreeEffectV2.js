/**
 * @fileoverview V2 Tree Effect — animated high-canopy overlay driven by _Tree masks.
 *
 * Archetype: Bus Overlay (Per-Tile Mesh)
 * - One ShaderMaterial overlay per tile/background with a _Tree mask.
 * - Overlay meshes are registered into FloorRenderBus so floor visibility is handled by the bus.
 * - No dependencies on V1 EffectBase / EffectMaskRegistry / TileEffectBindingManager.
 */

import { createLogger } from '../../core/log.js';
import { createMaskStatusSchemaGroup, refreshEffectMaskStatusUi } from '../../ui/effect-mask-status.js';
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
  GROUND_Z,
  MAX_INTRA_ROLE_OFFSET,
  tileAlbedoOrder,
  treeOverlayRenderOrders,
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
  VEGETATION_BUILDING_SHADOW_DEFAULTS,
  VEGETATION_BUILDING_SHADOW_UNIFORM_GLSL,
  VEGETATION_BUILDING_SHADOW_SAMPLE_GLSL,
  VEGETATION_BUILDING_SHADOW_APPLY_GLSL,
  VEGETATION_BUILDING_SHADOW_CONTROL_SCHEMA,
  createVegetationBuildingShadowUniforms,
  applyVegetationBuildingShadowParamsToUniforms,
  syncVegetationBuildingShadowForEffect,
  linkVegetationBuildingShadowUniforms,
} from './vegetation-building-shadow.js';
import {
  VEGETATION_PAINTED_SHADOW_DEFAULTS,
  VEGETATION_PAINTED_SHADOW_UNIFORM_GLSL,
  VEGETATION_PAINTED_SHADOW_SAMPLE_GLSL,
  VEGETATION_PAINTED_SHADOW_APPLY_GLSL,
  VEGETATION_PAINTED_SHADOW_CONTROL_SCHEMA,
  createVegetationPaintedShadowUniforms,
  applyVegetationPaintedShadowParamsToUniforms,
  syncVegetationPaintedShadowForEffect,
  linkVegetationPaintedShadowUniforms,
} from './vegetation-painted-shadow.js';
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
import {
  VEGETATION_CAMERA_GRADE_UNIFORM_GLSL,
  VEGETATION_CAMERA_GRADE_FUNCTION_GLSL,
  createVegetationCameraGradeUniforms,
  syncVegetationCameraGradeForEffect,
} from './vegetation-camera-grade.js';
import {
  VEGETATION_CLUMP_FIELD_DEFAULTS,
  VEGETATION_CLUMP_FIELD_CONTROL_SCHEMA,
  VEGETATION_CLUMP_DEBUG_SCHEMA_GROUP,
  VEGETATION_CLUMP_FIELD_UNIFORM_GLSL,
  VEGETATION_CLUMP_FIELD_SAMPLE_GLSL,
  VEGETATION_CLUMP_ID_GLSL,
  VEGETATION_CLUMP_DEBUG_GLSL,
  createVegetationClumpFieldSharedUniforms,
  createVegetationClumpFieldOverlayUniforms,
  applyVegetationClumpFieldParamsToUniforms,
  buildClumpCoordTexture,
  bindClumpCoordTextureToOverlayMaterials,
  syncClumpCoordTextureToOverlayMaterials,
  disposeClumpCoordTexture,
  windDisplacedMeshSegments,
  initClumpWindAttributesOnGeometry,
} from './vegetation-clump-field.js';
import {
  VEGETATION_SCENE_WIND_UNIFORM_GLSL,
  VEGETATION_SCENE_WIND_STRENGTH_GLSL,
  createVegetationSceneWindSharedUniforms,
} from './vegetation-scene-wind.js';
import { sceneWindField } from '../../core/SceneWindField.js';
import {
  VEGETATION_WIND_NOISE_GLSL,
  VEGETATION_WIND_OVERLAY_UNIFORM_GLSL,
  VEGETATION_WIND_LAYER_UNIFORM_GLSL,
  VEGETATION_CLUMP_WIND_VARYING_GLSL,
  VEGETATION_BULK_WIND_OFFSET_GLSL,
  VEGETATION_BULK_VERTEX_DISPLACEMENT_GLSL,
  VEGETATION_BULK_WIND_TURBULENCE_GLSL,
  VEGETATION_FLUTTER_UV_GLSL,
  VEGETATION_FLUTTER_FRAGMENT_GLSL,
  VEGETATION_BILLBOARD_SHADOW_GLSL,
  createVegetationWindOverlayUniforms,
} from './vegetation-bulk-wind.js';
import {
  isVegetationWindTuningParam,
  syncVegetationWindParamsToUniforms,
  linkVegetationWindLayerUniforms,
  TREE_WIND_LAYER_DEFAULTS,
} from './vegetation-wind-params.js';
import {
  probeVegetationMaskPathsBatch,
  readMaskImageData,
  detectDerivedAlphaFromImageData,
  buildAlphaSampleCache,
  VEGETATION_MASK_READ_MAX_DIM,
  getVegetationMaskLoadQueue,
  yieldVegetationPopulateFrame,
} from './vegetation-mask-load.js';

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
     * @type {Map<string, {mesh: THREE.Mesh, shadowMesh: THREE.Mesh, material: THREE.ShaderMaterial, shadowMaterial: THREE.ShaderMaterial, floorIndex: number}>}
     */
    this._overlays = new Map();

    /** @type {Set<string>} */
    this._negativeCache = new Set();

    /** @type {object|null} */
    this._sharedUniforms = null;

    /** @type {{ enabled: boolean, global?: object, interior?: object }} */
    this._timelineGradeState = { enabled: false };

    // Derived-alpha support (some Tree masks might be opaque with white background)
    /** @type {Map<string, boolean>} */
    this._deriveAlphaByTileId = new Map();

    /** @type {Map<string, {width:number, height:number, data:Uint8ClampedArray}>} */
    this._alphaSampleByTileId = new Map();

    // Temporal state (smoothed wind coupling)
    this._currentWindSpeed = 0.0;
    this._windFieldPhase = 0.0;
    this._wavePhase = 0.0;
    this._flutterPhase = 0.0;
    this._lastFrameTime = 0.0;
    this._hoverHidden = false;
    this._hoverFadeInProgress = false;
    this._worldSamplePoint = null;
    this._localSamplePoint = null;
    /** @type {number|null} */
    this._lastVisibilityFloorIndex = null;
    /** @type {string} */
    this._viewBoundsSignature = '';
    /** @type {{ minX: number, minY: number, maxX: number, maxY: number }|null} */
    this._cachedViewBounds = null;
    this._viewCullPadding = 192;

    /** Bumped on clear/populate so stale async mask loads cannot touch new overlays. */
    this._populateGeneration = 0;
    this._windLayerUniformsLinked = false;
    /** Per-overlay serial invalidated when an entry is torn down or replaced. */
    this._maskLoadSerial = 0;
    /** Wall-clock ms — block hover-reveal shadow stacking right after repopulate. */
    this._suppressHoverRevealStackingUntilMs = 0;
    /** @type {object|null} Last populate geometry snapshot for edge-safety fallback. */
    this._lastFoundrySceneData = null;
    /** @type {string} Cached {@link vegetationEdgeSafetyBoundsSignature} */
    this._edgeSafetyBoundsSignature = '';

    /** @type {'idle'|'searching'|'found'|'missing'} */
    this._maskDiscoveryPhase = 'idle';
    /** Per-frame cache for per-tile hover-hidden lookups. */
    this._frameHoverHiddenByTileId = new Map();
    /** Cached roof-mask uniform bind signature. */
    this._roofMaskUniformSig = '';

    // Public params — tuned for high-canopy motion; optional turbulence on by default.
    this.params = {
      enabled: true,
      intensity: 1.0,

      // -- Wind Physics --
      windSpeedGlobal: 0.06,
      windRampSpeed: 1.32,
      windAttackRamp: 2.5,
      windDecayRamp: 0.88,
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
      turbulence: 0.45,
      turbulenceScale: 0.00022,
      minRustleSpeed: 0.12,
      edgeFadeStart: 0.0,
      edgeFadeEnd: 0.03,

      // -- Bulk sway (vertex) + leaf flutter (fragment) --
      bulkSway: 0.029,
      bulkSwayScale: 0.68,
      bulkSwaySpeed: 2.36,
      bulkSwaySpread: 0.48,
      elasticity: 0.5,

      // -- Leaf Flutter --
      flutterIntensity: 0.0005,
      flutterSpeed: 2.25,
      flutterScale: 0.005,

      // -- Color --
      exposure: -0.4,
      brightness: 0.0,
      contrast: 1.0,
      saturation: 1.0,
      temperature: 0.0,
      tint: 0.0,

      // Canopy shadow (offset alpha sample — same model as BushEffectV2)
      shadowOpacity: 0.35,
      shadowLength: 0.04,
      shadowSoftness: 0.8,

      ...VEGETATION_CLOUD_SHADOW_DEFAULTS,
      ...VEGETATION_BUILDING_SHADOW_DEFAULTS,
      ...VEGETATION_PAINTED_SHADOW_DEFAULTS,
      ...VEGETATION_LANDSCAPE_LIGHTNING_DEFAULTS,
      ...VEGETATION_CLUMP_FIELD_DEFAULTS,
    };

    log.debug('TreeEffectV2 created');
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
        title: 'Tree canopy (_Tree masks)',
        summary: [
          'Animates **high-canopy motion** on tiles (and the scene background) that ship a matching **`_Tree`** texture next to the art.',
          'Wind and canopy shadow use the same shader math as **Bush**; **turbulence** adds extra treetop chop (on by default). Lower turbulence for bush-like motion.',
          'Render order is tuned so canopies sit above bushes/specular on the same floor.',
          'Cost scales with overlay count (shadow uses the same multi-tap pattern as bushes).',
          'Settings save with the scene (not World Based).',
        ].join('\n\n'),
        glossary: {
          Texture: 'Whether the scene found at least one `_Tree` texture after load (row under Enabled).',
          Intensity: 'Overall strength of the tree layer (alpha and shadow contribution).',
          Turbulence: 'Extra high-frequency wobble mixed into distortion (trees only).',
          'Canopy shadow': 'Darkening from a blurred, offset sample of the mask opposite the sun (same as bushes).',
          'Cloud shadows': 'Screen-space darkening from the cloud shadow map (same pass as ground tiles).',
          'Building shadows': 'Scene-space darkening from BuildingShadowsEffectV2 (matches ground structural shade).',
          'Painted shadows': 'Scene-space darkening from PaintedShadowEffectV2 (artist-painted shadow masks).',
          'Landscape lightning': 'HDR brightening on canopy during distant strikes (Map Shine Control lightning).',
          'Edge safety': 'Pulls motion and shadow down near scene edges to hide UV seams.',
          'Hover fade': 'When hover-hide is active, the canopy fades out but the offset ground shadow stays at full strength.',
          'Clump waves': 'Transparent gaps in the mask define foliage clumps; wind waves roll across clump positions on the map.',
          'Clump ID view': 'Debug false-color of island labels — use to check whether antialiased edges share the same ID as the canopy body.',
        },
      },
      presetApplyDefaults: true,
      groups: [
        createMaskStatusSchemaGroup('tree'),
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
            'waveInfluence',
            'gustFrequency',
            'gustSpeed',
            'turbulence',
            'turbulenceScale',
            'minRustleSpeed',
          ],
        },
        {
          name: 'bulkSway',
          label: 'Bulk sway',
          type: 'folder',
          expanded: true,
          parameters: ['bulkSway', 'bulkSwayScale', 'bulkSwaySpeed', 'bulkSwaySpread', 'elasticity'],
        },
        {
          name: 'flutter',
          label: 'Leaf flutter',
          type: 'folder',
          expanded: true,
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
          tooltip: 'Extra foliage tweaks on top of Camera Grade and Time of Day (applied automatically).',
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
          name: 'buildingShadow',
          label: 'Building shadows',
          type: 'folder',
          advanced: true,
          expanded: false,
          parameters: [
            'buildingShadowEnabled',
            'buildingShadowDarkenStrength',
            'buildingShadowDarkenCurve',
          ],
        },
        {
          name: 'paintedShadow',
          label: 'Painted shadows',
          type: 'folder',
          advanced: true,
          expanded: false,
          parameters: [
            'paintedShadowEnabled',
            'paintedShadowDarkenStrength',
            'paintedShadowDarkenCurve',
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
        VEGETATION_CLUMP_DEBUG_SCHEMA_GROUP,
      ],
      parameters: {
        intensity: {
          type: 'slider',
          label: 'Intensity',
          min: 0.0,
          max: 2.0,
          step: 0.01,
          default: 1.0,
          throttle: 100,
          tooltip: 'Master strength of the tree layer (alpha and shadow contribution).',
        },
        windSpeedGlobal: {
          type: 'slider',
          label: 'Wind scale',
          min: 0.0,
          max: 3.0,
          step: 0.001,
          default: 0.06,
          throttle: 100,
          hidden: true,
          tooltip: 'Moved to Scene Wind → Vegetation response.',
        },
        windRampSpeed: {
          type: 'slider',
          label: 'Wind catch-up',
          min: 0.1,
          max: 10.0,
          step: 0.05,
          default: 1.32,
          throttle: 100,
          hidden: true,
          tooltip: 'Moved to Scene Wind → Vegetation catch-up.',
        },
        gustFrequency: {
          type: 'slider',
          label: 'Gust frequency',
          min: 0.0,
          max: 0.05,
          step: 0.0001,
          default: 0.0022,
          throttle: 100,
          tooltip: 'Procedural gust noise scale on foliage (fine chop layered on scene wind).',
        },
        gustSpeed: {
          type: 'slider',
          label: 'Gust travel',
          min: 0.0,
          max: 2.0,
          step: 0.01,
          default: 0.15,
          throttle: 100,
          tooltip: 'How fast procedural gust noise scrolls across the canopy.',
        },
        waveSpatialFrequency: {
          type: 'slider',
          label: 'Wave spacing',
          min: 0.0001,
          max: 0.01,
          step: 0.0001,
          default: 0.0014,
          throttle: 100,
          hidden: true,
          tooltip: 'Moved to Scene Wind → Wave spacing.',
        },
        waveTravelSpeed: {
          type: 'slider',
          label: 'Wave speed',
          min: 0.05,
          max: 4.0,
          step: 0.01,
          default: 0.7,
          throttle: 100,
          hidden: true,
          tooltip: 'Moved to Scene Wind → Wave speed.',
        },
        waveSharpness: {
          type: 'slider',
          label: 'Wave sharpness',
          min: 0.5,
          max: 6.0,
          step: 0.05,
          default: 2.0,
          throttle: 100,
          hidden: true,
          tooltip: 'Moved to Scene Wind → Wave sharpness.',
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
          default: 0.45,
          throttle: 100,
          tooltip: 'Extra procedural chop (0 = bush-identical wind UV; raise for livelier treetops).',
        },
        turbulenceScale: {
          type: 'slider',
          label: 'Turbulence scale',
          min: 0.00005,
          max: 0.003,
          step: 0.00001,
          default: 0.00022,
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
          default: 0.12,
          throttle: 100,
          tooltip: 'Minimum effective wind speed when the scene reports calm air.',
        },
        bulkSway: {
          type: 'slider',
          label: 'Sway amount',
          min: 0.0,
          max: 0.14,
          step: 0.001,
          default: 0.029,
          throttle: 100,
          tooltip: 'Rigid whole-island motion — moves overlay geometry, not mask UV.',
        },
        bulkSwayScale: {
          type: 'slider',
          label: 'Sway scale',
          min: 0.0,
          max: 2.5,
          step: 0.01,
          default: 0.68,
          throttle: 100,
          tooltip: 'Multiplier on bulk sway amplitude.',
        },
        bulkSwaySpeed: {
          type: 'slider',
          label: 'Sway speed',
          min: 0.2,
          max: 3.0,
          step: 0.01,
          default: 2.36,
          throttle: 100,
          tooltip: 'How fast each island rocks (slow compared to leaf flutter).',
        },
        bulkSwaySpread: {
          type: 'slider',
          label: 'Direction spread',
          min: 0.08,
          max: 0.75,
          step: 0.01,
          default: 0.48,
          throttle: 100,
          tooltip: 'Per-island variation in sway direction (radians). Higher = more independent trees.',
        },
        elasticity: {
          type: 'slider',
          label: 'Springiness',
          min: 0.5,
          max: 5.0,
          step: 0.01,
          default: 0.5,
          throttle: 100,
          tooltip: 'Oscillation rate mixed into bulk sway (leaf flutter uses Flutter speed).',
        },
        flutterIntensity: {
          type: 'slider',
          label: 'Flutter amount',
          min: 0.0,
          max: 0.02,
          step: 0.0001,
          default: 0.0005,
          throttle: 100,
          tooltip: 'Fine per-pixel leaf UV shimmer (layer 3 — after canopy sway and branch bend).',
        },
        flutterSpeed: {
          type: 'slider',
          label: 'Flutter speed',
          min: 1.0,
          max: 20.0,
          step: 0.05,
          default: 2.25,
          throttle: 100,
          tooltip: 'How fast the flutter phase advances.',
        },
        flutterScale: {
          type: 'slider',
          label: 'Flutter scale',
          min: 0.005,
          max: 0.1,
          step: 0.0001,
          default: 0.005,
          throttle: 100,
          tooltip: 'World-space scale of noise driving flutter.',
        },
        exposure: {
          type: 'slider',
          label: 'Exposure',
          min: -2.0,
          max: 2.0,
          step: 0.02,
          default: -0.4,
          throttle: 100,
          tooltip: 'Extra stops on top of Camera Grade exposure.',
        },
        brightness: {
          type: 'slider',
          label: 'Brightness',
          min: -0.5,
          max: 0.5,
          step: 0.01,
          default: 0.0,
          throttle: 100,
          tooltip: 'Extra linear offset after Camera Grade.',
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
          default: 0.35,
          throttle: 100,
          tooltip: 'Opacity of the offset canopy shadow pass.',
        },
        shadowLength: {
          type: 'slider',
          label: 'Shadow offset',
          min: 0.0,
          max: 0.1,
          step: 0.001,
          default: 0.04,
          throttle: 100,
          tooltip: 'How far the shadow sample is pushed opposite the sun.',
        },
        shadowSoftness: {
          type: 'slider',
          label: 'Shadow softness',
          min: 0.5,
          max: 5.0,
          step: 0.05,
          default: 0.8,
          throttle: 100,
          tooltip: 'Blur radius of the multi-tap shadow sample.',
        },
        ...VEGETATION_CLOUD_SHADOW_CONTROL_SCHEMA,
        ...VEGETATION_BUILDING_SHADOW_CONTROL_SCHEMA,
        ...VEGETATION_PAINTED_SHADOW_CONTROL_SCHEMA,
        ...VEGETATION_LANDSCAPE_LIGHTNING_CONTROL_SCHEMA,
        ...VEGETATION_CLUMP_FIELD_CONTROL_SCHEMA,
        edgeFadeStart: {
          type: 'slider',
          label: 'Edge fade start',
          min: 0.0,
          max: 0.2,
          step: 0.005,
          default: 0.0,
          throttle: 100,
          tooltip: 'Scene-edge band where motion and shadow begin to fall off.',
        },
        edgeFadeEnd: {
          type: 'slider',
          label: 'Edge fade end',
          min: 0.02,
          max: 0.4,
          step: 0.005,
          default: 0.03,
          throttle: 100,
          tooltip: 'Scene-edge distance where motion and shadow are fully suppressed.',
        },
      },
      presets: {
        Calm: {
          windSpeedGlobal: 0.12,
          turbulence: 0.0,
          flutterIntensity: 0.00035,
          branchBend: 0.008,
        },
        Windy: {
          windSpeedGlobal: 0.48,
          gustSpeed: 0.95,
          waveTravelSpeed: 1.15,
          turbulence: 0.45,
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
    log.info('TreeEffectV2 initialized');
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
    // background can get a corresponding _Tree overlay regardless of current view.
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
    const tileDocs = canvas?.scene?.tiles?.contents ?? [];
    const probePaths = [];
    for (const bg of bgEntries) {
      if (!bg.src) continue;
      probePaths.push(bg.src.replace(/\.[^.]+$/, ''));
    }
    for (const tileDoc of tileDocs) {
      const src = tileDoc?.texture?.src ?? tileDoc?.img ?? '';
      if (!src) continue;
      probePaths.push(src.replace(/\.[^.]+$/, ''));
    }
    const maskUrls = await probeVegetationMaskPathsBatch(
      probePaths,
      (basePath, suffix) => this._probeMask(basePath, suffix),
      '_Tree',
      this._negativeCache,
    );

    let spawnIdx = 0;
    for (const bg of bgEntries) {
      const bgSrc = bg.src;
      if (!bgSrc) continue;
      const basePath = bgSrc.replace(/\.[^.]+$/, '');
      const url = maskUrls.get(basePath);
      if (!url) continue;
      const centerX = sceneX + sceneW / 2;
      const centerY = worldH - (sceneY + sceneH / 2);
      const tileW = sceneW;
      const tileH = sceneH;
      const z = GROUND_Z - 1 + TREE_Z_OFFSET;
      this._createOverlay(bg.key, bg.floorIndex, { url, centerX, centerY, z, tileW, tileH, rotation: 0 });
      spawnIdx += 1;
      if (spawnIdx % 2 === 0) await yieldVegetationPopulateFrame();
    }

    for (const tileDoc of tileDocs) {
      const src = tileDoc?.texture?.src ?? tileDoc?.img ?? '';
      if (!src) continue;

      const basePath = src.replace(/\.[^.]+$/, '');
      const url = maskUrls.get(basePath);
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
      spawnIdx += 1;
      if (spawnIdx % 2 === 0) await yieldVegetationPopulateFrame();
    }

    this._resetAllOverlayHoverAndStacking();

    const n = this._overlays.size;
    this._maskDiscoveryPhase = n > 0 ? 'found' : 'missing';
    this._notifyMaskStatusUi();
    log.info(`TreeEffectV2 populated: ${n} overlays`);
  }

  /** Push _Tree texture row state into the Tree Tweakpane panel. */
  _notifyMaskStatusUi() {
    refreshEffectMaskStatusUi('tree');
  }

  /**
   * Minimal uniform tick while the camera is panning — skips wind/weather CPU work
   * but still advances canopy hover-fade uniforms.
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
      this._syncWindUniforms();
    }
    const maxFloor = this._getSafeVisibleMaxFloorIndex();
    const floorChanged = maxFloor !== this._lastVisibilityFloorIndex;
    const viewChanged = this._viewBoundsMayHaveChanged();
    if (floorChanged) this._lastVisibilityFloorIndex = maxFloor;
    if (floorChanged || viewChanged) this._syncOverlayVisibility();
    this._advanceHoverFadeUniforms(delta);
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

    const weather = weatherController?.currentState;
    const windDir = weather?.windDirection;
    const windSpeed01 = Number(weather?.windSpeed ?? 0);

    const attack = Math.max(0.001, Number(this.params.windAttackRamp ?? this.params.windRampSpeed ?? 1));
    const decay = Math.max(0.001, Number(this.params.windDecayRamp ?? attack * 0.35));
    const ramp = windSpeed01 > this._currentWindSpeed ? attack : decay;
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
    if (sceneWindField.params.enabled !== false) {
      this._wavePhase = sceneWindField.getUniforms().uSceneWindWavePhase;
    } else {
      this._wavePhase += phaseDelta * Math.max(0.0, Number(this.params.waveTravelSpeed ?? 0.0)) * (0.35 + rustleSpeed);
    }
    this._flutterPhase += phaseDelta * Math.max(0.0, Number(this.params.flutterSpeed ?? 0.0))
      * (0.85 + rustleSpeed);

    this._syncSceneBoundsUniforms();

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

      this._sharedUniforms.uIntensity.value = (this.params.intensity ?? 1.0);
      this._syncWindUniforms();
      this._sharedUniforms.uShadowSoftness.value = this.params.shadowSoftness * (Number(this._driverShadowSoftnessScale) || 1.0);

      this._sharedUniforms.uExposure.value = this.params.exposure;
      this._sharedUniforms.uBrightness.value = this.params.brightness;
      this._sharedUniforms.uContrast.value = this.params.contrast;
      this._sharedUniforms.uSaturation.value = this.params.saturation;
      this._sharedUniforms.uTemperature.value = this.params.temperature;
      this._sharedUniforms.uTint.value = this.params.tint;

      this._applyShadowDriverUniforms();
      this._syncRoofMaskUniforms();
      applyVegetationCloudShadowParamsToUniforms(this._sharedUniforms, this.params);
      applyVegetationBuildingShadowParamsToUniforms(this._sharedUniforms, this.params);
      applyVegetationPaintedShadowParamsToUniforms(this._sharedUniforms, this.params);
      applyVegetationLandscapeLightningParamsToUniforms(this._sharedUniforms, this.params);
      applyVegetationClumpFieldParamsToUniforms(this._sharedUniforms, this.params);
    }

    this._advanceHoverFadeUniforms(delta);

    this._lastFrameTime = time;
  }

  /**
   * Timeline grade from ColorCorrectionEffectV2 (updated each frame by FloorCompositor).
   * @param {{ enabled: boolean, global?: object, interior?: object }} state
   */
  setTimelineGradeState(state) {
    this._timelineGradeState = state ?? { enabled: false };
  }

  /**
   * Push Camera Grade + ToD uniforms before pre-merge vegetation composite.
   */
  syncCameraGradeUniforms() {
    if (!this._initialized) return;
    syncVegetationCameraGradeForEffect(this);
  }

  /**
   * Bind CloudEffectV2 shadow map for canopy darkening (call after cloud render each frame).
   */
  syncCloudShadowUniforms() {
    if (!this._initialized || !this._sharedUniforms) return;
    syncVegetationCloudShadowUniforms(this._sharedUniforms, this.params);
  }

  /**
   * Bind BuildingShadowsEffectV2 lit-factor maps (call after building shadow render each frame).
   */
  syncBuildingShadowUniforms() {
    if (!this._initialized) return;
    syncVegetationBuildingShadowForEffect(this);
  }

  /**
   * Bind PaintedShadowEffectV2 lit-factor maps (call after painted shadow render each frame).
   */
  syncPaintedShadowUniforms() {
    if (!this._initialized) return;
    syncVegetationPaintedShadowForEffect(this);
  }

  /**
   * Push wind/flutter tuning from this.params into shared shader uniforms.
   * @private
   */
  _syncWindUniforms() {
    syncVegetationWindParamsToUniforms(this._sharedUniforms, this.params, {
      sceneWindField,
      windLayerDefaults: TREE_WIND_LAYER_DEFAULTS,
    });
    if (!this._windLayerUniformsLinked) {
      this._relinkAllOverlayWindUniforms();
      this._windLayerUniformsLinked = true;
    }
  }

  /** @private */
  _linkOverlayWindUniforms(uniforms) {
    linkVegetationWindLayerUniforms(uniforms, this._sharedUniforms);
  }

  /** @private */
  _relinkAllOverlayWindUniforms() {
    for (const entry of this._overlays.values()) {
      this._linkOverlayWindUniforms(entry.material?.uniforms);
      this._linkOverlayWindUniforms(entry.shadowMaterial?.uniforms);
    }
  }

  applyParamChange(paramId, _value) {
    if (!this._sharedUniforms) return;
    if (isVegetationWindTuningParam(paramId)) {
      this._syncWindUniforms();
      if (paramId === 'clumpWaveEnabled' || paramId === 'clumpWaveMix' || paramId === 'clumpIdDebug') {
        applyVegetationClumpFieldParamsToUniforms(this._sharedUniforms, this.params);
        this._syncAllOverlayClumpFieldUniforms();
      }
      return;
    }
    if (paramId.startsWith('buildingShadow')) {
      applyVegetationBuildingShadowParamsToUniforms(this._sharedUniforms, this.params);
      syncVegetationBuildingShadowForEffect(this);
      return;
    }
    if (paramId.startsWith('paintedShadow')) {
      applyVegetationPaintedShadowParamsToUniforms(this._sharedUniforms, this.params);
      syncVegetationPaintedShadowForEffect(this);
      return;
    }
    if (paramId.startsWith('cloudShadow')) {
      applyVegetationCloudShadowParamsToUniforms(this._sharedUniforms, this.params);
      syncVegetationCloudShadowUniforms(this._sharedUniforms, this.params);
      return;
    }
  }

  /**
   * Bind landscape lightning flash from WeatherLightningEffectV2 (after its update each frame).
   */
  syncLandscapeLightningUniforms() {
    if (!this._initialized) return;
    syncVegetationLandscapeLightningForEffect(this);
  }

  /**
   * Ramp per-overlay uHoverFade toward the active hover-hidden target.
   * @param {number} delta
   * @private
   */
  _resolveTileHoverHidden(tileId, hoverCache) {
    if (this._hoverHidden) return true;
    if (!tileId || String(tileId).startsWith('__')) return false;
    if (hoverCache.has(tileId)) return hoverCache.get(tileId);
    const hidden = this._isTileHoverHiddenOnActiveScene(tileId);
    hoverCache.set(tileId, hidden);
    return hidden;
  }

  _advanceHoverFadeUniforms(delta) {
    const stepDelta = Number.isFinite(delta) ? delta : 0.016;
    const hoverCache = this._frameHoverHiddenByTileId;
    hoverCache.clear();
    // Warmup/populate paths freeze delta — snap instead of leaving _hoverFadeInProgress stuck.
    if (stepDelta <= 1e-6) {
      for (const [tileId, entry] of this._overlays) {
        const hoverUniform = entry?.material?.uniforms?.uHoverFade;
        const shadowHoverUniform = entry?.shadowMaterial?.uniforms?.uHoverFade;
        const shadowCanopyFadeUniform = entry?.shadowMaterial?.uniforms?.uCanopyHoverFade;
        if (!hoverUniform) continue;
        const hoverHidden = this._resolveTileHoverHidden(tileId, hoverCache);
        const targetFade = hoverHidden ? 0.0 : 1.0;
        hoverUniform.value = targetFade;
        if (shadowHoverUniform) shadowHoverUniform.value = 1.0;
        if (shadowCanopyFadeUniform) shadowCanopyFadeUniform.value = targetFade;
        this._applyTreeHoverRevealStacking(entry, tileId, targetFade);
      }
      this._hoverFadeInProgress = false;
      return;
    }

    let hoverFadeInProgress = false;
    const hoverHiding = this._hoverHidden;
    for (const [tileId, entry] of this._overlays) {
      if (!entry?.mesh?.visible && !hoverHiding && !this._hoverFadeInProgress) continue;
      const hoverUniform = entry?.material?.uniforms?.uHoverFade;
      const shadowHoverUniform = entry?.shadowMaterial?.uniforms?.uHoverFade;
      const shadowCanopyFadeUniform = entry?.shadowMaterial?.uniforms?.uCanopyHoverFade;
      if (!hoverUniform) continue;

      const hoverHidden = this._resolveTileHoverHidden(tileId, hoverCache);
      const targetFade = hoverHidden ? 0.0 : 1.0;
      const currentFade = Number.isFinite(hoverUniform.value) ? hoverUniform.value : targetFade;
      const diff = targetFade - currentFade;
      const absDiff = Math.abs(diff);

      if (absDiff <= 0.0005) {
        hoverUniform.value = targetFade;
        if (shadowHoverUniform) shadowHoverUniform.value = 1.0;
        if (shadowCanopyFadeUniform) shadowCanopyFadeUniform.value = targetFade;
        this._applyTreeHoverRevealStacking(entry, tileId, targetFade);
        continue;
      }
      hoverFadeInProgress = true;

      const maxStep = stepDelta / 2.0;
      const step = Math.sign(diff) * Math.min(absDiff, maxStep);
      hoverUniform.value = currentFade + step;
      // Ground shadow stays full strength during hover reveal — only the canopy fades.
      if (shadowHoverUniform) shadowHoverUniform.value = 1.0;
      // Billboard lit-capture must follow canopy fade so lighting does not lift shadow
      // under foliage and leave a masked canopy-shaped ring.
      if (shadowCanopyFadeUniform) shadowCanopyFadeUniform.value = hoverUniform.value;
      this._applyTreeHoverRevealStacking(entry, tileId, hoverUniform.value);
    }
    this._hoverFadeInProgress = hoverFadeInProgress;
  }

  onFloorChange(_maxFloorIndex) {
    this._lastVisibilityFloorIndex = null;
    this._viewBoundsMayHaveChanged();
    this._syncOverlayVisibility();
  }

  wantsContinuousRender() {
    // Canopy hover fade runs on presented frames only — no continuous lock-in.
    return false;
  }

  setHoverHidden(hidden) {
    const next = !!hidden;
    if (next === this._hoverHidden) return;
    this._hoverHidden = next;
    if (!next) {
      for (const entry of this._overlays.values()) {
        const hoverFade = entry?.material?.uniforms?.uHoverFade?.value;
        if (Number.isFinite(hoverFade) && hoverFade < 0.999) {
          this._hoverFadeInProgress = true;
          break;
        }
      }
    }
    if (next || this._hoverFadeInProgress) {
      this._pumpHoverFadeRenderBurst();
    }
  }

  /**
   * Request a short presentation burst for hover-fade ramps. Skipped during populate
   * slim renders and shader warmup so loading/pause UI pacing is not disturbed.
   * @private
   */
  _pumpHoverFadeRenderBurst() {
    try {
      const fc = window.MapShine?.effectComposer?._floorCompositorV2;
      if (fc?._populateSlimRenderActive?.()) return;
      if (!fc?._shaderWarmupGateOpen) return;
    } catch (_) {}
    try { window.MapShine?.renderLoop?.requestContinuousRender?.(750); } catch (_) {}
    try { window.MapShine?.renderLoop?.requestRender?.(); } catch (_) {}
  }

  /**
   * True while tree canopy reveal/hide is active or still fading.
   * @returns {boolean}
   */
  isHoverRevealActive() {
    return !!this._hoverHidden || !!this._hoverFadeInProgress;
  }

  /** True only while canopy fade is actively ramping (not steady hidden state). */
  isHoverFadeInProgress() {
    return !!this._hoverFadeInProgress;
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
    this._edgeSafetyBoundsSignature = '';
    this._syncSceneBoundsUniforms();
  }

  clear() {
    this._populateGeneration += 1;
    this._windLayerUniformsLinked = false;
    for (const [tileId, entry] of this._overlays) {
      this._teardownOverlayEntry(tileId, entry);
    }
    this._overlays.clear();
    this._deriveAlphaByTileId.clear();
    this._alphaSampleByTileId.clear();
    this._hoverHidden = false;
    this._hoverFadeInProgress = false;
    this._frameHoverHiddenByTileId.clear();
    this._roofMaskUniformSig = '';
    this._lastFoundrySceneData = null;
    this._edgeSafetyBoundsSignature = '';
    this._maskDiscoveryPhase = 'missing';
    this._notifyMaskStatusUi();
  }

  /**
   * @param {string} tileId
   * @private
   */
  _disposeSingleTileOverlay(tileId) {
    if (!tileId || String(tileId).startsWith('__bg_image__')) return;
    const entry = this._overlays.get(tileId);
    if (!entry) return;
    this._teardownOverlayEntry(tileId, entry);
    this._overlays.delete(tileId);
    try { this._deriveAlphaByTileId.delete(tileId); } catch (_) {}
    try { this._alphaSampleByTileId.delete(tileId); } catch (_) {}
  }

  /**
   * Re-probe `_Tree` and rebuild the overlay after `texture.src` changed on a tile.
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
    const url = await this._probeMask(basePath, '_Tree');
    if (!url) return;

    const floorIndex = this._resolveFloorIndex(tileDoc, floors);
    const tileW = Number(tileDoc?.width ?? 0);
    const tileH = Number(tileDoc?.height ?? 0);
    const centerX = Number(tileDoc?.x ?? 0) + tileW / 2;
    const centerY = worldH - (Number(tileDoc?.y ?? 0) + tileH / 2);
    const z = GROUND_Z + floorIndex + TREE_Z_OFFSET;
    const rotation = typeof tileDoc?.rotation === 'number' ? (tileDoc.rotation * Math.PI) / 180 : 0;

    this._createOverlay(tileId, floorIndex, { url, centerX, centerY, z, tileW, tileH, rotation });
  }

  setBillboardShadowMode(enabled) {
    if (!this._sharedUniforms?.uBillboardShadowMode) return;
    this._sharedUniforms.uBillboardShadowMode.value = enabled ? 1.0 : 0.0;
  }

  /**
   * Shadow multi-tap LOD for perf (see vegetationBillboardShadowAccum).
   * @param {number} lod 0.5 = coarse, 1.0 = default, 1.5 = full quality
   */
  setShadowTapLod(lod) {
    if (!this._sharedUniforms?.uShadowTapLod) return;
    const v = Number(lod);
    this._sharedUniforms.uShadowTapLod.value = Number.isFinite(v) ? v : 1.0;
  }

  /**
   * @returns {{mesh: import('three').Mesh, uniforms: object}[]}
   */
  collectBillboardShadowOverlayEntries() {
    if (!this._enabled || !this._initialized) return [];
    const out = [];
    for (const entry of this._overlays.values()) {
      if (!entry?.shadowMesh?.visible || !entry.shadowMaterial?.uniforms) continue;
      const shadowOp = Number(entry.shadowMaterial.uniforms.uShadowOpacity?.value ?? this.params.shadowOpacity ?? 0);
      if (!(shadowOp > 0.001)) continue;
      out.push({
        mesh: entry.shadowMesh,
        uniforms: entry.shadowMaterial.uniforms,
        material: entry.shadowMaterial,
      });
    }
    return out;
  }

  /**
   * Live tree canopy meshes for screen-space occlusion masks (e.g. bush shadows).
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
    log.info('TreeEffectV2 disposed');
  }

  // ── Private helpers ─────────────────────────────────────────────────────────

  /**
   * Remove overlay meshes from the bus and dispose GPU resources. Detaches materials
   * first so late TextureLoader callbacks cannot paint torn-down meshes.
   * @param {string} tileId
   * @param {{ mesh?: import('three').Mesh, shadowMesh?: import('three').Mesh, material?: import('three').ShaderMaterial, shadowMaterial?: import('three').ShaderMaterial }} entry
   * @private
   */
  _teardownOverlayEntry(tileId, entry) {
    if (!entry) return;
    try { if (entry.shadowMesh) entry.shadowMesh.visible = false; } catch (_) {}
    try { if (entry.mesh) entry.mesh.visible = false; } catch (_) {}
    try { this._renderBus.removeEffectOverlay(`${tileId}_tree_shadow`); } catch (_) {}
    try { this._renderBus.removeEffectOverlay(`${tileId}_tree`); } catch (_) {}
    try { if (entry.shadowMesh) entry.shadowMesh.material = null; } catch (_) {}
    try { if (entry.mesh) entry.mesh.material = null; } catch (_) {}
    const tex = entry.material?.uniforms?.uTreeMask?.value ?? null;
    disposeClumpCoordTexture(entry.clumpCoordTexture ?? null);
    try { entry.material?.dispose?.(); } catch (_) {}
    try { entry.shadowMaterial?.dispose?.(); } catch (_) {}
    const geom = entry.mesh?.geometry ?? entry.shadowMesh?.geometry ?? null;
    if (geom) {
      try { entry.mesh.geometry = null; } catch (_) {}
      try { entry.shadowMesh.geometry = null; } catch (_) {}
      try { geom.dispose(); } catch (_) {}
    }
    if (tex?.dispose) {
      try { tex.dispose(); } catch (_) {}
    }
  }

  /**
   * Only honor TileManager hover-hide when the tile belongs to the active scene.
   * @param {string} tileId
   * @returns {boolean}
   * @private
   */
  _isTileHoverHiddenOnActiveScene(tileId) {
    if (!tileId || String(tileId).startsWith('__')) return false;
    try {
      const tileDoc = canvas?.scene?.tiles?.get?.(tileId);
      if (!tileDoc) return false;
      return !!window.MapShine?.tileManager?.getTileSpriteData?.(tileId)?.hoverHidden;
    } catch (_) {
      return false;
    }
  }

  _buildSharedUniforms() {
    const THREE = window.THREE;
    this._sharedUniforms = {
      uTreeMask: { value: null },
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
      uTurbulence: { value: this.params.turbulence },
      uTurbulenceScale: { value: this.params.turbulenceScale },
      uMinRustleSpeed: { value: this.params.minRustleSpeed },
      uEdgeFadeStart: { value: this.params.edgeFadeStart },
      uEdgeFadeEnd: { value: this.params.edgeFadeEnd },
      uBulkSway: { value: this.params.bulkSway },
      uBulkSwayScale: { value: this.params.bulkSwayScale },
      uBulkSwaySpeed: { value: this.params.bulkSwaySpeed },
      uBulkSwaySpread: { value: this.params.bulkSwaySpread },
      uElasticity: { value: this.params.elasticity },
      uFlutterIntensity: { value: this.params.flutterIntensity },
      uFlutterSpeed: { value: this.params.flutterSpeed },
      uFlutterScale: { value: this.params.flutterScale },
      uShadowOpacity: { value: this.params.shadowOpacity },
      uShadowLength: { value: this.params.shadowLength },
      uShadowSoftness: { value: this.params.shadowSoftness },

      uBillboardShadowMode: { value: 0.0 },
      uShadowLitCapture: { value: 0.0 },
      /** Shadow blur tap LOD: 0.5 = 5 taps, 1.0 = 9 taps, 1.5 = 13 taps (full). */
      uShadowTapLod: { value: 1.0 },

      uExposure: { value: this.params.exposure },
      uBrightness: { value: this.params.brightness },
      uContrast: { value: this.params.contrast },
      uSaturation: { value: this.params.saturation },
      uTemperature: { value: this.params.temperature },
      uTint: { value: this.params.tint },

      uDeriveAlpha: { value: 0.0 },
      uRoofAlphaMap: { value: null },
      uRoofBlockMap: { value: null },
      uHasRoofAlphaMap: { value: 0.0 },
      uHasRoofBlockMap: { value: 0.0 },
      uRoofRainHardBlockEnabled: { value: 0.0 },
      uScreenSize: { value: new THREE.Vector2(1920, 1080) },
      ...createVegetationCloudShadowUniforms(THREE, this.params),
      ...createVegetationBuildingShadowUniforms(THREE, this.params),
      ...createVegetationPaintedShadowUniforms(THREE, this.params),
      ...createVegetationLandscapeLightningUniforms(THREE, this.params),
      ...createVegetationCameraGradeUniforms(THREE),
      ...createVegetationClumpFieldSharedUniforms(this.params),
      ...createVegetationSceneWindSharedUniforms(sceneWindField.params),
    };
  }

  /**
   * Push clump-wave toggles to every live overlay (shared refs + per-overlay has-map).
   * @private
   */
  _syncAllOverlayClumpFieldUniforms() {
    for (const entry of this._overlays.values()) {
      syncClumpCoordTextureToOverlayMaterials(entry, entry.clumpCoordTexture ?? null, this.params);
    }
  }

  /**
   * Build and bind clump coord map after mask texture load.
   * @param {string} tileId
   * @param {import('three').Texture} tex
   * @param {boolean} deriveAlpha
   * @param {{ centerX: number, centerY: number, tileW: number, tileH: number, rotation: number }} placement
   * @private
   */
  _applyClumpCoordMapForOverlay(tileId, tex, deriveAlpha, placement, imageDataOpts = null) {
    const entry = this._overlays.get(tileId);
    if (!entry) return;

    disposeClumpCoordTexture(entry.clumpCoordTexture ?? null);
    entry.clumpCoordTexture = null;

    const built = buildClumpCoordTexture(tex, deriveAlpha, {
      centerX: placement.centerX,
      centerY: placement.centerY,
      tileW: placement.tileW,
      tileH: placement.tileH,
      rotationRad: Number(placement.rotation) || 0,
    }, imageDataOpts);

    if (built?.texture) {
      entry.clumpCoordTexture = built.texture;
      entry.clumpIslandBySeed = built.islandBySeed ?? null;
      bindClumpCoordTextureToOverlayMaterials(
        entry, built.texture, this.params, built.primaryAnchor,
        placement.centerX, placement.centerY, placement, built.islandCount,
      );
      log.debug(`TreeEffectV2 clump map: ${tileId} (${built.islandCount} islands, meshSeg ${entry._windMeshSegments ?? '?'})`);
    } else {
      entry.clumpIslandBySeed = null;
      bindClumpCoordTextureToOverlayMaterials(
        entry, null, this.params, null, placement.centerX, placement.centerY, placement,
      );
    }
  }

  _syncRoofMaskUniforms() {
    if (!this._sharedUniforms) return;
    let roofAlphaTexture = null;
    let roofBlockTexture = null;
    let screenWidth = 1920;
    let screenHeight = 1080;

    try {
      const fc = window.MapShine?.floorCompositorV2 ?? window.MapShine?.effectComposer?._floorCompositorV2;
      const ose = fc?._overheadShadowEffect;
      roofBlockTexture = ose?.roofBlockTexture ?? null;
      const oseAlpha = ose?.roofAlphaTexture ?? null;
      if (oseAlpha) {
        roofAlphaTexture = oseAlpha;
        const rt = ose?.roofVisibilityTarget;
        if (rt?.width > 0 && rt?.height > 0) {
          screenWidth = rt.width;
          screenHeight = rt.height;
        }
      }
    } catch (_) {}

    const hasRoofAlphaMap = !!roofAlphaTexture;
    const hasRoofBlockMap = !!roofBlockTexture;
    const roofHardBlockEnabled = hasRoofAlphaMap && hasRoofBlockMap;
    const sig = [
      roofAlphaTexture?.uuid ?? '0',
      roofBlockTexture?.uuid ?? '0',
      screenWidth,
      screenHeight,
      roofHardBlockEnabled ? 1 : 0,
    ].join('|');
    if (sig === this._roofMaskUniformSig) return;
    this._roofMaskUniformSig = sig;

    this._sharedUniforms.uRoofAlphaMap.value = roofAlphaTexture;
    this._sharedUniforms.uRoofBlockMap.value = roofBlockTexture;
    this._sharedUniforms.uHasRoofAlphaMap.value = hasRoofAlphaMap ? 1.0 : 0.0;
    this._sharedUniforms.uHasRoofBlockMap.value = hasRoofBlockMap ? 1.0 : 0.0;
    this._sharedUniforms.uRoofRainHardBlockEnabled.value = roofHardBlockEnabled ? 1.0 : 0.0;
    this._sharedUniforms.uScreenSize.value.set(screenWidth, screenHeight);
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

    // Prefer V14 native level assignment first. Some migrated scenes can carry
    // legacy Levels range data that no longer matches the active native level.
    const v14Idx = resolveV14NativeDocFloorIndexMin(tileDoc, globalThis.canvas?.scene);
    if (v14Idx !== null) return v14Idx;

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
      ...createVegetationClumpFieldOverlayUniforms(THREE),
      ...createVegetationWindOverlayUniforms(THREE, tileW, tileH, centerX, centerY),
      uTreeMask: { value: null },
      uDeriveAlpha: { value: 0.0 },
      uHoverFade: { value: 1.0 },
      uCanopyHoverFade: { value: 1.0 },
      uVegetationPass: { value: 2.0 },
      uBuildingShadowFloorIndex: { value: Math.max(0, Math.min(3, Math.floor(Number(floorIndex)))) },
    };
    const shadowUniforms = {
      ...this._sharedUniforms,
      ...createVegetationClumpFieldOverlayUniforms(THREE),
      ...createVegetationWindOverlayUniforms(THREE, tileW, tileH, centerX, centerY),
      ...createVegetationShadowLightningUniforms(THREE),
      uTreeMask: { value: null },
      uDeriveAlpha: { value: 0.0 },
      uHoverFade: { value: 1.0 },
      uCanopyHoverFade: { value: 1.0 },
      uVegetationPass: { value: 1.0 },
      uBuildingShadowFloorIndex: { value: Math.max(0, Math.min(3, Math.floor(Number(floorIndex)))) },
    };
    linkVegetationLandscapeLightningUniforms(uniforms, this._sharedUniforms);
    linkVegetationBuildingShadowUniforms(uniforms, this._sharedUniforms);
    linkVegetationBuildingShadowUniforms(shadowUniforms, this._sharedUniforms);
    linkVegetationPaintedShadowUniforms(uniforms, this._sharedUniforms);
    linkVegetationPaintedShadowUniforms(shadowUniforms, this._sharedUniforms);
    this._linkOverlayWindUniforms(uniforms);
    this._linkOverlayWindUniforms(shadowUniforms);

    const material = new THREE.ShaderMaterial({
      name: 'TreeV2Canopy',
      uniforms,
      vertexShader: /* glsl */`
        uniform float uTime;
        uniform float uWindFieldPhase;
        uniform float uWavePhase;
        uniform vec2  uWindDir;
        uniform float uWindSpeed;
        uniform float uWindSpeedGlobal;
        uniform float uGustFrequency;
        uniform float uWaveSpatialFrequency;
        uniform float uWaveSharpness;
        uniform float uWaveInfluence;
        uniform float uAmbientMotion;
        uniform float uRustleFloorScale;
        uniform float uBendMinStrength;
        uniform float uBendWindStart;
        uniform float uBendWindFull;
        uniform float uMinRustleSpeed;
        uniform float uEdgeFadeStart;
        uniform float uEdgeFadeEnd;
        uniform float uElasticity;
        uniform float uVegetationPass;
        uniform vec2  uSceneMin;
        uniform vec2  uSceneMax;
${VEGETATION_CLUMP_WIND_VARYING_GLSL}
${VEGETATION_WIND_OVERLAY_UNIFORM_GLSL}
${VEGETATION_WIND_LAYER_UNIFORM_GLSL}
${VEGETATION_SCENE_WIND_UNIFORM_GLSL}
${VEGETATION_WIND_NOISE_GLSL}
${VEGETATION_SCENE_WIND_STRENGTH_GLSL}
${VEGETATION_BULK_WIND_OFFSET_GLSL}
${VEGETATION_BULK_VERTEX_DISPLACEMENT_GLSL}

        varying vec2 vUv;
        varying vec2 vWorldPos;
        varying vec2 vRestWorldPos;

        void main() {
          vUv = uv;
          vec2 restWorldPos = (modelMatrix * vec4(position, 1.0)).xy;
          vRestWorldPos = restWorldPos;

          float islandActive = step(1e-5, aClumpId);
          vec2 windAnchor = aClumpAnchor;
          float windSeed = aClumpId;
          if (islandActive < 0.5) {
            float posHash = vegetationHash(restWorldPos * 0.0037);
            windAnchor = mix(uWindAnchorWorld, restWorldPos, 0.42);
            windSeed = fract(uWindClumpSeed * 0.15915 + posHash);
          }
          vClumpAnchor = windAnchor;
          vClumpId = islandActive > 0.5 ? aClumpId : windSeed;

          vec2 bulkUv = computeVegetationBulkWindOffset(windAnchor, windSeed, uWindDir);
          bulkUv = applyVegetationBulkWindVertexDisplacement(bulkUv, restWorldPos);
          vBulkWindUv = bulkUv;

          vec3 localPos = position;
          localPos.x -= bulkUv.x * uTileWorldSize.x;
          localPos.y += bulkUv.y * uTileWorldSize.y;
          vec4 worldPos = modelMatrix * vec4(localPos, 1.0);
          vWorldPos = worldPos.xy;
          gl_Position = projectionMatrix * viewMatrix * worldPos;
        }
      `,
      fragmentShader: /* glsl */`
        uniform sampler2D uTreeMask;
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
        uniform float uTurbulence;
        uniform float uTurbulenceScale;
        uniform float uMinRustleSpeed;
        uniform float uEdgeFadeStart;
        uniform float uEdgeFadeEnd;
        uniform float uBulkSway;
        uniform float uBulkSwaySpread;
        uniform float uElasticity;
        uniform float uFlutterIntensity;
        uniform float uFlutterSpeed;
        uniform float uFlutterScale;
        uniform float uShadowOpacity;
        uniform float uShadowLength;
        uniform float uShadowSoftness;
        uniform float uBillboardShadowMode;
        uniform float uShadowLitCapture;
        uniform float uShadowTapLod;
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
        uniform float uCanopyHoverFade;
        uniform float uVegetationPass;
${VEGETATION_WIND_OVERLAY_UNIFORM_GLSL}
${VEGETATION_CLUMP_FIELD_UNIFORM_GLSL}
${VEGETATION_SCENE_WIND_UNIFORM_GLSL}
${VEGETATION_CAMERA_GRADE_UNIFORM_GLSL}
${VEGETATION_CLOUD_SHADOW_UNIFORM_GLSL}
${VEGETATION_BUILDING_SHADOW_UNIFORM_GLSL}
${VEGETATION_PAINTED_SHADOW_UNIFORM_GLSL}
${VEGETATION_LANDSCAPE_LIGHTNING_UNIFORM_GLSL}
        uniform sampler2D uRoofAlphaMap;
        uniform sampler2D uRoofBlockMap;
        uniform float uHasRoofAlphaMap;
        uniform float uHasRoofBlockMap;
        uniform float uRoofRainHardBlockEnabled;
        uniform vec2  uScreenSize;

        varying vec2 vUv;
        varying vec2 vWorldPos;
        varying vec2 vRestWorldPos;
        varying vec2 vClumpAnchor;
        varying float vClumpId;
        varying vec2 vBulkWindUv;

${VEGETATION_CAMERA_GRADE_FUNCTION_GLSL}
${VEGETATION_CLUMP_FIELD_SAMPLE_GLSL}
${VEGETATION_CLUMP_ID_GLSL}
${VEGETATION_CLUMP_DEBUG_GLSL}
${VEGETATION_WIND_NOISE_GLSL}
${VEGETATION_SCENE_WIND_STRENGTH_GLSL}
${VEGETATION_FLUTTER_UV_GLSL}
${VEGETATION_FLUTTER_FRAGMENT_GLSL}
${VEGETATION_BULK_WIND_TURBULENCE_GLSL}

${VEGETATION_BUILDING_SHADOW_SAMPLE_GLSL}
${VEGETATION_PAINTED_SHADOW_SAMPLE_GLSL}

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

${VEGETATION_BILLBOARD_SHADOW_GLSL}

        void main() {
          vec2 globalWindDir = normalize(uWindDir);
          if (length(globalWindDir) < 0.01) globalWindDir = vec2(1.0, 0.0);

          float restTexA = safeAlpha(texture2D(uTreeMask, vUv));
          vec4 clumpDebugColor = vegetationClumpDebugOutput(vUv, vRestWorldPos, restTexA);
          if (clumpDebugColor.a == 0.0) discard;
          if (clumpDebugColor.a > 0.0 && clumpDebugColor.r >= 0.0) {
            gl_FragColor = vec4(clumpDebugColor.rgb * uIntensity, clumpDebugColor.a * uIntensity);
            return;
          }

          float edgeFade = vegetationSceneEdgeFade(vRestWorldPos);
          vec2 flutterUv = vegetationCanopyFlutterUvOffset(
            vRestWorldPos, restTexA, vClumpAnchor, vClumpId, globalWindDir, edgeFade
          );
          if (uTurbulence > 0.001) {
            float foliageFlutterWeight = smoothstep(0.02, 0.38, restTexA);
            flutterUv += computeVegetationBulkTurbulenceUvOffset(
              vClumpAnchor, vClumpId, globalWindDir, vec2(0.0)
            ) * uTurbulence * foliageFlutterWeight * 0.12;
            flutterUv = capVegetationFlutterUvOffset(flutterUv) * edgeFade * foliageFlutterWeight;
          }

          clumpDebugColor = vegetationClumpWindUvSplitOutput(vUv, vUv, vRestWorldPos, restTexA);
          if (clumpDebugColor.a == 0.0) discard;
          if (clumpDebugColor.a > 0.0 && clumpDebugColor.r >= 0.0) {
            gl_FragColor = vec4(clumpDebugColor.rgb * uIntensity, clumpDebugColor.a * uIntensity);
            return;
          }

          // Pass 1: ground shadow - distorted canopy silhouette, sun-offset, multi-tap blur.
          if (uVegetationPass < 1.5) {
            vec2 shadowDir = normalize(vec2(uSunDir.x, -uSunDir.y));
            if (length(shadowDir) < 0.01) shadowDir = -globalWindDir;
            vec2 shadowOffset = shadowDir * uShadowLength;
            float shadowBlur = max(0.0001, uShadowSoftness * 0.0008);
            float shadowA = vegetationBillboardShadowAccum(
              uTreeMask, vUv, shadowOffset, uTileWorldSize, vRestWorldPos,
              vClumpAnchor, vClumpId, globalWindDir, edgeFade, shadowBlur, uShadowTapLod
            );
            if (uBillboardShadowMode > 0.5) shadowA = 0.0;
            shadowA *= clamp(uShadowOpacity, 0.0, 1.0) * uIntensity * edgeFade;

            if (uShadowLitCapture > 0.5) {
              float texA = safeAlpha(texture2D(uTreeMask, vUv + flutterUv));
              float lit = clamp(1.0 - shadowA, 0.0, 1.0);
              float canopyFade = clamp(uCanopyHoverFade, 0.0, 1.0);
              lit = mix(lit, 1.0, clamp(texA * uIntensity * canopyFade, 0.0, 1.0));
              gl_FragColor = vec4(lit, lit, lit, 1.0);
              return;
            }
            if (shadowA <= 0.001) discard;
            gl_FragColor = vec4(0.0, 0.0, 0.0, shadowA);
            return;
          }

          // Pass 2: canopy - bulk sway is vertex displacement; fragment adds tiny flutter only.
          vec4 treeSample = texture2D(uTreeMask, vUv + flutterUv);
          float texA = safeAlpha(treeSample);
          float hf = clamp(uHoverFade, 0.0, 1.0);
          float mainAlpha = texA * uIntensity;
          float visibleMainAlpha = mainAlpha * hf;

          if (uRoofRainHardBlockEnabled > 0.5) {
            float rv = 1.0;
            if (uHasRoofAlphaMap > 0.5) {
              vec2 screenUv = gl_FragCoord.xy / uScreenSize;
              rv = clamp(texture2D(uRoofAlphaMap, screenUv).a, 0.0, 1.0);
            }
            float rb = rv;
            if (uHasRoofBlockMap > 0.5) {
              vec2 screenUvB = gl_FragCoord.xy / uScreenSize;
              rb = clamp(texture2D(uRoofBlockMap, screenUvB).a, 0.0, 1.0);
            }
            float hiddenBlock = rb * (1.0 - rv);
            hiddenBlock = smoothstep(0.02, 0.28, hiddenBlock);
            visibleMainAlpha *= (1.0 - hiddenBlock);
          }

          if (visibleMainAlpha <= 0.001) discard;

          vec3 c = treeSample.rgb;
          c *= texA;
          vec2 sceneUv = vegetationSceneUvFromWorld(vWorldPos);
${VEGETATION_LANDSCAPE_LIGHTNING_APPLY_GLSL}
${VEGETATION_CLOUD_SHADOW_APPLY_GLSL}
${VEGETATION_BUILDING_SHADOW_APPLY_GLSL}
${VEGETATION_PAINTED_SHADOW_APPLY_GLSL}
          if (uCcGradeEnabled > 0.5
              || abs(uExposure) + abs(uBrightness) + abs(uContrast - 1.0)
                 + abs(uSaturation - 1.0) + abs(uTemperature) + abs(uTint) > 0.0001) {
            c = applyVegetationColorGrade(c);
          }
          gl_FragColor = vec4(c * hf, visibleMainAlpha);
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
      name: 'TreeV2Shadow',
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

    const windSeg = windDisplacedMeshSegments(tileW, tileH, 0, 0, 1);
    const geometry = new THREE.PlaneGeometry(tileW, tileH, windSeg, windSeg);
    initClumpWindAttributesOnGeometry(geometry, centerX, centerY, 0);
    const shadowMesh = new THREE.Mesh(geometry, shadowMaterial);
    const mesh = new THREE.Mesh(geometry, material);
    shadowMesh.name = `TreeV2Shadow_${tileId}`;
    mesh.name = `TreeV2_${tileId}`;
    shadowMesh.frustumCulled = true;
    mesh.frustumCulled = true;
    shadowMesh.userData = shadowMesh.userData || {};
    mesh.userData = mesh.userData || {};
    mesh.userData.mapShineTreeTileId = tileId;
    shadowMesh.userData.mapShineTreeTileId = tileId;
    shadowMesh.userData.mapShineTreeGroundShadow = true;
    mesh.userData.mapShineTreeCanopy = true;
    shadowMesh.userData.floorIndex = floorIndex;
    mesh.userData.floorIndex = floorIndex;
    shadowMesh.position.set(centerX, centerY, z);
    mesh.position.set(centerX, centerY, z);
    shadowMesh.rotation.z = rotation;
    mesh.rotation.z = rotation;

    this._applyTreeOverlayRenderOrders(shadowMesh, mesh, tileId, floorIndex);
    applyVegetationAboveWaterLayer(shadowMesh, {});
    applyVegetationAboveWaterLayer(mesh, { retainWeatherRoofLayer: true });

    this._renderBus.addEffectOverlay(`${tileId}_tree_shadow`, shadowMesh, floorIndex);
    this._renderBus.addEffectOverlay(`${tileId}_tree`, mesh, floorIndex);
    const bounds = overlayWorldBounds(centerX, centerY, tileW, tileH);
    const maskLoadSerial = ++this._maskLoadSerial;
    const populateGen = this._populateGeneration;
    this._overlays.set(tileId, {
      mesh,
      shadowMesh,
      material,
      shadowMaterial,
      floorIndex,
      bounds,
      maskLoadSerial,
      maskReady: false,
    });
    mesh.visible = false;
    shadowMesh.visible = false;
    this._viewBoundsMayHaveChanged();

    // Load mask texture.
    const maskLoadQueue = getVegetationMaskLoadQueue(2);
    this._loader.load(url, (tex) => {
      if (populateGen !== this._populateGeneration) {
        try { tex.dispose(); } catch (_) {}
        return;
      }
      const entry = this._overlays.get(tileId);
      if (!entry
        || entry.maskLoadSerial !== maskLoadSerial
        || entry.material !== material
        || entry.shadowMaterial !== shadowMaterial) {
        try { tex.dispose(); } catch (_) {}
        return;
      }
      tex.flipY = true;
      // Tree masks carry visible color data, so sample in sRGB for correct contrast.
      if ('colorSpace' in tex && THREE?.SRGBColorSpace) tex.colorSpace = THREE.SRGBColorSpace;
      else if ('encoding' in tex && THREE?.sRGBEncoding) tex.encoding = THREE.sRGBEncoding;
      tex.needsUpdate = true;
      material.uniforms.uTreeMask.value = tex;
      shadowMaterial.uniforms.uTreeMask.value = tex;
      entry.maskReady = true;
      this._syncOverlayVisibility();
      maskLoadQueue.enqueue(() => {
        if (populateGen !== this._populateGeneration) return;
        const liveEntry = this._overlays.get(tileId);
        if (!liveEntry
          || liveEntry.maskLoadSerial !== maskLoadSerial
          || liveEntry.material !== material
          || liveEntry.shadowMaterial !== shadowMaterial) return;
        const maskRead = readMaskImageData(tex, VEGETATION_MASK_READ_MAX_DIM);
        const derive = maskRead
          ? detectDerivedAlphaFromImageData(maskRead.data, maskRead.width, maskRead.height)
          : false;
        this._deriveAlphaByTileId.set(tileId, derive);
        material.uniforms.uDeriveAlpha.value = derive ? 1.0 : 0.0;
        shadowMaterial.uniforms.uDeriveAlpha.value = derive ? 1.0 : 0.0;
        if (maskRead) {
          this._alphaSampleByTileId.set(
            tileId,
            buildAlphaSampleCache(maskRead.data, maskRead.width, maskRead.height),
          );
        }
        this._applyClumpCoordMapForOverlay(tileId, tex, derive, {
          centerX, centerY, tileW, tileH, rotation,
        }, maskRead);
        try {
          if (liveEntry?.shadowMesh && liveEntry?.mesh) {
            this._applyTreeOverlayRenderOrders(liveEntry.shadowMesh, liveEntry.mesh, tileId, floorIndex);
          }
        } catch (_) {}
      }).catch(() => {});
    }, undefined, (err) => {
      log.warn(`TreeEffectV2: failed to load mask for ${tileId}: ${url}`, err);
    });
  }

  _getSafeVisibleMaxFloorIndex() {
    const busIdx = Number(this._renderBus?._visibleMaxFloorIndex);
    const activeIdx = Number(window.MapShine?.floorStack?.getActiveFloor?.()?.index);
    if (Number.isFinite(busIdx)) return busIdx;
    if (Number.isFinite(activeIdx)) return activeIdx;
    return 0;
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
      const maskReady = entry.maskReady === true;
      const visible = floorOk && viewOk && maskReady;
      if (entry._lastSyncedVisible !== visible) {
        entry._lastSyncedVisible = visible;
        if (entry?.mesh) {
          entry.mesh.visible = visible;
          applyVegetationAboveWaterLayer(entry.mesh, { retainWeatherRoofLayer: true });
        }
        if (entry?.shadowMesh) {
          entry.shadowMesh.visible = visible;
          applyVegetationAboveWaterLayer(entry.shadowMesh, {});
        }
      }
    }
  }

  /**
   * After scene repopulate, drop hover-reveal stacking and restore shadow-under-canopy
   * render orders so a prior canopy hover cannot leave shadows painted on top.
   * @private
   */
  _resetAllOverlayHoverAndStacking() {
    this._hoverHidden = false;
    this._hoverFadeInProgress = false;
    const nowMs = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    this._suppressHoverRevealStackingUntilMs = nowMs + 750;
    for (const [tileId, entry] of this._overlays) {
      const hoverUniform = entry?.material?.uniforms?.uHoverFade;
      const shadowHoverUniform = entry?.shadowMaterial?.uniforms?.uHoverFade;
      const shadowCanopyFadeUniform = entry?.shadowMaterial?.uniforms?.uCanopyHoverFade;
      if (hoverUniform) hoverUniform.value = 1.0;
      if (shadowHoverUniform) shadowHoverUniform.value = 1.0;
      if (shadowCanopyFadeUniform) shadowCanopyFadeUniform.value = 1.0;
      if (entry?.shadowMesh && entry?.mesh) {
        this._applyTreeOverlayRenderOrders(entry.shadowMesh, entry.mesh, tileId, entry.floorIndex);
      }
    }
  }

  /**
   * During hover reveal, draw the shadow decal above the fading canopy so partial
   * alpha does not punch holes in the ground shadow. Restore normal stacking when
   * the canopy is fully visible again.
   * @param {{ mesh?: import('three').Mesh, shadowMesh?: import('three').Mesh, floorIndex?: number }} entry
   * @param {string} tileId
   * @param {number} hoverFade
   * @private
   */
  _applyTreeHoverRevealStacking(entry, tileId, hoverFade) {
    if (!entry?.shadowMesh || !entry?.mesh) return;
    const nowMs = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    if (nowMs < this._suppressHoverRevealStackingUntilMs) {
      this._applyTreeOverlayRenderOrders(entry.shadowMesh, entry.mesh, tileId, entry.floorIndex);
      return;
    }
    const hf = Number.isFinite(Number(hoverFade)) ? Number(hoverFade) : 1.0;
    if (hf < 0.999) {
      const fi = Number.isFinite(Number(entry.floorIndex)) ? Math.max(0, Number(entry.floorIndex)) : 0;
      const { canopyOrder } = treeOverlayRenderOrders(0, fi);
      entry.shadowMesh.renderOrder = canopyOrder + 0.005;
      return;
    }
    this._applyTreeOverlayRenderOrders(entry.shadowMesh, entry.mesh, tileId, entry.floorIndex);
  }

  /**
   * Tile-stack tree shadow/canopy orders: shadow always below its own canopy,
   * both capped at the reserved top-of-floor tree slots.
   * @param {import('three').Mesh} shadowM
   * @param {import('three').Mesh} canopyM
   * @param {string} tileId
   * @param {number} floorIndex
   * @private
   */
  _applyTreeOverlayRenderOrders(shadowM, canopyM, tileId, floorIndex) {
    try {
      const fi = Number.isFinite(Number(floorIndex)) ? Math.max(0, Number(floorIndex)) : 0;
      const isBgPlane = /^__bg_image__(?:|[1-9]\d*)$/.test(String(tileId));
      let baseOrder = null;
      if (isBgPlane) {
        baseOrder = tileAlbedoOrder(fi, 0);
      } else {
        const baseEntry = this._renderBus?._tiles?.get?.(tileId);
        const fromTile = Number(baseEntry?.mesh?.renderOrder);
        baseOrder = Number.isFinite(fromTile)
          ? fromTile
          : tileAlbedoOrder(fi, MAX_INTRA_ROLE_OFFSET);
      }
      const { shadowOrder, canopyOrder } = treeOverlayRenderOrders(baseOrder, fi);
      shadowM.renderOrder = shadowOrder;
      canopyM.renderOrder = canopyOrder;
    } catch (_) {}
  }
}
