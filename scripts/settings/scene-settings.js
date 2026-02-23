/**
 * @fileoverview Scene settings management with three-tier control system
 * Handles Map Maker (author) → GM (game master) → Player (end user) settings hierarchy
 * @module settings/scene-settings
 */

import { createLogger } from '../core/log.js';
import { createDefaultStyledLoadingScreenConfig } from '../ui/loading-screen/loading-screen-config.js';

const log = createLogger('Settings');

/** Current module version for settings migration */
const CURRENT_VERSION = '0.2.0';

/** Flag namespace in Foundry scene */
const FLAG_NAMESPACE = 'map-shine-advanced';

/** Module setting keys */
const DEBUG_LOADING_MODE_SETTING = 'debugLoadingMode';
const LEVELS_COMPATIBILITY_MODE_SETTING = 'levelsCompatibilityMode';
const LIGHT_ICON_LEVEL_VISIBILITY_MODE_SETTING = 'lightIconLevelVisibilityMode';
const LOADING_SCREEN_ENABLED_SETTING = 'loadingScreenEnabled';
const LOADING_SCREEN_MODE_SETTING = 'loadingScreenMode';
const LOADING_SCREEN_CONFIG_SETTING = 'loadingScreenConfig';
const LOADING_SCREEN_USER_PRESETS_SETTING = 'loadingScreenUserPresets';
const LOADING_SCREEN_APPLY_TO_SETTING = 'loadingScreenApplyTo';
const LOADING_SCREEN_GOOGLE_FONTS_ENABLED_SETTING = 'loadingScreenGoogleFontsEnabled';
const LOADING_SCREEN_USE_FOUNDRY_DEFAULT_SETTING = 'loadingScreenUseFoundryDefault';
const LOADING_SCREEN_ACTIVE_PRESET_ID_SETTING = 'loadingScreenActivePresetId';

const LOADING_SCREEN_MODES = Object.freeze({
  LEGACY: 'legacy',
  STYLED: 'styled',
  FOUNDRY: 'foundry',
});

/** Levels compatibility mode setting values */
const LEVELS_COMPATIBILITY_MODES = Object.freeze({
  OFF: 'off',
  IMPORT_ONLY: 'import-only',
  DIAGNOSTIC_INTEROP: 'diagnostic-interop',
});

/** Light icon visibility policy for lighting edit mode. */
export const LIGHT_ICON_LEVEL_VISIBILITY_MODES = Object.freeze({
  ALL: 'all',
  PERSPECTIVE: 'perspective',
});

function _getPlayerOverridesSettingKey(scene) {
  return `scene-${scene?.id}-player-overrides`;
}

/**
 * Read the module-level Debug Loading Mode toggle.
 * @returns {boolean}
 * @public
 */
export function getDebugLoadingModeEnabled() {
  try {
    return !!game.settings.get(FLAG_NAMESPACE, DEBUG_LOADING_MODE_SETTING);
  } catch (_) {
    return false;
  }
}

/**
 * Read light icon level-visibility policy for lighting edit mode.
 * @returns {'all'|'perspective'}
 */
export function getLightIconLevelVisibilityMode() {
  try {
    const raw = String(game.settings.get(FLAG_NAMESPACE, LIGHT_ICON_LEVEL_VISIBILITY_MODE_SETTING) ?? '').trim().toLowerCase();
    if (raw === LIGHT_ICON_LEVEL_VISIBILITY_MODES.PERSPECTIVE) return LIGHT_ICON_LEVEL_VISIBILITY_MODES.PERSPECTIVE;
    return LIGHT_ICON_LEVEL_VISIBILITY_MODES.ALL;
  } catch (_) {
    return LIGHT_ICON_LEVEL_VISIBILITY_MODES.ALL;
  }
}

function _ensurePlayerOverridesSettingRegistered(scene) {
  try {
    if (!scene?.id) return;
    if (!game?.settings?.register || !game?.settings?.settings) return;

    const key = _getPlayerOverridesSettingKey(scene);
    const fullKey = `${FLAG_NAMESPACE}.${key}`;

    if (game.settings.settings.has(fullKey)) return;

    game.settings.register(FLAG_NAMESPACE, key, {
      name: `Player Overrides (${scene.id})`,
      hint: 'Per-scene Map Shine effect enable/disable overrides (client-local)',
      scope: 'client',
      config: false,
      type: Object,
      default: {}
    });
  } catch (e) {
  }
}

/**
 * Safely read player overrides for a scene (registers the setting on-demand).
 * @param {Scene} scene
 * @returns {Object.<string, boolean>}
 * @public
 */
