/**
 * @fileoverview Unified loading screen service.
 * Bridges legacy LoadingOverlay and new styled renderer while keeping API compatibility.
 * @module ui/loading-screen/loading-screen-service
 */

import { loadingOverlay as legacyLoadingOverlay } from '../loading-overlay.js';
import { StyledLoadingScreenRenderer } from './styled-loading-screen-renderer.js';
import { applyPresetToConfig, loadBuiltInPresets } from './loading-screen-presets.js';
import { createDefaultStyledLoadingScreenConfig, deepClone, normalizeLoadingScreenConfig } from './loading-screen-config.js';
import { loadConfiguredFonts } from './loading-screen-fonts.js';
import { isFirstLoadOfSession, preloadWallpapers, selectWallpaper } from './loading-screen-wallpapers.js';

const MODULE_ID = 'map-shine-advanced';

export const LOADING_SCREEN_MODES = Object.freeze({
  LEGACY: 'legacy',
  STYLED: 'styled',
  FOUNDRY: 'foundry',
});

/**
 * @typedef {Object} LoadingScreenRuntimeSettings
 * @property {boolean} enabled
 * @property {string} mode
 * @property {string} applyTo
 * @property {boolean} googleFontsEnabled
 * @property {boolean} useFoundryDefault
 * @property {string|null} activePresetId
 * @property {Object} styledConfig
 */

class LoadingScreenService {
  constructor() {
    this.legacy = legacyLoadingOverlay;
    this.styled = new StyledLoadingScreenRenderer();
    this.noop = {
      configureStages: () => {},
      startStages: () => {},
      setStage: () => {},
      ensure: () => {},
      setSceneName: () => {},
      setMessage: () => {},
      setProgress: () => {},
      startAutoProgress: () => {},
      stopAutoProgress: () => {},
      showBlack: () => {},
      showLoading: () => {},
      hide: () => {},
      fadeToBlack: async () => {},
      fadeIn: async () => {},
      enableDebugMode: () => {},
      disableDebugMode: () => {},
      appendDebugLine: () => {},
      setDebugLog: () => {},
      showDebugDismiss: () => {},
      getElapsedSeconds: () => 0,
    };

    /** @type {LoadingScreenRuntimeSettings} */
    this.settings = this.createDefaultSettings();

    this._initialized = false;
    this._activeRenderer = this.legacy;
  }

  _active() {
    return this._activeRenderer ?? this.legacy;
  }

  createDefaultSettings() {
    return {
      enabled: true,
      mode: LOADING_SCREEN_MODES.LEGACY,
      applyTo: 'all',
      googleFontsEnabled: true,
      useFoundryDefault: false,
      activePresetId: 'map-shine-default',
      styledConfig: createDefaultStyledLoadingScreenConfig(),
    };
  }

  /**
   * Initialize from Foundry settings if available.
   * Safe to call multiple times.
   * @returns {Promise<void>}
   */
  async initialize() {
    if (!this._initialized) {
      this._initialized = true;
    }
    await this.refreshFromGameSettings();
  }

