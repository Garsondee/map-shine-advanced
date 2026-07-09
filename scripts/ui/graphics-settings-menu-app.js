/**
 * @fileoverview Foundry module-settings submenu launcher for Performance & Graphics.
 * Works before Map Shine finishes loading a scene — edits client Foundry settings.
 * @module ui/graphics-settings-menu-app
 */

import {
  CLIENT_GPU_VRAM_PRESET_SETTING,
  CLIENT_RENDER_RESOLUTION_PRESET_SETTING,
  listGpuVramPresetOptions,
} from '../streaming/memory-settings.js';

const MODULE_ID = 'map-shine-advanced';

const CLIENT_RENDER_RESOLUTION_OPTIONS = Object.freeze([
  { id: 'native', label: 'Native (full quality)' },
  { id: '1920x1080', label: '1920×1080' },
  { id: '1280x720', label: '1280×720' },
  { id: '800x450', label: '800×450' },
]);

/**
 * Open the per-client Performance & Graphics overlay when the live manager exists.
 * @returns {boolean} true when opened
 */
export function openPerformanceGraphicsFromSettings() {
  const graphicsSettings = window.MapShine?.graphicsSettings;
  if (!graphicsSettings || typeof graphicsSettings.show !== 'function') {
    ui.notifications?.warn?.(
      'The full Performance & Graphics panel opens after Map Shine initializes. '
      + 'Use the GPU VRAM and render resolution controls below while a scene is loading.',
    );
    return false;
  }
  graphicsSettings.show();
  return true;
}

/**
 * Small FormApplication opened from Configure Settings → Map Shine submenus.
 */
export class GraphicsSettingsMenuApp extends FormApplication {
  static get defaultOptions() {
    return foundry.utils.mergeObject(super.defaultOptions, {
      id: 'map-shine-performance-graphics-menu',
      title: 'Performance & Graphics',
      template: `modules/${MODULE_ID}/templates/performance-graphics-menu.hbs`,
      classes: ['map-shine-performance-graphics-menu'],
      width: 520,
      height: 'auto',
      closeOnSubmit: false,
      submitOnChange: false,
    });
  }

  /** @override */
  getData() {
    let gpuVramPreset = 'auto';
    let renderResolutionPreset = 'native';
    try {
      gpuVramPreset = game.settings.get(MODULE_ID, CLIENT_GPU_VRAM_PRESET_SETTING) ?? 'auto';
      renderResolutionPreset = game.settings.get(MODULE_ID, CLIENT_RENDER_RESOLUTION_PRESET_SETTING) ?? 'native';
    } catch (_) {
    }

    return {
      gpuVramOptions: listGpuVramPresetOptions().map((opt) => ({
        ...opt,
        selected: opt.id === gpuVramPreset,
      })),
      gpuVramPreset,
      renderResolutionOptions: CLIENT_RENDER_RESOLUTION_OPTIONS.map((opt) => ({
        ...opt,
        selected: opt.id === renderResolutionPreset,
      })),
      renderResolutionPreset,
    };
  }

  /** @override */
  activateListeners(html) {
    super.activateListeners(html);

    html.find('[data-action="open"]').on('click', (ev) => {
      ev.preventDefault();
      openPerformanceGraphicsFromSettings();
    });

    html.find('[name="clientGpuVramPreset"]').on('change', async (ev) => {
      const value = String(ev.currentTarget.value || 'auto');
      try {
        await game.settings.set(MODULE_ID, CLIENT_GPU_VRAM_PRESET_SETTING, value);
        ui.notifications?.info?.('GPU VRAM preset saved. Reload the world or scene for it to apply.');
      } catch (e) {
        ui.notifications?.error?.('Failed to save GPU VRAM preset.');
      }
    });

    html.find('[name="clientRenderResolutionPreset"]').on('change', async (ev) => {
      const value = String(ev.currentTarget.value || 'native');
      try {
        await game.settings.set(MODULE_ID, CLIENT_RENDER_RESOLUTION_PRESET_SETTING, value);
        ui.notifications?.info?.('Default render resolution saved. Reload the world or scene for it to apply.');
      } catch (e) {
        ui.notifications?.error?.('Failed to save render resolution preset.');
      }
    });
  }

  /** @override */
  async _updateObject(_event, _formData) {
  }
}
