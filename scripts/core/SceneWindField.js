/**
 * @fileoverview Spatial scene wind field — traveling gust fronts with lulls on top of WeatherController.
 * Compass owns base speed/direction/gustiness; this module owns propagation, gaps, and consumer coupling.
 * @module core/SceneWindField
 */

import { weatherController, WeatherController } from './WeatherController.js';
import { windDirFromBearingDeg } from '../compositor-v2/effects/resolve-effect-wind.js';

const MAX_WIND_MS = WeatherController.MAX_WIND_MS;

/** @param {number} edge0 @param {number} edge1 @param {number} x */
function smoothstep(edge0, edge1, x) {
  const t = Math.max(0, Math.min(1, (x - edge0) / Math.max(1e-6, edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

/**
 * CPU mirror of {@link VEGETATION_SCENE_WIND_STRENGTH_GLSL}.
 * @param {number} worldX
 * @param {number} worldY
 * @param {object} params
 * @param {number} wavePhase
 * @returns {number}
 */
export function computeSceneWindStrength(worldX, worldY, params, wavePhase) {
  if (params?.enabled === false) return 1.0;
  const dirX = Number(params._dirXThree) || 1;
  const dirY = Number(params._dirYThree) || 0;
  const len = Math.hypot(dirX, dirY);
  const nx = len > 1e-6 ? dirX / len : 1;
  const ny = len > 1e-6 ? dirY / len : 0;
  const along = worldX * nx + worldY * ny;
  const spatialFreq = Math.max(1e-6, Number(params.waveSpatialFrequency) || 0.0014);
  const sharpness = Math.max(0.1, Number(params.waveSharpness) || 2.5);
  const gapRatio = Math.max(0, Math.min(0.95, Number(params.gapRatio) ?? 0.55));
  const gapSoftness = Math.max(0.001, Number(params.gapSoftness) ?? 0.04);
  const carrier = 0.5 + 0.5 * Math.sin(along * spatialFreq - wavePhase);
  const peak = Math.pow(Math.max(0, carrier), sharpness);
  const threshold = 1.0 - gapRatio;
  const softness = gapSoftness * (0.35 + 0.65 * gapRatio);
  const spatial = smoothstep(threshold, threshold + softness, peak);
  const floorVal = Math.max(0, Math.min(0.95, Number(params.spatialFloor) || 0));
  return floorVal + (1.0 - floorVal) * spatial;
}

export class SceneWindField {
  constructor() {
    /** @type {boolean} */
    this.initialized = false;

    /** @type {object} */
    this.params = {
      enabled: true,
      waveSpatialFrequency: 0.0014,
      waveTravelSpeed: 0.7,
      waveSharpness: 3.5,
      gapRatio: 0.55,
      gapSoftness: 0.04,
      directionEvolutionScale: 1.0,
      // Cloud drift (defaults match CloudEffectV2)
      windInfluence: 1.33,
      driftSpeed: 0.061,
      minDriftSpeed: 0.002,
      driftResponsiveness: 0.75,
      driftDecelFactor: 0.14,
      driftMaxSpeed: 0.5,
      // Water coupling
      windDirResponsiveness: 10,
      windOverrideEnabled: true,
      windOverrideBearingDeg: 90,
      windOverrideSpeed01: 0.2,
      // Vegetation response
      windResponse: 0.06,
      windRampSpeed: 1.32,
      clumpWaveEnabled: true,
      clumpWaveMix: 1.0,
      vegetationWaveInfluence: 1.0,
      windAttackRamp: 2.5,
      windDecayRamp: 0.88,
      bendRiseSoftness: 0.35,
      // Profile tuning multipliers (authoring — GM uses astrolabe slider only)
      gapRatioTune: 1.0,
      gapSoftnessTune: 1.0,
      spatialFloorTune: 1.0,
      stormSwingTune: 1.0,
      waveSharpnessTune: 1.0,
      // Particles & rain
      fireWindInfluence: 0.7,
      fireWeatherWindKill: 0.9,
      fogAdvectionSpeed: 1.7,
      fogWindDirResponsiveness: 6.0,
      rainWindInfluence: 2.3,
      snowWindInfluence: 0.85,
    };

    /** @type {import('./wind-profile.js').ReturnType<import('./wind-profile.js').deriveWindProfile>|null} */
    this._activeProfile = null;

    /** @private Effective runtime params merged from profile + tuning. */
    this._runtime = {
      gapRatio: 0.55,
      gapSoftness: 0.04,
      waveSharpness: 3.5,
      spatialFloor: 0.0,
      cloudLullSurplus: 0.55,
      bendWindStart: 0.22,
      flutterLowWindBoost: 1.0,
    };

    /** @private */
    this._wavePhase = 0;
    /** @private */
    this._dirXThree = 1;
    /** @private */
    this._dirYThree = 0;
    /** @private */
    this._speed01 = 0;
    /** @private cached for getUniforms */
    this._uniforms = {
      uSceneWindEnabled: 1.0,
      uSceneWindSpatialFreq: 0.0014,
      uSceneWindWavePhase: 0,
      uSceneWindSharpness: 2.5,
      uSceneWindGapRatio: 0.4,
      uSceneWindGapSoftness: 0.12,
      uSceneWindStrengthFloor: 0.0,
      uBendRiseSoftness: 0.35,
    };
  }

  /** @returns {import('./wind-profile.js').ReturnType<import('./wind-profile.js').deriveWindProfile>|null} */
  getActiveProfile() {
    return this._activeProfile;
  }

  /**
   * Merge astrolabe wind profile with scene authoring tuners.
   * @param {ReturnType<import('./wind-profile.js').deriveWindProfile>} profile
   */
  applyWindProfile(profile) {
    if (!profile) return;
    this._activeProfile = profile;
    const p = this.params;
    const clampTune = (v, fb = 1) => {
      const n = Number(v);
      return Number.isFinite(n) ? Math.max(0.05, Math.min(3, n)) : fb;
    };

    this._runtime.gapRatio = Math.max(0, Math.min(0.95,
      profile.gapRatio * clampTune(p.gapRatioTune)));
    this._runtime.gapSoftness = Math.max(0.01, Math.min(0.5,
      profile.gapSoftness * clampTune(p.gapSoftnessTune)));
    this._runtime.waveSharpness = Math.max(0.5, Math.min(8,
      profile.waveSharpness * clampTune(p.waveSharpnessTune)));
    this._runtime.spatialFloor = Math.max(0, Math.min(0.95,
      profile.spatialFloor * clampTune(p.spatialFloorTune)));
    this._runtime.cloudLullSurplus = profile.cloudLullSurplus;
    this._runtime.bendWindStart = profile.bendWindStart;
    this._runtime.flutterLowWindBoost = profile.flutterBias;

    this._activeProfile = {
      ...profile,
      stormSwingRad: profile.stormSwingRad * clampTune(p.stormSwingTune),
    };

    this._refreshUniformCache();
    this.propagateToConsumers();
  }

  initialize() {
    this.initialized = true;
    this._syncFromWeather();
    this._refreshUniformCache();
  }

  /** @private */
  _isExternallyDriven() {
    try {
      return window.MapShine?.environmentControlApi?.isExternallyDriven?.() === true;
    } catch (_) {
      return false;
    }
  }

  /** @private */
  _syncFromWeather() {
    const ws = weatherController?.getCurrentState?.() ?? weatherController?.currentState;
    if (!ws) return;
    const wx = Number(ws.windDirection?.x);
    const wy = Number(ws.windDirection?.y);
    if (Number.isFinite(wx) && Number.isFinite(wy)) {
      const len = Math.hypot(wx, wy);
      if (len > 1e-6) {
        this._dirXThree = wx / len;
        this._dirYThree = -wy / len;
      }
    }
    const wvMS = Number(ws.windSpeedMS);
    const wv01 = Number(ws.windSpeed);
    if (Number.isFinite(wvMS)) {
      this._speed01 = Math.max(0, Math.min(1, wvMS / MAX_WIND_MS));
    } else if (Number.isFinite(wv01)) {
      this._speed01 = Math.max(0, Math.min(1, wv01));
    }
    this.params._dirXThree = this._dirXThree;
    this.params._dirYThree = this._dirYThree;
  }

  /** @private */
  _refreshUniformCache() {
    const p = this.params;
    const rt = this._runtime;
    this._uniforms.uSceneWindEnabled = p.enabled !== false ? 1.0 : 0.0;
    this._uniforms.uSceneWindSpatialFreq = Math.max(1e-6, Number(p.waveSpatialFrequency) || 0.0014);
    this._uniforms.uSceneWindWavePhase = this._wavePhase;
    this._uniforms.uSceneWindSharpness = Math.max(0.1, Number(rt.waveSharpness) || Number(p.waveSharpness) || 2.5);
    this._uniforms.uSceneWindGapRatio = Math.max(0, Math.min(0.95, Number(rt.gapRatio) ?? Number(p.gapRatio) ?? 0.4));
    this._uniforms.uSceneWindGapSoftness = Math.max(0.001, Number(rt.gapSoftness) ?? Number(p.gapSoftness) ?? 0.12);
    this._uniforms.uSceneWindStrengthFloor = Math.max(0, Math.min(0.95, Number(rt.spatialFloor) || 0));
    this._uniforms.uBendRiseSoftness = Math.max(0.05, Math.min(1, Number(p.bendRiseSoftness) ?? 0.35));
  }

  /**
   * @param {number} delta
   * @param {number} [time]
   */
  update(delta = 0.016, time = 0) {
    if (!this.initialized) this.initialize();
    this._syncFromWeather();

    if (!this._isExternallyDriven() && this.params.enabled !== false) {
      const travel = Math.max(0, Number(this.params.waveTravelSpeed) || 0.7);
      const phaseDelta = Math.min(0.25, Math.max(0, delta));
      const speedScale = 0.35 + this._speed01 * 0.65;
      this._wavePhase += phaseDelta * travel * speedScale;
    }

    this._refreshUniformCache();
    void time;
  }

  /**
   * Foundry-space base wind from WeatherController.
   * @returns {{ dirX: number, dirY: number, speed01: number }}
   */
  getBaseWind() {
    this._syncFromWeather();
    const len = Math.hypot(this._dirXThree, this._dirYThree);
    return {
      dirX: len > 1e-6 ? this._dirXThree / len : 1,
      dirY: len > 1e-6 ? -this._dirYThree / len : 0,
      speed01: this._speed01,
    };
  }

  /**
   * Sample spatial wind at world XY (Three Y-up).
   * @param {number} x
   * @param {number} y
   * @returns {{ strength01: number, dirX: number, dirY: number, inLull: boolean, wavePhase: number }}
   */
  getSampleWorld(x, y) {
    const sampleParams = {
      ...this.params,
      gapRatio: this._runtime.gapRatio,
      gapSoftness: this._runtime.gapSoftness,
      waveSharpness: this._runtime.waveSharpness,
      spatialFloor: this._runtime.spatialFloor,
      _dirXThree: this._dirXThree,
      _dirYThree: this._dirYThree,
    };
    const spatial = computeSceneWindStrength(x, y, sampleParams, this._wavePhase);
    const strength01 = this._speed01 * spatial;
    return {
      strength01,
      spatial01: spatial,
      dirX: this._dirXThree,
      dirY: this._dirYThree,
      inLull: spatial < 0.08,
      wavePhase: this._wavePhase,
    };
  }

  /** @returns {typeof this._uniforms} */
  getUniforms() {
    return this._uniforms;
  }

  /**
   * @param {string} paramId
   * @param {unknown} value
   */
  applyParamChange(paramId, value) {
    if (!Object.prototype.hasOwnProperty.call(this.params, paramId)) return;
    this.params[paramId] = value;
    if (this._activeProfile) {
      this.applyWindProfile(this._activeProfile);
    } else {
      this._refreshUniformCache();
    }
  }

  /**
   * Push coupling params to bound FloorCompositor effects.
   * @param {object|null} fc
   */
  propagateToConsumers(fc) {
    if (!fc) {
      try {
        fc = window.MapShine?.effectComposer?._floorCompositorV2 ?? null;
      } catch (_) {
        fc = null;
      }
    }
    if (!fc) return;
    const p = this.params;

    const cloud = fc._cloudEffect;
    if (cloud?.params) {
      cloud.params.windInfluence = p.windInfluence;
      cloud.params.driftSpeed = p.driftSpeed;
      cloud.params.minDriftSpeed = p.minDriftSpeed;
      cloud.params.driftResponsiveness = p.driftResponsiveness;
      cloud.params.driftDecelFactor = p.driftDecelFactor;
      cloud.params.driftMaxSpeed = p.driftMaxSpeed;
    }

    const ashCloud = fc._ashCloudEffect;
    if (ashCloud?.params) {
      ashCloud.params.windInfluence = p.windInfluence;
      ashCloud.params.driftSpeed = p.driftSpeed;
      ashCloud.params.minDriftSpeed = p.minDriftSpeed;
      ashCloud.params.driftResponsiveness = p.driftResponsiveness;
      ashCloud.params.driftDecelFactor = p.driftDecelFactor;
      ashCloud.params.driftMaxSpeed = p.driftMaxSpeed;
    }

    const water = fc._waterEffect;
    if (water?.params) {
      water.params.windDirResponsiveness = p.windDirResponsiveness;
      water.params.windOverrideEnabled = p.windOverrideEnabled;
      water.params.windOverrideBearingDeg = p.windOverrideBearingDeg;
      water.params.windOverrideSpeed01 = p.windOverrideSpeed01;
    }

    for (const key of ['_treeEffect', '_bushEffect']) {
      const veg = fc[key];
      if (!veg?.params) continue;
      veg.params.windSpeedGlobal = p.windResponse;
      veg.params.windRampSpeed = p.windRampSpeed;
      veg.params.clumpWaveEnabled = p.clumpWaveEnabled;
      veg.params.clumpWaveMix = p.clumpWaveMix;
      veg.params.waveSpatialFrequency = p.waveSpatialFrequency;
      veg.params.waveTravelSpeed = p.waveTravelSpeed;
      veg.params.waveSharpness = p.waveSharpness;
      veg.params.waveInfluence = p.vegetationWaveInfluence;
      veg.params.windAttackRamp = p.windAttackRamp;
      veg.params.windDecayRamp = p.windDecayRamp;
      if (typeof veg._syncWindUniforms === 'function') {
        veg._syncWindUniforms();
      }
    }

    const fire = fc._fireEffect;
    if (fire?.params) {
      fire.params.windInfluence = p.fireWindInfluence;
      fire.params.weatherWindKill = p.fireWeatherWindKill;
    }

    const fog = fc._atmosphericFogEffect;
    if (fog?.params) {
      fog.params.advectionSpeed = p.fogAdvectionSpeed;
      fog.params.windDirResponsiveness = p.fogWindDirResponsiveness;
    }

    try {
      if (weatherController) {
        if (!weatherController.rainTuning) weatherController.rainTuning = {};
        if (!weatherController.snowTuning) weatherController.snowTuning = {};
        weatherController.rainTuning.windInfluence = Number(p.rainWindInfluence) || 0;
        weatherController.snowTuning.windInfluence = Number(p.snowWindInfluence) || 0;
      }
    } catch (_) {}
  }

  /**
   * Seed scene-wind params from legacy effect defaults on first load.
   * @param {object|null} fc
   */
  migrateFromConsumers(fc) {
    if (!fc) return;
    const p = this.params;
    const cloud = fc._cloudEffect?.params;
    if (cloud) {
      if (cloud.windInfluence != null) p.windInfluence = cloud.windInfluence;
      if (cloud.driftSpeed != null) p.driftSpeed = cloud.driftSpeed;
      if (cloud.minDriftSpeed != null) p.minDriftSpeed = cloud.minDriftSpeed;
      if (cloud.driftResponsiveness != null) p.driftResponsiveness = cloud.driftResponsiveness;
      if (cloud.driftDecelFactor != null) p.driftDecelFactor = cloud.driftDecelFactor;
      if (cloud.driftMaxSpeed != null) p.driftMaxSpeed = cloud.driftMaxSpeed;
    }
    const water = fc._waterEffect?.params;
    if (water) {
      if (water.windDirResponsiveness != null) p.windDirResponsiveness = water.windDirResponsiveness;
      if (water.windOverrideEnabled != null) p.windOverrideEnabled = water.windOverrideEnabled;
      if (water.windOverrideBearingDeg != null) p.windOverrideBearingDeg = water.windOverrideBearingDeg;
      if (water.windOverrideSpeed01 != null) p.windOverrideSpeed01 = water.windOverrideSpeed01;
    }
    const tree = fc._treeEffect?.params;
    if (tree) {
      if (tree.windSpeedGlobal != null) p.windResponse = tree.windSpeedGlobal;
      if (tree.windRampSpeed != null) p.windRampSpeed = tree.windRampSpeed;
      if (tree.clumpWaveEnabled != null) p.clumpWaveEnabled = tree.clumpWaveEnabled;
      if (tree.clumpWaveMix != null) p.clumpWaveMix = tree.clumpWaveMix;
      if (tree.waveSpatialFrequency != null) p.waveSpatialFrequency = tree.waveSpatialFrequency;
      if (tree.waveTravelSpeed != null) p.waveTravelSpeed = tree.waveTravelSpeed;
      if (tree.waveSharpness != null) p.waveSharpness = tree.waveSharpness;
      if (tree.waveInfluence != null) p.vegetationWaveInfluence = tree.waveInfluence;
    }
    const fire = fc._fireEffect?.params;
    if (fire) {
      if (fire.windInfluence != null) p.fireWindInfluence = fire.windInfluence;
      if (fire.weatherWindKill != null) p.fireWeatherWindKill = fire.weatherWindKill;
    }
    const fog = fc._atmosphericFogEffect?.params;
    if (fog) {
      if (fog.advectionSpeed != null) p.fogAdvectionSpeed = fog.advectionSpeed;
      if (fog.windDirResponsiveness != null) p.fogWindDirResponsiveness = fog.windDirResponsiveness;
    }
    try {
      if (weatherController?.rainTuning?.windInfluence != null) {
        p.rainWindInfluence = weatherController.rainTuning.windInfluence;
      }
      if (weatherController?.snowTuning?.windInfluence != null) {
        p.snowWindInfluence = weatherController.snowTuning.windInfluence;
      }
    } catch (_) {}
    this._refreshUniformCache();
  }

  static getControlSchema() {
    return {
      enabled: true,
      groups: [
        {
          name: 'help',
          label: 'About',
          type: 'inline',
          parameters: [],
        },
        {
          name: 'profile-tuning',
          label: 'Wind Profile Tuning',
          type: 'inline',
          parameters: [
            'gapRatioTune',
            'gapSoftnessTune',
            'spatialFloorTune',
            'stormSwingTune',
            'waveSharpnessTune',
            'windAttackRamp',
            'windDecayRamp',
            'bendRiseSoftness',
          ],
        },
        {
          name: 'propagation',
          label: 'Propagation & Gaps',
          type: 'inline',
          parameters: [
            'waveSpatialFrequency',
            'waveTravelSpeed',
            'waveSharpness',
            'gapRatio',
            'gapSoftness',
            'directionEvolutionScale',
          ],
        },
        {
          name: 'cloud-drift',
          label: 'Cloud Drift',
          type: 'inline',
          separator: true,
          parameters: [
            'windInfluence',
            'driftSpeed',
            'minDriftSpeed',
            'driftResponsiveness',
            'driftDecelFactor',
            'driftMaxSpeed',
          ],
        },
        {
          name: 'water-coupling',
          label: 'Water Coupling',
          type: 'folder',
          expanded: false,
          separator: true,
          parameters: [
            'windDirResponsiveness',
            'windOverrideEnabled',
            'windOverrideBearingDeg',
            'windOverrideSpeed01',
          ],
        },
        {
          name: 'vegetation-response',
          label: 'Vegetation Response',
          type: 'inline',
          separator: true,
          parameters: [
            'windResponse',
            'windRampSpeed',
            'vegetationWaveInfluence',
            'clumpWaveEnabled',
            'clumpWaveMix',
          ],
        },
        {
          name: 'particles-rain',
          label: 'Particles & Rain',
          type: 'folder',
          expanded: false,
          separator: true,
          parameters: [
            'fireWindInfluence',
            'fireWeatherWindKill',
            'fogAdvectionSpeed',
            'fogWindDirResponsiveness',
            'rainWindInfluence',
            'snowWindInfluence',
          ],
        },
      ],
      parameters: {
        gapRatioTune: {
          type: 'slider',
          label: 'Gap ratio tune',
          min: 0.2,
          max: 2.0,
          step: 0.01,
          default: 1.0,
          tooltip: 'Scales astrolabe-derived gap ratio for this scene.',
        },
        gapSoftnessTune: {
          type: 'slider',
          label: 'Gap softness tune',
          min: 0.2,
          max: 2.0,
          step: 0.01,
          default: 1.0,
          tooltip: 'Wider = softer gust-front ramps on vegetation.',
        },
        spatialFloorTune: {
          type: 'slider',
          label: 'Storm floor tune',
          min: 0.0,
          max: 2.0,
          step: 0.01,
          default: 1.0,
          tooltip: 'Scales minimum wind strength during storm-tier slider positions.',
        },
        stormSwingTune: {
          type: 'slider',
          label: 'Storm swing tune',
          min: 0.0,
          max: 2.0,
          step: 0.01,
          default: 1.0,
          tooltip: 'Scales rapid direction oscillation at high wind slider.',
        },
        waveSharpnessTune: {
          type: 'slider',
          label: 'Wave sharpness tune',
          min: 0.2,
          max: 2.0,
          step: 0.01,
          default: 1.0,
        },
        windAttackRamp: {
          type: 'slider',
          label: 'Vegetation attack',
          min: 0.1,
          max: 10.0,
          step: 0.05,
          default: 2.5,
          tooltip: 'How quickly trees/bushes ramp up when wind rises.',
        },
        windDecayRamp: {
          type: 'slider',
          label: 'Vegetation decay',
          min: 0.05,
          max: 5.0,
          step: 0.05,
          default: 0.88,
          tooltip: 'How slowly trees/bushes tail off when wind drops.',
        },
        bendRiseSoftness: {
          type: 'slider',
          label: 'Bend rise softness',
          min: 0.05,
          max: 1.0,
          step: 0.01,
          default: 0.35,
          tooltip: 'Softens spatial gust-front bend onset on canopies.',
        },
        waveSpatialFrequency: {
          type: 'slider',
          label: 'Wave spacing',
          min: 0.0001,
          max: 0.01,
          step: 0.0001,
          default: 0.0014,
          tooltip: 'Distance between gust fronts along the wind direction.',
        },
        waveTravelSpeed: {
          type: 'slider',
          label: 'Wave speed',
          min: 0.05,
          max: 4.0,
          step: 0.01,
          default: 0.7,
          tooltip: 'How fast gust fronts travel across the map.',
        },
        waveSharpness: {
          type: 'slider',
          label: 'Wave sharpness',
          min: 0.5,
          max: 8.0,
          step: 0.05,
          default: 3.5,
          tooltip: 'Higher = crisper gust peaks and longer lulls between them.',
        },
        gapRatio: {
          type: 'slider',
          label: 'Gap ratio',
          min: 0.0,
          max: 0.9,
          step: 0.01,
          default: 0.55,
          tooltip: 'Fraction of each wave cycle spent in calm lulls (canopies can reset).',
        },
        gapSoftness: {
          type: 'slider',
          label: 'Gap softness',
          min: 0.01,
          max: 0.5,
          step: 0.01,
          default: 0.04,
          tooltip: 'Blend width at gust-front edges.',
        },
        directionEvolutionScale: {
          type: 'slider',
          label: 'Direction evolution',
          min: 0.0,
          max: 3.0,
          step: 0.05,
          default: 1.0,
          tooltip: 'Scales WeatherController heading meander (compass still sets base bearing).',
        },
        windInfluence: {
          type: 'slider',
          label: 'Cloud wind influence',
          min: 0.0,
          max: 2.0,
          step: 0.01,
          default: 1.33,
          tooltip: 'How strongly compass wind speed drives cloud advection.',
        },
        driftSpeed: {
          type: 'slider',
          label: 'Cloud drift speed',
          min: 0.0,
          max: 0.1,
          step: 0.001,
          default: 0.061,
        },
        minDriftSpeed: {
          type: 'slider',
          label: 'Min cloud drift',
          min: 0.0,
          max: 0.05,
          step: 0.001,
          default: 0.002,
          tooltip: 'Baseline advection in wind direction — clouds never fully stop.',
        },
        driftResponsiveness: {
          type: 'slider',
          label: 'Cloud accel response',
          min: 0.0,
          max: 1.0,
          step: 0.01,
          default: 0.75,
          tooltip: 'How quickly clouds speed up when wind rises.',
        },
        driftDecelFactor: {
          type: 'slider',
          label: 'Cloud decel rate',
          min: 0.02,
          max: 1.0,
          step: 0.01,
          default: 0.14,
          tooltip: 'Fraction of accel response used when wind drops (lower = slower coast-down).',
        },
        driftMaxSpeed: {
          type: 'slider',
          label: 'Max cloud drift',
          min: 0.0,
          max: 2.0,
          step: 0.01,
          default: 0.5,
        },
        windDirResponsiveness: {
          type: 'slider',
          label: 'Water wind response',
          min: 0.05,
          max: 30,
          step: 0.05,
          default: 10,
        },
        windOverrideEnabled: {
          type: 'boolean',
          label: 'Water wind override',
          default: true,
        },
        windOverrideBearingDeg: {
          type: 'slider',
          label: 'Override bearing',
          min: 0,
          max: 360,
          step: 1,
          default: 90,
        },
        windOverrideSpeed01: {
          type: 'slider',
          label: 'Override speed',
          min: 0,
          max: 1,
          step: 0.01,
          default: 0.2,
        },
        windResponse: {
          type: 'slider',
          label: 'Vegetation wind response',
          min: 0.0,
          max: 3.0,
          step: 0.001,
          default: 0.06,
          tooltip: 'How strongly trees/bushes respond to scene wind (not a second speed source).',
        },
        windRampSpeed: {
          type: 'slider',
          label: 'Vegetation catch-up',
          min: 0.1,
          max: 10.0,
          step: 0.05,
          default: 1.32,
        },
        vegetationWaveInfluence: {
          type: 'slider',
          label: 'Gust strength mix',
          min: 0.0,
          max: 1.0,
          step: 0.01,
          default: 1.0,
          tooltip: 'How fully gust fronts drive bend (1 = full calm in lulls).',
        },
        clumpWaveEnabled: {
          type: 'boolean',
          label: 'Clump wave field',
          default: true,
        },
        clumpWaveMix: {
          type: 'slider',
          label: 'Clump wave mix',
          min: 0.0,
          max: 1.0,
          step: 0.01,
          default: 1.0,
        },
        fireWindInfluence: {
          type: 'slider',
          label: 'Fire wind influence',
          min: 0.0,
          max: 5.0,
          step: 0.1,
          default: 0.7,
        },
        fireWeatherWindKill: {
          type: 'slider',
          label: 'Fire wind kill',
          min: 0.0,
          max: 5.0,
          step: 0.05,
          default: 0.9,
        },
        fogAdvectionSpeed: {
          type: 'slider',
          label: 'Fog advection',
          min: 0.0,
          max: 5.0,
          step: 0.05,
          default: 1.7,
        },
        fogWindDirResponsiveness: {
          type: 'slider',
          label: 'Fog wind response',
          min: 0.05,
          max: 20.0,
          step: 0.05,
          default: 6.0,
        },
        rainWindInfluence: {
          type: 'slider',
          label: 'Rain wind influence',
          min: 0.0,
          max: 3.0,
          step: 0.05,
          default: 1.0,
        },
        snowWindInfluence: {
          type: 'slider',
          label: 'Snow wind influence',
          min: 0.0,
          max: 3.0,
          step: 0.05,
          default: 1.0,
        },
      },
    };
  }
}

export const sceneWindField = new SceneWindField();

try {
  if (typeof window !== 'undefined' && window.MapShine) {
    window.MapShine.sceneWindField = sceneWindField;
  }
} catch (_) {}

export { windDirFromBearingDeg };
