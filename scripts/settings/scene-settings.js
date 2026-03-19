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
const TOKEN_RENDERING_MODE_SETTING = 'tokenRenderingMode';
const LOADING_SCREEN_ENABLED_SETTING = 'loadingScreenEnabled';
const LOADING_SCREEN_MODE_SETTING = 'loadingScreenMode';
const LOADING_SCREEN_CONFIG_SETTING = 'loadingScreenConfig';
const LOADING_SCREEN_USER_PRESETS_SETTING = 'loadingScreenUserPresets';
const LOADING_SCREEN_APPLY_TO_SETTING = 'loadingScreenApplyTo';
const LOADING_SCREEN_GOOGLE_FONTS_ENABLED_SETTING = 'loadingScreenGoogleFontsEnabled';
const LOADING_SCREEN_USE_FOUNDRY_DEFAULT_SETTING = 'loadingScreenUseFoundryDefault';
const LOADING_SCREEN_ACTIVE_PRESET_ID_SETTING = 'loadingScreenActivePresetId';

/** World-scoped effect settings keys (used for effects in "World Based" mode) */
const WORLD_EFFECT_SETTINGS_KEY = 'worldEffectSettings';
const WORLD_BASED_EFFECTS_KEY = 'worldBasedEffects';

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

export const TOKEN_RENDERING_MODES = Object.freeze({
  THREE: 'three',
  FOUNDRY: 'foundry',
});

function _getPlayerOverridesSettingKey(scene) {
  return `scene-${scene?.id}-player-overrides`;
}

/**
 * Read token rendering mode policy.
 * @returns {'three'|'foundry'}
 */
