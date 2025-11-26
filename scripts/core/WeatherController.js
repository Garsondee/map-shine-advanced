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
    this.variability = 0.2; // Default variability
    this.noiseOffset = 0;

    // Time of Day (0-24)
    this.timeOfDay = 12.0; // Noon

    // Season
    this.season = 'SUMMER';

    this.initialized = false;

    /** @type {boolean} Whether weather effects should currently apply the roof/outdoors mask */
    this.roofMaskActive = false;

    /** @type {boolean} Manual override to force indoor/roof mask for weather at all times */
    this.roofMaskForceEnabled = false;

    /** @type {number} Global simulation speed scalar for Quarks-based effects (weather, fire, etc.). */
    this.simulationSpeed = 2.0;

    // Per-system tuning parameters for precipitation visuals
    this.rainTuning = {
      intensityScale: 2.6,
      streakLength: 0.25,
      dropSize: 8.0,
      brightness: 0.3,
      gravityScale: 3.0,
      windInfluence: 2.0,

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
      splash2OpacityPeak: 0.02,

      // Splash 3: Droplets-only pattern
      splash3IntensityScale: 5.95,
      splash3LifeMin: 0.06,
      splash3LifeMax: 1.50,
      splash3SizeMin: 6.0,
      splash3SizeMax: 17.0,
      splash3OpacityPeak: 0.08,

      // Splash 4: Inner puddle
      splash4IntensityScale: 1.10,
      splash4LifeMin: 0.305,
      splash4LifeMax: 1.40,
      splash4SizeMin: 9.0,
      splash4SizeMax: 24.0,
      splash4OpacityPeak: 0.10
    };

    this.snowTuning = {
      intensityScale: 1.0,
      flakeSize: 1.0,
      brightness: 1.0,
      gravityScale: 0.5,
      windInfluence: 1.0,
      curlStrength: 1.0,
      flutterStrength: 1.0
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
      this._applyVariability(elapsed);
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
   * @private
   */
  _applyVariability(time) {
    // Use sine waves as a cheap substitute for Perlin noise for now, 
    // or assume we have a noise library available.
    // For now, simple sine composition for "wandering"
    
    const base = this.variability;
    const noise1 = Math.sin(time * 0.02 + this.noiseOffset) * base * 0.05;
    const noise2 = Math.cos(time * 0.10 + this.noiseOffset * 2) * base * 0.10;
    const noise3 = Math.sin(time * 0.70 + this.noiseOffset * 3) * base * 0.20;

    // Perturb wind speed
    // Scale variability by wind speed so we don't get strong gusts at 0 base wind
    const windScale = Math.min(1.0, this.targetState.windSpeed * 2.0 + 0.1);
    
    this.currentState.windSpeed = THREE.MathUtils.clamp(
      this.currentState.windSpeed + (noise1 + noise3) * windScale, 
      0, 1
    );

    // Perturb wind direction angle
    const anglePerturb = noise2 + (noise3 * 0.5); // Radians
    const currentAngle = Math.atan2(this.currentState.windDirection.y, this.currentState.windDirection.x);
    const newAngle = currentAngle + anglePerturb;
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
          default: 0.2,
          min: 0.0,
          max: 1.0,
          step: 0.01,
          group: 'simulation'
        },
        simulationSpeed: {
          label: 'Simulation Speed',
          default: 2.0,
          min: 0.05,
          max: 3.0,
          step: 0.05,
          group: 'simulation'
        },
        
        // Time
        timeOfDay: {
          label: 'Time of Day',
          default: 12.0,
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
        windSpeed: {
          label: 'Wind Speed',
          default: 0.0,
          min: 0.0,
          max: 1.0,
          step: 0.01,
          group: 'state'
        },
        windDirection: {
          label: 'Wind Angle',
          default: 0.0,
          min: 0.0,
          max: 360.0,
          step: 1.0,
          group: 'state'
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

        // Rain tuning
        rainIntensityScale: {
          label: 'Rain Intensity Scale',
          default: 2.6,
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
          default: 8.0,
          min: 0.5,
          max: 16.0,
          step: 0.05,
          group: 'rain'
        },
        rainBrightness: {
          label: 'Rain Brightness',
          default: 0.3,
          min: 0.1,
          max: 12.0,
          step: 0.05,
          group: 'rain'
        },
        rainGravityScale: {
          label: 'Rain Gravity Scale',
          default: 3.0,
          min: 0.2,
          max: 6.0,
          step: 0.05,
          group: 'rain'
        },
        rainWindInfluence: {
          label: 'Rain Wind Influence',
          default: 2.0,
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
          default: 0.02,
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
          default: 0.08,
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
          default: 9.0,
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
          default: 0.10,
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
          default: 0.5,
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
          default: 0.5,
          min: 0.01,
          max: 3.0,
          step: 0.05,
          group: 'snow'
        },
        snowWindInfluence: {
          label: 'Snow Wind Influence',
          default: 1.0,
          min: 0.0,
          max: 2.0,
          step: 0.05,
          group: 'snow'
        },
        snowCurlStrength: {
          label: 'Snow Curl Strength',
          default: 3.0,
          min: 0.0,
          max: 12.0,
          step: 0.05,
          group: 'snow'
        },
        snowFlutterStrength: {
          label: 'Snow Flutter Strength',
          default: 3.0,
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
        { label: 'Manual Override', type: 'folder', parameters: ['precipitation', 'cloudCover', 'windSpeed', 'windDirection', 'fogDensity', 'wetness', 'freezeLevel'], expanded: true },
        { label: 'Rain', type: 'folder', parameters: [
          'rainIntensityScale',
          'rainStreakLength',
          'rainDropSize',
          'rainBrightness',
          'rainGravityScale',
          'rainWindInfluence'
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
