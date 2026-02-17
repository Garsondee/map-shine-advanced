/**
 * @fileoverview Weather Controller - Manages global weather state and transitions
 * Follows the "Cinematic Plausibility over Physical Simulation" philosophy.
 * @module core/WeatherController
 */

import { createLogger } from './log.js';

const log = createLogger('WeatherController');

/**
 * @enum {number}
 */
export const PrecipitationType = {
  NONE: 0,
  RAIN: 1,
  SNOW: 2,
  HAIL: 3,
  ASH: 4
};

/**
 * @typedef {Object} WeatherState
 * @property {number} precipitation - 0.0 (dry) to 1.0 (monsoon)
 * @property {number} precipType - Enum value from PrecipitationType
 * @property {number} cloudCover - 0.0 (clear) to 1.0 (overcast)
 * @property {number} windSpeed - 0.0 to 1.0 (hurricane)
 * @property {THREE.Vector2} windDirection - Normalized 2D vector
 * @property {number} fogDensity - 0.0 to 1.0
 * @property {number} wetness - Accumulation logic (lagging behind precipitation)
 * @property {number} freezeLevel - Determines if accumulation is puddles or snow (0.0 = warm, 1.0 = frozen)
 * @property {number} ashIntensity - 0.0 (none) to 1.0 (heavy ash fall)
 */

/**
 * @typedef {Object} WeatherPreset
 * @property {string} id
 * @property {string} name
 * @property {WeatherState} targetState
 */

export class WeatherController {
  constructor() {
    /** @type {WeatherState} */
    this.currentState = {
      precipitation: 0.0,
      precipType: PrecipitationType.NONE,
      cloudCover: 0.0,
      windSpeed: 0.44,
      windDirection: { x: 1, y: 0 }, // 0deg, upgraded to Vector2 in initialize() (Y-down world)
      fogDensity: 0.0,
      wetness: 0.0,
      freezeLevel: 0.0,
      ashIntensity: 0.93 // 0.0 (none) to 1.0 (heavy ash fall)
    };

    /**
     * Neutral state returned by getCurrentState() while weather is disabled.
     * This ensures all dependent effects (clouds, precipitation, wind-driven visuals)
     * immediately render as "off" without needing each effect to special-case.
     * @type {WeatherState}
     */
    this._disabledState = {
      precipitation: 0.0,
      precipType: PrecipitationType.NONE,
      cloudCover: 0.0,
      windSpeed: 0.0,
      windDirection: { x: 1, y: 0 },
      fogDensity: 0.0,
      wetness: 0.0,
      freezeLevel: 0.0,
      ashIntensity: 0.0
    };

    /** @type {WeatherState} */
    this.targetState = { 
      precipitation: 0.0,
      precipType: PrecipitationType.NONE,
      cloudCover: 0.0,
      windSpeed: 0.44,
      windDirection: { x: 1, y: 0 },
      fogDensity: 0.0,
      wetness: 0.0,
      freezeLevel: 0.0,
      ashIntensity: 0.93
    };

    /** @type {WeatherState} */
    this.startState = { ...this.currentState, windDirection: { ...this.currentState.windDirection } };

    // Transition tracking
    this.transitionDuration = 13.3;
    this.transitionElapsed = 0;
    this.isTransitioning = false;

    // Variability (Wanderer Loop)
    this.variability = 0.7; // Tuned variability
    this.noiseOffset = 0;

    // Manual preset transition duration (used when selecting a preset)
    this.presetTransitionDurationSeconds = undefined;

    // Wind Gust System
    this.gustWaitMin = 1.0;   // Seconds to wait between gusts (min)
    this.gustWaitMax = 11.5;  // Seconds to wait between gusts (max)
    this.gustDuration = 7.4;  // Duration of a gust
    this.gustTimer = 0;       // Countdown timer
    this.isGusting = false;   // Current state
    this.currentGustStrength = 0; // Smoothed gust value
    this.gustStrength = 1.0;      // Multiplier for how strong gusts are compared to base wind

    // Time of Day (0-24)
    this.timeOfDay = 6.6; // Tuned time of day

    // Season
    this.season = 'SUMMER';

    this.dynamicEnabled = false;
    this.dynamicPresetId = 'Temperate Plains';
    this.dynamicPaused = false;
    this.dynamicEvolutionSpeed = 15.0;

    this.dynamicPlanDurationSeconds = undefined;
    this._dynamicPlanStrength = 0.0;

    /** @type {THREE.Texture|null} */
    this.roofDistanceMap = null;

    /** @type {number} */
    this.roofDistanceMapMaxPx = 1.0;

    this._dynamicInitialized = false;
    this._dynamicSeed = 0;
    this._dynamicRngState = 0;
    this._dynamicSimAccumulator = 0;
    this._dynamicStepSeconds = 1.0;
    this._dynamicPersistTimer = 0;
    this._dynamicPersistIntervalSeconds = 30.0;

    this._dynamicLatent = {
      temperature: 0.6,
      humidity: 0.4,
      storminess: 0.2,
      windBase: 0.1,
      windAngle: (205.0 * Math.PI) / 180.0
    };

    this._dynamicManualTargetSnapshot = null;

    this._dynamicStateSaveTimeout = null;
    this._dynamicStateSaveDebounceMs = 1000;

    this.dynamicBoundsEnabled = false;
    this._dynamicBounds = {
      precipitationMin: 0.0,
      precipitationMax: 1.0,
      cloudCoverMin: 0.0,
      cloudCoverMax: 1.0,
      windSpeedMin: 0.0,
      windSpeedMax: 1.0,
      fogDensityMin: 0.0,
      fogDensityMax: 1.0,
      freezeLevelMin: 0.0,
      freezeLevelMax: 1.0
    };

    this._queuedTransitionTarget = {
      precipitation: 0.0,
      cloudCover: 0.0,
      windSpeed: 0.1,
      windDirectionDeg: 205.0,
      fogDensity: 0.0,
      freezeLevel: 0.0,
      ashIntensity: 0.0
    };
    this._queuedTransitionSaveTimeout = null;
    this._queuedTransitionSaveDebounceMs = 1000;

    this._lastTransitionCommandStartedAt = 0;

    this._weatherSnapshotPersistTimer = 0;
    this._weatherSnapshotPersistIntervalSeconds = 300.0;
    this._weatherSnapshotSaveTimeout = null;
    this._weatherSnapshotSaveDebounceMs = 1000;

    this._environmentState = {
      timeOfDay: 0.0,
      sceneDarkness: 0.0,
      effectiveDarkness: 0.0,
      skyColor: null,
      skyIntensity: 1.0,
      overcastFactor: 0.0,
      stormFactor: 0.0
    };

    /** @type {boolean} Global enable/disable flag for all weather simulation & particles */
    this.enabled = true;

    this.initialized = false;

    /** @type {boolean} Whether weather effects should currently apply the roof/outdoors mask */
    this.roofMaskActive = false;

    /** @type {boolean} Manual override to force indoor/roof mask for weather at all times */
    this.roofMaskForceEnabled = false;

    /** @type {number} Global simulation speed scalar for Quarks-based effects (weather, fire, etc.). */
    this.simulationSpeed = 1.0;

    // Wetness Tracker — surface wetness lags behind precipitation via slow
    // wetting/drying rates.  Tracks currentState.precipitation in real-time
    // (even during transitions) because the slow rates provide natural lag.
    // No holdoff needed — avoids deadlock with dynamic weather's back-to-back transitions.
    this.wetnessTuning = {
      wettingDuration: 30.0,   // Seconds for full rain (precip=1) to reach wetness=1
      dryingDuration: 180.0,   // Seconds for fully wet surface to reach wetness=0
      precipThreshold: 0.05    // Precipitation below this is considered "not raining"
    };

    // Per-system tuning parameters for precipitation visuals
    this.rainTuning = {
      intensityScale: 1.0,
      streakLength: 0.18,
      dropSize: 3.1,
      dropSizeMin: 1.4,
      dropSizeMax: 13.8,
      brightness: 5.7,
      gravityScale: 0.05,
      windInfluence: 0.85,
      curlStrength: 4.0,

      // Splash-specific tuning (rain splashes on the ground)
      splashIntensityScale: 10.0,  // Multiplier on base splash emission
      splashLifeMin: 0.02,         // Seconds
      splashLifeMax: 0.22,         // Seconds
      splashSizeMin: 8.0,          // World units/pixels
      splashSizeMax: 8.0,          // World units/pixels
      splashOpacityPeak: 0.04,     // 0..1 peak alpha for SplashAlphaBehavior

      // Per-tile splash tuning (4 atlas tiles / splash archetypes)
      // Splash 1: Thin clean ring
      splash1IntensityScale: 8.45,
      splash1LifeMin: 0.20,
      splash1LifeMax: 0.35,
      splash1SizeMin: 8.0,
      splash1SizeMax: 16.0,
      splash1OpacityPeak: 0.05,

      // Splash 2: Thick broken ring
      splash2IntensityScale: 8.7,
      splash2LifeMin: 0.09,
      splash2LifeMax: 0.22,
      splash2SizeMin: 2.0,
      splash2SizeMax: 3.0,
      splash2OpacityPeak: 0.05,

      // Splash 3: Droplets-only pattern
      splash3IntensityScale: 9.1,
      splash3LifeMin: 0.20,
      splash3LifeMax: 0.79,
      splash3SizeMin: 6.0,
      splash3SizeMax: 27.0,
      splash3OpacityPeak: 0.12,

      // Splash 4: Inner puddle
      splash4IntensityScale: 9.25,
      splash4LifeMin: 0.305,
      splash4LifeMax: 1.40,
      splash4SizeMin: 10.0,
      splash4SizeMax: 24.0,
      splash4OpacityPeak: 0.02
    };

    this.snowTuning = {
      intensityScale: 1.0,
      flakeSize: 1.5,
      brightness: 1.0,
      gravityScale: 0.01,
      windInfluence: 0.85,
      curlStrength: 11.25,
      flutterStrength: 4.65
    };

    // Ash precipitation tuning (WeatherParticles + AshGeometry)
    this.ashTuning = {
      intensityScale: 0.5,
      emissionRate: 840,
      sizeMin: 5,
      sizeMax: 17,
      lifeMin: 2,
      lifeMax: 4.7,
      speedMin: 15,
      speedMax: 25,
      opacityStartMin: 0.53,
      opacityStartMax: 0.75,
      opacityEnd: 0.85,
      colorStart: { r: 0.45, g: 0.42, b: 0.38 },
      colorEnd: { r: 0.35, g: 0.32, b: 0.28 },
      brightness: 1.0,
      gravityScale: 0.55,
      windInfluence: 2.1,
      curlStrength: 3,
      clusterHoldMin: 1.3,
      clusterHoldMax: 2.3,
      clusterRadiusMin: 1150,
      clusterRadiusMax: 2060,
      clusterBoostMin: 1.1,
      clusterBoostMax: 2.55,
      emberEmissionRate: 167,
      emberSizeMin: 7,
      emberSizeMax: 14,
      emberLifeMin: 12,
      emberLifeMax: 16,
      emberSpeedMin: 180,
      emberSpeedMax: 820,
      emberOpacityStartMin: 0.87,
      emberOpacityStartMax: 0.94,
      emberOpacityEnd: 0.83,
      emberColorStart: { r: 1.0, g: 0.25, b: 0.0 },
      emberColorEnd: { r: 1.0, g: 0.25, b: 0.0 },
      emberBrightness: 5,
      emberGravityScale: 0,
      emberWindInfluence: 0.45,
      emberCurlStrength: 3
    };
  }

  /**
   * Initialize the controller
   */
  async initialize() {
    if (this.initialized) return;
    
    if (!window.THREE) {
      log.error('THREE not found during initialization');
      return;
    }

    // Upgrade placeholders to THREE objects
    const upgradeState = (state) => {
      if (!(state.windDirection instanceof window.THREE.Vector2)) {
        state.windDirection = new window.THREE.Vector2(state.windDirection.x, state.windDirection.y);
      }
    };

    upgradeState(this.currentState);
    upgradeState(this.targetState);
    upgradeState(this.startState);
    upgradeState(this._disabledState);

    if (!this._environmentState.skyColor) {
      this._environmentState.skyColor = new window.THREE.Color(0.6, 0.7, 0.9);
    }

    this._loadDynamicStateFromScene();
    this._loadQueuedTransitionTargetFromScene();
    await this._loadWeatherSnapshotFromScene();

    log.info('WeatherController initialized');
    this.initialized = true;
  }

  _canEditSceneFlags() {
    const scene = canvas?.scene;
    const user = game?.user;
    if (!scene || !user) return false;
    if (user.isGM) return true;
    try {
      if (typeof scene.canUserModify === 'function') return scene.canUserModify(user, 'update');
    } catch (_) {
      return false;
    }
    return false;
  }

  /**
   * Set the Roof Map (Indoor/Outdoor Mask) texture
   * @param {THREE.Texture} texture - The _Outdoors texture
   */
  setRoofMap(texture) {
    this.roofMap = texture;
    log.info('Roof Map set from _Outdoors texture');
    
    if (texture && texture.image) {
      this._extractRoofMaskData(texture.image);
    } else {
      this.roofMaskData = null;
      this.roofMaskSize = { width: 0, height: 0 };
      this._disposeRoofDistanceMap();
    }
  }

  _disposeRoofDistanceMap() {
    try {
      if (this.roofDistanceMap) {
        this.roofDistanceMap.dispose?.();
      }
    } catch (_) {
    }
    this.roofDistanceMap = null;
    this.roofDistanceMapMaxPx = 1.0;
  }

