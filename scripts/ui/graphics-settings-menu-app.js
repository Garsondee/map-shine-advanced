/**
 * @fileoverview Foundry module-settings submenu launcher for Performance & Graphics.
 * @module ui/graphics-settings-menu-app
 */

const MODULE_ID = 'map-shine-advanced';

/**
 * Open the per-client Performance & Graphics overlay.
 * @returns {boolean} true when opened
 */
export function openPerformanceGraphicsFromSettings() {
  const graphicsSettings = window.MapShine?.graphicsSettings;
  if (!graphicsSettings || typeof graphicsSettings.show !== 'function') {
    ui.notifications?.warn?.('Performance & Graphics are not available yet. The scene may still be initializing.');
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
      width: 440,
      height: 'auto',
      closeOnSubmit: false,
      submitOnChange: false,
    });
  }

  /** @override */
  getData() {
    return {};
  }

  /** @override */
  activateListeners(html) {
    super.activateListeners(html);
    html.find('[data-action="open"]').on('click', (ev) => {
      ev.preventDefault();
      if (openPerformanceGraphicsFromSettings()) {
        this.close();
      }
    });
  }

  /** @override */
  async _updateObject(_event, _formData) {
  }
}
