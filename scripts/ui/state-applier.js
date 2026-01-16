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

    /** @type {number|null} Pending target darkness level to flush */
    this._pendingDarknessTarget = null;

    /** @type {number|null} */
    this._timeTransitionIntervalId = null;
  }

  _getWeatherController() {
    return coreWeatherController || window.MapShine?.weatherController || window.weatherController;
  }

  /**
   * Apply time of day change to all systems
   * @param {number} hour - 0-24 hour value
   * @param {boolean} [saveToScene=true] - Whether to save to scene flags
   * @param {boolean} [applyDarkness=true] - Whether to update Foundry scene darkness
   * @returns {Promise<void>}
   */
  async applyTimeOfDay(hour, saveToScene = true, applyDarkness = true) {
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
      if (applyDarkness) {
        await this._updateSceneDarkness(clampedHour);
      } else if (this._darknessTimer) {
        clearTimeout(this._darknessTimer);
        this._darknessTimer = null;
      }

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
   * Start a smooth time-of-day transition.
   * @param {number} targetHour - 0-24 hour value
   * @param {number} transitionMinutes - Transition duration in minutes
   * @param {boolean} [saveToScene=true]
   * @returns {Promise<void>}
   */
  async startTimeOfDayTransition(targetHour, transitionMinutes, saveToScene = true) {
    try {
      const minutesNum = typeof transitionMinutes === 'number' ? transitionMinutes : Number(transitionMinutes);
      const safeMinutes = Number.isFinite(minutesNum) ? Math.max(0.0, Math.min(60.0, minutesNum)) : 0.0;
      const durationSeconds = safeMinutes * 60.0;

      const wc = this._getWeatherController();
      const current = wc?.getCurrentTime?.() ?? wc?.timeOfDay ?? window.MapShine?.controlPanel?.controlState?.timeOfDay;
      const startHour = Number.isFinite(Number(current)) ? ((Number(current) % 24) + 24) % 24 : 12.0;

      const tgt = ((Number(targetHour) % 24) + 24) % 24;

      // Cancel any previous time transition.
      if (this._timeTransitionIntervalId) {
        clearInterval(this._timeTransitionIntervalId);
        this._timeTransitionIntervalId = null;
      }

      // If duration is 0, apply immediately.
      if (durationSeconds <= 0.001) {
        await this.applyTimeOfDay(tgt, saveToScene, true);
        return;
      }

      // Move along the shortest arc in circular time space.
      let delta = tgt - startHour;
      if (delta > 12) delta -= 24;
      if (delta < -12) delta += 24;

      const startMs = Date.now();
      const durationMs = durationSeconds * 1000.0;

      // Apply the first frame immediately.
      await this.applyTimeOfDay(startHour, false, true);

      return await new Promise((resolve, reject) => {
        this._timeTransitionIntervalId = setInterval(() => {
          try {
            const elapsedMs = Date.now() - startMs;
            const t = Math.max(0, Math.min(1, elapsedMs / durationMs));

            const hour = ((startHour + delta * t) % 24 + 24) % 24;

            // During the ramp we don't want to spam scene flags.
            void this.applyTimeOfDay(hour, false, true);

            if (t >= 1) {
              if (this._timeTransitionIntervalId) {
                clearInterval(this._timeTransitionIntervalId);
                this._timeTransitionIntervalId = null;
              }

              // Final application persists.
              void this.applyTimeOfDay(tgt, saveToScene, true).then(resolve).catch(reject);
            }
          } catch (e) {
            if (this._timeTransitionIntervalId) {
              clearInterval(this._timeTransitionIntervalId);
              this._timeTransitionIntervalId = null;
            }
            reject(e);
          }
        }, 100);
      });
    } catch (error) {
      log.error('Failed to start time-of-day transition:', error);
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

      const minutesNum = typeof transitionMinutes === 'number' ? transitionMinutes : Number(transitionMinutes);
      const safeMinutes = Number.isFinite(minutesNum) ? Math.max(0.1, Math.min(60.0, minutesNum)) : 5.0;
      const durationSeconds = safeMinutes * 60.0;

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
      let preset = null;
      if (presetId === 'Custom') {
        const custom = window.MapShine?.controlPanel?.controlState?.directedCustomPreset;
        const target = weatherController.targetState;
        const windDir = target?.windDirection || { x: 1, y: 0 };
        const windDirectionDegFromTarget =
          (Math.atan2(-Number(windDir.y) || 0, Number(windDir.x) || 1) * 180) / Math.PI;

        preset = {
          precipitation: Number(custom?.precipitation ?? target?.precipitation ?? 0.0),
          cloudCover: Number(custom?.cloudCover ?? target?.cloudCover ?? 0.0),
          windSpeed: Number(custom?.windSpeed ?? target?.windSpeed ?? 0.0),
          windDirection: Number(custom?.windDirection ?? (windDirectionDegFromTarget < 0 ? windDirectionDegFromTarget + 360 : windDirectionDegFromTarget)),
          fogDensity: Number(custom?.fogDensity ?? target?.fogDensity ?? 0.0),
          freezeLevel: Number(custom?.freezeLevel ?? target?.freezeLevel ?? 0.0)
        };
      } else {
        const schema = weatherController.constructor?.getControlSchema?.();
        if (!schema?.presets?.[presetId]) {
          throw new Error(`Weather preset not found: ${presetId}`);
        }
        preset = schema.presets[presetId];
      }

      if (typeof weatherController.presetTransitionDurationSeconds === 'number') {
        weatherController.presetTransitionDurationSeconds = durationSeconds;
      }

      if (typeof weatherController.transitionToPreset === 'function') {
        weatherController.transitionToPreset(preset, durationSeconds);
      } else {
        // Fallback: older/manual queue system
        Object.entries(preset).forEach(([key, value]) => {
          const queuedKey = `queued${key.charAt(0).toUpperCase() + key.slice(1)}`;
          if (typeof weatherController.setQueuedTransitionParam === 'function') {
            weatherController.setQueuedTransitionParam(queuedKey, value);
          }
        });

        if (typeof weatherController.startQueuedTransition === 'function') {
          weatherController.startQueuedTransition(durationSeconds);
        }
      }

      log.info(`Started directed weather transition: ${presetId} (${safeMinutes}min)`);
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
        // Early morning: 7am (0.3) -> 8am (0.0)
        const progress = (hour - 7) / 1;
        targetDarkness = 0.3 - progress * 0.3;
      } else if (hour >= 8 && hour < 17) {
        // Day: 8am -> 5pm is full daylight
        targetDarkness = 0.0;
      } else if (hour >= 17 && hour < 19) {
        // Dusk: 5pm (0.0) -> 7pm (0.6)
        const progress = (hour - 17) / 2;
        targetDarkness = 0.0 + progress * 0.6;
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
      const currentDarkness = canvas?.environment?.darknessLevel ?? canvas?.scene?.environment?.darknessLevel ?? 0.0;

      // Schedule updates during rapid time changes (e.g. transitions) without starving the timer.
      if (Math.abs(currentDarkness - targetDarkness) > 0.002) {
        this._pendingDarknessTarget = targetDarkness;

        // If a flush is already scheduled, just update the pending value.
        if (this._darknessTimer) return;

        this._darknessTimer = setTimeout(async () => {
          // Allow new schedules while the async update is in-flight.
          this._darknessTimer = null;

          const pending = this._pendingDarknessTarget;
          this._pendingDarknessTarget = null;
          if (!Number.isFinite(pending)) return;

          try {
            await canvas.scene.update({ 'environment.darknessLevel': pending });
            log.debug(`Scene darkness updated: ${pending.toFixed(3)}`);
          } catch (error) {
            log.warn('Failed to update scene darkness:', error);
          }

          // If more updates were requested while we were updating, schedule another flush.
          if (Number.isFinite(this._pendingDarknessTarget)) {
            try {
              await this._updateSceneDarkness(hour);
            } catch (e) {
            }
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

    this._pendingDarknessTarget = null;

    if (this._timeTransitionIntervalId) {
      clearInterval(this._timeTransitionIntervalId);
      this._timeTransitionIntervalId = null;
    }
  }
}

// Export singleton instance for easy access
export const stateApplier = new StateApplier();