export function getPlayerOverrides(scene) {
  try {
    _ensurePlayerOverridesSettingRegistered(scene);
    const key = _getPlayerOverridesSettingKey(scene);
    return game.settings.get(FLAG_NAMESPACE, key) || {};
  } catch (e) {
    return {};
  }
}

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
  const playerOverrides = getPlayerOverrides(scene);

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
  _ensurePlayerOverridesSettingRegistered(scene);
  await game.settings.set(FLAG_NAMESPACE, _getPlayerOverridesSettingKey(scene), overrides);
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

  // Phase 3 floor loop: per-floor scene rendering for correct per-floor masks,
  // depth capture, and effect isolation on multi-floor Levels scenes. When enabled,
  // EffectComposer renders each visible floor separately (bottom-to-top) with its
  // own mask bundle, depth pass, and scene geometry, then accumulates the results.
  // Has no effect on single-floor scenes. Enabled by default — Phase 3 is complete.
  game.settings.register('map-shine-advanced', 'experimentalFloorRendering', {
    name: 'Per-Floor Rendering',
    hint: 'Render each visible floor separately in multi-floor Levels scenes so each floor uses its own effect masks (water, fire, specular, etc.). Disable only if visual artifacts appear on multi-floor scenes.',
    scope: 'world',
    // Legacy setting retained for backwards compatibility but hidden.
    // Compositor V2 is now the default render path.
    config: false,
    type: Boolean,
    default: true
  });

  // Compositor V2: clean-room per-floor rendering using Three.js layers for
  // floor isolation instead of per-frame visibility toggling. When enabled,
  // FloorCompositor handles the floor loop instead of the legacy EffectComposer
  // floor loop. Default: true (forced default).
  game.settings.register('map-shine-advanced', 'useCompositorV2', {
    name: 'Compositor V2',
    hint: 'Use the clean-room floor compositor with Three.js layer-based isolation.',
    scope: 'world',
    // Forced default: keep out of UI so users can’t accidentally fall back.
    // If you need to debug legacy behavior, toggle this in console or via
    // a temporary local dev patch.
    config: false,
    type: Boolean,
    default: true
  });

  game.settings.register('map-shine-advanced', 'dismissExperimentalWarning', {
    name: 'Dismiss Experimental Warning',
    hint: 'When enabled, the experimental warning dialog will no longer be shown for this user.',
    scope: 'client',
    config: false,
    type: Boolean,
    default: false
  });

  game.settings.register(FLAG_NAMESPACE, DEBUG_LOADING_MODE_SETTING, {
    name: 'Debug Loading Mode',
    hint: 'When enabled, scene loading pauses at completion and shows a copyable loading log until you press the continue button.',
    scope: 'world',
    config: true,
    restricted: true,
    type: Boolean,
    default: false,
    onChange: (enabled) => {
      try {
        const profiler = window.MapShine?.debugLoadingProfiler;
        if (profiler) profiler.debugMode = !!enabled;
      } catch (_) {
      }
    }
  });

  game.settings.register(FLAG_NAMESPACE, LEVELS_COMPATIBILITY_MODE_SETTING, {
    name: 'Levels Compatibility Mode',
    hint: 'Controls how Map Shine handles Levels data/wrappers. Import-only is recommended for stable gameplay authority.',
    scope: 'world',
    config: true,
    restricted: true,
    type: String,
    choices: {
      [LEVELS_COMPATIBILITY_MODES.OFF]: 'Off (ignore Levels import data)',
      [LEVELS_COMPATIBILITY_MODES.IMPORT_ONLY]: 'Import-Only (recommended)',
      [LEVELS_COMPATIBILITY_MODES.DIAGNOSTIC_INTEROP]: 'Diagnostic Interop (migration debugging)',
    },
    default: LEVELS_COMPATIBILITY_MODES.IMPORT_ONLY,
  });

  game.settings.register(FLAG_NAMESPACE, LIGHT_ICON_LEVEL_VISIBILITY_MODE_SETTING, {
    name: 'Light Icon Visibility by Level',
    hint: 'Choose whether lighting edit icons show all lights or only lights visible for the current level perspective.',
    scope: 'client',
    config: true,
    type: String,
    choices: {
      [LIGHT_ICON_LEVEL_VISIBILITY_MODES.ALL]: 'Show all light icons',
      [LIGHT_ICON_LEVEL_VISIBILITY_MODES.PERSPECTIVE]: 'Show only icons visible for current level',
    },
    default: LIGHT_ICON_LEVEL_VISIBILITY_MODES.ALL,
    onChange: () => {
      try {
        window.MapShine?.lightIconManager?._refreshPerLightVisibility?.();
      } catch (_) {
      }
    },
  });

  // Loading Screens / Scene Transitions (world-scoped)
  game.settings.register(FLAG_NAMESPACE, LOADING_SCREEN_ENABLED_SETTING, {
    name: 'Loading Screens Enabled',
    hint: 'Enable Map Shine loading screen system for startup and transitions.',
    scope: 'world',
    config: true,
    restricted: true,
    type: Boolean,
    default: true,
    onChange: () => {
      try { window.MapShine?.loadingScreenService?.refreshFromGameSettings?.(); } catch (_) {}
    }
  });

  game.settings.register(FLAG_NAMESPACE, LOADING_SCREEN_MODE_SETTING, {
    name: 'Loading Screen Mode',
    hint: 'Choose which loading screen renderer to use by default.',
    scope: 'world',
    config: true,
    restricted: true,
    type: String,
    choices: {
      [LOADING_SCREEN_MODES.LEGACY]: 'Map Shine Advanced current loading screen',
      [LOADING_SCREEN_MODES.STYLED]: 'Styled custom loading screen',
      [LOADING_SCREEN_MODES.FOUNDRY]: 'Foundry default loading screen',
    },
    default: LOADING_SCREEN_MODES.LEGACY,
    onChange: () => {
      try { window.MapShine?.loadingScreenService?.refreshFromGameSettings?.(); } catch (_) {}
    }
  });

  game.settings.register(FLAG_NAMESPACE, LOADING_SCREEN_APPLY_TO_SETTING, {
    name: 'Loading Screen Applies To',
    hint: 'Where loading screens are shown.',
    scope: 'world',
    config: true,
    restricted: true,
    type: String,
    choices: {
      all: 'All startup + all scene transitions',
      'startup-only': 'Startup only',
      'transitions-only': 'Scene transitions only',
    },
    default: 'all',
    onChange: () => {
      try { window.MapShine?.loadingScreenService?.refreshFromGameSettings?.(); } catch (_) {}
    }
  });

  game.settings.register(FLAG_NAMESPACE, LOADING_SCREEN_GOOGLE_FONTS_ENABLED_SETTING, {
    name: 'Google Fonts for Loading Screens',
    hint: 'Allow loading screen themes to fetch Google Fonts families.',
    scope: 'world',
    config: true,
    restricted: true,
    type: Boolean,
    default: true,
    onChange: () => {
      try { window.MapShine?.loadingScreenService?.refreshFromGameSettings?.(); } catch (_) {}
    }
  });

  game.settings.register(FLAG_NAMESPACE, LOADING_SCREEN_USE_FOUNDRY_DEFAULT_SETTING, {
    name: 'Force Foundry Default Loading',
    hint: 'Bypass Map Shine loading overlays and use Foundry UI loading indicators only.',
    scope: 'world',
    config: true,
    restricted: true,
    type: Boolean,
    default: false,
    onChange: () => {
      try { window.MapShine?.loadingScreenService?.refreshFromGameSettings?.(); } catch (_) {}
    }
  });

  game.settings.register(FLAG_NAMESPACE, LOADING_SCREEN_ACTIVE_PRESET_ID_SETTING, {
    name: 'Active Loading Screen Preset',
    hint: 'Built-in preset ID currently selected for styled mode.',
    scope: 'world',
    config: false,
    restricted: true,
    type: String,
    default: 'map-shine-default',
    onChange: () => {
      try { window.MapShine?.loadingScreenService?.refreshFromGameSettings?.(); } catch (_) {}
    }
  });

  game.settings.register(FLAG_NAMESPACE, LOADING_SCREEN_CONFIG_SETTING, {
    name: 'Loading Screen Config',
    hint: 'Full loading screen configuration object used by styled mode.',
    scope: 'world',
    config: false,
    restricted: true,
    type: Object,
    default: createDefaultStyledLoadingScreenConfig(),
    onChange: () => {
      try { window.MapShine?.loadingScreenService?.refreshFromGameSettings?.(); } catch (_) {}
    }
  });

  game.settings.register(FLAG_NAMESPACE, LOADING_SCREEN_USER_PRESETS_SETTING, {
    name: 'Loading Screen User Presets',
    hint: 'GM-authored loading screen presets.',
    scope: 'world',
    config: false,
    restricted: true,
    type: Array,
    default: []
  });

  game.settings.register('map-shine-advanced', 'allowPlayersToTogglePlayerLightMode', {
    name: 'Allow Players to Toggle Player Light',
    hint: 'If disabled, only the GM can switch between torch and flashlight mode for player lights.',
    scope: 'world',
    config: true,
    restricted: true,
    type: Boolean,
    default: true
  });

  game.settings.register('map-shine-advanced', 'rightClickMoveImmediate', {
    name: 'Right-Click Move Immediate',
    hint: 'When enabled, right-click movement executes on the first click instead of requiring a second confirmation click on the same destination.',
    scope: 'client',
    config: true,
    type: Boolean,
    default: false
  });

  game.settings.register('map-shine-advanced', 'leftClickMoveEnabled', {
    name: 'Left-Click to Move',
    hint: 'When enabled, click-to-move uses left-click on empty space instead of right-click. Right-click remains available for panning/HUD interactions.',
    scope: 'client',
    config: true,
    type: Boolean,
    default: false
  });

  // Last used map point effect target (for quick placement)
  game.settings.register('map-shine-advanced', 'lastMapPointEffect', {
    name: 'Last Map Point Effect',
    hint: 'The last effect type used when placing map points',
    scope: 'client',
    config: false,
    type: String,
    default: 'smellyFlies'
  });

  log.info('Settings registered');
}