  /**
   * Re-read world settings and update active renderer.
   * @returns {Promise<void>}
   */
  async refreshFromGameSettings() {
    const next = this.createDefaultSettings();
    let hasSavedStyledConfig = false;

    try {
      if (globalThis.game?.settings?.get) {
        next.enabled = game.settings.get(MODULE_ID, 'loadingScreenEnabled') !== false;
        next.mode = String(game.settings.get(MODULE_ID, 'loadingScreenMode') || LOADING_SCREEN_MODES.LEGACY);
        next.applyTo = String(game.settings.get(MODULE_ID, 'loadingScreenApplyTo') || 'all');
        next.googleFontsEnabled = game.settings.get(MODULE_ID, 'loadingScreenGoogleFontsEnabled') !== false;
        next.useFoundryDefault = game.settings.get(MODULE_ID, 'loadingScreenUseFoundryDefault') === true;
        next.activePresetId = String(game.settings.get(MODULE_ID, 'loadingScreenActivePresetId') || 'map-shine-default');

        const savedConfig = game.settings.get(MODULE_ID, 'loadingScreenConfig');
        hasSavedStyledConfig = !!savedConfig && typeof savedConfig === 'object';
        next.styledConfig = normalizeLoadingScreenConfig(savedConfig);
      }
    } catch (err) {
      // Keep defaults when settings are not available yet.
      console.debug('Map Shine: loading screen settings not available yet, using defaults', err?.message || err);
    }

    this.settings = next;

    // Apply active preset only when there is no saved styled config yet.
    if (!hasSavedStyledConfig) {
      try {
        this.settings.styledConfig = await applyPresetToConfig(this.settings.activePresetId, this.settings.styledConfig);
      } catch (_) {
      }
    }

    this._activeRenderer = this._selectRenderer();
    const rendererName = this._activeRenderer === this.styled ? 'styled'
      : this._activeRenderer === this.legacy ? 'legacy' : 'noop';
    console.log(`Map Shine: loading screen renderer = ${rendererName}, mode = ${this.settings.mode}, enabled = ${this.settings.enabled}`);

    if (this._activeRenderer === this.styled) {
      this.styled.setConfig(this.settings.styledConfig);
      this._prepareStyledAssets().catch((e) => console.warn('Map Shine: failed to prepare styled assets', e));
    }

    this._syncFoundryLoadingVisibility();
  }

  /**
   * @returns {boolean}
   */
  shouldHandleLoading() {
    if (!this.settings.enabled) return false;
    if (this.settings.useFoundryDefault) return false;
    if (this.settings.mode === LOADING_SCREEN_MODES.FOUNDRY) return false;
    return true;
  }

  /**
   * Save and apply mode/settings in one call.
   * @param {Partial<LoadingScreenRuntimeSettings>} patch
   * @returns {Promise<void>}
   */
  async updateSettings(patch) {
    const merged = {
      ...this.settings,
      ...(patch || {}),
      styledConfig: normalizeLoadingScreenConfig(patch?.styledConfig || this.settings.styledConfig),
    };

    this.settings = merged;
    this._activeRenderer = this._selectRenderer();

    if (this._activeRenderer === this.styled) {
      this.styled.setConfig(this.settings.styledConfig);
      this._prepareStyledAssets().catch(() => {});
    }

    this._syncFoundryLoadingVisibility();
    await this._persistSettings();
  }

  /**
   * @returns {Object}
   */
  getStyledConfig() {
    return deepClone(this.settings.styledConfig);
  }

  /**
   * @param {Object} config
   * @returns {Promise<void>}
   */
  async saveStyledConfig(config) {
    this.settings.styledConfig = normalizeLoadingScreenConfig(config);
    if (this._activeRenderer === this.styled) {
      this.styled.setConfig(this.settings.styledConfig);
      await this._prepareStyledAssets();
    }
    await this._persistSettings();
  }

  /**
   * @returns {Promise<Array<any>>}
   */
  async getBuiltInPresets() {
    return loadBuiltInPresets();
  }

  /**
   * @param {string} presetId
   * @returns {Promise<void>}
   */
  async applyPreset(presetId) {
    this.settings.styledConfig = await applyPresetToConfig(presetId, this.settings.styledConfig);
    this.settings.activePresetId = String(presetId || 'map-shine-default');

    if (this._activeRenderer === this.styled) {
      this.styled.setConfig(this.settings.styledConfig);
      await this._prepareStyledAssets();
    }

    await this._persistSettings();
  }

  // API compatibility methods
  configureStages(stages) { this._active().configureStages?.(stages); }
  startStages(opts) { this._active().startStages?.(opts); }
  setStage(stageId, progress01, message, opts) { this._active().setStage?.(stageId, progress01, message, opts); }
  ensure() { this._active().ensure?.(); }
  setSceneName(name) { this._active().setSceneName?.(name); }
  setMessage(message) { this._active().setMessage?.(message); }
  setProgress(value01, opts) { this._active().setProgress?.(value01, opts); }
  startAutoProgress(target01, rate01PerSec) { this._active().startAutoProgress?.(target01, rate01PerSec); }
  stopAutoProgress() { this._active().stopAutoProgress?.(); }
  showBlack(message) { if (!this.shouldHandleLoading()) return; this._prepareStyledWallpaperForShow(); this._renderer().showBlack?.(message); }
  showLoading(message) { if (!this.shouldHandleLoading()) return; this._prepareStyledWallpaperForShow(); this._renderer().showLoading?.(message); }
  hide() { this._renderer().hide?.(); }

