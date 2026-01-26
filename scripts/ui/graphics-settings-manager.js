/**
 * @fileoverview Graphics Settings Manager
 *
 * ESSENTIAL FEATURE:
 * This manager implements per-client graphics overrides for Map Shine Advanced.
 * Players and GMs can disable effects (and later: reduce intensities) without modifying
 * the authoritative scene settings. This is intended for accessibility and performance.
 *
 * @module ui/graphics-settings-manager
 */

import { createLogger } from '../core/log.js';
import { GraphicsSettingsDialog } from './graphics-settings-dialog.js';

const log = createLogger('GraphicsSettings');

/**
 * @typedef {Object} GraphicsSettingsState
 * @property {boolean} globalDisableAll
 * @property {Object<string, {enabled?: boolean}>} effectOverrides
 */

export class GraphicsSettingsManager {
  /**
   * @param {import('../effects/EffectComposer.js').EffectComposer|null} effectComposer
   * @param {import('../effects/effect-capabilities-registry.js').EffectCapabilitiesRegistry|null} capabilitiesRegistry
   */
  constructor(effectComposer, capabilitiesRegistry) {
    this.effectComposer = effectComposer;
    this.capabilitiesRegistry = capabilitiesRegistry;

    /** @type {GraphicsSettingsState} */
    this.state = {
      globalDisableAll: false,
      effectOverrides: {}
    };

    this.dialog = new GraphicsSettingsDialog(this);

    this._storageKey = this._buildStorageKey();

    // Cache of effect instances wired for runtime application.
    /** @type {Map<string, any>} */
    this._effects = new Map();
  }

  _buildStorageKey() {
    try {
      const sceneId = canvas?.scene?.id || 'no-scene';
      const userId = game?.user?.id || 'no-user';
      return `map-shine-advanced.graphicsOverrides.${sceneId}.${userId}`;
    } catch (_) {
      return 'map-shine-advanced.graphicsOverrides';
    }
  }

  /**
   * Register a live effect instance so overrides can be applied.
   * @param {string} effectId
   * @param {any} effect
   */
  registerEffectInstance(effectId, effect) {
    if (!effectId || !effect) return;
    this._effects.set(effectId, effect);
  }

  /**
   * Initialize UI and load persisted state.
   */
  async initialize() {
    this.loadState();
    await this.dialog.initialize();
    this.applyOverrides();
  }

  /**
   * @returns {Array<{effectId:string, displayName:string}>}
   */
  listEffectsForUI() {
    const caps = this.capabilitiesRegistry?.list?.() ?? [];
    if (caps.length > 0) {
      return caps.map((c) => ({
        effectId: c.effectId,
        displayName: c.displayName || c.effectId
      }));
    }

    // Fallback: if registry isn't available, list known registered instances.
    return Array.from(this._effects.keys()).map((id) => ({ effectId: id, displayName: id }));
  }

  /**
   * @param {string} effectId
   * @returns {{available:boolean, reason:string}}
   */
  getAvailability(effectId) {
    if (!this.capabilitiesRegistry?.getAvailability) return { available: true, reason: '' };
    return this.capabilitiesRegistry.getAvailability(effectId);
  }

  /**
   * Effective enabled state = availability && !globalDisableAll && per-effect enabled (if set).
   * @param {string} effectId
   */
  getEffectiveEnabled(effectId) {
    const avail = this.getAvailability(effectId);
    if (!avail.available) return false;

    if (this.state.globalDisableAll) return false;

    const ov = this.state.effectOverrides?.[effectId];
    if (ov && typeof ov.enabled === 'boolean') return ov.enabled;

    // Default: enabled.
    return true;
  }

  /**
   * Apply overrides to live effects.
   */
  applyOverrides() {
    for (const [effectId, effect] of this._effects.entries()) {
      const enabled = this.getEffectiveEnabled(effectId);

      try {
        // EffectComposer only renders enabled effects, so this is the safest first step.
        if (typeof effect.enabled === 'boolean') {
          effect.enabled = enabled;
        }

        // Some effects use params.enabled patterns.
        if (effect.params && typeof effect.params.enabled === 'boolean') {
          effect.params.enabled = enabled;
        }

        // Some effects have a specific settings enabled.
        if (effect.settings && typeof effect.settings.enabled === 'boolean') {
          effect.settings.enabled = enabled;
        }

      } catch (e) {
        log.warn(`Failed to apply override to ${effectId}`, e);
      }
    }
  }

  setDisableAll(disableAll) {
    this.state.globalDisableAll = disableAll === true;
    this.applyOverrides();
    this.saveState();
  }

  disableAllEffects() {
    const ids = this.listEffectsForUI().map((e) => e.effectId);
    for (const id of ids) {
      this.state.effectOverrides[id] = { ...(this.state.effectOverrides[id] || {}), enabled: false };
    }
    this.applyOverrides();
    this.saveState();
  }

  enableAllEffects() {
    const ids = this.listEffectsForUI().map((e) => e.effectId);
    for (const id of ids) {
      this.state.effectOverrides[id] = { ...(this.state.effectOverrides[id] || {}), enabled: true };
    }
    this.applyOverrides();
    this.saveState();
  }

  /**
   * @param {string} effectId
   * @param {boolean} enabled
   */
  setEffectEnabled(effectId, enabled) {
    if (!effectId) return;
    this.state.effectOverrides[effectId] = {
      ...(this.state.effectOverrides[effectId] || {}),
      enabled: enabled === true
    };
    this.applyOverrides();
  }

  /**
   * @param {string} effectId
   */
  clearEffectOverride(effectId) {
    if (!effectId) return;
    if (!this.state.effectOverrides) this.state.effectOverrides = {};
    delete this.state.effectOverrides[effectId];
    this.applyOverrides();
  }

  resetAllOverrides() {
    this.state.globalDisableAll = false;
    this.state.effectOverrides = {};
    this.applyOverrides();
    this.saveState();
  }

  show() {
    this.dialog.show();
  }

  hide() {
    this.dialog.hide();
  }

  toggle() {
    this.dialog.toggle();
  }

  loadState() {
    try {
      const raw = localStorage.getItem(this._storageKey);
      if (!raw) return;
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object') return;

      if (typeof parsed.globalDisableAll === 'boolean') this.state.globalDisableAll = parsed.globalDisableAll;
      if (parsed.effectOverrides && typeof parsed.effectOverrides === 'object') this.state.effectOverrides = parsed.effectOverrides;

      log.debug('Loaded graphics overrides');
    } catch (e) {
      log.warn('Failed to load graphics overrides', e);
    }
  }

  saveState() {
    try {
      localStorage.setItem(this._storageKey, JSON.stringify(this.state));
    } catch (e) {
      log.warn('Failed to save graphics overrides', e);
    }
  }

  dispose() {
    try {
      this.dialog.dispose();
    } catch (_) {
    }

    this._effects.clear();
  }
}