  /**
   * Extract pixel data from the roof mask texture for CPU-side lookup.
   * @param {HTMLImageElement|HTMLCanvasElement} image 
   * @private
   */
  _extractRoofMaskData(image) {
    try {
      const canvas = document.createElement('canvas');
      // Downscale slightly for performance if huge? No, keep simple for now.
      // But limit max resolution to avoid massive memory usage if the map is huge.
      // 1024x1024 is plenty for this lookup.
      let w = image.width;
      let h = image.height;
      const maxDim = 1024;
      if (w > maxDim || h > maxDim) {
        const scale = maxDim / Math.max(w, h);
        w = Math.floor(w * scale);
        h = Math.floor(h * scale);
      }
      
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(image, 0, 0, w, h);
      
      // We only need the Red channel (luminance)
      const imageData = ctx.getImageData(0, 0, w, h);
      const pixels = imageData.data; // RGBA
      
      // Store compact: 1 byte per pixel
      this.roofMaskData = new Uint8Array(w * h);
      for (let i = 0; i < w * h; i++) {
        // Red channel is every 4th byte
        this.roofMaskData[i] = pixels[i * 4];
      }
      
      this.roofMaskSize = { width: w, height: h };
      log.info(`Roof mask data extracted: ${w}x${h}`);

      this._buildRoofDistanceMap();
      
    } catch (e) {
      log.warn('Failed to extract roof mask data:', e);
      this.roofMaskData = null;
      this._disposeRoofDistanceMap();
    }
  }

  _buildRoofDistanceMap() {
    if (!this.roofMaskData || !this.roofMaskSize?.width || !this.roofMaskSize?.height) {
      this._disposeRoofDistanceMap();
      return;
    }

    const THREE = window.THREE;
    if (!THREE) return;

    const w = this.roofMaskSize.width;
    const h = this.roofMaskSize.height;

    // Build a distance-to-indoors field using a fast 2-pass chamfer transform.
    // The mask is authored as outdoors=255 (white), indoors=0 (black).
    // We compute distance for outdoor pixels to the nearest indoor pixel.
    const INF = 1e9;
    const dist = new Int32Array(w * h);
    for (let i = 0; i < w * h; i++) {
      const v = this.roofMaskData[i];
      // Indoors threshold
      dist[i] = v < 128 ? 0 : INF;
    }

    // Chamfer weights (scaled): orthogonal=3, diagonal=4.
    const ORTH = 3;
    const DIAG = 4;

    // Forward pass
    for (let y = 0; y < h; y++) {
      const row = y * w;
      for (let x = 0; x < w; x++) {
        const idx = row + x;
        let d = dist[idx];
        if (d === 0) continue;

        if (x > 0) d = Math.min(d, dist[idx - 1] + ORTH);
        if (y > 0) d = Math.min(d, dist[idx - w] + ORTH);
        if (x > 0 && y > 0) d = Math.min(d, dist[idx - w - 1] + DIAG);
        if (x < w - 1 && y > 0) d = Math.min(d, dist[idx - w + 1] + DIAG);

        dist[idx] = d;
      }
    }

    // Backward pass
    for (let y = h - 1; y >= 0; y--) {
      const row = y * w;
      for (let x = w - 1; x >= 0; x--) {
        const idx = row + x;
        let d = dist[idx];
        if (d === 0) continue;

        if (x < w - 1) d = Math.min(d, dist[idx + 1] + ORTH);
        if (y < h - 1) d = Math.min(d, dist[idx + w] + ORTH);
        if (x < w - 1 && y < h - 1) d = Math.min(d, dist[idx + w + 1] + DIAG);
        if (x > 0 && y < h - 1) d = Math.min(d, dist[idx + w - 1] + DIAG);

        dist[idx] = d;
      }
    }

    // Convert to pixels in Foundry scene space.
    // The _Outdoors texture is mapped across sceneRect, so compute pixel scale.
    const rect = canvas?.dimensions?.sceneRect;
    const sceneW = Math.max(1, Number(rect?.width) || 1);
    const sceneH = Math.max(1, Number(rect?.height) || 1);
    const scaleX = sceneW / Math.max(1, w);
    const scaleY = sceneH / Math.max(1, h);
    const texelToPx = (scaleX + scaleY) * 0.5;

    // Clamp range for 8-bit encoding.
    // This should comfortably cover expected building buffer sizes.
    const maxDistPx = 2048;
    const maxDistTexel = Math.max(1, Math.floor(maxDistPx / texelToPx));
    const maxDistWeight = Math.max(1, maxDistTexel * ORTH);

    // Encode distance into an RGBA8 DataTexture, storing normalized distance in R.
    const out = new Uint8Array(w * h * 4);
    for (let i = 0; i < w * h; i++) {
      const di = dist[i];
      const clamped = di > maxDistWeight ? maxDistWeight : di;
      const n = clamped / maxDistWeight;
      const b = Math.max(0, Math.min(255, Math.round(n * 255)));
      const o = i * 4;
      out[o] = b;
      out[o + 1] = b;
      out[o + 2] = b;
      out[o + 3] = 255;
    }

    this._disposeRoofDistanceMap();

    const tex = new THREE.DataTexture(out, w, h, THREE.RGBAFormat);
    tex.needsUpdate = true;
    tex.flipY = this.roofMap?.flipY ?? false;
    tex.minFilter = THREE.LinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.generateMipmaps = false;

    this.roofDistanceMap = tex;
    this.roofDistanceMapMaxPx = maxDistWeight * (texelToPx / ORTH);
  }

  /**
   * Check if a specific UV coordinate is considered "Outdoors".
   * @param {number} u - Normalized X (0-1)
   * @param {number} v - Normalized Y (0-1)
   * @returns {number} 0.0 (Indoors) to 1.0 (Outdoors)
   */
  getRoofMaskIntensity(u, v) {
    if (!this.roofMaskData || !this.roofMaskSize.width) return 1.0; // Default to outdoors if no mask

    // Clamp UVs
    const x = Math.max(0, Math.min(1, u));
    const y = Math.max(0, Math.min(1, v));
    
    const w = this.roofMaskSize.width;
    const h = this.roofMaskSize.height;
    
    // Sample coordinates
    const px = Math.floor(x * (w - 1));
    const py = Math.floor(y * (h - 1));
    
    const idx = py * w + px;
    
    // Return normalized intensity (0-255 -> 0.0-1.0)
    return this.roofMaskData[idx] / 255.0;
  }

  /**
   * Enable or disable use of the roof/outdoors mask for weather rendering.
   * This lets other systems (e.g. TileManager hover reveal) decide when the
   * _Outdoors mask should actually gate precipitation visibility.
   * @param {boolean} active
   */
  setRoofMaskActive(active) {
    this.roofMaskActive = !!active;
  }

  /**
   * Update the weather simulation
   * @param {Object} timeInfo - Time information from TimeManager
   */
  update(timeInfo) {
    if (!this.initialized) return;
    if (this.enabled === false && this.dynamicEnabled !== true) return;

    const fc = Number(timeInfo?.frameCount);
    if (Number.isFinite(fc)) {
      if (this._msLastUpdateFrame === fc) return;
      this._msLastUpdateFrame = fc;
    }

    const dt = Math.min(timeInfo.delta, 0.25);
    const elapsed = timeInfo.elapsed;

    if (this._canEditSceneFlags()) {
      this._weatherSnapshotPersistTimer += dt;
      if (this._weatherSnapshotPersistTimer >= this._weatherSnapshotPersistIntervalSeconds) {
        this._weatherSnapshotPersistTimer = 0;
        this._scheduleSaveWeatherSnapshot();
      }
    }

    if (this.dynamicEnabled === true) {
      this._updateDynamic(dt);
    }

    // 1. Calculate Base State (Transition or Static)
    if (this.isTransitioning) {
      this.transitionElapsed += dt;
      const dur = Number.isFinite(this.transitionDuration) ? this.transitionDuration : 0;
      const safeDur = dur > 0.0001 ? dur : 0.0001;
      const progress = Math.min(this.transitionElapsed / safeDur, 1.0);
      
      // Cubic ease-in-out for smoother transitions
      const t = progress < 0.5 
        ? 4 * progress * progress * progress 
        : 1 - Math.pow(-2 * progress + 2, 3) / 2;

      this._lerpState(this.startState, this.targetState, t);

      if (progress >= 1.0) {
        this.isTransitioning = false;
        log.debug('Weather transition complete');

        // Snap to final target state so discrete fields like precipType are correct
        // before we persist a snapshot.
        this._copyState(this.targetState, this.currentState);

        if (this._canEditSceneFlags()) {
          this._weatherSnapshotPersistTimer = 0;
          void this._saveWeatherSnapshotToScene();

          const scene = canvas?.scene;
          if (scene) {
            setTimeout(() => {
              try {
                const cmd = scene.getFlag('map-shine-advanced', 'weather-transition');
                const startedAt = Number(cmd?.startedAt) || 0;
                if (startedAt > 0 && startedAt === this._lastTransitionCommandStartedAt) {
                  scene.unsetFlag('map-shine-advanced', 'weather-transition');
                }
              } catch (_) {
              }
            }, 0);
          }
        }
      }
    } else {
      // Snap to target state (base for this frame)
      this._copyState(this.targetState, this.currentState);
    }

    // 2. Apply Wanderer Loop (Noise)
    // Only apply noise to continuous variables if variability > 0
    if (this.variability > 0) {
      this._applyVariability(elapsed, dt);
    }

    // 3. Update derived state (Wetness lagging)
    this._updateWetness(dt);

    this._updateEnvironmentOutputs();
  }

  _serializeWeatherState(state) {
    return {
      precipitation: Number(state?.precipitation) || 0.0,
      precipType: Number(state?.precipType) || 0,
      cloudCover: Number(state?.cloudCover) || 0.0,
      windSpeed: Number(state?.windSpeed) || 0.0,
      windDirection: {
        x: Number(state?.windDirection?.x) || 1,
        y: Number(state?.windDirection?.y) || 0
      },
      fogDensity: Number(state?.fogDensity) || 0.0,
      wetness: Number(state?.wetness) || 0.0,
      freezeLevel: Number(state?.freezeLevel) || 0.0,
      ashIntensity: Number(state?.ashIntensity) || 0.0
    };
  }

  _applySerializedWeatherState(serialized, dest) {
    if (!serialized || typeof serialized !== 'object' || !dest) return;
    dest.precipitation = Number(serialized.precipitation) || 0.0;
    dest.precipType = Number(serialized.precipType) || 0;
    dest.cloudCover = Number(serialized.cloudCover) || 0.0;
    dest.windSpeed = Number(serialized.windSpeed) || 0.0;
    dest.fogDensity = Number(serialized.fogDensity) || 0.0;
    dest.wetness = Number(serialized.wetness) || 0.0;
    dest.freezeLevel = Number(serialized.freezeLevel) || 0.0;
    dest.ashIntensity = Number(serialized.ashIntensity) || 0.0;

    const wx = Number(serialized.windDirection?.x);
    const wy = Number(serialized.windDirection?.y);
    const x = Number.isFinite(wx) ? wx : 1;
    const y = Number.isFinite(wy) ? wy : 0;
    if (dest.windDirection?.set) dest.windDirection.set(x, y);
    else dest.windDirection = { x, y };
  }

  _scheduleSaveWeatherSnapshot() {
    try {
      if (!this._canEditSceneFlags()) return;
      const scene = canvas?.scene;
      if (!scene) return;

      if (this._weatherSnapshotSaveTimeout) {
        clearTimeout(this._weatherSnapshotSaveTimeout);
      }

      this._weatherSnapshotSaveTimeout = setTimeout(() => {
        this._weatherSnapshotSaveTimeout = null;
        this._saveWeatherSnapshotToScene();
      }, this._weatherSnapshotSaveDebounceMs);
    } catch (e) {
    }
  }

  scheduleSaveWeatherSnapshot() {
    this._scheduleSaveWeatherSnapshot();
  }

  /**
   * Persist the current weather snapshot to the scene immediately (no debounce).
   * Used by scene publishing to ensure compendium exports reproduce the current weather exactly.
   * @returns {Promise<void>}
   * @public
   */
  async saveWeatherSnapshotNow() {
    try {
      if (this._weatherSnapshotSaveTimeout) {
        clearTimeout(this._weatherSnapshotSaveTimeout);
        this._weatherSnapshotSaveTimeout = null;
      }
      await this._saveWeatherSnapshotToScene();
    } catch (e) {
      log.warn('Failed to save weather snapshot immediately:', e);
    }
  }

  async _saveWeatherSnapshotToScene() {
    try {
      if (!this._canEditSceneFlags()) return;
      const scene = canvas?.scene;
      if (!scene) return;

      const payload = {
        version: 1,
        updatedAt: Date.now(),
        enabled: this.enabled === true,
        dynamicEnabled: this.dynamicEnabled === true,
        dynamicPresetId: this.dynamicPresetId,
        dynamicEvolutionSpeed: this.dynamicEvolutionSpeed,
        dynamicPaused: this.dynamicPaused === true,
        timeOfDay: Number(this.timeOfDay) || 12,
        sceneDarkness: Number(
          canvas?.scene?.environment?.darknessLevel ??
          canvas?.environment?.darknessLevel ??
          canvas?.scene?.darkness ??
          0.0
        ),
        start: this._serializeWeatherState(this.startState),
        current: this._serializeWeatherState(this.currentState),
        target: this._serializeWeatherState(this.targetState),
        isTransitioning: this.isTransitioning === true,
        transitionDuration: Number(this.transitionDuration) || 0,
        transitionElapsed: Number(this.transitionElapsed) || 0
      };

      await scene.setFlag('map-shine-advanced', 'weather-snapshot', payload);
      log.debug(`Saved weather snapshot to scene flags (updatedAt=${payload.updatedAt})`);
    } catch (e) {
      log.warn('Failed to save weather snapshot to scene flags:', e);
    }
  }

