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
      windSpeed: 0.0,
      windDirection: { x: 1, y: 0 }, // Placeholder, upgraded to Vector2 in initialize()
      fogDensity: 0.0,
      wetness: 0.0,
      freezeLevel: 0.0
    };

    /** @type {WeatherState} */
    this.targetState = { ...this.currentState, windDirection: { ...this.currentState.windDirection } };

    /** @type {WeatherState} */
    this.startState = { ...this.currentState, windDirection: { ...this.currentState.windDirection } };

    // Transition tracking
    this.transitionDuration = 0;
    this.transitionElapsed = 0;
    this.isTransitioning = false;

    // Variability (Wanderer Loop)
    this.variability = 0.7; // Tuned variability
    this.noiseOffset = 0;

    // Wind Gust System
    this.gustWaitMin = 5.0;   // Seconds to wait between gusts (min)
    this.gustWaitMax = 13.5;  // Seconds to wait between gusts (max)
    this.gustDuration = 2.8;  // Duration of a gust
    this.gustTimer = 0;       // Countdown timer
    this.isGusting = false;   // Current state
    this.currentGustStrength = 0; // Smoothed gust value
    this.gustStrength = 0.7;      // Multiplier for how strong gusts are compared to base wind

    // Time of Day (0-24)
    this.timeOfDay = 6.6; // Tuned time of day

    // Season
    this.season = 'SUMMER';

    this.initialized = false;

    /** @type {boolean} Whether weather effects should currently apply the roof/outdoors mask */
    this.roofMaskActive = false;

    /** @type {boolean} Manual override to force indoor/roof mask for weather at all times */
    this.roofMaskForceEnabled = false;

    /** @type {number} Global simulation speed scalar for Quarks-based effects (weather, fire, etc.). */
    this.simulationSpeed = 1.0;

    // Per-system tuning parameters for precipitation visuals
    this.rainTuning = {
      intensityScale: 1.0,
      streakLength: 0.25,
      dropSize: 6.1,
      dropSizeMin: 1.4,
      dropSizeMax: 13.8,
      brightness: 0.8,
      gravityScale: 6.0,
      windInfluence: 1.6,
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
      splash1IntensityScale: 0.85,
      splash1LifeMin: 0.20,
      splash1LifeMax: 0.35,
      splash1SizeMin: 8.0,
      splash1SizeMax: 16.0,
      splash1OpacityPeak: 0.01,

      // Splash 2: Thick broken ring
      splash2IntensityScale: 0.10,
      splash2LifeMin: 0.09,
      splash2LifeMax: 0.22,
      splash2SizeMin: 2.0,
      splash2SizeMax: 3.0,
      splash2OpacityPeak: 0.01,

      // Splash 3: Droplets-only pattern
      splash3IntensityScale: 5.95,
      splash3LifeMin: 0.06,
      splash3LifeMax: 1.50,
      splash3SizeMin: 6.0,
      splash3SizeMax: 17.0,
      splash3OpacityPeak: 0.04,

      // Splash 4: Inner puddle
      splash4IntensityScale: 1.10,
      splash4LifeMin: 0.305,
      splash4LifeMax: 1.40,
      splash4SizeMin: 10.0,
      splash4SizeMax: 24.0,
      splash4OpacityPeak: 0.01
    };

    this.snowTuning = {
      intensityScale: 1.0,
      flakeSize: 0.6,
      brightness: 1.0,
      gravityScale: 0.41,
      windInfluence: 0.35,
      curlStrength: 2.5,
      flutterStrength: 2.0
    };
  }

  /**
   * Initialize the controller
   */
  initialize() {
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

    log.info('WeatherController initialized');
    this.initialized = true;
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
    }
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
      
    } catch (e) {
      log.warn('Failed to extract roof mask data:', e);
      this.roofMaskData = null;
    }
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

    const dt = timeInfo.delta;
    const elapsed = timeInfo.elapsed;

    // 1. Calculate Base State (Transition or Static)
    if (this.isTransitioning) {
      this.transitionElapsed += dt;
      const progress = Math.min(this.transitionElapsed / this.transitionDuration, 1.0);
      
      // Cubic ease-in-out for smoother transitions
      const t = progress < 0.5 
        ? 4 * progress * progress * progress 
        : 1 - Math.pow(-2 * progress + 2, 3) / 2;

      this._lerpState(this.startState, this.targetState, t);

      if (progress >= 1.0) {
        this.isTransitioning = false;
        log.debug('Weather transition complete');
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
    // wetness is derived, don't copy (or handle separately)
    
    if (source.windDirection && dest.windDirection) {
      dest.windDirection.copy(source.windDirection);
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
    this.currentState.precipitation = THREE.MathUtils.lerp(start.precipitation, end.precipitation, t);
    this.currentState.cloudCover = THREE.MathUtils.lerp(start.cloudCover, end.cloudCover, t);
    this.currentState.windSpeed = THREE.MathUtils.lerp(start.windSpeed, end.windSpeed, t);
    this.currentState.fogDensity = THREE.MathUtils.lerp(start.fogDensity, end.fogDensity, t);
    this.currentState.freezeLevel = THREE.MathUtils.lerp(start.freezeLevel, end.freezeLevel, t);

    // Vector lerp for wind direction
    this.currentState.windDirection.copy(start.windDirection).lerp(end.windDirection, t).normalize();

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
    // Attack fast (3.0), decay slower (1.0)
    const lerpSpeed = this.isGusting ? 3.0 : 1.0; 
    this.currentGustStrength += (targetGust - this.currentGustStrength) * lerpSpeed * dt;


    // --- Noise Generation ---
    
    // 1. Base Meander (Always active, low frequency)
    // Gives the wind a "living" feeling even when not gusting
    const meander = Math.sin(time * 0.2 + this.noiseOffset) * baseVar * 0.1;

    // 2. Gust Noise (High frequency turbulence)
    // Only audible/visible when gust strength is high
    // Composite sine waves for "ragged" feel
    const gustNoiseRaw = (
      Math.sin(time * 3.0 + this.noiseOffset * 2) * 0.5 + 
      Math.cos(time * 7.0 + this.noiseOffset * 3) * 0.25 +
      Math.sin(time * 1.3) * 0.25
    );
    
    // Modulate gust noise by the smooth gust strength envelope
    // Multiply by baseVar and gustStrength so the overall "Variability" slider and wind UI both scale this
    const gustComponent = gustNoiseRaw * this.currentGustStrength * (baseVar * 2.0) * this.gustStrength;


    // --- Apply to State ---

    // Wind Speed = Target + Meander + Gust
    // We scale the add-ons by the target speed so 0 wind doesn't have gusts (unless we want it to?)
    // Let's allow gusts to exist even at low wind, but maybe scale them slightly so they aren't overwhelming
    const windBase = this.targetState.windSpeed;
    // Allow gusts to boost speed significantly, but clamp to 0..1
    // The '0.2' ensures that even at 0 target wind, we can get small breezes if variability is high
    const magnitudeScale = Math.min(1.0, windBase + 0.2); 

    let newSpeed = windBase + (meander + gustComponent) * magnitudeScale;
    this.currentState.windSpeed = THREE.MathUtils.clamp(newSpeed, 0, 1);


    // Wind Direction = Target + Meander
    // Gusts usually push in the primary direction, so we mainly perturb direction with the slow meander
    const dirMeander = Math.cos(time * 0.15 + this.noiseOffset) * baseVar * 0.5; // Radians
    const currentAngle = Math.atan2(this.currentState.windDirection.y, this.currentState.windDirection.x);
    const newAngle = currentAngle + dirMeander;
    
    this.currentState.windDirection.set(Math.cos(newAngle), Math.sin(newAngle));
  }

  /**
   * Update wetness logic (accumulation/drying)
   * @param {number} dt 
   * @private
   */
  _updateWetness(dt) {
    // If raining, wetness increases fast
    // If dry, wetness decreases slow
    const targetWetness = this.currentState.precipitation > 0.1 ? 1.0 : 0.0;
    const rate = targetWetness > this.currentState.wetness 
      ? 0.2 // Wetting rate (5 seconds to full wet)
      : 0.05; // Drying rate (20 seconds to dry)

    this.currentState.wetness = THREE.MathUtils.damp(
      this.currentState.wetness,
      targetWetness,
      rate,
      dt
    );
  }

  /**
   * Transition to a new weather preset
   * @param {WeatherState} targetState 
   * @param {number} duration - Seconds
   */
  transitionTo(targetState, duration = 5.0) {
    log.info(`Transitioning weather over ${duration}s`);
    
    // Deep copy current state as start
    this.startState = { 
      ...this.currentState,
      windDirection: this.currentState.windDirection.clone()
    };
    
    // Set target
    this.targetState = {
      ...targetState,
      windDirection: targetState.windDirection instanceof THREE.Vector2 
        ? targetState.windDirection.clone() 
        : new THREE.Vector2(targetState.windDirection.x, targetState.windDirection.y)
    };

    this.transitionDuration = duration;
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
        enabled: {
          label: 'Enabled',
          default: true,
          type: 'boolean'
        },
        // Transition Controls
        transitionDuration: {
          label: 'Transition Time (s)',
          default: 5.0,
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
        
        // Time
        timeOfDay: {
          label: 'Time of Day',
          default: 6.6,
          min: 0.0,
          max: 24.0,
          step: 0.1,
          group: 'environment'
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
          default: 0.0,
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

        // Wind / Gust tuning
        gustWaitMin: {
          label: 'Gust Pause Min (s)',
          default: 5.0,
          min: 0.0,
          max: 60.0,
          step: 0.5,
          group: 'wind'
        },
        gustWaitMax: {
          label: 'Gust Pause Max (s)',
          default: 13.5,
          min: 0.0,
          max: 120.0,
          step: 0.5,
          group: 'wind'
        },
        gustDuration: {
          label: 'Gust Duration (s)',
          default: 2.8,
          min: 0.1,
          max: 30.0,
          step: 0.1,
          group: 'wind'
        },
        gustStrength: {
          label: 'Gust Strength',
          default: 0.7,
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
          default: 6.1,
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
          default: 0.8,
          min: 0.1,
          max: 12.0,
          step: 0.05,
          group: 'rain'
        },
        rainGravityScale: {
          label: 'Rain Gravity Scale',
          default: 6.0,
          min: 0.2,
          max: 6.0,
          step: 0.05,
          group: 'rain'
        },
        rainWindInfluence: {
          label: 'Rain Wind Influence',
          default: 1.6,
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
          default: 0.85,
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
          default: 0.01,
          min: 0.0,
          max: 0.6,
          step: 0.01,
          group: 'rain'
        },

        // Splash 2: Thick broken ring
        rainSplash2IntensityScale: {
          label: 'Splash 2 (Broken Ring) Intensity',
          default: 0.10,
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
          default: 0.01,
          min: 0.0,
          max: 0.6,
          step: 0.01,
          group: 'rain'
        },

        // Splash 3: Droplets-only pattern
        rainSplash3IntensityScale: {
          label: 'Splash 3 (Droplets) Intensity',
          default: 5.95,
          min: 0.0,
          max: 10.0,
          step: 0.05,
          group: 'rain'
        },
        rainSplash3LifeMin: {
          label: 'Splash 3 (Droplets) Life Min (s)',
          default: 0.060,
          min: 0.005,
          max: 1.0,
          step: 0.005,
          group: 'rain'
        },
        rainSplash3LifeMax: {
          label: 'Splash 3 (Droplets) Life Max (s)',
          default: 1.50,
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
          default: 17.0,
          min: 2.0,
          max: 256.0,
          step: 1.0,
          group: 'rain'
        },
        rainSplash3OpacityPeak: {
          label: 'Splash 3 (Droplets) Peak Opacity',
          default: 0.04,
          min: 0.0,
          max: 0.6,
          step: 0.01,
          group: 'rain'
        },

        // Splash 4: Inner puddle
        rainSplash4IntensityScale: {
          label: 'Splash 4 (Puddle) Intensity',
          default: 1.10,
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
          default: 0.01,
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
          default: 0.6,
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
          default: 0.41,
          min: 0.01,
          max: 3.0,
          step: 0.05,
          group: 'snow'
        },
        snowWindInfluence: {
          label: 'Snow Wind Influence',
          default: 0.35,
          min: 0.0,
          max: 2.0,
          step: 0.05,
          group: 'snow'
        },
        snowCurlStrength: {
          label: 'Snow Curl Strength',
          default: 2.5,
          min: 0.0,
          max: 12.0,
          step: 0.05,
          group: 'snow'
        },
        snowFlutterStrength: {
          label: 'Snow Flutter Strength',
          default: 2.0,
          min: 0.0,
          max: 6.0,
          step: 0.05,
          group: 'snow'
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
        { label: 'Environment', type: 'folder', parameters: ['timeOfDay', 'roofMaskForceEnabled'] },
        { label: 'Simulation', type: 'folder', parameters: ['variability', 'transitionDuration', 'simulationSpeed'] },
        { label: 'Manual Override', type: 'folder', parameters: ['precipitation', 'cloudCover', 'fogDensity', 'wetness', 'freezeLevel'], expanded: true },
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
        'Clear': { precipitation: 0.0, cloudCover: 0.0, windSpeed: 0.1, fogDensity: 0.0 },
        'Overcast': { precipitation: 0.0, cloudCover: 0.8, windSpeed: 0.2, fogDensity: 0.1 },
        'Light Rain': { precipitation: 0.3, cloudCover: 0.6, windSpeed: 0.3, fogDensity: 0.2 },
        'Heavy Storm': { precipitation: 0.9, cloudCover: 1.0, windSpeed: 0.8, fogDensity: 0.4 },
        'Foggy': { precipitation: 0.0, cloudCover: 0.4, windSpeed: 0.0, fogDensity: 0.8 }
      }
    };
  }
}

// Create singleton instance
export const weatherController = new WeatherController();
