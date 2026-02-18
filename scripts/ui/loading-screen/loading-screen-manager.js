/**
 * @fileoverview Loading screen manager (GM utility entry point).
 * @module ui/loading-screen/loading-screen-manager
 */

import { loadingScreenService, LOADING_SCREEN_MODES } from './loading-screen-service.js';
import { LoadingScreenDialog } from './loading-screen-dialog.js';
import { deepClone } from './loading-screen-config.js';
import { clearPresetCache } from './loading-screen-presets.js';

const MODULE_ID = 'map-shine-advanced';

export class LoadingScreenManager {
  constructor() {
    this._dialog = null;
    this._initialized = false;
  }

  async initialize() {
    if (this._initialized) return;
    this._initialized = true;

    await loadingScreenService.initialize();
    this._dialog = new LoadingScreenDialog(this);
    await this._dialog.initialize(document.body);
  }

  async open() {
    await this.initialize();
    this._dialog?.show();
  }

  async close() {
    await this.initialize();
    this._dialog?.hide();
  }

  async toggle() {
    await this.initialize();
    this._dialog?.toggle();
  }

  /**
   * @returns {Promise<Object>}
   */
  async getRuntimeState() {
    // Clear preset cache so a fresh fetch happens each time the dialog opens,
    // avoiding stale data from an earlier fetch that may have failed.
    clearPresetCache();
    await loadingScreenService.refreshFromGameSettings();

    const settings = loadingScreenService.settings;
    return {
      enabled: settings.enabled !== false,
      mode: settings.mode || LOADING_SCREEN_MODES.LEGACY,
      applyTo: settings.applyTo || 'all',
      googleFontsEnabled: settings.googleFontsEnabled !== false,
      useFoundryDefault: settings.useFoundryDefault === true,
      activePresetId: settings.activePresetId || 'map-shine-default',
      config: loadingScreenService.getStyledConfig(),
      userPresets: await this.getUserPresets(),
      builtInPresets: await loadingScreenService.getBuiltInPresets(),
    };
  }

  /**
   * @param {Object} state
   * @returns {Promise<void>}
   */
  async saveRuntimeState(state) {
    const nextSettings = {
      ...loadingScreenService.settings,
      enabled: state.enabled !== false,
      mode: String(state.mode || LOADING_SCREEN_MODES.LEGACY),
      applyTo: String(state.applyTo || 'all'),
      googleFontsEnabled: state.googleFontsEnabled !== false,
      useFoundryDefault: state.useFoundryDefault === true,
      activePresetId: String(state.activePresetId || 'map-shine-default'),
      styledConfig: deepClone(state.config || loadingScreenService.getStyledConfig()),
    };

    await loadingScreenService.updateSettings(nextSettings);
  }

  /**
   * @param {string} presetId
   * @returns {Promise<Object>}
   */
  async applyBuiltInPreset(presetId) {
    await loadingScreenService.applyPreset(presetId);
    return loadingScreenService.getStyledConfig();
  }

  /**
   * Apply either built-in or user preset by id.
   * @param {string} presetId
   * @returns {Promise<Object|null>}
   */
  async applyPresetById(presetId) {
    const id = String(presetId || '').trim();
    if (!id) return null;

    const builtIns = await loadingScreenService.getBuiltInPresets();
    const builtIn = builtIns.find((p) => String(p?.id || '') === id);
    if (builtIn) {
      await loadingScreenService.applyPreset(id);
      return loadingScreenService.getStyledConfig();
    }

    const users = await this.getUserPresets();
    const user = users.find((p) => String(p?.id || '') === id);
    if (!user?.config) return null;

    await this.saveStyledConfig(user.config);
    return loadingScreenService.getStyledConfig();
  }

  /**
   * @returns {Promise<Array<any>>}
   */
  async getUserPresets() {
    try {
      const raw = game.settings.get(MODULE_ID, 'loadingScreenUserPresets');
      return Array.isArray(raw) ? raw : [];
    } catch (_) {
      return [];
    }
  }

  /**
   * @param {{id?:string,name:string,config:Object}} preset
   * @returns {Promise<void>}
   */
  async saveUserPreset(preset) {
    const list = await this.getUserPresets();
    const id = String(preset.id || `user-${Date.now()}`);

    const next = [...list];
    const index = next.findIndex((p) => String(p?.id || '') === id);
    const item = {
      id,
      name: String(preset.name || 'Custom Preset').trim() || 'Custom Preset',
      config: deepClone(preset.config || loadingScreenService.getStyledConfig()),
    };

    if (index >= 0) next[index] = item;
    else next.push(item);

    await game.settings.set(MODULE_ID, 'loadingScreenUserPresets', next);
  }

  /**
   * @param {string} presetId
   * @returns {Promise<void>}
   */
  async deleteUserPreset(presetId) {
    const id = String(presetId || '').trim();
    if (!id) return;

    const list = await this.getUserPresets();
    const next = list.filter((p) => String(p?.id || '') !== id);
    await game.settings.set(MODULE_ID, 'loadingScreenUserPresets', next);
  }

  /**
   * @param {Object} config
   * @returns {Promise<void>}
   */
  async saveStyledConfig(config) {
    await loadingScreenService.saveStyledConfig(config);
  }

  dispose() {
    try {
      this._dialog?.dispose();
    } catch (_) {
    }
    this._dialog = null;
    this._initialized = false;
  }
}
