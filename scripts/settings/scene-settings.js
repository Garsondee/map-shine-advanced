/**
 * @fileoverview Scene settings management with three-tier control system
 * Handles Map Maker (author) → GM (game master) → Player (end user) settings hierarchy
 * @module settings/scene-settings
 */

import { createLogger } from '../core/log.js';

const log = createLogger('Settings');

/** Current module version for settings migration */
const CURRENT_VERSION = '0.2.0';

/** Flag namespace in Foundry scene */
const FLAG_NAMESPACE = 'map-shine-advanced';

/**
 * Check if a scene is enabled for Map Shine
 * @param {Scene} scene - Foundry scene object
 * @returns {boolean} Whether Map Shine is enabled
 * @public
 */
export function isEnabled(scene) {
  return scene.getFlag(FLAG_NAMESPACE, 'enabled') === true;
}

/**
 * Enable Map Shine for a scene with default settingsxx
 * @param {Scene} scene - Foundry scene object
 * @returns {Promise<void>}
 * @public
 */
export async function enable(scene) {
  const defaultSettings = createDefaultSettings();
  
  await scene.setFlag(FLAG_NAMESPACE, 'enabled', true);
  await scene.setFlag(FLAG_NAMESPACE, 'settings', defaultSettings);
  
  log.info(`Map Shine enabled for scene: ${scene.name}`);
}

/**
 * Disable Map Shine for a scene
 * @param {Scene} scene - Foundry scene object
 * @returns {Promise<void>}
 * @public
 */
export async function disable(scene) {
  await scene.setFlag(FLAG_NAMESPACE, 'enabled', false);
  log.info(`Map Shine disabled for scene: ${scene.name}`);
}

/**
 * Get effective settings for current user, respecting three-tier hierarchy
 * @param {Scene} scene - Foundry scene object
 * @returns {EffectiveSettings} Resolved settings
 * @public
 */
export function getEffectiveSettings(scene) {
  if (!isEnabled(scene)) {
    return null;
  }

  const settings = scene.getFlag(FLAG_NAMESPACE, 'settings');
  if (!settings) {
    log.warn('Scene enabled but no settings found, using defaults');
    return createDefaultSettings();
  }

  // Determine user mode
  const isGM = game.user.isGM;
  const mode = isGM ? 'gm' : 'player';

  // Get player overrides from client settings
  const playerOverrides = game.settings.get('map-shine-advanced', `scene-${scene.id}-player-overrides`) || {};

  // Resolve settings hierarchy: mapMaker → gm → player
  let effectiveEffects = { ...settings.mapMaker.effects };

  // Apply GM overrides if present
  if (settings.gm && settings.gm.effects) {
    effectiveEffects = { ...effectiveEffects, ...settings.gm.effects };
  }

  // Apply player overrides (disable only)
  for (const [effectId, enabled] of Object.entries(playerOverrides)) {
    if (effectiveEffects[effectId] && !enabled) {
      effectiveEffects[effectId] = { ...effectiveEffects[effectId], enabled: false };
    }
  }

  return {
    effects: effectiveEffects,
    activeMode: mode,
    canRevert: isGM && settings.gm !== null
  };
}

/**
 * Save Map Maker (author) settings to scene
 * @param {Scene} scene - Foundry scene object
 * @param {SceneSettings} settings - Settings to save
 * @returns {Promise<void>}
 * @public
 */
export async function saveMapMakerSettings(scene, settings) {
  if (!game.user.isGM) {
    throw new Error('Only GMs can save Map Maker settings');
  }

  settings.version = CURRENT_VERSION;
  
  const currentSettings = scene.getFlag(FLAG_NAMESPACE, 'settings') || {};
  currentSettings.mapMaker = settings;

  await scene.setFlag(FLAG_NAMESPACE, 'settings', currentSettings);
  log.info('Map Maker settings saved');
}

/**
 * Save GM override settings to scene
 * @param {Scene} scene - Foundry scene object
 * @param {SceneSettings} settings - Settings to save
 * @returns {Promise<void>}
 * @public
 */
export async function saveGMSettings(scene, settings) {
  if (!game.user.isGM) {
    throw new Error('Only GMs can save GM settings');
  }

  settings.version = CURRENT_VERSION;

  const currentSettings = scene.getFlag(FLAG_NAMESPACE, 'settings') || {};
  currentSettings.gm = settings;

  await scene.setFlag(FLAG_NAMESPACE, 'settings', currentSettings);
  log.info('GM settings saved');
}

/**
 * Revert GM settings back to Map Maker original
 * @param {Scene} scene - Foundry scene object
 * @returns {Promise<void>}
 * @public
 */
export async function revertToOriginal(scene) {
  if (!game.user.isGM) {
    throw new Error('Only GMs can revert settings');
  }

  const currentSettings = scene.getFlag(FLAG_NAMESPACE, 'settings') || {};
  currentSettings.gm = null;

  await scene.setFlag(FLAG_NAMESPACE, 'settings', currentSettings);
  log.info('Reverted to Map Maker original settings');
}

/**
 * Save player overrides (client-local, not distributed)
 * @param {Scene} scene - Foundry scene object
 * @param {Object.<string, boolean>} overrides - Effect ID to enabled state
 * @returns {Promise<void>}
 * @public
 */
export async function savePlayerOverrides(scene, overrides) {
  await game.settings.set('map-shine-advanced', `scene-${scene.id}-player-overrides`, overrides);
  log.info('Player overrides saved (client-local)');
}

/**
 * Migrate settings from old version to current
 * @param {SceneSettings} oldSettings - Settings to migrate
 * @returns {MigrationResult} Migration result
 * @public
 */
export function migrateSettings(oldSettings) {
  const fromVersion = oldSettings.version || '0.1.0';
  const warnings = [];

  try {
    // Migration logic will be added as versions evolve
    // For now, just ensure version is current
    const migratedSettings = { ...oldSettings };
    migratedSettings.version = CURRENT_VERSION;

    log.info(`Migrated settings from ${fromVersion} to ${CURRENT_VERSION}`);

    return {
      success: true,
      fromVersion,
      toVersion: CURRENT_VERSION,
      warnings,
      error: null
    };
  } catch (error) {
    log.error('Settings migration failed:', error);
    return {
      success: false,
      fromVersion,
      toVersion: CURRENT_VERSION,
      warnings,
      error
    };
  }
}

/**
 * Create default scene settings
 * @returns {SceneSettings} Default settings
 * @private
 */
function createDefaultSettings() {
  return {
    mapMaker: {
      enabled: true,
      version: CURRENT_VERSION,
      effects: {},
      renderer: {
        antialias: true,
        pixelRatio: 'auto'
      },
      performance: {
        targetFPS: 30,
        adaptiveQuality: true
      }
    },
    gm: null,
    player: {}
  };
}

/**
 * Register client settings for player overrides
 * Called during module initialization
 * @public
 */
export function registerSettings() {
  // Note: Per-scene player overrides are registered dynamically
  // This is just a placeholder for module-wide settings
  
  game.settings.register('map-shine-advanced', 'debug-mode', {
    name: 'Debug Mode',
    hint: 'Enable verbose logging for troubleshooting',
    scope: 'client',
    config: true,
    type: Boolean,
    default: false
  });

  log.info('Settings registered');
}
