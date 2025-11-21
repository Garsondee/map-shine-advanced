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
    
    const noise1 = Math.sin(time * 0.1 + this.noiseOffset) * this.variability * 0.1;
    const noise2 = Math.cos(time * 0.05 + this.noiseOffset * 2) * this.variability * 0.2;

    // Perturb wind speed
    this.currentState.windSpeed = THREE.MathUtils.clamp(
      this.currentState.windSpeed + noise1, 
      0, 1
    );

    // Perturb wind direction angle
    const anglePerturb = noise2; // Radians
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
          group: 'manual'
        },
        cloudCover: {
          label: 'Cloud Cover',
          default: 0.0,
          min: 0.0,
          max: 1.0,
          step: 0.01,
          group: 'manual'
        },
        windSpeed: {
          label: 'Wind Speed',
          default: 0.0,
          min: 0.0,
          max: 1.0,
          step: 0.01,
          group: 'manual'
        },
        windDirection: {
          label: 'Wind Angle',
          default: 0.0,
          min: 0.0,
          max: 360.0,
          step: 1.0,
          group: 'manual'
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
        }
      },
      groups: [
        { label: 'Environment', type: 'folder', parameters: ['timeOfDay'] },
        { label: 'Simulation', type: 'folder', parameters: ['variability', 'transitionDuration'] },
        { label: 'Manual Override', type: 'folder', parameters: ['precipitation', 'cloudCover', 'windSpeed', 'windDirection', 'fogDensity', 'wetness'], expanded: true }
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
