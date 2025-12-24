/**
 * @fileoverview Centralized state application utility
 * Shared logic for applying time and weather changes to avoid duplication
 * @module ui/state-applier
 */

import { createLogger } from '../core/log.js';
import { weatherController as coreWeatherController } from '../core/WeatherController.js';

const log = createLogger('StateApplier');

/**
 * Centralized utility for applying time and weather state changes
 * Used by both Configuration Panel and Control Panel to ensure consistency
 */
export class StateApplier {
  constructor() {
    /** @type {number|null} Timer for debounced darkness updates */
    this._darknessTimer = null;
  }

  _getWeatherController() {
    return coreWeatherController || window.MapShine?.weatherController || window.weatherController;
  }

  /**
   * Apply time of day change to all systems
   * @param {number} hour - 0-24 hour value
   * @param {boolean} [saveToScene=true] - Whether to save to scene flags
   * @returns {Promise<void>}
   */
  async applyTimeOfDay(hour, saveToScene = true) {
    try {
      const clampedHour = ((hour % 24) + 24) % 24;
      
      log.debug(`Applying time of day: ${clampedHour.toFixed(2)}`);

      // Forward to WeatherController (single source of truth for time-driven systems)
      const weatherController = this._getWeatherController();
      if (weatherController && typeof weatherController.setTime === 'function') {
        weatherController.setTime(clampedHour);
      } else {
        log.warn('WeatherController not available for time application');
      }

      // Update Foundry scene darkness based on time
      await this._updateSceneDarkness(clampedHour);

      // Save to scene flags if requested and user is GM
      if (saveToScene && game?.user?.isGM && canvas?.scene) {
        try {
          if (window.MapShine?.controlPanel?.controlState) {
            window.MapShine.controlPanel.controlState.timeOfDay = clampedHour;
            await canvas.scene.setFlag('map-shine-advanced', 'controlState', window.MapShine.controlPanel.controlState);
          }
        } catch (error) {
          log.warn('Failed to save timeOfDay to scene flags:', error);
        }
      }

      log.info(`Time of day applied: ${clampedHour.toFixed(2)}`);
    } catch (error) {
      log.error('Failed to apply time of day:', error);
      throw error;
    }
  }

  /**
   * Apply weather mode and settings
   * @param {Object} weatherState - Weather state object
   * @param {string} weatherState.mode - 'dynamic' or 'directed'
   * @param {boolean} [weatherState.dynamicEnabled] - Dynamic weather enabled
   * @param {string} [weatherState.dynamicPresetId] - Dynamic biome preset
   * @param {number} [weatherState.dynamicEvolutionSpeed] - Evolution speed multiplier
   * @param {boolean} [weatherState.dynamicPaused] - Evolution paused
   * @param {string} [weatherState.directedPresetId] - Directed weather preset
   * @param {number} [weatherState.directedTransitionMinutes] - Transition duration
   * @param {boolean} [saveToScene=true] - Whether to save to scene flags
   * @returns {Promise<void>}
   */
  async applyWeatherState(weatherState, saveToScene = true) {
    try {
      const weatherController = this._getWeatherController();
      if (!weatherController) {
        log.warn('WeatherController not available for weather application');
        return;
      }

      log.debug('Applying weather state:', weatherState);

      // Apply dynamic mode settings
      if (weatherState.mode === 'dynamic') {
        if (typeof weatherController.setDynamicEnabled === 'function') {
          weatherController.setDynamicEnabled(weatherState.dynamicEnabled ?? false);
        } else if (typeof weatherController.dynamicEnabled !== 'undefined') {
          weatherController.dynamicEnabled = weatherState.dynamicEnabled ?? false;
        }
        if (typeof weatherController.dynamicPresetId !== 'undefined') {
          if (typeof weatherController.setDynamicPreset === 'function') {
            weatherController.setDynamicPreset(weatherState.dynamicPresetId ?? 'Temperate Plains');
          } else {
            weatherController.dynamicPresetId = weatherState.dynamicPresetId ?? 'Temperate Plains';
          }
        }
        if (typeof weatherController.dynamicEvolutionSpeed !== 'undefined') {
          if (typeof weatherController.setDynamicEvolutionSpeed === 'function') {
            weatherController.setDynamicEvolutionSpeed(weatherState.dynamicEvolutionSpeed ?? 60.0);
          } else {
            weatherController.dynamicEvolutionSpeed = weatherState.dynamicEvolutionSpeed ?? 60.0;
          }
        }
        if (typeof weatherController.dynamicPaused !== 'undefined') {
          if (typeof weatherController.setDynamicPaused === 'function') {
            weatherController.setDynamicPaused(weatherState.dynamicPaused ?? false);
          } else {
            weatherController.dynamicPaused = weatherState.dynamicPaused ?? false;
          }
        }
      }

      // Save to scene flags if requested and user is GM
      if (saveToScene && game?.user?.isGM && canvas?.scene) {
        try {
          // Update control state if ControlPanel is available
          if (window.MapShine?.controlPanel) {
            Object.assign(window.MapShine.controlPanel.controlState, weatherState);
            await canvas.scene.setFlag('map-shine-advanced', 'controlState', window.MapShine.controlPanel.controlState);
          }
        } catch (error) {
          log.warn('Failed to save weather state to scene flags:', error);
        }
      }

      log.info('Weather state applied successfully');
    } catch (error) {
      log.error('Failed to apply weather state:', error);
      throw error;
    }
  }

