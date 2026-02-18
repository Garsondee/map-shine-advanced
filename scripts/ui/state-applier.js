/**
 * @fileoverview Centralized state application utility
 * Shared logic for applying time and weather changes to avoid duplication
 * @module ui/state-applier
 */

import { createLogger } from '../core/log.js';
import { weatherController as coreWeatherController } from '../core/WeatherController.js';
import { getFoundryTimePhaseHours, getWrappedHourProgress, getFoundrySunlightFactor } from '../core/foundry-time-phases.js';

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

    /** @type {number} Timestamp (ms) of the last successful darkness write */
    this._lastDarknessAppliedAtMs = 0;

    /** @type {number|null} Last darkness value successfully written */
    this._lastDarknessAppliedValue = null;

    /** @type {number|null} */
    this._timeTransitionIntervalId = null;
  }

  _getWeatherController() {
    return coreWeatherController || window.MapShine?.weatherController || window.weatherController;
  }

  /**
   * Resolve whether time should be synchronized into Foundry core world time.
   * @returns {boolean}
   * @private
   */
  _isFoundryTimeLinkEnabled() {
    const controlState = window.MapShine?.controlPanel?.controlState;
    if (controlState && typeof controlState === 'object') {
      return controlState.linkTimeToFoundry === true;
    }

    // Fallback for early boot / UI-only states where the panel is not yet constructed.
    const sceneState = canvas?.scene?.getFlag?.('map-shine-advanced', 'controlState');
    return sceneState?.linkTimeToFoundry === true;
  }

  /**
   * Get calendar unit sizing for the active Foundry calendar.
   * @returns {{hoursPerDay:number, minutesPerHour:number, secondsPerMinute:number}|null}
   * @private
   */
  _getCalendarUnits() {
    const calDays = game?.time?.calendar?.days;
    if (!calDays) return null;

    const hoursPerDay = Number(calDays.hoursPerDay);
    const minutesPerHour = Number(calDays.minutesPerHour);
    const secondsPerMinute = Number(calDays.secondsPerMinute);
    if (!Number.isFinite(hoursPerDay) || !Number.isFinite(minutesPerHour) || !Number.isFinite(secondsPerMinute)) {
      return null;
    }

    return {
      hoursPerDay: Math.max(1, hoursPerDay),
      minutesPerHour: Math.max(1, minutesPerHour),
      secondsPerMinute: Math.max(1, secondsPerMinute)
    };
  }

  /**
   * PF2E world clock can apply a world-created epoch offset to worldTime.
   * Resolve that offset in seconds when available.
   * @returns {number|null}
   * @private
   */
  _getPf2eEpochOffsetSeconds() {
    if (game?.system?.id !== 'pf2e') return null;

    const created = game?.pf2e?.worldClock?.worldCreatedOn?.c;
    if (!created || typeof created !== 'object') return null;

    const hour = Number(created.hour) || 0;
    const minute = Number(created.minute) || 0;
    const second = Number(created.second) || 0;
    const millisecond = Number(created.millisecond) || 0;

    return (hour * 3600) + (minute * 60) + second + (millisecond * 0.001);
  }

  /**
   * Resolve PF2E display clock components for a given worldTime value.
   * @param {number} worldTime
   * @returns {{hour:number, minute:number, second:number}|null}
   * @private
   */
  _getPf2eClockComponentsFromWorldTime(worldTime) {
    if (game?.system?.id !== 'pf2e') return null;

    const timeValue = Number(worldTime);
    const epochOffset = this._getPf2eEpochOffsetSeconds();
    if (Number.isFinite(timeValue) && Number.isFinite(epochOffset)) {
      const secondsPerDay = 24 * 60 * 60;
      let secondOfDay = (timeValue + epochOffset) % secondsPerDay;
      if (secondOfDay < 0) secondOfDay += secondsPerDay;

      const hour = Math.floor(secondOfDay / 3600);
      secondOfDay -= hour * 3600;
      const minute = Math.floor(secondOfDay / 60);
      const second = secondOfDay - (minute * 60);
      return { hour, minute, second };
    }

    // Fallback to the PF2E clock cache if epoch metadata is unavailable.
    const c = game?.pf2e?.worldClock?.worldTime?.c;
    if (!c || typeof c !== 'object') return null;
    const hour = Number(c.hour);
    const minute = Number(c.minute);
    const second = Number(c.second);
    if (!Number.isFinite(hour) || !Number.isFinite(minute) || !Number.isFinite(second)) return null;
    return { hour, minute, second };
  }

  /**
   * Convert a Foundry worldTime second value into Map Shine's 0-24 hour scale.
   * @param {number} [worldTime] - Foundry world time in seconds
   * @returns {number|null}
   */
  getHourFromWorldTime(worldTime = game?.time?.worldTime) {
    const timeValue = Number(worldTime);
    if (!Number.isFinite(timeValue)) return null;

    const pf2eComponents = this._getPf2eClockComponentsFromWorldTime(timeValue);
    if (pf2eComponents) {
      const h = Number(pf2eComponents.hour) || 0;
      const m = Number(pf2eComponents.minute) || 0;
      const s = Number(pf2eComponents.second) || 0;
      return ((h + (m / 60) + (s / 3600)) % 24 + 24) % 24;
    }

    const calendar = game?.time?.calendar;
    const units = this._getCalendarUnits();
    if (!calendar || !units) return null;

    const components = calendar.timeToComponents(timeValue);
    const h = Number(components?.hour) || 0;
    const m = Number(components?.minute) || 0;
    const s = Number(components?.second) || 0;

    const dayFraction =
      (h + (m / units.minutesPerHour) + (s / (units.minutesPerHour * units.secondsPerMinute))) /
      units.hoursPerDay;

    return ((dayFraction * 24) % 24 + 24) % 24;
  }

  /**
   * Canonical entrypoint for Foundry world-time -> Map Shine time application.
   * Keeps all time-driven systems in sync while explicitly avoiding a write-back to
   * game.time (prevents updateWorldTime feedback loops).
   * @param {number} [worldTime] - Foundry world time in seconds
   * @param {boolean} [saveToScene=false]
   * @param {boolean} [applyDarkness=true]
   * @returns {Promise<number|null>} Applied hour in Map Shine 0-24 scale
   */
  async applyFoundryWorldTime(worldTime = game?.time?.worldTime, saveToScene = false, applyDarkness = true) {
    const linkedHour = this.getHourFromWorldTime(worldTime);
    if (!Number.isFinite(linkedHour)) return null;

    await this.applyTimeOfDay(linkedHour, saveToScene, applyDarkness, false);
    return linkedHour;
  }

  /**
   * Convert a Map Shine 0-24 hour value into Foundry worldTime seconds while preserving calendar day/year.
   * @param {number} hour
   * @param {number} [baseWorldTime]
   * @returns {number|null}
   * @private
   */
  _worldTimeFromHour(hour, baseWorldTime = game?.time?.worldTime) {
    const normalizedHour = ((Number(hour) % 24) + 24) % 24;
    const base = Number(baseWorldTime);

    const pf2eEpochOffset = this._getPf2eEpochOffsetSeconds();
    if (Number.isFinite(base) && Number.isFinite(pf2eEpochOffset)) {
      const secondsPerDay = 24 * 60 * 60;
      const shifted = base + pf2eEpochOffset;
      const dayIndex = Math.floor(shifted / secondsPerDay);

      let secondsInDay = Math.round((normalizedHour / 24) * secondsPerDay);
      secondsInDay = Math.max(0, Math.min(secondsPerDay - 1, secondsInDay));

      const targetShifted = (dayIndex * secondsPerDay) + secondsInDay;
      return targetShifted - pf2eEpochOffset;
    }

    const calendar = game?.time?.calendar;
    const units = this._getCalendarUnits();
    if (!calendar || !units || !Number.isFinite(base)) return null;

    const components = calendar.timeToComponents(base);

    const secondsPerDay = units.hoursPerDay * units.minutesPerHour * units.secondsPerMinute;
    let secondsInDay = Math.round((normalizedHour / 24) * secondsPerDay);
    secondsInDay = Math.max(0, Math.min(secondsPerDay - 1, secondsInDay));

    const hourValue = Math.floor(secondsInDay / (units.minutesPerHour * units.secondsPerMinute));
    const remAfterHour = secondsInDay - (hourValue * units.minutesPerHour * units.secondsPerMinute);
    const minuteValue = Math.floor(remAfterHour / units.secondsPerMinute);
    const secondValue = remAfterHour - (minuteValue * units.secondsPerMinute);

    return calendar.componentsToTime({
      year: Number(components?.year) || 0,
      day: Number(components?.day) || 0,
      hour: hourValue,
      minute: minuteValue,
      second: secondValue
    });
  }

  /**
   * Synchronize Map Shine time-of-day into Foundry's canonical world time.
   * @param {number} hour
   * @returns {Promise<void>}
   * @private
   */
  async _syncFoundryWorldTimeFromHour(hour) {
    if (!game?.user?.isGM) return;

    const currentWorldTime = Number(game?.time?.worldTime);
    if (!Number.isFinite(currentWorldTime)) return;

    const targetWorldTime = this._worldTimeFromHour(hour, currentWorldTime);
    if (!Number.isFinite(targetWorldTime)) return;

    // 1 second threshold avoids redundant socket churn from tiny rounding differences.
    if (Math.abs(targetWorldTime - currentWorldTime) < 1) return;

    await game.time.set(targetWorldTime, { mapShineTimeSync: true });
  }

  /**
   * Apply time of day change to all systems
   * @param {number} hour - 0-24 hour value
   * @param {boolean} [saveToScene=true] - Whether to save to scene flags
   * @param {boolean} [applyDarkness=true] - Whether to update Foundry scene darkness
   * @param {boolean} [syncFoundryTime=true] - Whether to synchronize linked Foundry world time
   * @returns {Promise<void>}
   */
  async applyTimeOfDay(hour, saveToScene = true, applyDarkness = true, syncFoundryTime = true) {
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

      if (syncFoundryTime && this._isFoundryTimeLinkEnabled()) {
        await this._syncFoundryWorldTimeFromHour(clampedHour);
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

      const nowMs = Date.now();

      // Align darkness transitions to Foundry/PF2E time-of-day phase definitions.
      const safeHour = ((Number(hour) % 24) + 24) % 24;
      const phases = getFoundryTimePhaseHours();
      const dawnDuskDarkness = 0.55;
      const noonDarkness = 0.0;
      const midnightDarkness = 0.95;

      let targetDarkness;
      const dayProgress = getWrappedHourProgress(safeHour, phases.sunrise, phases.sunset);

      if (Number.isFinite(dayProgress)) {
        const sunlight = Math.pow(getFoundrySunlightFactor(safeHour, phases), 0.85);
        targetDarkness = dawnDuskDarkness + ((noonDarkness - dawnDuskDarkness) * sunlight);
      } else {
        const nightProgress = getWrappedHourProgress(safeHour, phases.sunset, phases.sunrise);
        if (Number.isFinite(nightProgress)) {
          const moonArc = Math.pow(Math.max(0, Math.sin(Math.PI * nightProgress)), 0.8);
          targetDarkness = dawnDuskDarkness + ((midnightDarkness - dawnDuskDarkness) * moonArc);
        } else {
          targetDarkness = midnightDarkness;
        }
      }

      // Clamp to valid range
      targetDarkness = Math.max(0, Math.min(1, targetDarkness));

      // Get current darkness
      const currentDarkness = canvas?.environment?.darknessLevel ?? canvas?.scene?.environment?.darknessLevel ?? 0.0;

      const lastApplied = Number.isFinite(this._lastDarknessAppliedValue)
        ? this._lastDarknessAppliedValue
        : currentDarkness;

      const darknessDelta = Math.abs(lastApplied - targetDarkness);
      const DARKNESS_DELTA_THRESHOLD = 0.002;
      const MIN_LINKED_WRITE_INTERVAL_MS = 1500;
      const shouldForceByAge =
        darknessDelta > 0.00005 &&
        (nowMs - this._lastDarknessAppliedAtMs) >= MIN_LINKED_WRITE_INTERVAL_MS;

      // Schedule updates during rapid time changes (e.g. transitions) without starving the timer.
      if ((Math.abs(currentDarkness - targetDarkness) > DARKNESS_DELTA_THRESHOLD) || shouldForceByAge) {
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
            this._lastDarknessAppliedAtMs = Date.now();
            this._lastDarknessAppliedValue = pending;
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
    this._lastDarknessAppliedAtMs = 0;
    this._lastDarknessAppliedValue = null;

    if (this._timeTransitionIntervalId) {
      clearInterval(this._timeTransitionIntervalId);
      this._timeTransitionIntervalId = null;
    }
  }
}

// Export singleton instance for easy access
export const stateApplier = new StateApplier();
