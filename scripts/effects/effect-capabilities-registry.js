/**
 * @fileoverview Effect Capabilities Registry
 *
 * ESSENTIAL FEATURE:
 * This registry is part of the "Graphics Settings" system, which provides players and GMs
 * with safe, per-client overrides for disabling or reducing the intensity of visual effects.
 *
 * New effects should register capabilities here (or via a higher-level integration helper)
 * so they automatically appear in the Graphics Settings UI.
 *
 * @module effects/effect-capabilities-registry
 */

import { createLogger } from '../core/log.js';

const log = createLogger('EffectCapabilities');

/**
 * @typedef {Object} EffectCapabilities
 * @property {string} effectId
 * @property {string} displayName
 * @property {string} [category]
 * @property {'low'|'medium'|'high'} [performanceImpact]
 * @property {boolean} [supportsEnabledOverride]
 * @property {boolean} [supportsIntensityOverride]
 * @property {() => boolean} [isAvailable]
 * @property {string} [availabilityReason]
 */

/**
 * Central registry describing what each effect supports for Graphics Settings.
 */
export class EffectCapabilitiesRegistry {
  constructor() {
    /** @type {Map<string, EffectCapabilities>} */
    this._caps = new Map();
  }

  /**
   * Register (or replace) capabilities.
   * @param {EffectCapabilities} caps
   */
  register(caps) {
    if (!caps || typeof caps.effectId !== 'string' || !caps.effectId) {
      throw new Error('EffectCapabilitiesRegistry.register: caps.effectId is required');
    }

    const normalized = {
      category: 'global',
      performanceImpact: 'medium',
      supportsEnabledOverride: true,
      supportsIntensityOverride: false,
      isAvailable: () => true,
      availabilityReason: '',
      ...caps
    };

    this._caps.set(normalized.effectId, normalized);
    log.debug(`Registered capabilities: ${normalized.effectId}`);
  }

  /**
   * @param {string} effectId
   * @returns {EffectCapabilities|null}
   */
  get(effectId) {
    return this._caps.get(effectId) ?? null;
  }

  /**
   * @returns {EffectCapabilities[]}
   */
  list() {
    return Array.from(this._caps.values());
  }

  /**
   * @param {string} effectId
   * @returns {{available:boolean, reason:string}}
   */
  getAvailability(effectId) {
    const caps = this.get(effectId);
    if (!caps) return { available: false, reason: 'Not registered' };

    try {
      const available = (caps.isAvailable ? caps.isAvailable() : true) === true;
      return {
        available,
        reason: available ? '' : (caps.availabilityReason || 'Unavailable')
      };
    } catch (e) {
      return { available: false, reason: 'Availability check failed' };
    }
  }
}
