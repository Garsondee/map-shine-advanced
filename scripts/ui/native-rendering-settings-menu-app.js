/**
 * @fileoverview Foundry module-settings submenu for native Foundry/PIXI rendering opt-out.
 * @module ui/native-rendering-settings-menu-app
 */

import {
  NATIVE_FOUNDRY_RENDERING_SETTING,
  isNativeFoundryRenderingEnabled,
  notifyNativeRenderingReloadRequired,
} from '../settings/scene-settings.js';

const MODULE_ID = 'map-shine-advanced';

/**
 * Small FormApplication opened from Configure Settings → Map Shine submenus.
 */
export class NativeRenderingSettingsMenuApp extends FormApplication {
  static get defaultOptions() {
    return foundry.utils.mergeObject(super.defaultOptions, {
      id: 'map-shine-native-rendering-menu',
      title: game.i18n.localize('MAPSHINE.NativeFoundryRenderingMenuTitle'),
      template: `modules/${MODULE_ID}/templates/native-rendering-menu.hbs`,
      classes: ['map-shine-native-rendering-menu'],
      width: 560,
      height: 'auto',
      closeOnSubmit: false,
      submitOnChange: false,
    });
  }

  /** @override */
  getData() {
    return {
      enabled: isNativeFoundryRenderingEnabled(),
    };
  }

  /** @override */
  activateListeners(html) {
    super.activateListeners(html);

    html.find('[data-action="reload"]').on('click', (ev) => {
      ev.preventDefault();
      window.location.reload();
    });

    html.find('[name="useNativeFoundryRendering"]').on('change', async (ev) => {
      const enabled = !!ev.currentTarget.checked;
      const previous = isNativeFoundryRenderingEnabled();
      if (enabled === previous) return;

      try {
        await game.settings.set(MODULE_ID, NATIVE_FOUNDRY_RENDERING_SETTING, enabled);
      } catch (e) {
        ev.currentTarget.checked = previous;
        ui.notifications?.error?.('Failed to save native rendering preference.');
        return;
      }

      notifyNativeRenderingReloadRequired(enabled);
      html.find('[data-native-rendering-status]').text(
        enabled
          ? game.i18n.localize('MAPSHINE.NativeFoundryRenderingStatusOn')
          : game.i18n.localize('MAPSHINE.NativeFoundryRenderingStatusOff')
      );
    });
  }

  /** @override */
  async _updateObject(_event, _formData) {
  }
}
