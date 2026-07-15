/**
 * @fileoverview SkyColorEffectV2 — CPU sky environment facade for downstream systems.
 *
 * Outdoor atmosphere grading now runs inside {@link ColorCorrectionEffectV2} on the
 * merged HDR frame. This class evaluates the analytic sky model each frame and
 * exports tint, sun angles, and intensity for water, windows, dust, clouds, and
 * weather-aware lighting.
 *
 * @module compositor-v2/effects/SkyColorEffectV2
 */

import { createLogger } from '../../core/log.js';
import {
  DEFAULT_ATMOSPHERE_PARAMS,
  evaluateSkyEnvironment,
  pickAtmosphereParams,
} from '../SkyEnvironmentModel.js';

const log = createLogger('SkyColorEffectV2');

export class SkyColorEffectV2 {
  constructor() {
    /** @type {boolean} */
    this._initialized = false;

    /** @type {import('../SkyEnvironmentModel.js').SkyEnvironmentState|null} */
    this._lastState = null;

    this.params = {
      ...DEFAULT_ATMOSPHERE_PARAMS,
      skyTintDarknessLightsEnabled: true,
      skyTintDarknessLightsIntensity: 4.27,
    };

    this.currentSkyTintColor = { r: 1.0, g: 1.0, b: 1.0 };
    this.currentSunAzimuthDeg = 180.0;
    this.currentSunElevationDeg = 45.0;
    this.currentSkyIntensity01 = 1.0;
    this._lastDayFactor = 0.5;
  }

  static getControlSchema() {
    return {
      enabled: true,
      help: {
        title: 'Sky Environment (exports)',
        summary: [
          'Computes time-of-day sky tint, sun angle, and weather data for water, windows, clouds, and weather-aware lighting.',
          'Outdoor atmosphere grading is applied in **Camera Grade (HDR → LDR)** under the Outdoor atmosphere folder.',
          'Use the controls here for downstream light tinting and exported environment strength.',
        ].join('\n\n'),
        glossary: {
          'Sun light tint': 'How strongly Foundry sun/global lights follow the computed sky hue at night.',
        },
      },
      groups: [
        {
          name: 'sky-color',
          label: 'Sky exports',
          type: 'inline',
          parameters: [
            'skyTintDarknessLightsEnabled',
            'skyTintDarknessLightsIntensity',
          ],
        },
      ],
      parameters: {
        enabled: { type: 'boolean', default: true, hidden: true },
        skyTintDarknessLightsEnabled: {
          type: 'boolean',
          default: true,
          label: 'Tint Sun Lights',
        },
        skyTintDarknessLightsIntensity: {
          type: 'slider',
          min: 0.0,
          max: 5.0,
          step: 0.01,
          default: 4.27,
          label: 'Sun Light Tint Intensity',
          throttle: 50,
        },
      },
      presets: {},
    };
  }

  initialize() {
    this._initialized = true;
    log.info('SkyColorEffectV2 initialized (CPU facade)');
  }

  /**
   * @returns {import('../SkyEnvironmentModel.js').SkyEnvironmentState|null}
   */
  getAtmosphereState() {
    return this._lastState;
  }

  /**
   * Resolve atmosphere params: Camera Grade owns authoring when present.
   * @param {Record<string, *>|null} [colorCorrectionParams]
   * @returns {Record<string, *>}
   */
  resolveAtmosphereParams(colorCorrectionParams = null) {
    if (colorCorrectionParams && colorCorrectionParams.atmosphereEnabled !== false) {
      return { ...this.params, ...pickAtmosphereParams(colorCorrectionParams) };
    }
    return this.params;
  }

  /**
   * @param {{ elapsed: number, delta: number }} _timeInfo
   * @param {Record<string, *>|null} [colorCorrectionParams]
   */
  update(_timeInfo, colorCorrectionParams = null) {
    if (!this._initialized) return;
    if (this.params.enabled === false) {
      this._lastState = null;
      return;
    }

    try {
      const state = evaluateSkyEnvironment(this.resolveAtmosphereParams(colorCorrectionParams));
      this._lastState = state;
      this.currentSkyTintColor = { ...state.skyTintColor };
      this.currentSunAzimuthDeg = state.sunAzimuthDeg;
      this.currentSunElevationDeg = state.sunElevationDeg;
      this.currentSkyIntensity01 = state.skyIntensity01;
      this._lastDayFactor = state.dayFactor;
    } catch (e) {
      if (Math.random() < 0.01) {
        log.warn('SkyColorEffectV2 update failed:', e);
      }
    }
  }

  /** @deprecated Per-level render removed; atmosphere runs in Camera Grade. */
  render(_renderer, _inputRT, _outputRT) {}

  /** @deprecated No GPU masks; wired on ColorCorrectionEffectV2 post-merge. */
  setOutdoorsMask(_outdoorsTex) {}

  /** @deprecated */
  setSkyReachMask(_skyReachTex) {}

  /** @deprecated */
  setSkyOcclusionTexture(_texture) {}

  /** @deprecated */
  setCombinedShadowTexture(_texture) {}

  /** @deprecated */
  setCombinedShadowEffectStrength(_strength) {}

  /** @deprecated */
  setIlluminationMasks(_dynamicLightTex, _windowLightTex) {}

  dispose() {
    this._initialized = false;
    this._lastState = null;
    log.info('SkyColorEffectV2 disposed');
  }
}

export default SkyColorEffectV2;