  /**
   * Explicitly start a directed weather transition (button-driven).
   * @param {string} presetId
   * @param {number} transitionMinutes
   * @returns {Promise<void>}
   */
  async startDirectedTransition(presetId, transitionMinutes) {
    await this._startDirectedTransition(presetId, transitionMinutes);
  }

  /**
   * Start a directed weather transition
   * @param {string} presetId - Weather preset ID
   * @param {number} transitionMinutes - Transition duration in minutes
   * @private
   */
  async _startDirectedTransition(presetId, transitionMinutes) {
    try {
      const weatherController = this._getWeatherController();
      if (!weatherController) {
        throw new Error('WeatherController not available');
      }

      log.info(`Directed transition requested: preset=${presetId}, minutes=${transitionMinutes}`);

      // Directed transitions must not be blocked by Dynamic Weather state (e.g. after refresh).
      // Force dynamic off before queuing.
      if (typeof weatherController.setDynamicEnabled === 'function') {
        weatherController.setDynamicEnabled(false);
      } else if (typeof weatherController.dynamicEnabled !== 'undefined') {
        weatherController.dynamicEnabled = false;
      }
      if (typeof weatherController.enabled !== 'undefined') {
        weatherController.enabled = true;
      }

      // Get preset values from WeatherController schema
      const schema = weatherController.constructor?.getControlSchema?.();
      if (!schema?.presets?.[presetId]) {
        throw new Error(`Weather preset not found: ${presetId}`);
      }

      const preset = schema.presets[presetId];
      
      // Queue the transition parameters
      Object.entries(preset).forEach(([key, value]) => {
        const queuedKey = `queued${key.charAt(0).toUpperCase() + key.slice(1)}`;
        if (typeof weatherController.setQueuedTransitionParam === 'function') {
          weatherController.setQueuedTransitionParam(queuedKey, value);
        }
      });

      // Set transition duration and start
      weatherController.presetTransitionDurationSeconds = transitionMinutes * 60;
      
      if (typeof weatherController.startQueuedTransition === 'function') {
        weatherController.startQueuedTransition(transitionMinutes * 60);
      }

      log.info(`Started directed weather transition: ${presetId} (${transitionMinutes}min)`);
    } catch (error) {
      log.error('Failed to start directed transition:', error);
      throw error;
    }
  }

