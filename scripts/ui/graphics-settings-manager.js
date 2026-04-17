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

// Legacy/alias IDs used by capabilities or historical UI wiring.
// Normalize these to the runtime V2 effect IDs so overrides remain stable.
const EFFECT_ID_ALIASES = Object.freeze({
  'window-lights': 'windowLight',
  'window-light': 'windowLight',
  'color-correction': 'colorCorrection',
  'dot-screen': 'dotScreen',
  'clouds': 'cloud',
  'trees': 'tree',
  'bushes': 'bush',
});

// Graphics effect ID -> FloorCompositor V2 property key.
const V2_EFFECT_KEY_BY_ID = Object.freeze({
  lighting: '_lightingEffect',
  specular: '_specularEffect',
  fluid: '_fluidEffect',
  iridescence: '_iridescenceEffect',
  prism: '_prismEffect',
  bush: '_bushEffect',
  tree: '_treeEffect',
  'sky-color': '_skyColorEffect',
  windowLight: '_windowLightEffect',
  'fire-sparks': '_fireEffect',
  'water-splashes': '_waterSplashesEffect',
  'underwater-bubbles': '_underwaterBubblesEffect',
  bloom: '_bloomEffect',
  colorCorrection: '_colorCorrectionEffect',
  filter: '_filterEffect',
  'atmospheric-fog': '_atmosphericFogEffect',
  fog: '_fogEffect',
  sharpen: '_sharpenEffect',
  dotScreen: '_dotScreenEffect',
  halftone: '_halftoneEffect',
  ascii: '_asciiEffect',
  dazzleOverlay: '_dazzleOverlayEffect',
  visionMode: '_visionModeEffect',
  invert: '_invertEffect',
  sepia: '_sepiaEffect',
  lens: '_lensEffect',
  water: '_waterEffect',
  cloud: '_cloudEffect',
  'overhead-shadows': '_overheadShadowEffect',
  'building-shadows': '_buildingShadowEffect',
  'player-light': '_playerLightEffect',
  'candle-flames': '_candleFlamesEffect',
});