export function getTokenRenderingMode() {
  try {
    const raw = String(game.settings.get(FLAG_NAMESPACE, TOKEN_RENDERING_MODE_SETTING) ?? '').trim().toLowerCase();
    if (raw === TOKEN_RENDERING_MODES.FOUNDRY) return TOKEN_RENDERING_MODES.FOUNDRY;
    return TOKEN_RENDERING_MODES.THREE;
  } catch (_) {
    return TOKEN_RENDERING_MODES.THREE;
  }
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
 * Check whether a scene has Map Shine authoring data that implies it was pre-configured
 * by a map author (e.g. packaged as a module compendium). This is distinct from the
 * explicit `enabled` flag, which may not survive the compendium/Adventure import path.
 *
 * Indicators that survive packaging:
 *   - `settings.mapMaker` block is present (author tuned effects)
 *   - `mapPointGroups` has at least one group (author placed map points)
 *   - `mapPointGroupsInitialized` is true (author opened map-points at least once)
 *
 * @param {Scene} scene - Foundry scene object
 * @returns {boolean}
 * @public
 */
export function hasImpliedMapShineConfig(scene) {
  if (!scene) return false;
  try {
    const msaFlags = scene.flags?.[FLAG_NAMESPACE] ?? {};

    // Settings block with a mapMaker section — strongest authoring evidence.
    const settings = msaFlags['settings'];
    if (settings && typeof settings === 'object' && settings.mapMaker) return true;

    // Map point groups were populated by the author.
    const groups = msaFlags['mapPointGroups'];
    if (groups && typeof groups === 'object' && Object.keys(groups).length > 0) return true;

    // Author explicitly initialized the map points system.
    if (msaFlags['mapPointGroupsInitialized'] === true) return true;

    return false;
  } catch (_) {
    return false;
  }
}

/**
 * Silently persist the `enabled` flag to true on the scene so that subsequent loads
 * skip the implied-config check. Fire-and-forget — never blocks canvas init.
 * @param {Scene} scene
 * @private
 */
function _silentlyPersistEnabled(scene) {
  Promise.resolve().then(async () => {
    try {
      if (scene.flags?.[FLAG_NAMESPACE]?.['enabled'] === true) return;
      if (typeof scene.setFlag !== 'function') return;
      await scene.setFlag(FLAG_NAMESPACE, 'enabled', true);
    } catch (_) {}
  });
}

/**
 * Check if a scene is enabled for Map Shine.
 *
 * Returns true when:
 *   1. The explicit `enabled` flag is set to true (standard path), OR
 *   2. The scene carries unambiguous Map Shine authoring data that implies it was
 *      pre-configured by a map author (packaged map auto-activation path).
 *      In this case the flag is silently persisted so future loads skip the check.
 *
 * @param {Scene} scene - Foundry scene object
 * @returns {boolean} Whether Map Shine is enabled
 * @public
 */
export function isEnabled(scene) {
  const val = scene.getFlag(FLAG_NAMESPACE, 'enabled');
  if (val === true) return true;

  // Auto-detect pre-configured scenes (e.g. packaged module maps where the
  // `enabled` flag was not included in the compendium export).
  if (hasImpliedMapShineConfig(scene)) {
    log.info(`MapShine: scene "${scene?.name ?? scene?.id ?? '?'}" has Map Shine authoring data but no enabled flag — auto-activating and persisting flag.`);
    _silentlyPersistEnabled(scene);
    return true;
  }

  return false;
}

function _isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function _safeParseJsonMaybe(value) {
  try {
    if (typeof value !== 'string') return value;
    const s = value.trim();
    if (!s) return null;
    // Only attempt JSON parse for obvious JSON payloads.
    if (!(s.startsWith('{') || s.startsWith('['))) return value;
    return JSON.parse(s);
  } catch (_) {
    return value;
  }
}

function _canEditScene(scene) {
  try {
    const user = game?.user;
    if (!scene || !user) return false;
    if (user.isGM) return true;
    if (typeof scene.canUserModify === 'function') return scene.canUserModify(user, 'update');
  } catch (_) {
  }
  return false;
}

/**
 * Read and normalize the scene settings payload without mutating the Scene.
 * This gives all callers a single authoritative read path, even when older
 * scenes still contain legacy strings or malformed partial objects.
 *
 * @param {Scene} scene
 * @returns {SceneSettings}
 * @public
 */
export function getSceneSettings(scene) {
  const defaults = createDefaultSettings();

  try {
    if (!scene) return defaults;

    let raw = scene.getFlag(FLAG_NAMESPACE, 'settings');
    raw = _safeParseJsonMaybe(raw);

    if (!_isPlainObject(raw)) return defaults;

    const next = {
      ...defaults,
      ...raw,
    };

    if (!_isPlainObject(next.mapMaker)) next.mapMaker = { ...defaults.mapMaker };
    else next.mapMaker = { ...defaults.mapMaker, ...next.mapMaker };
    if (!_isPlainObject(next.mapMaker.effects)) next.mapMaker.effects = {};
    if (!_isPlainObject(next.mapMaker.renderer)) next.mapMaker.renderer = { ...defaults.mapMaker.renderer };
    if (!_isPlainObject(next.mapMaker.performance)) next.mapMaker.performance = { ...defaults.mapMaker.performance };

    if (next.gm !== null) {
      if (!_isPlainObject(next.gm)) next.gm = null;
      else {
        next.gm = { ...next.gm };
        if (!_isPlainObject(next.gm.effects)) next.gm.effects = {};
      }
    }

    if (!_isPlainObject(next.player)) next.player = {};

    next.version = CURRENT_VERSION;
    next.mapMaker.version = CURRENT_VERSION;

    return next;
  } catch (e) {
    log.warn('Failed to read scene settings; falling back to defaults:', e?.message ?? e);
    return defaults;
  }
}

/**
 * Persist a normalized scene settings payload back to the Scene document.
 *
 * @param {Scene} scene
 * @param {any} settings
 * @returns {Promise<SceneSettings>}
 * @public
 */
export async function setSceneSettings(scene, settings) {
  const defaults = createDefaultSettings();
  const normalized = getSceneSettings(scene);

  try {
    if (!scene) return defaults;

    const merged = {
      ...normalized,
      ...(_isPlainObject(settings) ? settings : {}),
    };

    if (_isPlainObject(settings?.mapMaker)) {
      merged.mapMaker = {
        ...normalized.mapMaker,
        ...settings.mapMaker,
      };
      if (!_isPlainObject(merged.mapMaker.effects)) merged.mapMaker.effects = {};
      if (!_isPlainObject(merged.mapMaker.renderer)) merged.mapMaker.renderer = { ...defaults.mapMaker.renderer };
      if (!_isPlainObject(merged.mapMaker.performance)) merged.mapMaker.performance = { ...defaults.mapMaker.performance };
    }

    if (settings?.gm === null) {
      merged.gm = null;
    } else if (_isPlainObject(settings?.gm)) {
      merged.gm = {
        ...(normalized.gm && _isPlainObject(normalized.gm) ? normalized.gm : {}),
        ...settings.gm,
      };
      if (!_isPlainObject(merged.gm.effects)) merged.gm.effects = {};
    }

    if (_isPlainObject(settings?.player)) {
      merged.player = { ...normalized.player, ...settings.player };
    }

    merged.version = CURRENT_VERSION;
    if (!_isPlainObject(merged.mapMaker)) merged.mapMaker = { ...defaults.mapMaker };
    merged.mapMaker.version = CURRENT_VERSION;
    if (!_isPlainObject(merged.mapMaker.effects)) merged.mapMaker.effects = {};

    await scene.setFlag(FLAG_NAMESPACE, 'settings', merged);
    return merged;
  } catch (e) {
    log.warn('Failed to save normalized scene settings:', e?.message ?? e);
    return normalized;
  }
}

/**
 * Ensure the scene's Map Shine settings flag exists and has the expected shape.
 *
 * Old scenes (or scenes migrated from earlier versions) may have:
 * - a JSON string stored in the flag
 * - missing tiers (mapMaker/gm/player)
 * - missing effects object
 * - malformed values (null, arrays)
 *
 * This function is intended to be safe to call during scene initialization.
 * It always returns a valid settings object. If the current user can edit the
 * scene, it will also auto-repair the stored flag.
 *
 * @param {Scene} scene
 * @param {{autoRepair?: boolean}} [options]
 * @returns {Promise<any>} Valid settings object
 */
export async function ensureValidSceneSettings(scene, options = {}) {
  const { autoRepair = true } = options || {};

  const defaults = createDefaultSettings();

  try {
    if (!scene) return defaults;

    let raw = scene.getFlag(FLAG_NAMESPACE, 'settings');
    raw = _safeParseJsonMaybe(raw);

    // If missing or totally invalid, reset.
    if (!_isPlainObject(raw)) {
      if (autoRepair && _canEditScene(scene)) {
        await scene.setFlag(FLAG_NAMESPACE, 'settings', defaults);
        log.warn('Scene settings flag was invalid; repaired to defaults');
      }
      return defaults;
    }

    // Normalize tiers.
    const next = getSceneSettings(scene);

    // If anything had to be normalized, persist it.
    if (autoRepair && _canEditScene(scene)) {
      const changed = (raw.version !== next.version)
        || !_isPlainObject(raw.mapMaker)
        || !_isPlainObject(raw.mapMaker?.effects)
        || (raw.gm !== next.gm)
        || (raw.gm && !_isPlainObject(raw.gm?.effects))
        || !_isPlainObject(raw.player);

      if (changed) {
        await scene.setFlag(FLAG_NAMESPACE, 'settings', next);
        log.warn('Scene settings flag shape normalized and saved');
      }
    }

    return next;
  } catch (e) {
    log.warn('Failed to ensure valid scene settings; falling back to defaults:', e?.message ?? e);
    return defaults;
  }
}

/**
 * Enable Map Shine for a scene.
 *
 * For fresh blank scenes, writes default settings. For scenes that already have
 * Map Shine authoring data (e.g. imported from a packaged module compendium), the
 * existing settings are preserved so the author's effect parameters are not lost.
 *
 * @param {Scene} scene - Foundry scene object
 * @returns {Promise<void>}
 * @public
 */
export async function enable(scene) {
  await scene.setFlag(FLAG_NAMESPACE, 'enabled', true);

  // Only write default settings when the scene has no existing Map Shine settings.
  // Pre-configured packaged maps already have author-tuned parameters that must
  // not be overwritten with defaults.
  let existing = null;
  try {
    existing = scene.getFlag(FLAG_NAMESPACE, 'settings');
    existing = _safeParseJsonMaybe(existing);
  } catch (_) {}

  if (!_isPlainObject(existing)) {
    await setSceneSettings(scene, createDefaultSettings());
    log.info(`Map Shine enabled for scene: ${scene.name} (default settings written)`);
  } else {
    log.info(`Map Shine enabled for scene: ${scene.name} (existing settings preserved)`);
  }
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

  const settings = getSceneSettings(scene);

  // Determine user mode
  const isGM = game.user.isGM;
  const mode = isGM ? 'gm' : 'player';

  // Get player overrides from client settings
  const playerOverrides = getPlayerOverrides(scene);

  // Resolve settings hierarchy: mapMaker → gm → player
  let effectiveEffects = { ...settings.mapMaker.effects };

  // Apply GM overrides if present
  if (_isPlainObject(settings.gm) && _isPlainObject(settings.gm.effects)) {
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

  const currentSettings = getSceneSettings(scene);
  currentSettings.mapMaker = {
    ...currentSettings.mapMaker,
    ...settings,
    version: CURRENT_VERSION,
  };

  await setSceneSettings(scene, currentSettings);
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

  const currentSettings = getSceneSettings(scene);
  currentSettings.gm = {
    ...(currentSettings.gm && _isPlainObject(currentSettings.gm) ? currentSettings.gm : {}),
    ...settings,
    version: CURRENT_VERSION,
  };

  await setSceneSettings(scene, currentSettings);
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

  const currentSettings = getSceneSettings(scene);
  currentSettings.gm = null;

  await setSceneSettings(scene, currentSettings);
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

  game.settings.register(FLAG_NAMESPACE, TOKEN_RENDERING_MODE_SETTING, {
    name: 'Token Rendering Mode',
    hint: 'Choose whether token visuals are rendered by Map Shine (Three.js) or Foundry native PIXI. Selection/input remains Foundry-native in both modes.',
    scope: 'world',
    config: true,
    restricted: true,
    type: String,
    choices: {
      [TOKEN_RENDERING_MODES.THREE]: 'Map Shine Three.js (default)',
      [TOKEN_RENDERING_MODES.FOUNDRY]: 'Foundry native PIXI (fallback)',
    },
    default: TOKEN_RENDERING_MODES.THREE,
    onChange: () => {
      try {
        window.MapShine?.applyTokenRenderingMode?.();
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

  // Intro Zoom Effect — client-local (each player can opt out independently).
  game.settings.register('map-shine-advanced', 'introZoomEnabled', {
    name: 'Intro Zoom on Scene Load',
    hint: 'When enabled, the loading screen transitions with a white flash and a cinematic camera zoom-in to your owned token(s) instead of a plain fade-out.',
    scope: 'client',
    config: true,
    type: Boolean,
    default: true,
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

  // Pathfinding policy settings (BUG-1: these were previously only stored
  // in-memory on TokenMovementManager and lost on every canvas reinit).
  game.settings.register('map-shine-advanced', 'movementFogPathPolicy', {
    name: 'Fog Path Policy',
    hint: 'Controls whether pathfinding respects fog-of-war for players.',
    scope: 'world',
    config: false,
    type: String,
    default: 'strictNoFogPath'
  });

  game.settings.register('map-shine-advanced', 'movementWeightedAStarWeight', {
    name: 'A* Pathfinding Weight',
    hint: 'Heuristic weight for the weighted A* pathfinder (1.0 = optimal, 2.0 = faster).',
    scope: 'world',
    config: false,
    type: Number,
    default: 1.15
  });

  game.settings.register('map-shine-advanced', 'movementDoorPolicy', {
    name: 'Door Policy',
    hint: 'Persisted door auto-open/close policy for token pathfinding.',
    scope: 'world',
    config: false,
    type: Object,
    default: {
      autoOpen: true,
      autoClose: 'outOfCombatOnly',
      closeDelayMs: 0,
      playerAutoDoorEnabled: false,
      requireDoorPermission: true
    }
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

  // World-based effect settings: params stored globally instead of per-scene.
  // Only used for effects the user has toggled to "World Based" mode (lighting, colorCorrection).
  game.settings.register(FLAG_NAMESPACE, WORLD_EFFECT_SETTINGS_KEY, {
    name: 'World Effect Settings',
    hint: 'Stores effect parameters that apply globally across all scenes (world-based mode).',
    scope: 'world',
    config: false,
    type: Object,
    default: {}
  });

  game.settings.register(FLAG_NAMESPACE, WORLD_BASED_EFFECTS_KEY, {
    name: 'World-Based Effects Config',
    hint: 'Tracks which effects use world-based (global) settings instead of per-scene settings.',
    scope: 'world',
    config: false,
    type: Object,
    default: {}
  });

  log.info('Settings registered');
}

/**
 * Get effect parameters stored in world-based (global) mode.
 * Returns an object keyed by effectId containing their saved parameters.
 * @returns {Object.<string, Object>}
 * @public
 */
export function getWorldEffectSettings() {
  try {
    return game.settings.get(FLAG_NAMESPACE, WORLD_EFFECT_SETTINGS_KEY) || {};
  } catch (_) {
    return {};
  }
}

/**
 * Persist world-based effect parameters.
 * @param {Object.<string, Object>} settings - All world-effect params keyed by effectId
 * @returns {Promise<void>}
 * @public
 */
export async function setWorldEffectSettings(settings) {
  try {
    await game.settings.set(FLAG_NAMESPACE, WORLD_EFFECT_SETTINGS_KEY, settings || {});
  } catch (e) {
    log.warn('Failed to save world effect settings:', e?.message ?? e);
  }
}

/**
 * Get the world-based effects configuration (which effects are in world-based mode).
 * @returns {Object.<string, boolean>}
 * @public
 */
export function getWorldBasedEffectsConfig() {
  try {
    return game.settings.get(FLAG_NAMESPACE, WORLD_BASED_EFFECTS_KEY) || {};
  } catch (_) {
    return {};
  }
}

/**
 * Persist the world-based effects configuration.
 * @param {Object.<string, boolean>} config - effectId → true/false
 * @returns {Promise<void>}
 * @public
 */
export async function setWorldBasedEffectsConfig(config) {
  try {
    await game.settings.set(FLAG_NAMESPACE, WORLD_BASED_EFFECTS_KEY, config || {});
  } catch (e) {
    log.warn('Failed to save world-based effects config:', e?.message ?? e);
  }
}
