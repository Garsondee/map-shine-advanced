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
import { tileHasLevelsRange, readTileLevelsFlags } from '../../foundry/levels-scene-flags.js';
import { weatherController } from '../../core/WeatherController.js';

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
     * @type {Map<string, {mesh: THREE.Mesh, material: THREE.ShaderMaterial, floorIndex: number}>}
     */
    this._overlays = new Map();

    /** @type {Set<string>} */
    this._negativeCache = new Set();

    /** @type {object|null} */
    this._sharedUniforms = null;

    // Derived-alpha support (some Bush masks can be authored as opaque RGB).
    /** @type {Map<string, boolean>} */
    this._deriveAlphaByTileId = new Map();

    // Temporal state (smoothed wind coupling)
    this._currentWindSpeed = 0.0;
    this._lastFrameTime = 0.0;

    // Public params (mirrors V1 schema / defaults)
    this.params = {
      enabled: true,
      intensity: undefined,

      // -- Wind Physics --
      windSpeedGlobal: 0.6,
      windRampSpeed: 2.93,
      gustFrequency: 0.01,
      gustSpeed: 0.52463,
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
      minRustleSpeed: 0.18,
      edgeFadeStart: 0.03,
      edgeFadeEnd: 0.14,

      // -- Bush Movement --
      branchBend: 0.037,
      elasticity: 5.0,

      // -- Leaf Flutter --
      flutterIntensity: 0.0014,
      flutterSpeed: 1.85362,
      flutterScale: 0.01133,

      // -- Color --
      exposure: 0.0,
      brightness: 0.0,
      contrast: 1.0,
      saturation: 1.0,
      temperature: 0.0,
      tint: 0.0,

      // Shadow params retained for UI parity (not applied in V2 yet)
      shadowOpacity: 0.4,
      shadowLength: 0.02,
      shadowSoftness: 5.0,
    };

    log.debug('BushEffectV2 created');
  }

  get enabled() { return this._enabled; }
  set enabled(v) {
    this._enabled = !!v;
    for (const entry of this._overlays.values()) {
      entry.mesh.visible = this._enabled;
    }
    if (this._sharedUniforms?.uEffectEnabled) {
      this._sharedUniforms.uEffectEnabled.value = this._enabled;
    }
  }

  static getControlSchema() {
    return {
      enabled: true,
      groups: [
        {
          name: 'bush-phys',
          label: 'Wind Physics',
          type: 'inline',
          parameters: ['windSpeedGlobal', 'windRampSpeed', 'gustFrequency', 'gustSpeed', 'waveSpatialFrequency', 'waveTravelSpeed', 'waveSharpness', 'waveInfluence', 'minRustleSpeed', 'branchBend', 'elasticity']
        },
        {
          name: 'bush-flutter',
          label: 'Leaf Flutter',
          type: 'inline',
          parameters: ['flutterIntensity', 'flutterSpeed', 'flutterScale']
        },
        {
          name: 'bush-response',
          label: 'Response Curves',
          type: 'folder',
          parameters: [
            'ambientMotion', 'rustleFloorScale',
            'flutterBaseDrive', 'flutterWindStart', 'flutterWindFull', 'flutterLowWindBoost', 'flutterLowWindFadeEnd', 'flutterGustFloor',
            'bendMinStrength', 'bendWindStart', 'bendWindFull'
          ]
        },
        {
          name: 'bush-color',
          label: 'Color',
          type: 'folder',
          parameters: ['exposure', 'brightness', 'contrast', 'saturation', 'temperature', 'tint']
        },
        {
          name: 'bush-shadow',
          label: 'Shadow',
          type: 'inline',
          parameters: ['shadowOpacity', 'shadowLength', 'shadowSoftness']
        },
        {
          name: 'bush-edges',
          label: 'Edge Safety',
          type: 'inline',
          parameters: ['edgeFadeStart', 'edgeFadeEnd']
        }
      ],
      parameters: {
        intensity: { type: 'slider', min: 0.0, max: 2.0, default: undefined },
        windSpeedGlobal: { type: 'slider', label: 'Wind Strength', min: 0.0, max: 3.0, default: 0.6 },
        windRampSpeed: { type: 'slider', label: 'Wind Responsiveness', min: 0.1, max: 10.0, default: 2.93 },
        gustFrequency: { type: 'slider', label: 'Gust Frequency', min: 0.0, max: 0.05, step: 0.0001, default: 0.01 },
        gustSpeed: { type: 'slider', label: 'Gust Speed', min: 0.0, max: 2.0, step: 0.0001, default: 0.52463 },
        waveSpatialFrequency: { type: 'slider', label: 'Wave Spacing', min: 0.0001, max: 0.01, step: 0.0001, default: 0.0018 },
        waveTravelSpeed: { type: 'slider', label: 'Wave Travel Speed', min: 0.05, max: 4.0, default: 0.85 },
        waveSharpness: { type: 'slider', label: 'Wave Crest Sharpness', min: 0.5, max: 6.0, default: 2.2 },
        waveInfluence: { type: 'slider', label: 'Wave Influence', min: 0.0, max: 1.0, default: 0.65 },
        ambientMotion: { type: 'slider', label: 'Ambient Motion', min: 0.0, max: 0.35, step: 0.005, default: 0.1 },
        rustleFloorScale: { type: 'slider', label: 'Rustle Floor Scale', min: 0.0, max: 1.0, step: 0.01, default: 0.25 },
        flutterBaseDrive: { type: 'slider', label: 'Flutter Base Drive', min: 0.0, max: 1.0, step: 0.01, default: 0.3 },
        flutterWindStart: { type: 'slider', label: 'Flutter Wind Start', min: 0.0, max: 0.4, step: 0.01, default: 0.0 },
        flutterWindFull: { type: 'slider', label: 'Flutter Wind Full', min: 0.01, max: 0.6, step: 0.01, default: 0.12 },
        flutterLowWindBoost: { type: 'slider', label: 'Flutter Low-Wind Boost', min: 1.0, max: 2.5, step: 0.01, default: 1.35 },
        flutterLowWindFadeEnd: { type: 'slider', label: 'Flutter Boost Fade End', min: 0.05, max: 1.0, step: 0.01, default: 0.35 },
        flutterGustFloor: { type: 'slider', label: 'Flutter Gust Floor', min: 0.0, max: 1.0, step: 0.01, default: 0.35 },
        bendMinStrength: { type: 'slider', label: 'Bend Min Strength', min: 0.0, max: 1.0, step: 0.01, default: 0.2 },
        bendWindStart: { type: 'slider', label: 'Bend Wind Start', min: 0.0, max: 0.8, step: 0.01, default: 0.22 },
        bendWindFull: { type: 'slider', label: 'Bend Wind Full', min: 0.1, max: 1.0, step: 0.01, default: 0.78 },
        minRustleSpeed: { type: 'slider', label: 'Low-Wind Rustle Floor', min: 0.0, max: 0.6, default: 0.18 },
        branchBend: { type: 'slider', label: 'Branch Bend', min: 0.0, max: 0.05, step: 0.001, default: 0.037 },
        elasticity: { type: 'slider', label: 'Springiness', min: 0.5, max: 5.0, default: 5.0 },
        flutterIntensity: { type: 'slider', label: 'Leaf Flutter Amount', min: 0.0, max: 0.005, step: 0.0001, default: 0.0014 },
        flutterSpeed: { type: 'slider', label: 'Leaf Flutter Speed', min: 1.0, max: 20.0, default: 1.85 },
        flutterScale: { type: 'slider', label: 'Leaf Cluster Size', min: 0.005, max: 0.1, default: 0.01 },
        exposure: { type: 'slider', min: -2.0, max: 2.0, default: 0.0 },
        brightness: { type: 'slider', min: -0.5, max: 0.5, default: 0.0 },
        contrast: { type: 'slider', min: 0.5, max: 2.0, default: 1.0 },
        saturation: { type: 'slider', min: 0.0, max: 2.0, default: 1.0 },
        temperature: { type: 'slider', min: -1.0, max: 1.0, default: 0.0 },
        tint: { type: 'slider', min: -1.0, max: 1.0, default: 0.0 },
        shadowOpacity: { type: 'slider', label: 'Shadow Opacity', min: 0.0, max: 1.0, default: 0.4 },
        shadowLength: { type: 'slider', label: 'Shadow Length', min: 0.0, max: 0.1, default: 0.02 },
        shadowSoftness: { type: 'slider', label: 'Shadow Softness', min: 0.5, max: 5.0, default: 5.0 },
        edgeFadeStart: { type: 'slider', label: 'Edge Fade Start', min: 0.0, max: 0.2, default: 0.03 },
        edgeFadeEnd: { type: 'slider', label: 'Edge Fade End', min: 0.02, max: 0.4, default: 0.14 }
      }
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

  async populate(foundrySceneData) {
    if (!this._initialized) return;
    this.clear();

    const floors = window.MapShine?.floorStack?.getFloors() ?? [];
    const worldH = Number(foundrySceneData?.height) || 0;

    // Background first
    const bgSrc = canvas?.scene?.background?.src ?? '';
    if (bgSrc) {
      const basePath = bgSrc.replace(/\.[^.]+$/, '');
      const url = await this._probeMask(basePath, '_Bush');
      if (url) {
        const centerX = Number(foundrySceneData?.sceneX ?? 0) + Number(foundrySceneData?.sceneWidth ?? 0) / 2;
        const centerY = worldH - (Number(foundrySceneData?.sceneY ?? 0) + Number(foundrySceneData?.sceneHeight ?? 0) / 2);
        const tileW = Number(foundrySceneData?.sceneWidth ?? 0);
        const tileH = Number(foundrySceneData?.sceneHeight ?? 0);
        const z = GROUND_Z - 1 + BUSH_Z_OFFSET;
        this._createOverlay('__bg_image__', 0, { url, centerX, centerY, z, tileW, tileH, rotation: 0 });
      }
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

    log.info(`BushEffectV2 populated: ${this._overlays.size} overlays`);
  }

  update(timeInfo) {
    if (!this._enabled || !this._initialized) return;

    const time = Number.isFinite(timeInfo?.elapsed)
      ? Number(timeInfo.elapsed)
      : Number(timeInfo?.time ?? 0);
    const delta = Number.isFinite(timeInfo?.delta)
      ? Number(timeInfo.delta)
      : 0.016;

    // Wind coupling — use WeatherController's smoothed state.
    const weather = weatherController?.currentState;
    const windDir = weather?.windDirection;
    const windSpeed01 = Number(weather?.windSpeed ?? 0);

    // Smooth wind speed to avoid snapping.
    const ramp = Math.max(0.001, Number(this.params.windRampSpeed ?? 1));
    const lerpT = Math.min(1.0, delta * ramp);
    this._currentWindSpeed = this._currentWindSpeed + (windSpeed01 - this._currentWindSpeed) * lerpT;

    this._syncSceneBoundsUniforms();

    // Update shared uniforms.
    if (this._sharedUniforms) {
      this._sharedUniforms.uTime.value = time;
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

    this._lastFrameTime = time;
  }

  onFloorChange(_maxFloorIndex) {
    // Bus overlay visibility is handled by FloorRenderBus.setVisibleFloors().
  }

  wantsContinuousRender() {
    return this._enabled && this._initialized && this._overlays.size > 0;
  }

  onResize(_w, _h) {
    // No RTs.
  }

  clear() {
    for (const [tileId, entry] of this._overlays) {
      this._renderBus.removeEffectOverlay(`${tileId}_bush`);
      entry.material.dispose();
      entry.mesh.geometry.dispose();
      const tex = entry.material.uniforms.uBushMask?.value;
      if (tex && tex.dispose) {
        try { tex.dispose(); } catch (_) {}
      }
    }
    this._overlays.clear();
    this._deriveAlphaByTileId.clear();
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
      uEffectEnabled: { value: this._enabled },
      uBushMask: { value: null },
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
    } catch (err) {
      this._negativeCache.add(basePath);
      return null;
    }
  }

  _resolveFloorIndex(tileDoc, floors) {
    if (!floors || floors.length <= 1) return 0;
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
      uBushMask: { value: null },
      uDeriveAlpha: { value: 0.0 },
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
        uniform sampler2D uBushMask;
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

          vec2 gustPos = vWorldPos * uGustFrequency;
          vec2 scroll = windDir * uTime * uGustSpeed * rustleSpeed;
          float gustNoise = noise(gustPos - scroll);
          float gustStrength = smoothstep(0.2, 0.8, gustNoise);

          float waveCoord = dot(vWorldPos, windDir);
          float wavePhase = waveCoord * uWaveSpatialFrequency - uTime * uWaveTravelSpeed * (0.35 + rustleSpeed);
          float waveCarrier = 0.5 + 0.5 * sin(wavePhase);
          float waveFront = pow(clamp(waveCarrier, 0.0, 1.0), max(0.1, uWaveSharpness));
          float waveMod = mix(1.0, waveFront, clamp(uWaveInfluence, 0.0, 1.0));

          vec2 perpDir = vec2(-windDir.y, windDir.x);
          float orbitPhase = uTime * uElasticity + (gustNoise * 5.0);
          float orbitSway = sin(orbitPhase);

          float bendStrength = (uBendMinStrength + (1.0 - uBendMinStrength) * rawWind) * bendDrive;
          float pushMagnitude = gustStrength * uBranchBend * effectiveSpeed * waveMod * bendStrength;
          float swayMagnitude = orbitSway * (uBranchBend * 0.4) * effectiveSpeed * (0.5 + 0.5 * gustStrength) * (0.65 + 0.35 * waveMod) * bendStrength;

          float noiseVal = noise(vWorldPos * uFlutterScale);
          float flutterPhase = uTime * uFlutterSpeed * (0.85 + rustleSpeed) + noiseVal * 6.28;
          float flutter = sin(flutterPhase);
          float lowWindBoost = mix(uFlutterLowWindBoost, 1.0, smoothstep(0.04, max(0.041, uFlutterLowWindFadeEnd), rawWind));
          float gustFlutter = uFlutterGustFloor + (1.0 - uFlutterGustFloor) * gustStrength;
          float flutterMagnitude = flutter * uFlutterIntensity * gustFlutter * lowWindBoost * flutterDrive * (0.6 + 0.4 * waveMod);
          vec2 flutterVec = (perpDir * flutterMagnitude) + (windDir * (flutterMagnitude * 0.35));

          vec2 distortion = (windDir * pushMagnitude)
                          + (perpDir * swayMagnitude)
                          + flutterVec;

          vec2 sceneSpan = max(uSceneMax - uSceneMin, vec2(1e-3));
          vec2 sceneUv = clamp((vWorldPos - uSceneMin) / sceneSpan, 0.0, 1.0);
          float edgeDist = min(min(sceneUv.x, 1.0 - sceneUv.x), min(sceneUv.y, 1.0 - sceneUv.y));
          float edgeFade = smoothstep(0.0, max(uEdgeFadeStart + 1e-4, uEdgeFadeEnd), edgeDist);
          distortion *= edgeFade;

          vec2 shadowDir = normalize(vec2(uSunDir.x, -uSunDir.y));
          if (length(shadowDir) < 0.01) shadowDir = -windDir;
          vec2 shadowOffset = shadowDir * uShadowLength;
          float shadowBlur = max(0.0001, uShadowSoftness * 0.0008);
          vec2 shadowBaseUv = vUv - distortion - shadowOffset;
          vec2 step1 = vec2(shadowBlur);
          vec2 step2 = step1 * 2.0;

          // Kawase-style multi-ring taps: center + near diagonals + far axis + far diagonals.
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
          shadowA *= clamp(uShadowOpacity, 0.0, 1.0) * uIntensity * edgeFade;

          vec4 bushSample = texture2D(uBushMask, vUv - distortion);
          float mainAlpha = safeAlpha(bushSample) * uIntensity;
          float shadowOnlyAlpha = shadowA * (1.0 - clamp(mainAlpha, 0.0, 1.0));
          float finalAlpha = clamp(mainAlpha + shadowOnlyAlpha, 0.0, 1.0);
          if (finalAlpha <= 0.001) discard;

          float ccDelta = abs(uExposure) + abs(uBrightness) + abs(uContrast - 1.0)
                        + abs(uSaturation - 1.0) + abs(uTemperature) + abs(uTint);
          vec3 color = bushSample.rgb;
          if (ccDelta > 0.0001) color = applyCC(color);
          vec3 finalColor = mix(vec3(0.0), color, mainAlpha / max(finalAlpha, 1e-4));
          gl_FragColor = vec4(finalColor, finalAlpha);
        }
      `,
      transparent: true,
      depthWrite: false,
      depthTest: false,
      side: THREE.DoubleSide,
      blending: THREE.NormalBlending,
    });

    const geometry = new THREE.PlaneGeometry(tileW, tileH);
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = `BushV2_${tileId}`;
    mesh.frustumCulled = false;
    mesh.position.set(centerX, centerY, z);
    mesh.rotation.z = rotation;

    // Tie render order to base tile when possible.
    try {
      const baseEntry = this._renderBus?._tiles?.get?.(tileId);
      const baseOrder = Number(baseEntry?.mesh?.renderOrder);
      if (Number.isFinite(baseOrder)) mesh.renderOrder = baseOrder + 2;
    } catch (_) {}

    this._renderBus.addEffectOverlay(`${tileId}_bush`, mesh, floorIndex);
    this._overlays.set(tileId, { mesh, material, floorIndex });

    // Load mask texture.
    this._loader.load(url, (tex) => {
      tex.flipY = true;
      // Bush masks carry visible color data, so sample in sRGB for correct contrast.
      if ('colorSpace' in tex && THREE?.SRGBColorSpace) tex.colorSpace = THREE.SRGBColorSpace;
      else if ('encoding' in tex && THREE?.sRGBEncoding) tex.encoding = THREE.sRGBEncoding;
      tex.needsUpdate = true;
      if (this._overlays.has(tileId)) {
        material.uniforms.uBushMask.value = tex;
        const derive = this._detectDerivedAlpha(tex);
        this._deriveAlphaByTileId.set(tileId, derive);
        material.uniforms.uDeriveAlpha.value = derive ? 1.0 : 0.0;
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
}
