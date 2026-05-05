/**
 * @fileoverview Built-in scene presets: discover JSON in data/presets/, apply to scenes, clipboard export.
 * @module ui/scene-presets
 */

import * as sceneSettings from '../settings/scene-settings.js';
import {
  cloneAndSanitizeControlState,
  getSanitizedControlStateForExport,
  repairSceneControlStateFlag
} from '../settings/control-state-sanitize.js';
import { createLogger } from '../core/log.js';

const log = createLogger('ScenePresets');

/** @type {string} */
export const PRESETS_DIRECTORY = 'modules/map-shine-advanced/data/presets';

/** Scene flag key for which built-in preset was last applied (authoring hint). */
export const ACTIVE_PRESET_FLAG_KEY = 'activePresetId';

/** @type {Array<MapShineScenePreset>|null} */
let presetCache = null;

/**
 * @typedef {Object} MapShineScenePreset
 * @property {string} id
 * @property {string} name
 * @property {string} [description]
 * @property {boolean} [enabled]
 * @property {Record<string, unknown>} settings
 * @property {Record<string, unknown>} [controlState]
 * @property {string} [sourcePath] — resolved file URL used for load (debug)
 */

/**
 * @returns {((source: string, target: string, options?: object) => Promise<unknown>)|null}
 */
function getFilePickerBrowseFn() {
  try {
    const App = globalThis.foundry?.applications?.apps?.FilePicker;
    if (App && typeof App.browse === 'function') {
      return (source, target, options) => App.browse(source, target, options);
    }
  } catch (_) {
  }
  const Legacy = globalThis.FilePicker;
  if (Legacy && typeof Legacy.browse === 'function') {
    return (source, target, options) => Legacy.browse(source, target, options);
  }
  return null;
}

/**
 * @param {string} name
 * @returns {string}
 */
export function slugifySceneName(name) {
  const raw = String(name ?? 'scene').trim().toLowerCase();
  const slug = raw.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return slug || 'scene';
}

/**
 * @param {unknown} v
 * @returns {boolean}
 */
function _isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/**
 * Load preset JSON files from the module presets directory via FilePicker.
 *
 * @param {{ force?: boolean }} [options]
 * @returns {Promise<Array<MapShineScenePreset>>}
 */
export async function loadBuiltInPresets(options = {}) {
  const { force = false } = options;
  if (!force && Array.isArray(presetCache)) return presetCache;

  presetCache = [];

  const browse = getFilePickerBrowseFn();
  /** @type {{ source: string, target: string }[]} */
  const browseTargets = [
    ['data', PRESETS_DIRECTORY],
    ['public', PRESETS_DIRECTORY],
    ['data', PRESETS_DIRECTORY.replace('modules/map-shine-advanced/', '')]
  ];

  /** @type {string[]} */
  let discovered = [];

  if (browse) {
    for (const [source, target] of browseTargets) {
      try {
        const result = await browse(source, target);
        const files = result?.files;
        if (Array.isArray(files) && files.length > 0) {
          discovered = files.filter((f) => String(f).toLowerCase().endsWith('.json'));
          if (discovered.length > 0) break;
        }
      } catch (_) {
        // try next
      }
    }
  }

  /** @type {MapShineScenePreset[]} */
  const loaded = [];

  for (const fileUrl of discovered) {
    try {
      const response = await fetch(fileUrl, { cache: 'no-store' });
      if (!response.ok) continue;
      const parsed = await response.json();
      if (!parsed || parsed.msaVersion !== 'scene-settings-v1' || typeof parsed.id !== 'string' || !parsed.id.trim()) {
        continue;
      }
      if (!_isPlainObject(parsed.settings)) continue;
      loaded.push({
        id: String(parsed.id).trim(),
        name: String(parsed.name || parsed.id || 'Preset'),
        description: String(parsed.description || ''),
        enabled: typeof parsed.enabled === 'boolean' ? parsed.enabled : undefined,
        settings: /** @type {Record<string, unknown>} */ (parsed.settings),
        ...(_isPlainObject(parsed.controlState) ? { controlState: parsed.controlState } : {}),
        sourcePath: String(fileUrl)
      });
    } catch (e) {
      log.warn('Failed to load preset file', fileUrl, e?.message ?? e);
    }
  }

  loaded.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
  presetCache = loaded;

  try {
    log.info(`Loaded ${presetCache.length} scene preset(s) from ${PRESETS_DIRECTORY}`);
  } catch (_) {
  }

  return presetCache;
}