  async _loadWeatherSnapshotFromScene() {
    try {
      const scene = canvas?.scene;
      if (!scene) return;
      const stored = scene.getFlag('map-shine-advanced', 'weather-snapshot');
      if (!stored || typeof stored !== 'object') return;
      if (stored.version !== 1) return;

      if (stored.enabled === true || stored.enabled === false) {
        this.enabled = stored.enabled === true;
      }

      if (stored.dynamicEnabled === true || stored.dynamicEnabled === false) {
        this.dynamicEnabled = stored.dynamicEnabled === true;
      }

      if (typeof stored.dynamicPresetId === 'string' && stored.dynamicPresetId) {
        this.dynamicPresetId = stored.dynamicPresetId;
      }

      if (Number.isFinite(stored.dynamicEvolutionSpeed)) {
        this.dynamicEvolutionSpeed = stored.dynamicEvolutionSpeed;
      }

      if (stored.dynamicPaused === true || stored.dynamicPaused === false) {
        this.dynamicPaused = stored.dynamicPaused === true;
      }

      if (Number.isFinite(stored.timeOfDay)) {
        this.timeOfDay = stored.timeOfDay % 24;
      }

      // Restore scene darkness if available and user is GM
      const hasStoredDarkness = Number.isFinite(stored.sceneDarkness);
      if (hasStoredDarkness && game?.user?.isGM && canvas?.scene) {
        try {
          await canvas.scene.update({ 'environment.darknessLevel': stored.sceneDarkness });
          log.debug(`Restored scene darkness: ${stored.sceneDarkness.toFixed(3)}`);
        } catch (e) {
          log.warn('Failed to restore scene darkness:', e);
        }
      }

      this._applySerializedWeatherState(stored.target, this.targetState);
      this._applySerializedWeatherState(stored.current, this.currentState);

      const storedDur = Number(stored.transitionDuration) || 0;
      const storedElapsed = Number(stored.transitionElapsed) || 0;
      const wantsTransition = stored.isTransitioning === true && storedDur > 0.05;

      if (wantsTransition) {
        // If we have an explicit serialized start state, restore it so the lerp is correct.
        // Otherwise, restart the transition from the stored current state (smooth continuation).
        if (stored.start && typeof stored.start === 'object') {
          this._applySerializedWeatherState(stored.start, this.startState);
          this.transitionElapsed = Math.max(0, Math.min(storedElapsed, storedDur));
        } else {
          this._copyState(this.currentState, this.startState);
          this.transitionElapsed = 0;
        }
        this.transitionDuration = storedDur;
        this.isTransitioning = true;
      } else {
        this._copyState(this.currentState, this.startState);
        this.isTransitioning = false;
        this.transitionDuration = 0;
        this.transitionElapsed = 0;
      }

      this._updateEnvironmentOutputs();
      
      // Ensure time-driven systems (color grading, scene darkness) update with restored time
      if (Number.isFinite(stored.timeOfDay)) {
        try {
          const stateApplier = window.MapShine?.stateApplier;
          if (stateApplier && typeof stateApplier.applyTimeOfDay === 'function') {
            // If the snapshot contains a persisted Foundry scene darkness, do NOT recompute it
            // from timeOfDay here (would overwrite restored value). For older snapshots that
            // don't have sceneDarkness, fall back to recomputing from timeOfDay.
            const applyDarkness = !hasStoredDarkness;
            await stateApplier.applyTimeOfDay(stored.timeOfDay % 24, false, applyDarkness);
          }
        } catch (e) {
          log.warn('Failed to apply restored timeOfDay to time-driven systems:', e);
        }
      }
      
      log.info(`Loaded weather snapshot from scene flags (updatedAt=${stored.updatedAt ?? 'unknown'})`);
    } catch (e) {
      log.warn('Failed to load weather snapshot from scene flags:', e);
    }
  }

  /**
   * Persist the current dynamic weather state to the scene immediately (no debounce).
   * @returns {Promise<void>}
   * @public
   */
  async saveDynamicStateNow() {
    try {
      if (this._dynamicStateSaveTimeout) {
        clearTimeout(this._dynamicStateSaveTimeout);
        this._dynamicStateSaveTimeout = null;
      }
      await this._saveDynamicStateToScene();
    } catch (e) {
      // Safe no-op.
    }
  }

  /**
   * Persist the queued/manual transition target to the scene immediately (no debounce).
   * @returns {Promise<void>}
   * @public
   */
  async saveQueuedTransitionTargetNow() {
    try {
      if (this._queuedTransitionSaveTimeout) {
        clearTimeout(this._queuedTransitionSaveTimeout);
        this._queuedTransitionSaveTimeout = null;
      }
      await this._saveQueuedTransitionTargetToScene();
    } catch (e) {
      // Safe no-op.
    }
  }

  setDynamicEnabled(enabled) {
    const next = !!enabled;
    if (next === this.dynamicEnabled) return;

    if (next) {
      this._ensureDynamicSeed();
      if (!this._dynamicManualTargetSnapshot) {
        this._dynamicManualTargetSnapshot = {
          ...this.targetState,
          windDirection: this.targetState.windDirection?.clone?.() ?? this.targetState.windDirection
        };
      }
      this.enabled = true;
      this.dynamicEnabled = true;
      this._dynamicInitialized = false;
      this._scheduleSaveDynamicState();
    } else {
      this.dynamicEnabled = false;
      this._dynamicInitialized = false;
      if (this._dynamicManualTargetSnapshot) {
        const snap = this._dynamicManualTargetSnapshot;
        this.targetState.precipitation = snap.precipitation;
        this.targetState.precipType = snap.precipType;
        this.targetState.cloudCover = snap.cloudCover;
        this.targetState.windSpeed = snap.windSpeed;
        this.targetState.fogDensity = snap.fogDensity;
        this.targetState.freezeLevel = snap.freezeLevel;
        if (this.targetState.windDirection && snap.windDirection && this.targetState.windDirection.copy) {
          this.targetState.windDirection.copy(snap.windDirection);
        }
      }

      this._scheduleSaveDynamicState();
    }
  }

  setDynamicPreset(presetId) {
    if (typeof presetId !== 'string' || !presetId) return;
    this.dynamicPresetId = presetId;
    this._dynamicInitialized = false;

    this._scheduleSaveDynamicState();
  }

