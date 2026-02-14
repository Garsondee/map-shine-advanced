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
 * @property {string} renderResolutionPreset
 * @property {Object<string, {enabled?: boolean}>} effectOverrides
 */

export class GraphicsSettingsManager {
  /**
   * @param {import('../effects/EffectComposer.js').EffectComposer|null} effectComposer
   * @param {import('../effects/effect-capabilities-registry.js').EffectCapabilitiesRegistry|null} capabilitiesRegistry
   * @param {{onApplyRenderResolution?: Function}|null} [options]
   */
  constructor(effectComposer, capabilitiesRegistry, options = null) {
    this.effectComposer = effectComposer;
    this.capabilitiesRegistry = capabilitiesRegistry;

    /** @type {Function|null} */
    this._onApplyRenderResolution = options?.onApplyRenderResolution ?? null;

    /** @type {GraphicsSettingsState} */
    this.state = {
      globalDisableAll: false,
      renderResolutionPreset: 'native',
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

    try {
      this._onApplyRenderResolution?.();
    } catch (e) {
      log.warn('Failed to apply render resolution during initialize', e);
    }

    await this.dialog.initialize();
    this.applyOverrides();
  }

  /**
   * @returns {string}
   */
  getRenderResolutionPreset() {
    return this.state?.renderResolutionPreset || 'native';
  }

  /**
   * Compute effective renderer pixel ratio based on a familiar resolution preset.
   *
   * Notes:
   * - The canvas remains full-screen in CSS.
   * - We lower the drawing-buffer resolution by lowering renderer pixelRatio.
   * - If the viewport aspect ratio differs from the preset, we fit the preset inside
   *   the viewport while preserving the viewport aspect (pixelRatio is uniform).
   *
   * @param {number} viewportWidthCss
   * @param {number} viewportHeightCss
   * @param {number} basePixelRatio
   * @returns {number}
   */
  computeEffectivePixelRatio(viewportWidthCss, viewportHeightCss, basePixelRatio) {
    const preset = this.getRenderResolutionPreset();
    const base = Math.max(0.1, Number(basePixelRatio) || 1);

    if (!viewportWidthCss || !viewportHeightCss) return base;
    if (!preset || preset === 'native') return base;

    const match = String(preset).match(/^(\d+)x(\d+)$/i);
    if (!match) return base;

    const targetW = Math.max(1, Number(match[1]) || 1);
    const targetH = Math.max(1, Number(match[2]) || 1);

    // Pixel ratio is relative to CSS pixels, so ratio = targetPixels / cssPixels.
    const prFromW = targetW / viewportWidthCss;
    const prFromH = targetH / viewportHeightCss;
    const desired = Math.min(prFromW, prFromH);

    // Never upscale above base DPR.
    const capped = Math.min(base, desired);

    // Clamp to a sane minimum to avoid creating tiny render targets.
    return Math.max(0.1, capped);
  }

  /**
   * @param {string} preset
   */
  setRenderResolutionPreset(preset) {
    const value = preset || 'native';
    this.state.renderResolutionPreset = value;

    try {
      this._onApplyRenderResolution?.();
    } catch (e) {
      log.warn('Failed to apply render resolution', e);
    }
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
   * P2.1: If an effect was deferred during loading (lazy init) and the user
   * re-enables it, trigger ensureEffectInitialized() to compile its shaders
   * on demand. This is async but we fire-and-forget so the UI stays responsive.
   */
  applyOverrides() {
    for (const [effectId, effect] of this._effects.entries()) {
      const enabled = this.getEffectiveEnabled(effectId);

      try {
        // P2.1: If the effect was deferred and is now being enabled, trigger lazy init.
        if (enabled && effect._lazyInitPending && this.effectComposer) {
          this.effectComposer.ensureEffectInitialized(effect.id).then((ok) => {
            if (ok) {
              effect.enabled = true;
              if (effect.params && typeof effect.params.enabled === 'boolean') {
                effect.params.enabled = true;
              }
              if (effect.settings && typeof effect.settings.enabled === 'boolean') {
                effect.settings.enabled = true;
              }
              log.info(`Lazy-initialized and enabled effect: ${effectId}`);
            }
          }).catch((e) => {
            log.warn(`Failed to lazy-initialize effect: ${effectId}`, e);
          });
          // Don't enable yet — let the lazy init callback do it once shaders compile.
          continue;
        }

        // Prefer a dedicated enable/disable hook so effects can immediately hide
        // scene-attached objects even when the composer stops calling update().
        if (typeof effect.setEnabled === 'function') {
          effect.setEnabled(enabled);
        } else {
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
      if (typeof parsed.renderResolutionPreset === 'string') this.state.renderResolutionPreset = parsed.renderResolutionPreset;
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