/**
 * @param {string} presetId
 * @returns {Promise<MapShineScenePreset|null>}
 */
export async function getPresetById(presetId) {
  const id = String(presetId || '').trim();
  if (!id) return null;
  const presets = await loadBuiltInPresets();
  return presets.find((p) => p.id === id) || null;
}

/**
 * @param {Scene|null|undefined} scene
 * @returns {string|null}
 */
export function getActivePresetId(scene) {
  try {
    if (!scene) return null;
    const v = scene.getFlag('map-shine-advanced', ACTIVE_PRESET_FLAG_KEY);
    if (typeof v !== 'string' || !v.trim()) return null;
    return v.trim();
  } catch (_) {
    return null;
  }
}

/**
 * @param {Scene|null|undefined} scene
 * @returns {Promise<void>}
 */
export async function clearActivePresetId(scene) {
  if (!scene) return;
  try {
    await scene.unsetFlag('map-shine-advanced', ACTIVE_PRESET_FLAG_KEY);
  } catch (e) {
    log.warn('clearActivePresetId failed:', e?.message ?? e);
  }
}

/**
 * @param {Scene|null|undefined} scene
 * @param {string} presetId
 * @returns {Promise<void>}
 */
export async function setActivePresetId(scene, presetId) {
  if (!scene) return;
  const id = String(presetId || '').trim();
  if (!id) return;
  try {
    await scene.setFlag('map-shine-advanced', ACTIVE_PRESET_FLAG_KEY, id);
  } catch (e) {
    log.warn('setActivePresetId failed:', e?.message ?? e);
  }
}

/**
 * Build clipboard-ready preset JSON (extends scene-settings-v1 with id/name/description).
 *
 * @param {Scene|null|undefined} scene
 * @returns {Object|null}
 */
export function buildPresetReadyJsonForScene(scene) {
  if (!scene) return null;

  const settings = sceneSettings.getSceneSettings(scene);
  const enabled = scene.getFlag('map-shine-advanced', 'enabled') ?? false;
  const controlState = getSanitizedControlStateForExport(scene);
  const slug = slugifySceneName(scene.name);

  return {
    msaVersion: 'scene-settings-v1',
    id: slug,
    name: String(scene.name ?? 'Scene'),
    description: '',
    enabled,
    settings,
    ...(controlState ? { controlState } : {})
  };
}

/**
 * Apply a loaded preset to a scene (flags + full redraw).
 *
 * @param {Scene} scene
 * @param {MapShineScenePreset} preset
 * @returns {Promise<void>}
 */
export async function applyPresetToScene(scene, preset) {
  if (!scene || !preset?.id || !_isPlainObject(preset.settings)) {
    ui.notifications?.warn?.('Map Shine: Invalid preset or no active scene');
    return;
  }

  try {
    const enabledFlag = typeof preset.enabled === 'boolean' ? preset.enabled : false;
    await scene.setFlag('map-shine-advanced', 'enabled', enabledFlag);
    await sceneSettings.setSceneSettings(scene, preset.settings);

    const hasControlStatePaste =
      preset.controlState && _isPlainObject(preset.controlState) && !Array.isArray(preset.controlState);

    if (hasControlStatePaste) {
      const clean = cloneAndSanitizeControlState(preset.controlState, { silent: true });
      await scene.setFlag('map-shine-advanced', 'controlState', clean);
    } else {
      await repairSceneControlStateFlag(scene);
    }

    await setActivePresetId(scene, preset.id);

    const drawScene = game.scenes?.get?.(scene.id) ?? scene;
    await canvas.draw(drawScene);

    ui.notifications?.info?.(`Map Shine: Preset "${preset.name}" applied`);
  } catch (e) {
    log.error('applyPresetToScene failed:', e);
    ui.notifications?.error?.('Map Shine: Failed to apply preset — see console');
  }
}

/**
 * Clear in-memory preset list (e.g. after adding files in dev).
 */
export function clearPresetCache() {
  presetCache = null;
}