  async fadeToBlack(durationMs = 5000, contentFadeMs = 2000) {
    if (!this.shouldHandleLoading()) return;
    await this._renderer().fadeToBlack?.(durationMs, contentFadeMs);
  }

  async fadeIn(durationMs = 5000, contentFadeMs = 2000) {
    if (!this.shouldHandleLoading()) return;
    await this._renderer().fadeIn?.(durationMs, contentFadeMs);
  }

  enableDebugMode() { this._active().enableDebugMode?.(); }
  disableDebugMode() { this._active().disableDebugMode?.(); }
  appendDebugLine(line) { this._active().appendDebugLine?.(line); }
  setDebugLog(text) { this._active().setDebugLog?.(text); }
  showDebugDismiss(callback) { this._active().showDebugDismiss?.(callback); }
  getElapsedSeconds() { return this._active().getElapsedSeconds?.() ?? 0; }

  _renderer() {
    return this.shouldHandleLoading() ? this._activeRenderer : this.noop;
  }

  _selectRenderer() {
    if (!this.settings.enabled || this.settings.useFoundryDefault) return this.legacy;
    if (this.settings.mode === LOADING_SCREEN_MODES.STYLED) return this.styled;
    if (this.settings.mode === LOADING_SCREEN_MODES.FOUNDRY) return this.legacy;
    return this.legacy;
  }

  async _prepareStyledAssets() {
    const cfg = this.settings.styledConfig || createDefaultStyledLoadingScreenConfig();

    if (this.settings.googleFontsEnabled !== false) {
      await loadConfiguredFonts(cfg.fonts?.googleFamilies || [], { timeoutMs: 3000 });
    }

    await preloadWallpapers(cfg.wallpapers, { decodeTimeoutMs: 2500 });

    this._prepareStyledWallpaperForShow();
  }

  _prepareStyledWallpaperForShow() {
    if (this._activeRenderer !== this.styled) return;
    const cfg = this.settings.styledConfig || createDefaultStyledLoadingScreenConfig();
    const wall = selectWallpaper(cfg.wallpapers, { isFirstLoad: isFirstLoadOfSession() });
    this.styled.setActiveWallpaper(wall);
  }

  _syncFoundryLoadingVisibility() {
    try {
      const native = document.getElementById('loading');
      if (!native) return;
      native.style.display = this.shouldHandleLoading() ? 'none' : '';
    } catch (_) {
    }
  }

  async _persistSettings() {
    try {
      if (!globalThis.game?.settings?.set) {
        console.warn('Map Shine: game.settings.set not available, cannot persist loading screen settings');
        return;
      }
      await game.settings.set(MODULE_ID, 'loadingScreenEnabled', this.settings.enabled !== false);
      await game.settings.set(MODULE_ID, 'loadingScreenMode', String(this.settings.mode || LOADING_SCREEN_MODES.LEGACY));
      await game.settings.set(MODULE_ID, 'loadingScreenApplyTo', String(this.settings.applyTo || 'all'));
      await game.settings.set(MODULE_ID, 'loadingScreenGoogleFontsEnabled', this.settings.googleFontsEnabled !== false);
      await game.settings.set(MODULE_ID, 'loadingScreenUseFoundryDefault', this.settings.useFoundryDefault === true);
      await game.settings.set(MODULE_ID, 'loadingScreenActivePresetId', String(this.settings.activePresetId || 'map-shine-default'));
      await game.settings.set(MODULE_ID, 'loadingScreenConfig', normalizeLoadingScreenConfig(this.settings.styledConfig));
      console.log('Map Shine: loading screen settings persisted to world settings');
    } catch (err) {
      console.error('Map Shine: failed to persist loading screen settings', err);
    }
  }
}

export const loadingScreenService = new LoadingScreenService();