/**
 * @typedef {Object} GraphicsSettingsState
 * @property {boolean} globalDisableAll
 * @property {string} renderResolutionPreset
 * @property {boolean} renderAdaptiveFpsEnabled
 * @property {number} renderIdleFps
 * @property {number} renderActiveFps
 * @property {number} renderContinuousFps
 * @property {boolean} tokenDepthInteraction - P4-02: tokens participate in depth buffer when true
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
      renderAdaptiveFpsEnabled: true,
      renderIdleFps: 15,
      renderActiveFps: 60,
      renderContinuousFps: 30,
      // P4-02: When true, token sprites use depthTest/depthWrite so elevated foreground
      // tiles correctly occlude them. Default false preserves legacy always-on-top behaviour.
      tokenDepthInteraction: false,
      effectOverrides: {}
    };

    /** @type {Function|null} Callback invoked when tokenDepthInteraction changes. */
    this._onTokenDepthInteractionChanged = null;

    this.dialog = new GraphicsSettingsDialog(this);

    this._storageKey = this._buildStorageKey();

    // Cache of effect instances wired for runtime application.
    /** @type {Map<string, any>} */
    this._effects = new Map();
  }

  /**
   * @private
   * @param {string} effectId
   * @returns {string}
   */
  _normalizeEffectId(effectId) {
    if (!effectId) return '';
    return EFFECT_ID_ALIASES[effectId] || effectId;
  }

  /**
   * @private
   * @param {string} effectId
   * @returns {Array<string>}
   */
  _legacyAliasKeysFor(effectId) {
    const normalized = this._normalizeEffectId(effectId);
    const out = [];
    for (const [legacy, canonical] of Object.entries(EFFECT_ID_ALIASES)) {
      if (canonical === normalized) out.push(legacy);
    }
    return out;
  }

  /**
   * @private
   * @param {string} effectId
   * @returns {{enabled?: boolean}|null}
   */
  _getOverride(effectId) {
    const overrides = this.state.effectOverrides || {};
    const normalized = this._normalizeEffectId(effectId);
    if (overrides[normalized]) return overrides[normalized];
    if (overrides[effectId]) return overrides[effectId];
    const aliases = this._legacyAliasKeysFor(normalized);
    for (const key of aliases) {
      if (overrides[key]) return overrides[key];
    }
    return null;
  }

  /**
   * @private
   * @param {string} effectKey
   * @param {boolean} enabled
   */
  _queueV2Enabled(effectKey, enabled) {
    try {
      if (!window?.MapShine) return;
      const root = window.MapShine;
      if (!root.__pendingV2EffectParams) root.__pendingV2EffectParams = {};
      if (!root.__pendingV2EffectParams[effectKey]) root.__pendingV2EffectParams[effectKey] = {};
      root.__pendingV2EffectParams[effectKey].enabled = enabled === true;
    } catch (_) {
    }
  }

  /**
   * @private
   * @param {string} effectId
   * @param {boolean} enabled
   * @returns {boolean} true when the ID maps to a V2 effect key
   */
  _applyV2Enabled(effectId, enabled) {
    const normalized = this._normalizeEffectId(effectId);
    const effectKey = V2_EFFECT_KEY_BY_ID[normalized];
    if (!effectKey) return false;

    // Always queue so toggles made before lazy compositor creation still apply.
    this._queueV2Enabled(effectKey, enabled);

    try {
      const fc = window.MapShine?.effectComposer?._floorCompositorV2
        ?? this.effectComposer?._floorCompositorV2
        ?? null;
      if (!fc) return true;

      if (typeof fc.applyParam === 'function') {
        fc.applyParam(effectKey, 'enabled', enabled === true);
        return true;
      }

      const effect = fc[effectKey];
      if (!effect) return true;
      if (typeof effect.enabled === 'boolean') {
        effect.enabled = enabled === true;
      }
      if (effect.params && Object.prototype.hasOwnProperty.call(effect.params, 'enabled')) {
        effect.params.enabled = enabled === true;
      }
    } catch (e) {
      log.warn(`Failed to apply V2 override to ${normalized}`, e);
    }
    return true;
  }

  /**
   * @private
   * @param {*} value
   * @param {number} fallback
   * @param {number} min
   * @param {number} max
   * @returns {number}
   */
  _coerceFps(value, fallback, min, max) {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.max(min, Math.min(max, Math.floor(n)));
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
    this._effects.set(this._normalizeEffectId(effectId), effect);
  }

  /**
   * Initialize UI and load persisted state.
   */
  async initialize() {
    this.loadState();

    // Render loop reads these values from window.MapShine each frame.
    this.applyRenderPerformanceSettings();

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
   * @returns {boolean}
   */
  getRenderAdaptiveFpsEnabled() {
    return this.state?.renderAdaptiveFpsEnabled === true;
  }

  /**
   * @returns {number}
   */
  getRenderIdleFps() {
    return this._coerceFps(this.state?.renderIdleFps, 15, 5, 60);
  }

  /**
   * @returns {number}
   */
  getRenderActiveFps() {
    return this._coerceFps(this.state?.renderActiveFps, 60, 5, 120);
  }

  /**
   * @returns {number}
   */
  getRenderContinuousFps() {
    return this._coerceFps(this.state?.renderContinuousFps, 30, 5, 120);
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
   * P4-02: Returns the current tokenDepthInteraction setting.
   * @returns {boolean}
   */
  getTokenDepthInteraction() {
    return this.state.tokenDepthInteraction === true;
  }

  /**
   * P4-02/03: Set tokenDepthInteraction and notify TokenManager to apply it to all
   * existing sprites immediately.
   * @param {boolean} enabled
   */
  setTokenDepthInteraction(enabled) {
    this.state.tokenDepthInteraction = enabled === true;
    try {
      this._onTokenDepthInteractionChanged?.(this.state.tokenDepthInteraction);
    } catch (e) {
      log.warn('Failed to propagate tokenDepthInteraction change', e);
    }
    this.saveState();
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
    
    this.saveState();
  }

  /**
   * @param {boolean} enabled
   */
  setRenderAdaptiveFpsEnabled(enabled) {
    this.state.renderAdaptiveFpsEnabled = enabled === true;
    this.applyRenderPerformanceSettings();
    this.saveState();
  }

  /**
   * @param {number} fps
   */
  setRenderIdleFps(fps) {
    this.state.renderIdleFps = this._coerceFps(fps, 15, 5, 60);
    this.applyRenderPerformanceSettings();
    this.saveState();
  }

  /**
   * @param {number} fps
   */
  setRenderActiveFps(fps) {
    this.state.renderActiveFps = this._coerceFps(fps, 60, 5, 120);
    this.applyRenderPerformanceSettings();
    this.saveState();
  }

  /**
   * @param {number} fps
   */
  setRenderContinuousFps(fps) {
    this.state.renderContinuousFps = this._coerceFps(fps, 30, 5, 120);
    this.applyRenderPerformanceSettings();
    this.saveState();
  }

  /**
   * Push current frame pacing settings into the runtime namespace consumed by RenderLoop.
   */
  applyRenderPerformanceSettings() {
    try {
      if (!window) return;
      const ms = window.MapShine || (window.MapShine = {});
      ms.renderAdaptiveFpsEnabled = this.getRenderAdaptiveFpsEnabled();
      ms.renderIdleFps = this.getRenderIdleFps();
      ms.renderActiveFps = this.getRenderActiveFps();
      ms.renderContinuousFps = this.getRenderContinuousFps();
    } catch (e) {
      log.warn('Failed to apply render performance settings', e);
    }
  }

  /**
   * @returns {Array<{effectId:string, displayName:string}>}
   */
  listEffectsForUI() {
    const caps = this.capabilitiesRegistry?.list?.() ?? [];
    if (caps.length > 0) {
      const seen = new Set();
      const out = [];
      for (const c of caps) {
        const normalized = this._normalizeEffectId(c.effectId);
        if (!normalized || seen.has(normalized)) continue;
        seen.add(normalized);
        out.push({
          effectId: normalized,
          displayName: c.displayName || normalized
        });
      }
      return out;
    }

    // Fallback: if registry isn't available, list known registered instances.
    return Array.from(this._effects.keys()).map((id) => {
      const normalized = this._normalizeEffectId(id);
      return { effectId: normalized, displayName: normalized };
    });
  }

  /**
   * @param {string} effectId
   * @returns {{available:boolean, reason:string}}
   */
  getAvailability(effectId) {
    if (!this.capabilitiesRegistry?.getAvailability) return { available: true, reason: '' };

    const normalized = this._normalizeEffectId(effectId);
    const candidates = [normalized, effectId, ...this._legacyAliasKeysFor(normalized)];
    for (const id of candidates) {
      if (!id) continue;
      const caps = this.capabilitiesRegistry.get?.(id);
      if (!caps) continue;
      return this.capabilitiesRegistry.getAvailability(id);
    }

    return { available: true, reason: '' };
  }

  /**
   * Effective enabled state = availability && !globalDisableAll && per-effect enabled (if set).
   * @param {string} effectId
   */
  getEffectiveEnabled(effectId) {
    const normalized = this._normalizeEffectId(effectId);
    const avail = this.getAvailability(effectId);
    if (!avail.available) return false;

    if (this.state.globalDisableAll) return false;

    const ov = this._getOverride(normalized);
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
    const ids = new Set([
      ...this.listEffectsForUI().map((e) => this._normalizeEffectId(e.effectId)),
      ...Array.from(this._effects.keys()).map((id) => this._normalizeEffectId(id)),
    ]);

    for (const effectId of ids) {
      if (!effectId) continue;
      const enabled = this.getEffectiveEnabled(effectId);
      const effect = this._effects.get(effectId);

      // V2 runtime path (FloorCompositor-owned effects)
      this._applyV2Enabled(effectId, enabled);

      // Legacy/direct instance path (V1 or hybrid instances)
      if (!effect) continue;

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
    const normalized = this._normalizeEffectId(effectId);
    this.state.effectOverrides[normalized] = {
      ...(this.state.effectOverrides[normalized] || {}),
      enabled: enabled === true
    };
    // Clean legacy alias keys to avoid conflicting duplicate entries.
    for (const legacyKey of this._legacyAliasKeysFor(normalized)) {
      if (legacyKey !== normalized) delete this.state.effectOverrides[legacyKey];
    }
    this.applyOverrides();
  }

  /**
   * @param {string} effectId
   */
  clearEffectOverride(effectId) {
    if (!effectId) return;
    if (!this.state.effectOverrides) this.state.effectOverrides = {};
    const normalized = this._normalizeEffectId(effectId);
    delete this.state.effectOverrides[normalized];
    for (const legacyKey of this._legacyAliasKeysFor(normalized)) {
      delete this.state.effectOverrides[legacyKey];
    }
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
      if (typeof parsed.renderAdaptiveFpsEnabled === 'boolean') this.state.renderAdaptiveFpsEnabled = parsed.renderAdaptiveFpsEnabled;
      if (parsed.renderIdleFps !== undefined) this.state.renderIdleFps = this._coerceFps(parsed.renderIdleFps, 15, 5, 60);
      if (parsed.renderActiveFps !== undefined) this.state.renderActiveFps = this._coerceFps(parsed.renderActiveFps, 60, 5, 120);
      if (parsed.renderContinuousFps !== undefined) this.state.renderContinuousFps = this._coerceFps(parsed.renderContinuousFps, 30, 5, 120);
      if (typeof parsed.tokenDepthInteraction === 'boolean') this.state.tokenDepthInteraction = parsed.tokenDepthInteraction;
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