  /**
   * Update Foundry scene darkness based on time of day
   * @param {number} hour - 0-24 hour value
   * @private
   */
  async _updateSceneDarkness(hour) {
    try {
      if (!game?.user?.isGM || !canvas?.scene) return;

      // Enhanced darkness calculation for better day/night transitions
      let targetDarkness;

      if (hour >= 5 && hour < 7) {
        // Dawn: 5am (0.95) -> 7am (0.3)
        const progress = (hour - 5) / 2;
        targetDarkness = 0.95 - progress * 0.65;
      } else if (hour >= 7 && hour < 8) {
        // Early morning: 7am (0.3) -> 8am (0.2)
        const progress = (hour - 7) / 1;
        targetDarkness = 0.3 - progress * 0.1;
      } else if (hour >= 8 && hour < 17) {
        // Day: 8am (0.2) -> 5pm (0.15)
        const progress = (hour - 8) / 9;
        targetDarkness = 0.2 - progress * 0.05;
      } else if (hour >= 17 && hour < 19) {
        // Dusk: 5pm (0.15) -> 7pm (0.6)
        const progress = (hour - 17) / 2;
        targetDarkness = 0.15 + progress * 0.45;
      } else if (hour >= 19 && hour < 21) {
        // Evening: 7pm (0.6) -> 9pm (0.8)
        const progress = (hour - 19) / 2;
        targetDarkness = 0.6 + progress * 0.2;
      } else {
        // Night: 9pm (0.8) -> 5am (0.95)
        let nightHour = hour >= 21 ? hour - 21 : hour + 3;
        const progress = nightHour / 8;
        targetDarkness = 0.8 + progress * 0.15;
      }

      // Clamp to valid range
      targetDarkness = Math.max(0, Math.min(1, targetDarkness));

      // Get current darkness
      const currentDarkness = canvas?.environment?.darknessLevel ?? canvas.scene.darkness ?? 0.0;

      // Apply with debouncing to avoid rapid updates
      if (Math.abs(currentDarkness - targetDarkness) > 0.002) {
        if (this._darknessTimer) clearTimeout(this._darknessTimer);
        this._darknessTimer = setTimeout(async () => {
          try {
            await canvas.scene.update({ darkness: targetDarkness });
            log.debug(`Scene darkness updated: ${targetDarkness.toFixed(3)}`);
          } catch (error) {
            log.warn('Failed to update scene darkness:', error);
          }
        }, 100);
      }
    } catch (error) {
      log.warn('Failed to compute/apply scene darkness:', error);
    }
  }

  /**
   * Get current time and weather state from controllers
   * @returns {Object} Current state
   */
  getCurrentState() {
    const state = {};

    // Time state
    const weatherController = window.MapShine?.weatherController || window.weatherController;
    if (weatherController) {
      state.timeOfDay = weatherController.timeOfDay ?? 12.0;
      state.dynamicEnabled = weatherController.dynamicEnabled ?? false;
      state.dynamicPresetId = weatherController.dynamicPresetId ?? 'Temperate Plains';
      state.dynamicEvolutionSpeed = weatherController.dynamicEvolutionSpeed ?? 60.0;
      state.dynamicPaused = weatherController.dynamicPaused ?? false;
    }

    // UI state
    if (window.MapShine?.controlPanel) {
      state.weatherMode = window.MapShine.controlPanel.controlState.weatherMode ?? 'dynamic';
      state.directedPresetId = window.MapShine.controlPanel.controlState.directedPresetId ?? 'Clear (Dry)';
      state.directedTransitionMinutes = window.MapShine.controlPanel.controlState.directedTransitionMinutes ?? 5.0;
    }

    return state;
  }

  /**
   * Clean up resources
   */
  destroy() {
    if (this._darknessTimer) {
      clearTimeout(this._darknessTimer);
      this._darknessTimer = null;
    }
  }
}

// Export singleton instance for easy access
export const stateApplier = new StateApplier();