  setDynamicEvolutionSpeed(value) {
    const n = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(n)) return;
    this.dynamicEvolutionSpeed = n;
    this._scheduleSaveDynamicState();
  }

  setDynamicPaused(paused) {
    this.dynamicPaused = !!paused;
    this._scheduleSaveDynamicState();
  }

  setPresetTransitionDurationMinutes(minutes) {
    const n = typeof minutes === 'number' ? minutes : Number(minutes);
    if (!Number.isFinite(n)) return;
    const clamped = Math.max(0.5, Math.min(60.0, n));
    this.presetTransitionDurationSeconds = clamped * 60.0;
  }

  transitionToPreset(presetDef, durationSeconds) {
    const THREE = window.THREE;
    if (!THREE) return;
    if (!presetDef || typeof presetDef !== 'object') return;
    if (this.dynamicEnabled === true) return;

    const clamp01 = (v) => Math.max(0, Math.min(1, v));

    const precipitation = clamp01(Number(presetDef.precipitation ?? this.targetState.precipitation ?? 0));
    const cloudCover = clamp01(Number(presetDef.cloudCover ?? this.targetState.cloudCover ?? 0));
    const windSpeed = clamp01(Number(presetDef.windSpeed ?? this.targetState.windSpeed ?? 0));
    const fogDensity = clamp01(Number(presetDef.fogDensity ?? this.targetState.fogDensity ?? 0));
    const freezeLevel = clamp01(Number(presetDef.freezeLevel ?? this.targetState.freezeLevel ?? 0));
    // Ash presets include ashIntensity; default to 0 so non-ash presets clear any active ash.
    const ashIntensity = clamp01(Number(presetDef.ashIntensity ?? 0));

    const rad = (Number(presetDef.windDirection ?? NaN) * Math.PI) / 180;
    const windDirection = Number.isFinite(rad)
      ? new THREE.Vector2(Math.cos(rad), -Math.sin(rad))
      : (this.targetState.windDirection?.clone?.() ?? new THREE.Vector2(1, 0));

    const next = {
      precipitation,
      cloudCover,
      windSpeed,
      windDirection,
      fogDensity,
      freezeLevel,
      ashIntensity,
      precipType: PrecipitationType.NONE,
      wetness: 0.0
    };

    if (precipitation < 0.05) {
      next.precipType = PrecipitationType.NONE;
    } else if (freezeLevel > 0.55) {
      next.precipType = PrecipitationType.SNOW;
    } else {
      next.precipType = PrecipitationType.RAIN;
    }

    const dur = Number.isFinite(durationSeconds)
      ? durationSeconds
      : (Number.isFinite(this.presetTransitionDurationSeconds) ? this.presetTransitionDurationSeconds : 30.0);

    this.transitionTo(next, Math.max(0.1, dur));
  }

  getEnvironment() {
    return this._environmentState;
  }

  _dynamicRandom() {
    let t = (this._dynamicRngState += 0x6D2B79F5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  _dynamicNormal() {
    let s = 0;
    s += this._dynamicRandom();
    s += this._dynamicRandom();
    s += this._dynamicRandom();
    s += this._dynamicRandom();
    s += this._dynamicRandom();
    s += this._dynamicRandom();
    return s - 3.0;
  }

  _dynamicClamp(value, min, max) {
    if (value < min) return min;
    if (value > max) return max;
    return value;
  }

  _wrapAngle2Pi(angle) {
    const twoPi = Math.PI * 2.0;
    let a = angle % twoPi;
    if (a < 0) a += twoPi;
    return a;
  }

  _wrapAnglePi(angle) {
    const twoPi = Math.PI * 2.0;
    let a = angle % twoPi;
    if (a < -Math.PI) a += twoPi;
    if (a > Math.PI) a -= twoPi;
    return a;
  }

  _getDynamicBiomeConfig() {
    const cfg = WeatherController.DYNAMIC_BIOMES?.[this.dynamicPresetId];
    return cfg || WeatherController.DYNAMIC_BIOMES?.['Temperate Plains'] || null;
  }

  _ensureDynamicSeed() {
    if (this._dynamicSeed !== 0) return;
    this._dynamicSeed = (Math.random() * 4294967296) >>> 0;
    this._dynamicRngState = this._dynamicSeed >>> 0;
  }

  _initializeDynamicFromTarget() {
    const THREE = window.THREE;
    if (!THREE) return;

    this._ensureDynamicSeed();
    this._dynamicSimAccumulator = 0;

    const target = this.targetState;
    const windDir = target.windDirection || { x: 1, y: 0 };
    const windAngle = Math.atan2(-windDir.y, windDir.x);

    const clamp01 = (n) => Math.max(0, Math.min(1, n));
    this._dynamicLatent.temperature = clamp01(1.0 - (target.freezeLevel ?? 0.0));
    this._dynamicLatent.humidity = clamp01(target.cloudCover ?? 0.0);
    this._dynamicLatent.storminess = clamp01(target.precipitation ?? 0.0);
    this._dynamicLatent.windBase = clamp01(target.windSpeed ?? 0.0);
    this._dynamicLatent.windAngle = Number.isFinite(windAngle) ? windAngle : 0.0;

    this._dynamicInitialized = true;

    this._scheduleSaveDynamicState();
  }

  _loadDynamicStateFromScene() {
    try {
      const scene = canvas?.scene;
      if (!scene) return;

      const stored = scene.getFlag('map-shine-advanced', 'weather-dynamic');
      if (!stored || typeof stored !== 'object') return;

      if (stored.enabled === true) {
        this.dynamicEnabled = true;
        this.enabled = true;
      } else if (stored.enabled === false) {
        this.dynamicEnabled = false;
      }

      if (typeof stored.presetId === 'string' && stored.presetId) {
        this.dynamicPresetId = stored.presetId;
      }

      if (Number.isFinite(stored.evolutionSpeed)) {
        this.dynamicEvolutionSpeed = stored.evolutionSpeed;
      }

      if (Number.isFinite(stored.planDurationSeconds)) {
        this.dynamicPlanDurationSeconds = stored.planDurationSeconds;
      }

      if (stored.paused === true || stored.paused === false) {
        this.dynamicPaused = stored.paused;
      }

      const seed = stored.seed;
      if (Number.isFinite(seed) && seed !== 0) {
        this._dynamicSeed = (seed >>> 0);
        this._dynamicRngState = (stored.rngState >>> 0) || this._dynamicSeed;
      }

      const latent = stored.latent;
      if (latent && typeof latent === 'object') {
        if (Number.isFinite(latent.temperature)) this._dynamicLatent.temperature = latent.temperature;
        if (Number.isFinite(latent.humidity)) this._dynamicLatent.humidity = latent.humidity;
        if (Number.isFinite(latent.storminess)) this._dynamicLatent.storminess = latent.storminess;
        if (Number.isFinite(latent.windBase)) this._dynamicLatent.windBase = latent.windBase;
        if (Number.isFinite(latent.windAngle)) this._dynamicLatent.windAngle = latent.windAngle;

        this._dynamicInitialized = true;
      }

      if (stored.boundsEnabled === true || stored.boundsEnabled === false) {
        this.dynamicBoundsEnabled = stored.boundsEnabled;
      }
      const b = stored.bounds;
      if (b && typeof b === 'object') {
        const assign = (k) => {
          if (Number.isFinite(b[k])) this._dynamicBounds[k] = b[k];
        };
        assign('precipitationMin');
        assign('precipitationMax');
        assign('cloudCoverMin');
        assign('cloudCoverMax');
        assign('windSpeedMin');
        assign('windSpeedMax');
        assign('fogDensityMin');
        assign('fogDensityMax');
        assign('freezeLevelMin');
        assign('freezeLevelMax');
      }

      // If we loaded dynamic mode as enabled, snapshot current manual target state
      // so disabling dynamic mode can restore it.
      if (this.dynamicEnabled === true && !this._dynamicManualTargetSnapshot) {
        this._dynamicManualTargetSnapshot = {
          ...this.targetState,
          windDirection: this.targetState.windDirection?.clone?.() ?? this.targetState.windDirection
        };
      }
    } catch (e) {
      // Safe no-op; weather must not break scene load.
    }
  }

  _scheduleSaveDynamicState() {
    try {
      if (!game?.user?.isGM) return;
      const scene = canvas?.scene;
      if (!scene) return;

      if (this._dynamicStateSaveTimeout) {
        clearTimeout(this._dynamicStateSaveTimeout);
      }

      this._dynamicStateSaveTimeout = setTimeout(() => {
        this._dynamicStateSaveTimeout = null;
        this._saveDynamicStateToScene();
      }, this._dynamicStateSaveDebounceMs);
    } catch (e) {
    }
  }

  async _saveDynamicStateToScene() {
    try {
      if (!this._canEditSceneFlags()) return;
      const scene = canvas?.scene;
      if (!scene) return;

      this._ensureDynamicSeed();

      const latent = this._dynamicLatent;
      const payload = {
        version: 1,
        enabled: this.dynamicEnabled === true,
        presetId: this.dynamicPresetId,
        evolutionSpeed: this.dynamicEvolutionSpeed,
        planDurationSeconds: this.dynamicPlanDurationSeconds,
        paused: this.dynamicPaused === true,
        boundsEnabled: this.dynamicBoundsEnabled === true,
        bounds: { ...this._dynamicBounds },
        seed: this._dynamicSeed >>> 0,
        rngState: this._dynamicRngState >>> 0,
        latent: {
          temperature: latent.temperature,
          humidity: latent.humidity,
          storminess: latent.storminess,
          windBase: latent.windBase,
          windAngle: latent.windAngle
        }
      };

      await scene.setFlag('map-shine-advanced', 'weather-dynamic', payload);
    } catch (e) {
    }
  }

  _dynamicStep(seconds) {
    const cfg = this._getDynamicBiomeConfig();
    if (!cfg) return;

    const dtSeconds = Math.max(0, Number.isFinite(seconds) ? seconds : 0);

    const stepScalar = (dt, timeScaleSeconds) => {
      if (!Number.isFinite(timeScaleSeconds) || timeScaleSeconds <= 0) return 1.0;
      const f = dt / timeScaleSeconds;
      if (f <= 0) return 0.0;
      return f >= 1.0 ? 1.0 : f;
    };

    const updateScalar = (value, spec) => {
      if (!spec) return value;
      const f = stepScalar(dtSeconds, spec.timeScaleSeconds);
      if (f <= 0) return value;

      const noise = (spec.noise ?? 0) * Math.sqrt(f) * this._dynamicNormal();
      const drift = (spec.baseline - value) * f;
      const next = value + drift + noise;
      return this._dynamicClamp(next, spec.min, spec.max);
    };

    this._dynamicLatent.temperature = updateScalar(this._dynamicLatent.temperature, cfg.temperature);
    this._dynamicLatent.humidity = updateScalar(this._dynamicLatent.humidity, cfg.humidity);
    this._dynamicLatent.storminess = updateScalar(this._dynamicLatent.storminess, cfg.storminess);
    this._dynamicLatent.windBase = updateScalar(this._dynamicLatent.windBase, cfg.windBase);

    const angSpec = cfg.windAngle;
    if (angSpec) {
      const f = stepScalar(dtSeconds, angSpec.timeScaleSeconds);
      if (f > 0) {
        const current = Number.isFinite(this._dynamicLatent.windAngle) ? this._dynamicLatent.windAngle : 0.0;
        const baseline = Number.isFinite(angSpec.baseline) ? angSpec.baseline : 0.0;
        const delta = this._wrapAnglePi(baseline - current);
        const noise = (angSpec.noise ?? 0) * Math.sqrt(f) * this._dynamicNormal();
        this._dynamicLatent.windAngle = this._wrapAngle2Pi(current + delta * f + noise);
      }
    } else if (!Number.isFinite(this._dynamicLatent.windAngle)) {
      this._dynamicLatent.windAngle = this._dynamicRandom() * Math.PI * 2.0;
    }
  }

  _deriveDynamicOutputs() {
    const THREE = window.THREE;
    if (!THREE) return;

    const clamp01 = (n) => Math.max(0, Math.min(1, n));
    const temperature = clamp01(this._dynamicLatent.temperature);
    const humidity = clamp01(this._dynamicLatent.humidity);
    const storminess = clamp01(this._dynamicLatent.storminess);
    const windBase = clamp01(this._dynamicLatent.windBase);

    const freezeLevel = clamp01(1.0 - temperature);
    const cloudCover = clamp01(humidity * 0.65 + storminess * 0.55);
    const precipitation = clamp01(humidity * storminess * 1.35 - 0.1);
    const fogDensity = clamp01(humidity * (1.0 - windBase) * 0.65);

    let outFreezeLevel = freezeLevel;
    let outCloudCover = cloudCover;
    let outPrecipitation = precipitation;
    let outFogDensity = fogDensity;
    let outWindBase = windBase;

    if (this.dynamicBoundsEnabled === true) {
      const b = this._dynamicBounds;
      const minMax = (minKey, maxKey) => {
        let mn = b[minKey];
        let mx = b[maxKey];
        if (!Number.isFinite(mn)) mn = 0;
        if (!Number.isFinite(mx)) mx = 1;
        if (mx < mn) {
          const t = mn;
          mn = mx;
          mx = t;
        }
        return { mn, mx };
      };

      {
        const r = minMax('freezeLevelMin', 'freezeLevelMax');
        outFreezeLevel = this._dynamicClamp(outFreezeLevel, r.mn, r.mx);
      }
      {
        const r = minMax('cloudCoverMin', 'cloudCoverMax');
        outCloudCover = this._dynamicClamp(outCloudCover, r.mn, r.mx);
      }
      {
        const r = minMax('precipitationMin', 'precipitationMax');
        outPrecipitation = this._dynamicClamp(outPrecipitation, r.mn, r.mx);
      }
      {
        const r = minMax('fogDensityMin', 'fogDensityMax');
        outFogDensity = this._dynamicClamp(outFogDensity, r.mn, r.mx);
      }
      {
        const r = minMax('windSpeedMin', 'windSpeedMax');
        outWindBase = this._dynamicClamp(outWindBase, r.mn, r.mx);
      }
    }

    this.targetState.freezeLevel = outFreezeLevel;
    this.targetState.cloudCover = outCloudCover;
    this.targetState.precipitation = outPrecipitation;
    this.targetState.fogDensity = outFogDensity;
    this.targetState.windSpeed = outWindBase;

    if (this.targetState.windDirection && this.targetState.windDirection.set) {
      const ang = this._dynamicLatent.windAngle;
      this.targetState.windDirection.set(Math.cos(ang), -Math.sin(ang));
    }

    if (outPrecipitation < 0.05) {
      this.targetState.precipType = PrecipitationType.NONE;
    } else if (outFreezeLevel > 0.55) {
      this.targetState.precipType = PrecipitationType.SNOW;
    } else {
      this.targetState.precipType = PrecipitationType.RAIN;
    }
  }

  setDynamicBoundsEnabled(enabled) {
    this.dynamicBoundsEnabled = !!enabled;
    this._scheduleSaveDynamicState();
  }

  setDynamicBound(boundKey, value) {
    if (!this._dynamicBounds || typeof boundKey !== 'string') return;
    const n = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(n)) return;
    if (!Object.prototype.hasOwnProperty.call(this._dynamicBounds, boundKey)) return;
    this._dynamicBounds[boundKey] = n;
    this._scheduleSaveDynamicState();
  }

  queueTransitionFromCurrent() {
    const THREE = window.THREE;
    if (!THREE) return;

    const s = this.getCurrentState();
    const angleDeg = Math.atan2(-s.windDirection.y, s.windDirection.x) * (180 / Math.PI);
    this._queuedTransitionTarget.precipitation = s.precipitation ?? 0.0;
    this._queuedTransitionTarget.cloudCover = s.cloudCover ?? 0.0;
    this._queuedTransitionTarget.windSpeed = s.windSpeed ?? 0.0;
    this._queuedTransitionTarget.windDirectionDeg = angleDeg < 0 ? (angleDeg + 360) : angleDeg;
    this._queuedTransitionTarget.fogDensity = s.fogDensity ?? 0.0;
    this._queuedTransitionTarget.freezeLevel = s.freezeLevel ?? 0.0;
    this._queuedTransitionTarget.ashIntensity = s.ashIntensity ?? 0.0;

    this._scheduleSaveQueuedTransitionTarget();
  }

  setQueuedTransitionParam(paramId, value) {
    const n = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(n)) return;

    if (paramId === 'queuedPrecipitation') this._queuedTransitionTarget.precipitation = n;
    else if (paramId === 'queuedCloudCover') this._queuedTransitionTarget.cloudCover = n;
    else if (paramId === 'queuedWindSpeed') this._queuedTransitionTarget.windSpeed = n;
    else if (paramId === 'queuedWindDirection') this._queuedTransitionTarget.windDirectionDeg = n;
    else if (paramId === 'queuedFogDensity') this._queuedTransitionTarget.fogDensity = n;
    else if (paramId === 'queuedFreezeLevel') this._queuedTransitionTarget.freezeLevel = n;
    else if (paramId === 'queuedAshIntensity') this._queuedTransitionTarget.ashIntensity = n;
    else return;

    this._scheduleSaveQueuedTransitionTarget();
  }

  startQueuedTransition(durationSeconds) {
    if (this.dynamicEnabled === true) {
      try {
        ui?.notifications?.warn?.('Map Shine: disable Dynamic Weather to use manual transitions.');
      } catch (_) {
      }
      try {
        log.warn('startQueuedTransition blocked because dynamicEnabled=true');
      } catch (_) {
      }
      return;
    }

    const durArg = Number(durationSeconds);
    const durFromArg = Number.isFinite(durArg) && durArg > 0.05 ? durArg : null;
    const durFromTransition = Number.isFinite(this.transitionDuration) && this.transitionDuration > 0.05 ? this.transitionDuration : null;
    const durFromPreset = Number.isFinite(this.presetTransitionDurationSeconds) && this.presetTransitionDurationSeconds > 0.05
      ? this.presetTransitionDurationSeconds
      : 30.0;
    const duration = durFromArg ?? durFromTransition ?? durFromPreset;

    try {
      log.info(`startQueuedTransition(durationSeconds=${String(durationSeconds)}) -> duration=${duration}`);
    } catch (_) {
    }
    const target = this._buildQueuedTransitionWeatherState();
    if (!target) return;

    this.transitionTo(target, duration);
    this._broadcastTransitionCommand(target, duration);

    if (this._canEditSceneFlags()) {
      this._weatherSnapshotPersistTimer = 0;
      void this._saveWeatherSnapshotToScene();
    }
  }

  _buildQueuedTransitionWeatherState() {
    const THREE = window.THREE;
    if (!THREE) return null;

    const q = this._queuedTransitionTarget;
    const rad = (Number(q.windDirectionDeg) * Math.PI) / 180;
    const precipitation = Number(q.precipitation) || 0.0;
    const freezeLevel = Number(q.freezeLevel) || 0.0;
    const ashIntensity = Number(q.ashIntensity) || 0.0;

    let precipType = PrecipitationType.NONE;
    if (precipitation < 0.05) {
      precipType = PrecipitationType.NONE;
    } else if (freezeLevel > 0.55) {
      precipType = PrecipitationType.SNOW;
    } else {
      precipType = PrecipitationType.RAIN;
    }

    return {
      precipitation,
      cloudCover: q.cloudCover,
      windSpeed: q.windSpeed,
      windDirection: { x: Math.cos(rad), y: -Math.sin(rad) },
      fogDensity: q.fogDensity,
      freezeLevel,
      ashIntensity,
      precipType,
      wetness: 0.0
    };
  }

  async _broadcastTransitionCommand(targetState, durationSeconds) {
    try {
      if (!this._canEditSceneFlags()) return;
      const scene = canvas?.scene;
      if (!scene) return;

      const startedAt = Date.now();
      this._lastTransitionCommandStartedAt = startedAt;

      const cmd = {
        version: 1,
        startedAt,
        duration: durationSeconds,
        start: this._serializeWeatherState(this.startState),
        target: {
          precipitation: targetState.precipitation,
          cloudCover: targetState.cloudCover,
          windSpeed: targetState.windSpeed,
          windDirection: {
            x: targetState.windDirection?.x ?? 1,
            y: targetState.windDirection?.y ?? 0
          },
          fogDensity: targetState.fogDensity,
          freezeLevel: targetState.freezeLevel,
          ashIntensity: targetState.ashIntensity ?? 0.0
        }
      };

      await scene.setFlag('map-shine-advanced', 'weather-transition', cmd);
    } catch (e) {
    }
  }

  applyTransitionCommand(cmd) {
    try {
      if (!cmd || typeof cmd !== 'object') return;
      const startedAt = Number(cmd.startedAt) || 0;
      if (startedAt <= this._lastTransitionCommandStartedAt) return;
      this._lastTransitionCommandStartedAt = startedAt;

      const target = cmd.target;
      if (!target || typeof target !== 'object') return;

      const duration = Number.isFinite(cmd.duration) ? cmd.duration : 5.0;
      try {
        log.info(`applyTransitionCommand(startedAt=${startedAt}) duration=${duration}`);
      } catch (_) {
      }

      const start = cmd.start;
      if (start && typeof start === 'object') {
        this._applySerializedWeatherState(start, this.startState);
        this._applySerializedWeatherState(start, this.currentState);
      }

      this.transitionTo({
        precipitation: Number(target.precipitation) || 0,
        cloudCover: Number(target.cloudCover) || 0,
        windSpeed: Number(target.windSpeed) || 0,
        windDirection: { x: Number(target.windDirection?.x) || 1, y: Number(target.windDirection?.y) || 0 },
        fogDensity: Number(target.fogDensity) || 0,
        freezeLevel: Number(target.freezeLevel) || 0,
        ashIntensity: Number(target.ashIntensity) || 0,
        precipType: PrecipitationType.NONE,
        wetness: 0.0
      }, duration);

      const elapsedSeconds = startedAt > 0 ? (Date.now() - startedAt) / 1000.0 : 0;
      if (Number.isFinite(elapsedSeconds) && elapsedSeconds > 0) {
        this.transitionElapsed = Math.max(0, Math.min(elapsedSeconds, this.transitionDuration));
      }
    } catch (e) {
    }
  }

  _loadQueuedTransitionTargetFromScene() {
    try {
      const scene = canvas?.scene;
      if (!scene) return;
      const stored = scene.getFlag('map-shine-advanced', 'weather-transitionTarget');
      if (!stored || typeof stored !== 'object') return;

      const t = stored.target;
      if (!t || typeof t !== 'object') return;

      const assign = (key, prop) => {
        if (Number.isFinite(t[key])) this._queuedTransitionTarget[prop] = t[key];
      };
      assign('precipitation', 'precipitation');
      assign('cloudCover', 'cloudCover');
      assign('windSpeed', 'windSpeed');
      assign('windDirectionDeg', 'windDirectionDeg');
      assign('fogDensity', 'fogDensity');
      assign('freezeLevel', 'freezeLevel');
      assign('ashIntensity', 'ashIntensity');
    } catch (e) {
    }
  }

  _scheduleSaveQueuedTransitionTarget() {
    try {
      if (!this._canEditSceneFlags()) return;
      const scene = canvas?.scene;
      if (!scene) return;

      if (this._queuedTransitionSaveTimeout) {
        clearTimeout(this._queuedTransitionSaveTimeout);
      }

      this._queuedTransitionSaveTimeout = setTimeout(() => {
        this._queuedTransitionSaveTimeout = null;
        this._saveQueuedTransitionTargetToScene();
      }, this._queuedTransitionSaveDebounceMs);
    } catch (e) {
    }
  }

  async _saveQueuedTransitionTargetToScene() {
    try {
      if (!this._canEditSceneFlags()) return;
      const scene = canvas?.scene;
      if (!scene) return;

      const q = this._queuedTransitionTarget;
      await scene.setFlag('map-shine-advanced', 'weather-transitionTarget', {
        version: 1,
        updatedAt: Date.now(),
        target: {
          precipitation: q.precipitation,
          cloudCover: q.cloudCover,
          windSpeed: q.windSpeed,
          windDirectionDeg: q.windDirectionDeg,
          fogDensity: q.fogDensity,
          freezeLevel: q.freezeLevel,
          ashIntensity: q.ashIntensity
        }
      });
    } catch (e) {
    }
  }

  _updateDynamic(dt) {
    if (this._dynamicInitialized !== true) {
      this._initializeDynamicFromTarget();
    }

    const speed = Number.isFinite(this.dynamicEvolutionSpeed) ? this.dynamicEvolutionSpeed : 60.0;
    const safeDt = Math.min(dt, 0.25);

    if (this.dynamicPaused === true) {
      return;
    }

    // While a long transition is running, do not change the dynamic target.
    // This prevents the "constant readjustment" look.
    if (this.isTransitioning === true) {
      this._dynamicPersistTimer += safeDt;
      if (this._dynamicPersistTimer >= this._dynamicPersistIntervalSeconds) {
        this._dynamicPersistTimer = 0;
        this._scheduleSaveDynamicState();
      }
      return;
    }

    // Keep latent variables evolving, but only use them to inform the *next* planned target.
    this._dynamicSimAccumulator += safeDt;
    this._dynamicPersistTimer += safeDt;

    let steps = 0;
    while (this._dynamicSimAccumulator >= this._dynamicStepSeconds && steps < 10) {
      this._dynamicSimAccumulator -= this._dynamicStepSeconds;
      const simSeconds = this._dynamicStepSeconds * Math.max(0, speed);
      this._dynamicStep(simSeconds);
      steps++;
    }

    if (this._dynamicPersistTimer >= this._dynamicPersistIntervalSeconds) {
      this._dynamicPersistTimer = 0;
      this._scheduleSaveDynamicState();
    }

    // Start a long, smooth planned transition.
    this._dynamicStartPlannedTransition();
  }

  _dynamicStartPlannedTransition() {
    const THREE = window.THREE;
    if (!THREE) return;

    const cfg = this._getDynamicBiomeConfig();
    if (!cfg) return;

    const clamp01 = (n) => Math.max(0, Math.min(1, n));
    const rnd = () => this._dynamicRandom();

    const baseTemp = Number.isFinite(cfg.temperature?.baseline) ? cfg.temperature.baseline : 0.6;
    const baseHumidity = Number.isFinite(cfg.humidity?.baseline) ? cfg.humidity.baseline : 0.45;
    const baseStorm = Number.isFinite(cfg.storminess?.baseline) ? cfg.storminess.baseline : 0.25;
    const baseWind = Number.isFinite(cfg.windBase?.baseline) ? cfg.windBase.baseline : 0.2;
    const freezeBaseline = clamp01(1.0 - baseTemp);

    const coldFactor = clamp01((freezeBaseline - 0.5) / 0.5);
    const wetFactor = clamp01(baseHumidity * 0.6 + baseStorm * 0.8);

    let pBlizzard = clamp01(coldFactor * 0.5 + wetFactor * 0.2) * 0.35;
    let pStorm = clamp01(wetFactor) * 0.20;
    let pRain = clamp01(wetFactor) * 0.35;
    let pClear = clamp01(1.0 - wetFactor) * 0.35;
    let pOvercast = 0.10;

    if (pClear + pRain + pStorm + pBlizzard + pOvercast < 0.0001) {
      pClear = 1.0;
    }

    const sum = pClear + pRain + pStorm + pBlizzard + pOvercast;
    pClear /= sum;
    pRain /= sum;
    pStorm /= sum;
    pBlizzard /= sum;
    pOvercast /= sum;

    const r = rnd();
    let regime = 'clear';
    if (r < pClear) regime = 'clear';
    else if (r < pClear + pOvercast) regime = 'overcast';
    else if (r < pClear + pOvercast + pRain) regime = 'rain';
    else if (r < pClear + pOvercast + pRain + pStorm) regime = 'storm';
    else regime = 'blizzard';

    // Strength: how far we move toward the new regime.
    // (Examples: 0.3 = 30% more rainy, 0.5 = 50% more clear, etc.)
    const r2 = rnd();
    const strength = r2 < 0.6 ? 0.1 : (r2 < 0.9 ? 0.3 : 0.5);
    this._dynamicPlanStrength = strength;

    const archetype = {
      precipitation: 0.0,
      cloudCover: 0.2,
      windSpeed: clamp01(baseWind),
      windDirection: this.targetState.windDirection?.clone?.() ?? new THREE.Vector2(1, 0),
      fogDensity: 0.0,
      freezeLevel: freezeBaseline,
      precipType: PrecipitationType.NONE,
      wetness: 0.0
    };

    if (regime === 'clear') {
      archetype.precipitation = 0.0;
      archetype.cloudCover = 0.05 + 0.25 * rnd();
      archetype.fogDensity = 0.0 + 0.06 * rnd();
      archetype.windSpeed = clamp01(0.05 + 0.25 * rnd());
    } else if (regime === 'overcast') {
      archetype.precipitation = 0.0 + 0.15 * rnd();
      archetype.cloudCover = 0.55 + 0.45 * rnd();
      archetype.fogDensity = 0.05 + 0.20 * rnd();
      archetype.windSpeed = clamp01(0.08 + 0.25 * rnd());
    } else if (regime === 'rain') {
      archetype.precipitation = 0.35 + 0.45 * rnd();
      archetype.cloudCover = 0.65 + 0.35 * rnd();
      archetype.fogDensity = 0.06 + 0.25 * rnd();
      archetype.windSpeed = clamp01(0.15 + 0.35 * rnd());
    } else if (regime === 'storm') {
      archetype.precipitation = 0.65 + 0.35 * rnd();
      archetype.cloudCover = 0.85 + 0.15 * rnd();
      archetype.fogDensity = 0.10 + 0.35 * rnd();
      archetype.windSpeed = clamp01(0.35 + 0.55 * rnd());
    } else if (regime === 'blizzard') {
      archetype.precipitation = 0.65 + 0.35 * rnd();
      archetype.cloudCover = 0.85 + 0.15 * rnd();
      archetype.fogDensity = 0.15 + 0.35 * rnd();
      archetype.windSpeed = clamp01(0.45 + 0.55 * rnd());
      archetype.freezeLevel = 0.75 + 0.25 * rnd();
    }

    // Apply GM bounds to the archetype if enabled.
    if (this.dynamicBoundsEnabled === true) {
      const b = this._dynamicBounds;
      const minMax = (minKey, maxKey) => {
        let mn = b[minKey];
        let mx = b[maxKey];
        if (!Number.isFinite(mn)) mn = 0;
        if (!Number.isFinite(mx)) mx = 1;
        if (mx < mn) {
          const t = mn;
          mn = mx;
          mx = t;
        }
        return { mn, mx };
      };

      {
        const rB = minMax('precipitationMin', 'precipitationMax');
        archetype.precipitation = this._dynamicClamp(archetype.precipitation, rB.mn, rB.mx);
      }
      {
        const rB = minMax('cloudCoverMin', 'cloudCoverMax');
        archetype.cloudCover = this._dynamicClamp(archetype.cloudCover, rB.mn, rB.mx);
      }
      {
        const rB = minMax('windSpeedMin', 'windSpeedMax');
        archetype.windSpeed = this._dynamicClamp(archetype.windSpeed, rB.mn, rB.mx);
      }
      {
        const rB = minMax('fogDensityMin', 'fogDensityMax');
        archetype.fogDensity = this._dynamicClamp(archetype.fogDensity, rB.mn, rB.mx);
      }
      {
        const rB = minMax('freezeLevelMin', 'freezeLevelMax');
        archetype.freezeLevel = this._dynamicClamp(archetype.freezeLevel, rB.mn, rB.mx);
      }
    }

    const cur = this.targetState;
    const next = {
      precipitation: THREE.MathUtils.lerp(cur.precipitation, archetype.precipitation, strength),
      cloudCover: THREE.MathUtils.lerp(cur.cloudCover, archetype.cloudCover, strength),
      windSpeed: THREE.MathUtils.lerp(cur.windSpeed, archetype.windSpeed, strength),
      windDirection: cur.windDirection?.clone?.() ?? new THREE.Vector2(1, 0),
      fogDensity: THREE.MathUtils.lerp(cur.fogDensity, archetype.fogDensity, strength),
      freezeLevel: THREE.MathUtils.lerp(cur.freezeLevel, archetype.freezeLevel, strength),
      precipType: PrecipitationType.NONE,
      wetness: 0.0
    };

    if (next.precipitation < 0.05) {
      next.precipType = PrecipitationType.NONE;
    } else if (next.freezeLevel > 0.55) {
      next.precipType = PrecipitationType.SNOW;
    } else {
      next.precipType = PrecipitationType.RAIN;
    }

    const duration = Math.max(1.0, Number.isFinite(this.dynamicPlanDurationSeconds) ? this.dynamicPlanDurationSeconds : 360.0);
    this.transitionTo(next, duration);
  }

  setDynamicPlanDurationMinutes(minutes) {
    const n = typeof minutes === 'number' ? minutes : Number(minutes);
    if (!Number.isFinite(n)) return;
    const clamped = Math.max(0.1, Math.min(60.0, n));
    this.dynamicPlanDurationSeconds = clamped * 60.0;
    this._scheduleSaveDynamicState();
  }

  static DYNAMIC_BIOMES = {
    'Temperate Plains': {
      temperature: { baseline: 0.65, min: 0.25, max: 0.9, timeScaleSeconds: 1800, noise: 0.06 },
      humidity: { baseline: 0.45, min: 0.15, max: 0.85, timeScaleSeconds: 1500, noise: 0.08 },
      storminess: { baseline: 0.25, min: 0.02, max: 0.75, timeScaleSeconds: 1200, noise: 0.10 },
      windBase: { baseline: 0.18, min: 0.02, max: 0.75, timeScaleSeconds: 900, noise: 0.08 },
      windAngle: { baseline: (205.0 * Math.PI) / 180.0, timeScaleSeconds: 2400, noise: 0.35 }
    },
    Desert: {
      temperature: { baseline: 0.9, min: 0.65, max: 1.0, timeScaleSeconds: 2200, noise: 0.04 },
      humidity: { baseline: 0.18, min: 0.03, max: 0.35, timeScaleSeconds: 1800, noise: 0.05 },
      storminess: { baseline: 0.08, min: 0.0, max: 0.25, timeScaleSeconds: 1600, noise: 0.05 },
      windBase: { baseline: 0.22, min: 0.03, max: 0.85, timeScaleSeconds: 850, noise: 0.10 },
      windAngle: { baseline: (235.0 * Math.PI) / 180.0, timeScaleSeconds: 2400, noise: 0.45 }
    },
    'Tropical Jungle': {
      temperature: { baseline: 0.82, min: 0.55, max: 1.0, timeScaleSeconds: 2000, noise: 0.05 },
      humidity: { baseline: 0.78, min: 0.55, max: 1.0, timeScaleSeconds: 1400, noise: 0.09 },
      storminess: { baseline: 0.45, min: 0.12, max: 0.95, timeScaleSeconds: 1000, noise: 0.12 },
      windBase: { baseline: 0.22, min: 0.04, max: 0.8, timeScaleSeconds: 800, noise: 0.10 },
      windAngle: { baseline: (190.0 * Math.PI) / 180.0, timeScaleSeconds: 2100, noise: 0.35 }
    },
    Tundra: {
      temperature: { baseline: 0.18, min: 0.0, max: 0.45, timeScaleSeconds: 2400, noise: 0.06 },
      humidity: { baseline: 0.42, min: 0.12, max: 0.8, timeScaleSeconds: 1700, noise: 0.07 },
      storminess: { baseline: 0.25, min: 0.03, max: 0.75, timeScaleSeconds: 1300, noise: 0.10 },
      windBase: { baseline: 0.35, min: 0.08, max: 1.0, timeScaleSeconds: 750, noise: 0.12 },
      windAngle: { baseline: (210.0 * Math.PI) / 180.0, timeScaleSeconds: 2200, noise: 0.55 }
    },
    'Arctic Blizzard': {
      temperature: { baseline: 0.06, min: 0.0, max: 0.2, timeScaleSeconds: 2600, noise: 0.04 },
      humidity: { baseline: 0.55, min: 0.25, max: 0.95, timeScaleSeconds: 1500, noise: 0.08 },
      storminess: { baseline: 0.62, min: 0.2, max: 1.0, timeScaleSeconds: 900, noise: 0.12 },
      windBase: { baseline: 0.55, min: 0.15, max: 1.0, timeScaleSeconds: 650, noise: 0.14 },
      windAngle: { baseline: (200.0 * Math.PI) / 180.0, timeScaleSeconds: 1800, noise: 0.65 }
    }
  };

  _updateEnvironmentOutputs() {
    const THREE = window.THREE;
    if (!THREE) return;
    if (!this._environmentState.skyColor) return;

    const state = this.getCurrentState();
    const timeOfDay = Number.isFinite(this.timeOfDay) ? this.timeOfDay : 12.0;

    let sceneDarkness = 0.0;
    try {
      sceneDarkness = canvas?.environment?.darknessLevel ?? 0.0;
    } catch (e) {
      sceneDarkness = 0.0;
    }

    const clamp01 = (n) => Math.max(0, Math.min(1, n));
    const dayDist = Math.abs(timeOfDay - 12.0) / 12.0;
    const dayFactor = clamp01(1.0 - dayDist);
    const overcastFactor = clamp01((state.cloudCover ?? 0.0) * 0.8 + (state.precipitation ?? 0.0) * 0.6);
    const stormFactor = clamp01((state.precipitation ?? 0.0) * 1.0);

    const effectiveDarkness = clamp01(
      (sceneDarkness ?? 0.0) +
      (1.0 - dayFactor) * 0.25 +
      overcastFactor * 0.15 +
      stormFactor * 0.1
    );

    const skyIntensity = clamp01(
      (0.15 + 0.85 * dayFactor) *
      (1.0 - overcastFactor * 0.55) *
      (1.0 - stormFactor * 0.25) *
      (1.0 - (sceneDarkness ?? 0.0) * 0.85)
    );

    const skyDay = this._environmentTempDay || (this._environmentTempDay = new THREE.Color(0.62, 0.72, 0.92));
    const skyNight = this._environmentTempNight || (this._environmentTempNight = new THREE.Color(0.02, 0.03, 0.06));
    const skyStorm = this._environmentTempStorm || (this._environmentTempStorm = new THREE.Color(0.32, 0.35, 0.40));

    this._environmentState.skyColor.copy(skyNight).lerp(skyDay, dayFactor).lerp(skyStorm, overcastFactor * 0.65 + stormFactor * 0.35);

    this._environmentState.timeOfDay = timeOfDay;
    this._environmentState.sceneDarkness = clamp01(sceneDarkness ?? 0.0);
    this._environmentState.effectiveDarkness = effectiveDarkness;
    this._environmentState.skyIntensity = skyIntensity;
    this._environmentState.overcastFactor = overcastFactor;
    this._environmentState.stormFactor = stormFactor;
  }

  /**
   * Copy state properties from source to destination
   * @param {WeatherState} source 
   * @param {WeatherState} dest 
   * @private
   */
  _copyState(source, dest) {
    dest.precipitation = source.precipitation;
    dest.precipType = source.precipType;
    dest.cloudCover = source.cloudCover;
    dest.windSpeed = source.windSpeed;
    dest.fogDensity = source.fogDensity;
    dest.freezeLevel = source.freezeLevel;
    dest.ashIntensity = source.ashIntensity ?? 0.0;
    // wetness is derived, don't copy (or handle separately)
    
    if (source.windDirection && dest.windDirection) {
      if (typeof dest.windDirection.copy === 'function') {
        dest.windDirection.copy(source.windDirection);
      } else {
        dest.windDirection.x = source.windDirection.x;
        dest.windDirection.y = source.windDirection.y;
      }
    }
  }

  /**
   * Linear interpolation between two weather states
   * @param {WeatherState} start 
   * @param {WeatherState} end 
   * @param {number} t - Interpolation factor (0-1)
   * @private
   */
  _lerpState(start, end, t) {
    const THREE = window.THREE;
    if (!THREE) return;

    this.currentState.precipitation = THREE.MathUtils.lerp(start.precipitation, end.precipitation, t);
    this.currentState.cloudCover = THREE.MathUtils.lerp(start.cloudCover, end.cloudCover, t);
    this.currentState.windSpeed = THREE.MathUtils.lerp(start.windSpeed, end.windSpeed, t);
    this.currentState.fogDensity = THREE.MathUtils.lerp(start.fogDensity, end.fogDensity, t);
    this.currentState.freezeLevel = THREE.MathUtils.lerp(start.freezeLevel, end.freezeLevel, t);
    this.currentState.ashIntensity = THREE.MathUtils.lerp(start.ashIntensity ?? 0.0, end.ashIntensity ?? 0.0, t);

    // Vector lerp for wind direction
    if (
      this.currentState.windDirection &&
      typeof this.currentState.windDirection.copy === 'function' &&
      start.windDirection &&
      end.windDirection
    ) {
      this.currentState.windDirection.copy(start.windDirection).lerp(end.windDirection, t).normalize();
    } else if (this.currentState.windDirection && start.windDirection && end.windDirection) {
      const x = THREE.MathUtils.lerp(start.windDirection.x, end.windDirection.x, t);
      const y = THREE.MathUtils.lerp(start.windDirection.y, end.windDirection.y, t);
      const len = Math.max(1e-6, Math.sqrt(x * x + y * y));
      this.currentState.windDirection.x = x / len;
      this.currentState.windDirection.y = y / len;
    }

    // Discrete jump for PrecipType (change at 50%)
    if (t > 0.5) {
      this.currentState.precipType = end.precipType;
    }
  }

  /**
   * Apply noise-based variability to the current state
   * @param {number} time - Current absolute time
   * @param {number} dt - Delta time
   * @private
   */
  _hashFloat01(n) {
    // Deterministic pseudo-random hash -> [0,1). Keep this allocation-free and fast.
    // n is expected to be an integer (or close to it).
    const s = Math.sin(n * 127.1 + 311.7) * 43758.5453123;
    return s - Math.floor(s);
  }

  _valueNoise1D01(x) {
    // 1D value noise in [0,1] using smooth interpolation between hashed lattice points.
    const x0 = Math.floor(x);
    const xf = x - x0;
    const u = xf * xf * (3.0 - 2.0 * xf); // smoothstep
    const a = this._hashFloat01(x0);
    const b = this._hashFloat01(x0 + 1);
    return a + (b - a) * u;
  }

  _fbm1D01(x, octaves = 3) {
    // Fractal Brownian Motion (FBM) over 1D value noise -> [0,1].
    // Using lacunarity=2, gain=0.5 to approximate pink-ish noise.
    let sum = 0.0;
    let amp = 1.0;
    let freq = 1.0;
    let norm = 0.0;

    for (let i = 0; i < octaves; i++) {
      sum += this._valueNoise1D01(x * freq) * amp;
      norm += amp;
      amp *= 0.5;
      freq *= 2.0;
    }

    return norm > 0 ? (sum / norm) : 0.0;
  }

  _getPinkNoise01(time) {
    return this._fbm1D01(time, 3);
  }

  _applyVariability(time, dt) {
    const baseVar = this.variability;

    // --- Gust State Machine ---
    this.gustTimer -= dt;
    if (this.gustTimer <= 0) {
      // Toggle state
      this.isGusting = !this.isGusting;
      
      if (this.isGusting) {
        // Start Gust
        this.gustTimer = this.gustDuration;
        // log.debug('Gust started');
      } else {
        // Start Wait
        // Random wait between min and max
        const range = Math.max(0, this.gustWaitMax - this.gustWaitMin);
        this.gustTimer = this.gustWaitMin + Math.random() * range;
        // log.debug(`Gust ended. Waiting ${this.gustTimer.toFixed(1)}s`);
      }
    }

    // Smoothly attack/decay the gust strength scalar
    const targetGust = this.isGusting ? 1.0 : 0.0;
    // Attack fast, decay with a longer tail so gust-driven motion "coasts".
    // Use exponential smoothing so behavior is framerate independent.
    const attackRate = 6.0;
    const decayRate = 0.8;
    const rate = this.isGusting ? attackRate : decayRate;
    const k = 1.0 - Math.exp(-Math.max(0.0, rate) * Math.max(0.0, dt));
    this.currentGustStrength += (targetGust - this.currentGustStrength) * k;


    // --- Noise Generation ---
    
    // 1. Base Meander (Always active, low frequency)
    // Gives the wind a "living" feeling even when not gusting
    const meanderNoiseSigned = (this._getPinkNoise01(time * 0.06 + this.noiseOffset) * 2.0 - 1.0);
    const meander = meanderNoiseSigned * baseVar * 0.1;

    // 2. Gust Noise (High frequency turbulence)
    // Only audible/visible when gust strength is high
    // FBM gives organic "texture" without the pendulum wobble of sine waves.
    // Keep this as a 0..1 envelope so gusts can only ADD energy.
    const gustNoise01 = this._getPinkNoise01(time * 0.9 + this.noiseOffset * 10.0);
    // Multiply by baseVar and gustStrength so the overall "Variability" slider and wind UI both scale this.
    const gustComponent = gustNoise01 * this.currentGustStrength * (baseVar * 2.0) * this.gustStrength;


    // --- Apply to State ---

    // Wind Speed = Target + Meander + Gust
    // We scale the add-ons by the target speed so 0 wind doesn't have gusts (unless we want it to?)
    // Let's allow gusts to exist even at low wind, but maybe scale them slightly so they aren't overwhelming
    const windBase = this.targetState.windSpeed;
    // Allow gusts to boost speed significantly, but clamp to 0..1
    // The '0.2' ensures that even at 0 target wind, we can get small breezes if variability is high
    const magnitudeScale = Math.min(1.0, windBase + 0.2); 

    // Apply meander as signed (small) variation, but apply gust as strictly additive boost.
    // This guarantees: during gusts, windSpeed never decreases relative to the non-gusting baseline.
    const baseSpeed = windBase + meander * magnitudeScale;
    const gustBoost = gustComponent * magnitudeScale;
    let newSpeed = baseSpeed + gustBoost;
    this.currentState.windSpeed = THREE.MathUtils.clamp(newSpeed, 0, 1);


    // Wind Direction = Target + Meander
    // IMPORTANT: do NOT integrate from currentState each frame (random-walk drift can eventually reverse wind).
    // Instead, treat variability as a bounded perturbation around the *target* direction.
    const dirNoiseSigned = (this._getPinkNoise01(time * 0.04 + this.noiseOffset * 3.0 + 100.0) * 2.0 - 1.0);
    const dirMeander = dirNoiseSigned * baseVar * 0.5; // Radians
    // windDirection is stored in Foundry/world coordinates (Y-down).
    // Convert to a math angle (Y-up) for perturbation, then convert back.
    const baseAngle = Math.atan2(-this.targetState.windDirection.y, this.targetState.windDirection.x);
    const newAngle = baseAngle + dirMeander;
    this.currentState.windDirection.set(Math.cos(newAngle), -Math.sin(newAngle));

    // Ash Intensity = Target + subtle noise variation
    // Only modulate if target ashIntensity > 0 so idle scenes aren't affected.
    const targetAsh = this.targetState.ashIntensity ?? 0.0;
    if (targetAsh > 0) {
      const ashNoiseSigned = (this._getPinkNoise01(time * 0.08 + this.noiseOffset * 5.0 + 200.0) * 2.0 - 1.0);
      // Bounded perturbation: ±15% of variability around target, clamped to [0, 1]
      const ashMeander = ashNoiseSigned * baseVar * 0.15;
      this.currentState.ashIntensity = THREE.MathUtils.clamp(targetAsh + ashMeander, 0.0, 1.0);
    }
  }

  /**
   * Update wetness logic (accumulation/drying)
   * @param {number} dt 
   * @private
   */
  _updateWetness(dt) {
    const cs = this.currentState;
    const tuning = this.wetnessTuning;

    // Determine target wetness from current (possibly interpolated) precipitation.
    // Only rain creates surface wetness; snow/hail/ash don't (frost handles cold).
    // During a weather transition, currentState.precipitation is being lerped —
    // we intentionally track it in real-time rather than waiting for the transition
    // to finish. The slow wetting/drying rates (30s / 180s) already provide
    // natural lag, so wetness barely moves during a typical 13s transition.
    // A holdoff would deadlock wetness when dynamic weather runs back-to-back
    // transitions with no gap.
    const isRain = cs.precipType === PrecipitationType.RAIN;
    const precip = isRain ? cs.precipitation : 0.0;
    const targetWetness = precip > tuning.precipThreshold
      ? Math.min(1.0, precip)
      : 0.0;

    // --- Wetting / Drying ---
    const current = cs.wetness;
    const diff = targetWetness - current;

    // Close enough — snap and stop.
    if (Math.abs(diff) < 0.001) {
      cs.wetness = targetWetness;
      return;
    }

    if (diff > 0) {
      // Wetting: accumulate proportional to precipitation intensity.
      // At precip=1.0 → full wet in wettingDuration seconds.
      // At precip=0.3 → full wet in wettingDuration / 0.3 ≈ 3.3× longer.
      const effectivePrecip = Math.max(precip, 0.01);
      const rate = effectivePrecip / Math.max(tuning.wettingDuration, 0.1);
      cs.wetness = Math.min(targetWetness, current + rate * dt);
    } else {
      // Drying: constant rate so total drying time is proportional to
      // the distance to travel. Fully wet (1.0) → dry (0.0) takes
      // dryingDuration seconds. Half wet (0.5) → dry takes half as long.
      const rate = 1.0 / Math.max(tuning.dryingDuration, 0.1);
      cs.wetness = Math.max(targetWetness, current - rate * dt);
    }
  }

  /**
   * Transition to a new weather preset
   * @param {WeatherState} targetState 
   * @param {number} duration - Seconds
   */
  transitionTo(targetState, duration = 5.0) {
    const durArg = Number(duration);
    const safeDuration = Number.isFinite(durArg) ? Math.max(0.1, durArg) : 5.0;
    log.info(`Transitioning weather over ${safeDuration}s`);

    const THREE = window.THREE;
    if (!THREE) return;

    const cloneWindDir = (wd) => {
      if (wd instanceof THREE.Vector2) return wd.clone();
      return new THREE.Vector2(wd?.x ?? 1, wd?.y ?? 0);
    };

    // IMPORTANT: Keep startState/targetState object references stable.
    // Other systems (UI/status panels, effects) may hold references to these objects.
    // Replacing them would cause those consumers to read stale values.

    // Copy current state into start state.
    if (!this.startState || typeof this.startState !== 'object') {
      this.startState = { ...this.currentState };
    }
    // IMPORTANT: avoid aliasing windDirection objects (spread copy keeps references).
    // startState must not share the same Vector2 instance as currentState.
    if (!(this.startState.windDirection instanceof THREE.Vector2) || this.startState.windDirection === this.currentState.windDirection) {
      this.startState.windDirection = cloneWindDir(this.currentState.windDirection);
    }
    this._copyState(this.currentState, this.startState);

    // Copy provided target state into targetState.
    if (!this.targetState || typeof this.targetState !== 'object') {
      this.targetState = { ...this.currentState };
    }
    // targetState must not share the same Vector2 instance as currentState.
    if (!(this.targetState.windDirection instanceof THREE.Vector2) || this.targetState.windDirection === this.currentState.windDirection) {
      this.targetState.windDirection = cloneWindDir(targetState?.windDirection ?? this.currentState.windDirection);
    }

    this.targetState.precipitation = Number(targetState?.precipitation) || 0.0;
    this.targetState.cloudCover = Number(targetState?.cloudCover) || 0.0;
    this.targetState.windSpeed = Number(targetState?.windSpeed) || 0.0;
    this.targetState.fogDensity = Number(targetState?.fogDensity) || 0.0;
    this.targetState.freezeLevel = Number(targetState?.freezeLevel) || 0.0;
    this.targetState.ashIntensity = Number(targetState?.ashIntensity) || 0.0;

    const wd = targetState?.windDirection;
    if (wd && this.targetState.windDirection?.set) {
      this.targetState.windDirection.set(Number(wd.x) || 1, Number(wd.y) || 0);
      this.targetState.windDirection.normalize();
    }

    // Preserve explicitly provided discrete fields if present; otherwise derive.
    if (Number.isFinite(targetState?.precipType)) {
      this.targetState.precipType = Number(targetState.precipType) || 0;
    } else {
      if (this.targetState.precipitation < 0.05) this.targetState.precipType = PrecipitationType.NONE;
      else if (this.targetState.freezeLevel > 0.55) this.targetState.precipType = PrecipitationType.SNOW;
      else this.targetState.precipType = PrecipitationType.RAIN;
    }
    if (Number.isFinite(targetState?.wetness)) {
      this.targetState.wetness = Number(targetState.wetness) || 0.0;
    }

    this.transitionDuration = safeDuration;
    this.transitionElapsed = 0;
    this.isTransitioning = true;
  }

  /**
   * Set variability of the weather
   * @param {number} value - 0.0 to 1.0
   */
  setVariability(value) {
    this.variability = THREE.MathUtils.clamp(value, 0, 1);
  }

  /**
   * Set the time of day
   * @param {number} hour - 0.0 to 24.0
   */
  setTime(hour) {
    this.timeOfDay = hour % 24;
  }

  /**
   * Set the season
   * @param {string} seasonID 
   */
  setSeason(seasonID) {
    this.season = seasonID;
    // TODO: Trigger asset reload or palette swap
  }

  /**
   * Get the current weather state for shader uniforms
   * @returns {WeatherState}
   */
  getCurrentState() {
    if (this.enabled === false && this.dynamicEnabled !== true) return this._disabledState;
    return this.currentState;
  }

  /**
   * Get the control schema for Tweakpane
   * @returns {Object} Control schema
   */
  static getControlSchema() {
    return {
      enabled: true,
      parameters: {
        presetTransitionDurationMinutes: {
          label: 'Preset Transition (min)',
          default: 0.5,
          min: 0.5,
          max: 60.0,
          step: 0.5,
          group: 'transitions'
        },
        dynamicEnabled: {
          label: 'Dynamic Weather',
          default: false,
          type: 'boolean',
          group: 'dynamic'
        },
        dynamicPresetId: {
          label: 'Biome Preset',
          default: 'Temperate Plains',
          options: {
            'Temperate Plains': 'Temperate Plains',
            Desert: 'Desert',
            'Tropical Jungle': 'Tropical Jungle',
            Tundra: 'Tundra',
            'Arctic Blizzard': 'Arctic Blizzard'
          },
          group: 'dynamic'
        },
        dynamicEvolutionSpeed: {
          label: 'Evolution Speed (x)',
          default: 15.0,
          min: 0.0,
          max: 600.0,
          step: 1.0,
          group: 'dynamic'
        },
        dynamicPaused: {
          label: 'Pause Evolution',
          default: false,
          type: 'boolean',
          group: 'dynamic'
        },
        dynamicPlanDurationMinutes: {
          label: 'Transition Duration (min)',
          default: 6.0,
          min: 0.1,
          max: 60.0,
          step: 0.1,
          group: 'dynamic'
        },
        dynamicBoundsEnabled: {
          label: 'Clamp To Bounds',
          default: false,
          type: 'boolean',
          group: 'dynamicBounds',
          gmOnly: true
        },
        dynamicBoundsPrecipitationMin: { label: 'Precip Min', default: 0.0, min: 0.0, max: 1.0, step: 0.01, group: 'dynamicBounds', gmOnly: true },
        dynamicBoundsPrecipitationMax: { label: 'Precip Max', default: 1.0, min: 0.0, max: 1.0, step: 0.01, group: 'dynamicBounds', gmOnly: true },
        dynamicBoundsCloudCoverMin: { label: 'Cloud Min', default: 0.0, min: 0.0, max: 1.0, step: 0.01, group: 'dynamicBounds', gmOnly: true },
        dynamicBoundsCloudCoverMax: { label: 'Cloud Max', default: 1.0, min: 0.0, max: 1.0, step: 0.01, group: 'dynamicBounds', gmOnly: true },
        dynamicBoundsWindSpeedMin: { label: 'Wind Min', default: 0.0, min: 0.0, max: 1.0, step: 0.01, group: 'dynamicBounds', gmOnly: true },
        dynamicBoundsWindSpeedMax: { label: 'Wind Max', default: 1.0, min: 0.0, max: 1.0, step: 0.01, group: 'dynamicBounds', gmOnly: true },
        dynamicBoundsFogDensityMin: { label: 'Fog Min', default: 0.0, min: 0.0, max: 1.0, step: 0.01, group: 'dynamicBounds', gmOnly: true },
        dynamicBoundsFogDensityMax: { label: 'Fog Max', default: 1.0, min: 0.0, max: 1.0, step: 0.01, group: 'dynamicBounds', gmOnly: true },
        dynamicBoundsFreezeLevelMin: { label: 'Temp Min', default: 0.0, min: 0.0, max: 1.0, step: 0.01, group: 'dynamicBounds', gmOnly: true },
        dynamicBoundsFreezeLevelMax: { label: 'Temp Max', default: 1.0, min: 0.0, max: 1.0, step: 0.01, group: 'dynamicBounds', gmOnly: true },

        queuedPrecipitation: { label: 'Precipitation', default: 0.88, min: 0.0, max: 1.0, step: 0.01, group: 'queued', gmOnly: true },
        queuedCloudCover: { label: 'Cloud Cover', default: 0.93, min: 0.0, max: 1.0, step: 0.01, group: 'queued', gmOnly: true },
        queuedWindSpeed: { label: 'Wind Speed', default: 0.1, min: 0.0, max: 1.0, step: 0.01, group: 'queued', gmOnly: true },
        queuedWindDirection: { label: 'Wind Direction (deg)', default: 205.0, min: 0.0, max: 360.0, step: 1.0, group: 'queued', gmOnly: true },
        queuedFogDensity: { label: 'Fog Density', default: 0.0, min: 0.0, max: 1.0, step: 0.01, group: 'queued', gmOnly: true },
        queuedFreezeLevel: { label: 'Temperature (Rain <-> Snow)', default: 0.0, min: 0.0, max: 1.0, step: 0.01, group: 'queued', gmOnly: true },
        queuedAshIntensity: { label: 'Ash Intensity', default: 0.0, min: 0.0, max: 1.0, step: 0.01, group: 'queued', gmOnly: true },
        queueFromCurrent: { type: 'button', title: 'Queue From Current', group: 'queued', gmOnly: true },
        startQueuedTransition: { type: 'button', title: 'Start Transition', group: 'queued', gmOnly: true },
        enabled: {
          label: 'Enabled',
          default: true,
          type: 'boolean'
        },
        // Transition Controls
        transitionDuration: {
          label: 'Transition Time (s)',
          default: 13.3,
          min: 0.1,
          max: 60.0,
          step: 0.1,
          group: 'transitions'
        },
        
        // Variability
        variability: {
          label: 'Variability',
          default: 0.7,
          min: 0.0,
          max: 1.0,
          step: 0.01,
          group: 'simulation'
        },
        simulationSpeed: {
          label: 'Simulation Speed',
          default: 1.0,
          min: 0.05,
          max: 3.0,
          step: 0.05,
          group: 'simulation'
        },

        // State Override (Manual Control)
        precipitation: {
          label: 'Precipitation',
          default: 0.0,
          min: 0.0,
          max: 1.0,
          step: 0.01,
          group: 'state'
        },
        cloudCover: {
          label: 'Cloud Cover',
          default: 0.0,
          min: 0.0,
          max: 1.0,
          step: 0.01,
          group: 'state'
        },
        // Wind base state (moved into dedicated Wind folder)
        windSpeed: {
          label: 'Base Wind Speed',
          default: 0.44,
          min: 0.0,
          max: 1.0,
          step: 0.01,
          group: 'wind'
        },
        windDirection: {
          label: 'Wind Direction (deg)',
          default: 0.0,
          min: 0.0,
          max: 360.0,
          step: 1.0,
          group: 'wind'
        },
        fogDensity: {
          label: 'Fog Density',
          default: 0.0,
          min: 0.0,
          max: 1.0,
          step: 0.01,
          group: 'manual'
        },
        wetness: {
          label: 'Wetness',
          default: 0.0,
          min: 0.0,
          max: 1.0,
          step: 0.01,
          group: 'manual',
          readonly: true
        },
        freezeLevel: {
          label: 'Temperature (Rain <-> Snow)',
          default: 0.0,
          min: 0.0,
          max: 1.0,
          step: 0.01,
          group: 'manual'
        },
        ashIntensity: {
          label: 'Ash Intensity',
          default: 0.0,
          min: 0.0,
          max: 1.0,
          step: 0.01,
          group: 'manual'
        },

        // Wind / Gust tuning
        gustWaitMin: {
          label: 'Gust Pause Min (s)',
          default: 1.0,
          min: 0.0,
          max: 60.0,
          step: 0.5,
          group: 'wind'
        },
        gustWaitMax: {
          label: 'Gust Pause Max (s)',
          default: 11.5,
          min: 0.0,
          max: 120.0,
          step: 0.5,
          group: 'wind'
        },
        gustDuration: {
          label: 'Gust Duration (s)',
          default: 7.4,
          min: 0.1,
          max: 30.0,
          step: 0.1,
          group: 'wind'
        },
        gustStrength: {
          label: 'Gust Strength',
          default: 1.0,
          min: 0.0,
          max: 3.0,
          step: 0.05,
          group: 'wind'
        },

        // Rain tuning
        rainIntensityScale: {
          label: 'Rain Intensity Scale',
          default: 1.0,
          min: 0.0,
          max: 6.0,
          step: 0.05,
          group: 'rain'
        },
        rainStreakLength: {
          label: 'Rain Streak Length',
          default: 0.25,
          min: 0.25,
          max: 2.5,
          step: 0.05,
          group: 'rain'
        },
        rainDropSize: {
          label: 'Rain Drop Size',
          default: 3.1,
          min: 0.5,
          max: 16.0,
          step: 0.05,
          group: 'rain'
        },
        rainDropSizeMin: {
          label: 'Rain Drop Size Min',
          default: 1.4,
          min: 0.5,
          max: 64.0,
          step: 0.1,
          group: 'rain'
        },
        rainDropSizeMax: {
          label: 'Rain Drop Size Max',
          default: 13.8,
          min: 0.5,
          max: 64.0,
          step: 0.1,
          group: 'rain'
        },
        rainBrightness: {
          label: 'Rain Brightness',
          default: 5.7,
          min: 0.1,
          max: 12.0,
          step: 0.05,
          group: 'rain'
        },
        rainGravityScale: {
          label: 'Rain Gravity Scale',
          default: 0.05,
          min: 0.05,
          max: 6.0,
          step: 0.05,
          group: 'rain'
        },
        rainWindInfluence: {
          label: 'Rain Wind Influence',
          default: 0.85,
          min: 0.0,
          max: 4.0,
          step: 0.05,
          group: 'rain'
        },
        rainCurlStrength: {
          label: 'Rain Turbulence Strength',
          default: 4.0,
          min: 0.0,
          max: 4.0,
          step: 0.05,
          group: 'rain'
        },

        // Per-splash (per atlas tile) tuning
        // Splash 1: Thin clean ring
        rainSplash1IntensityScale: {
          label: 'Splash 1 (Thin Ring) Intensity',
          default: 8.45,
          min: 0.0,
          max: 10.0,
          step: 0.05,
          group: 'rain'
        },
        rainSplash1LifeMin: {
          label: 'Splash 1 (Thin Ring) Life Min (s)',
          default: 0.200,
          min: 0.005,
          max: 1.0,
          step: 0.005,
          group: 'rain'
        },
        rainSplash1LifeMax: {
          label: 'Splash 1 (Thin Ring) Life Max (s)',
          default: 0.35,
          min: 0.01,
          max: 1.5,
          step: 0.01,
          group: 'rain'
        },
        rainSplash1SizeMin: {
          label: 'Splash 1 (Thin Ring) Size Min (px)',
          default: 8.0,
          min: 2.0,
          max: 128.0,
          step: 1.0,
          group: 'rain'
        },
        rainSplash1SizeMax: {
          label: 'Splash 1 (Thin Ring) Size Max (px)',
          default: 16.0,
          min: 2.0,
          max: 256.0,
          step: 1.0,
          group: 'rain'
        },
        rainSplash1OpacityPeak: {
          label: 'Splash 1 (Thin Ring) Peak Opacity',
          default: 0.05,
          min: 0.0,
          max: 0.6,
          step: 0.01,
          group: 'rain'
        },

        // Splash 2: Thick broken ring
        rainSplash2IntensityScale: {
          label: 'Splash 2 (Broken Ring) Intensity',
          default: 8.7,
          min: 0.0,
          max: 10.0,
          step: 0.05,
          group: 'rain'
        },
        rainSplash2LifeMin: {
          label: 'Splash 2 (Broken Ring) Life Min (s)',
          default: 0.090,
          min: 0.005,
          max: 1.0,
          step: 0.005,
          group: 'rain'
        },
        rainSplash2LifeMax: {
          label: 'Splash 2 (Broken Ring) Life Max (s)',
          default: 0.22,
          min: 0.01,
          max: 1.5,
          step: 0.01,
          group: 'rain'
        },
        rainSplash2SizeMin: {
          label: 'Splash 2 (Broken Ring) Size Min (px)',
          default: 2.0,
          min: 2.0,
          max: 128.0,
          step: 1.0,
          group: 'rain'
        },
        rainSplash2SizeMax: {
          label: 'Splash 2 (Broken Ring) Size Max (px)',
          default: 3.0,
          min: 2.0,
          max: 256.0,
          step: 1.0,
          group: 'rain'
        },
        rainSplash2OpacityPeak: {
          label: 'Splash 2 (Broken Ring) Peak Opacity',
          default: 0.05,
          min: 0.0,
          max: 0.6,
          step: 0.01,
          group: 'rain'
        },

        // Splash 3: Droplets-only pattern
        rainSplash3IntensityScale: {
          label: 'Splash 3 (Droplets) Intensity',
          default: 9.1,
          min: 0.0,
          max: 10.0,
          step: 0.05,
          group: 'rain'
        },
        rainSplash3LifeMin: {
          label: 'Splash 3 (Droplets) Life Min (s)',
          default: 0.20,
          min: 0.005,
          max: 1.0,
          step: 0.005,
          group: 'rain'
        },
        rainSplash3LifeMax: {
          label: 'Splash 3 (Droplets) Life Max (s)',
          default: 0.79,
          min: 0.01,
          max: 1.5,
          step: 0.01,
          group: 'rain'
        },
        rainSplash3SizeMin: {
          label: 'Splash 3 (Droplets) Size Min (px)',
          default: 6.0,
          min: 2.0,
          max: 128.0,
          step: 1.0,
          group: 'rain'
        },
        rainSplash3SizeMax: {
          label: 'Splash 3 (Droplets) Size Max (px)',
          default: 27.0,
          min: 2.0,
          max: 256.0,
          step: 1.0,
          group: 'rain'
        },
        rainSplash3OpacityPeak: {
          label: 'Splash 3 (Droplets) Peak Opacity',
          default: 0.12,
          min: 0.0,
          max: 0.6,
          step: 0.01,
          group: 'rain'
        },

        // Splash 4: Inner puddle
        rainSplash4IntensityScale: {
          label: 'Splash 4 (Puddle) Intensity',
          default: 9.25,
          min: 0.0,
          max: 10.0,
          step: 0.05,
          group: 'rain'
        },
        rainSplash4LifeMin: {
          label: 'Splash 4 (Puddle) Life Min (s)',
          default: 0.305,
          min: 0.005,
          max: 1.0,
          step: 0.005,
          group: 'rain'
        },
        rainSplash4LifeMax: {
          label: 'Splash 4 (Puddle) Life Max (s)',
          default: 1.40,
          min: 0.01,
          max: 1.5,
          step: 0.01,
          group: 'rain'
        },
        rainSplash4SizeMin: {
          label: 'Splash 4 (Puddle) Size Min (px)',
          default: 10.0,
          min: 2.0,
          max: 128.0,
          step: 1.0,
          group: 'rain'
        },
        rainSplash4SizeMax: {
          label: 'Splash 4 (Puddle) Size Max (px)',
          default: 24.0,
          min: 2.0,
          max: 256.0,
          step: 1.0,
          group: 'rain'
        },
        rainSplash4OpacityPeak: {
          label: 'Splash 4 (Puddle) Peak Opacity',
          default: 0.02,
          min: 0.0,
          max: 0.6,
          step: 0.01,
          group: 'rain'
        },

        // Snow tuning
        snowIntensityScale: {
          label: 'Snow Intensity Scale',
          default: 3.0,
          min: 0.0,
          max: 6.0,
          step: 0.05,
          group: 'snow'
        },
        snowFlakeSize: {
          label: 'Snow Flake Size',
          default: 1.5,
          min: 0.05,
          max: 3.0,
          step: 0.05,
          group: 'snow'
        },
        snowBrightness: {
          label: 'Snow Brightness',
          default: 1.0,
          min: 0.1,
          max: 3.0,
          step: 0.05,
          group: 'snow'
        },
        snowGravityScale: {
          label: 'Snow Gravity Scale',
          default: 0.01,
          min: 0.01,
          max: 3.0,
          step: 0.05,
          group: 'snow'
        },
        snowWindInfluence: {
          label: 'Snow Wind Influence',
          default: 0.85,
          min: 0.0,
          max: 2.0,
          step: 0.05,
          group: 'snow'
        },
        snowCurlStrength: {
          label: 'Snow Curl Strength',
          default: 11.25,
          min: 0.0,
          max: 12.0,
          step: 0.05,
          group: 'snow'
        },
        snowFlutterStrength: {
          label: 'Snow Flutter Strength',
          default: 4.65,
          min: 0.0,
          max: 6.0,
          step: 0.05,
          group: 'snow'
        },

        // Wetness Tracker tuning
        wettingDuration: {
          label: 'Wetting Duration (s)',
          default: 30.0,
          min: 1.0,
          max: 120.0,
          step: 1.0,
          group: 'wetness'
        },
        dryingDuration: {
          label: 'Drying Duration (s)',
          default: 180.0,
          min: 10.0,
          max: 600.0,
          step: 5.0,
          group: 'wetness'
        },
        precipThreshold: {
          label: 'Rain Threshold',
          default: 0.05,
          min: 0.0,
          max: 0.5,
          step: 0.01,
          group: 'wetness'
        },

        // Roof/Indoors mask control
        roofMaskForceEnabled: {
          label: 'Force Indoor Mask',
          default: false,
          type: 'boolean',
          group: 'environment'
        }
      },
      groups: [
        { label: 'Dynamic Weather', type: 'folder', parameters: ['dynamicEnabled', 'dynamicPresetId', 'dynamicEvolutionSpeed', 'dynamicPaused'], expanded: true },
        { label: 'Dynamic Bounds (GM)', type: 'folder', parameters: [
          'dynamicBoundsEnabled',
          'dynamicBoundsPrecipitationMin',
          'dynamicBoundsPrecipitationMax',
          'dynamicBoundsCloudCoverMin',
          'dynamicBoundsCloudCoverMax',
          'dynamicBoundsWindSpeedMin',
          'dynamicBoundsWindSpeedMax',
          'dynamicBoundsFogDensityMin',
          'dynamicBoundsFogDensityMax',
          'dynamicBoundsFreezeLevelMin',
          'dynamicBoundsFreezeLevelMax'
        ], expanded: false },
        { label: 'GM Transition', type: 'folder', parameters: [
          'transitionDuration',
          'queuedPrecipitation',
          'queuedCloudCover',
          'queuedWindSpeed',
          'queuedWindDirection',
          'queuedFogDensity',
          'queuedFreezeLevel',
          'queueFromCurrent',
          'startQueuedTransition'
        ], expanded: false },
        { label: 'Environment', type: 'folder', parameters: ['roofMaskForceEnabled'] },
        { label: 'Simulation', type: 'folder', parameters: ['variability', 'transitionDuration', 'simulationSpeed'] },
        { label: 'Fog', type: 'folder', parameters: ['fogDensity'], expanded: true },
        { label: 'Manual Override', type: 'folder', parameters: ['precipitation', 'cloudCover', 'wetness', 'freezeLevel'], expanded: true },
        { label: 'Wetness', type: 'folder', parameters: ['wettingDuration', 'dryingDuration', 'precipThreshold'] },
        { label: 'Wind', type: 'folder', parameters: ['windSpeed', 'windDirection', 'gustWaitMin', 'gustWaitMax', 'gustDuration', 'gustStrength'], expanded: true },
        { label: 'Rain', type: 'folder', parameters: [
          'rainIntensityScale',
          'rainStreakLength',
          'rainDropSize',
          'rainDropSizeMin',
          'rainDropSizeMax',
          'rainBrightness',
          'rainGravityScale',
          'rainWindInfluence',
          'rainCurlStrength'
        ] },
        { label: 'Rain Splashes', type: 'folder', parameters: [
          'rainSplash1IntensityScale',
          'rainSplash1LifeMin',
          'rainSplash1LifeMax',
          'rainSplash1SizeMin',
          'rainSplash1SizeMax',
          'rainSplash1OpacityPeak',
          'rainSplash2IntensityScale',
          'rainSplash2LifeMin',
          'rainSplash2LifeMax',
          'rainSplash2SizeMin',
          'rainSplash2SizeMax',
          'rainSplash2OpacityPeak',
          'rainSplash3IntensityScale',
          'rainSplash3LifeMin',
          'rainSplash3LifeMax',
          'rainSplash3SizeMin',
          'rainSplash3SizeMax',
          'rainSplash3OpacityPeak',
          'rainSplash4IntensityScale',
          'rainSplash4LifeMin',
          'rainSplash4LifeMax',
          'rainSplash4SizeMin',
          'rainSplash4SizeMax',
          'rainSplash4OpacityPeak'
        ] },
        { label: 'Snow', type: 'folder', parameters: ['snowIntensityScale', 'snowFlakeSize', 'snowBrightness', 'snowGravityScale', 'snowWindInfluence', 'snowCurlStrength', 'snowFlutterStrength'] }
      ],
      presets: {
        'Clear (Dry)': { precipitation: 0.0, cloudCover: 0.05, windSpeed: 0.08, fogDensity: 0.0, freezeLevel: 0.0 },
        'Clear (Breezy)': { precipitation: 0.0, cloudCover: 0.15, windSpeed: 0.35, fogDensity: 0.02, freezeLevel: 0.0 },
        'Partly Cloudy': { precipitation: 0.0, cloudCover: 0.35, windSpeed: 0.15, fogDensity: 0.03, freezeLevel: 0.0 },
        'Overcast (Light)': { precipitation: 0.0, cloudCover: 0.65, windSpeed: 0.15, fogDensity: 0.08, freezeLevel: 0.0 },
        'Overcast (Heavy)': { precipitation: 0.1, cloudCover: 0.9, windSpeed: 0.22, fogDensity: 0.12, freezeLevel: 0.0 },
        'Mist': { precipitation: 0.0, cloudCover: 0.35, windSpeed: 0.05, fogDensity: 0.55, freezeLevel: 0.0 },
        'Fog (Dense)': { precipitation: 0.0, cloudCover: 0.5, windSpeed: 0.03, fogDensity: 0.85, freezeLevel: 0.0 },
        'Drizzle': { precipitation: 0.18, cloudCover: 0.7, windSpeed: 0.18, fogDensity: 0.14, freezeLevel: 0.0 },
        'Light Rain': { precipitation: 0.35, cloudCover: 0.75, windSpeed: 0.25, fogDensity: 0.18, freezeLevel: 0.0 },
        'Rain': { precipitation: 0.55, cloudCover: 0.85, windSpeed: 0.35, fogDensity: 0.22, freezeLevel: 0.0 },
        'Heavy Rain': { precipitation: 0.78, cloudCover: 0.95, windSpeed: 0.55, fogDensity: 0.28, freezeLevel: 0.0 },
        'Thunderstorm': { precipitation: 0.92, cloudCover: 1.0, windSpeed: 0.75, fogDensity: 0.35, freezeLevel: 0.0 },
        'Snow Flurries': { precipitation: 0.25, cloudCover: 0.75, windSpeed: 0.22, fogDensity: 0.12, freezeLevel: 0.85 },
        'Snow': { precipitation: 0.55, cloudCover: 0.9, windSpeed: 0.30, fogDensity: 0.16, freezeLevel: 0.95 },
        'Blizzard': { precipitation: 0.92, cloudCover: 1.0, windSpeed: 0.85, fogDensity: 0.25, freezeLevel: 1.0 },
        'Light Ash Fall': { precipitation: 0.0, cloudCover: 0.6, windSpeed: 0.15, fogDensity: 0.08, freezeLevel: 0.0, ashIntensity: 0.3 },
        'Ash Fall': { precipitation: 0.0, cloudCover: 0.8, windSpeed: 0.25, fogDensity: 0.18, freezeLevel: 0.0, ashIntensity: 0.6 },
        'Heavy Ash Fall': { precipitation: 0.0, cloudCover: 0.95, windSpeed: 0.4, fogDensity: 0.3, freezeLevel: 0.0, ashIntensity: 0.85 },
        'Volcanic Storm': { precipitation: 0.15, cloudCover: 1.0, windSpeed: 0.65, fogDensity: 0.45, freezeLevel: 0.0, ashIntensity: 1.0 }
      }
    };
  }
}

// Create singleton instance
export const weatherController = new WeatherController();
