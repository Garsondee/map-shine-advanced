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
import { canPersistSceneDocument } from '../core/gm-parity.js';
import { createLogger } from '../core/log.js';
import { extendMsaLocalFlagWriteGuard } from '../utils/msa-local-flag-guard.js';

const log = createLogger('ScenePresets');

/** Built-in preset id used as the default starting point for newly enabled scenes. */
export const BASELINE_PRESET_ID = 'baseline';

/** Scene id stored on `window.MapShine.__msaForceFullSceneReload` during preset apply. */
export const FORCE_FULL_SCENE_RELOAD_FLAG = '__msaForceFullSceneReload';

const SCENE_ENABLE_RESTART_BLOCKER_ID = 'map-shine-scene-enable-restart-blocker';

/** @type {string} */
export const PRESETS_DIRECTORY = 'modules/map-shine-advanced/data/presets';

/** Scene flag key for which built-in preset was last applied (authoring hint). */
export const ACTIVE_PRESET_FLAG_KEY = 'activePresetId';

/** `window.MapShine` key — survives Tweakpane dispose/recreate during preset `canvas.draw()`. */
export const PENDING_ACTIVE_PRESET_KEY = '__msaPendingActivePreset';

/** Scene id while `applyPresetToScene` is running (new Tweakpane must not flip to Custom). */
export const APPLYING_PRESET_SCENE_KEY = '__msaApplyingPresetSceneId';

/** Synthetic id for the one-level undo snapshot (not a file on disk). */
export const PRESET_UNDO_SNAPSHOT_ID = '__msa_previous_settings__';

/** @type {Map<string, { preset: MapShineScenePreset, savedAt: number }>} */
const _presetUndoBySceneId = new Map();

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
 * @property {string} [previousActivePresetId] — active preset before undo snapshot (undo only)
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
 * Preset id for UI display while a preset apply + full canvas reload is in flight.
 *
 * @param {Scene|null|undefined} scene
 * @returns {string|null}
 */
export function getPendingActivePresetId(scene) {
  try {
    const sid = scene?.id != null ? String(scene.id) : '';
    if (!sid) return null;
    const pending = window.MapShine?.[PENDING_ACTIVE_PRESET_KEY];
    if (!pending || typeof pending !== 'object') return null;
    if (String(pending.sceneId ?? '') !== sid) return null;
    const id = String(pending.presetId ?? '').trim();
    return id || null;
  } catch (_) {
    return null;
  }
}

/**
 * Flag on scene document, else in-flight pending apply (survives UI manager recreate).
 *
 * @param {Scene|null|undefined} scene
 * @returns {string|null}
 */
export function resolveActivePresetIdForScene(scene) {
  return getActivePresetId(scene) ?? getPendingActivePresetId(scene);
}

/**
 * @param {Scene|null|undefined} scene
 * @param {string} presetId
 */
export function setPendingActivePreset(scene, presetId) {
  const sid = scene?.id != null ? String(scene.id) : '';
  const id = String(presetId || '').trim();
  if (!sid || !id) return;
  if (!window.MapShine) window.MapShine = {};
  window.MapShine[PENDING_ACTIVE_PRESET_KEY] = { sceneId: sid, presetId: id };
}

/**
 * @param {Scene|null|undefined} scene
 */
export function clearPendingActivePreset(scene) {
  try {
    const sid = scene?.id != null ? String(scene.id) : '';
    if (!sid) return;
    const pending = window.MapShine?.[PENDING_ACTIVE_PRESET_KEY];
    if (pending && String(pending.sceneId ?? '') === sid) {
      delete window.MapShine[PENDING_ACTIVE_PRESET_KEY];
    }
  } catch (_) {}
}

/**
 * @param {Scene|null|undefined} scene
 */
export function armApplyingPreset(scene) {
  const sid = scene?.id != null ? String(scene.id) : '';
  if (!sid) return;
  if (!window.MapShine) window.MapShine = {};
  window.MapShine[APPLYING_PRESET_SCENE_KEY] = sid;
}

/**
 * @param {Scene|null|undefined} scene
 */
export function disarmApplyingPreset(scene) {
  try {
    const sid = scene?.id != null ? String(scene.id) : '';
    if (!sid) return;
    if (String(window.MapShine?.[APPLYING_PRESET_SCENE_KEY] ?? '') === sid) {
      delete window.MapShine[APPLYING_PRESET_SCENE_KEY];
    }
  } catch (_) {}
}

/**
 * @param {Scene|null|undefined} scene
 * @returns {boolean}
 */
export function isApplyingPresetToScene(scene) {
  const sid = scene?.id != null ? String(scene.id) : '';
  if (!sid) return false;
  return String(window.MapShine?.[APPLYING_PRESET_SCENE_KEY] ?? '') === sid;
}

/**
 * @param {Scene|null|undefined} scene
 * @returns {Promise<void>}
 */
export async function clearActivePresetId(scene) {
  if (!scene) return;
  clearPendingActivePreset(scene);
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
  if (!scene) return false;
  const id = String(presetId || '').trim();
  if (!id) return false;
  if (!canPersistSceneDocument()) return false;

  const flagPath = `flags.map-shine-advanced.${ACTIVE_PRESET_FLAG_KEY}`;

  try {
    await scene.setFlag('map-shine-advanced', ACTIVE_PRESET_FLAG_KEY, id);
  } catch (e) {
    log.warn('setActivePresetId setFlag failed:', e?.message ?? e);
  }

  let doc = _refreshSceneDocument(scene);
  if (getActivePresetId(doc) === id) return true;

  try {
    await doc.update({ [flagPath]: id });
    doc = _refreshSceneDocument(doc);
    if (getActivePresetId(doc) === id) return true;
  } catch (e) {
    log.warn('setActivePresetId scene.update failed:', e?.message ?? e);
  }

  log.warn(`setActivePresetId: "${id}" did not persist on scene "${scene.name ?? scene.id}"`);
  return false;
}

/**
 * Refresh the live Tweakpane presets bar after apply (manager is recreated on full reload).
 *
 * @returns {Promise<void>}
 */
async function _syncPresetsUiAfterApply() {
  const ui = window.MapShine?.uiManager;
  if (!ui) return;
  try {
    if (typeof ui._resyncUiAfterPresetApply === 'function') {
      await ui._resyncUiAfterPresetApply();
    }
    if (typeof ui._hydratePresetsSelect === 'function') {
      await ui._hydratePresetsSelect({ forceLoad: false });
    }
    if (typeof ui._updatePresetsRevertButton === 'function') {
      ui._updatePresetsRevertButton();
    }
  } catch (e) {
    log.warn('syncPresetsUiAfterApply failed:', e?.message ?? e);
  }
}

/**
 * Capture the current scene state so the user can revert the next preset apply.
 *
 * @param {Scene|null|undefined} scene
 * @returns {boolean}
 */
export function capturePresetUndoSnapshot(scene) {
  if (!scene?.id) return false;

  const payload = buildPresetReadyJsonForScene(scene);
  if (!payload) return false;

  const previousActivePresetId = getActivePresetId(scene);

  _presetUndoBySceneId.set(scene.id, {
    preset: {
      id: PRESET_UNDO_SNAPSHOT_ID,
      name: 'Previous Settings',
      description: previousActivePresetId
        ? `Saved before applying a preset (was "${previousActivePresetId}")`
        : 'Saved before applying a preset',
      enabled: payload.enabled,
      settings: payload.settings,
      ...(_isPlainObject(payload.controlState) ? { controlState: payload.controlState } : {}),
      previousActivePresetId
    },
    savedAt: Date.now()
  });

  return true;
}

/**
 * @param {Scene|null|undefined} scene
 * @returns {boolean}
 */
export function hasPresetUndoSnapshot(scene) {
  return Boolean(scene?.id && _presetUndoBySceneId.has(scene.id));
}

/**
 * @param {Scene|null|undefined} scene
 * @returns {MapShineScenePreset|null}
 */
export function getPresetUndoSnapshot(scene) {
  if (!scene?.id) return null;
  return _presetUndoBySceneId.get(scene.id)?.preset ?? null;
}

/**
 * @param {Scene|null|undefined} scene
 */
export function clearPresetUndoSnapshot(scene) {
  if (!scene?.id) return;
  _presetUndoBySceneId.delete(scene.id);
}

/**
 * Restore settings captured before the last preset apply.
 *
 * @param {Scene} scene
 * @returns {Promise<boolean>}
 */
export async function revertPresetChange(scene) {
  if (!scene?.id) {
    ui.notifications?.warn?.('Map Shine: No active scene');
    return false;
  }

  const entry = _presetUndoBySceneId.get(scene.id);
  if (!entry?.preset) {
    ui.notifications?.warn?.('Map Shine: No previous settings to restore');
    return false;
  }

  const restored = await applyPresetToScene(scene, entry.preset, { skipUndoCapture: true, isUndoRestore: true });
  if (!restored) return false;

  clearPresetUndoSnapshot(scene);
  ui.notifications?.info?.('Map Shine: Restored previous settings');
  return true;
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
 * Force a full canvas teardown/rebuild for this scene (not same-scene resync).
 * Used by preset apply and GM scene enable so UI-only Tweakpane is disposed.
 *
 * @param {Scene|null|undefined} scene
 */
export function armForceFullSceneReload(scene) {
  try {
    const sid = scene?.id != null ? String(scene.id) : '';
    if (!sid) return;
    if (!window.MapShine) window.MapShine = {};
    window.MapShine[FORCE_FULL_SCENE_RELOAD_FLAG] = sid;
    window.MapShine.__msaPredictSameSceneRedrawUntil = 0;
    try {
      delete window.MapShine.__msaPredictSameSceneRedrawSceneId;
    } catch (_) {}
    window.MapShine.__nativeSameSceneRedraw = false;
    window.MapShine.__nativeSameSceneLevelSwitch = false;
  } catch (_) {}
}

/** @param {Scene|null|undefined} scene */
function _armPresetFullSceneReload(scene) {
  armForceFullSceneReload(scene);
}

/**
 * Reload the Foundry tab after GM scene enable so MSA cold-boots with persisted flags.
 * In-session `canvas.draw` after UI-only mode can leave PIXI/Three.js out of sync (grey canvas).
 *
 * @param {Scene|null|undefined} scene
 */
export function requestSceneEnablePageReload(scene) {
  const name = scene?.name ? String(scene.name) : 'this scene';
  try {
    let blocker = document.getElementById(SCENE_ENABLE_RESTART_BLOCKER_ID);
    if (!blocker) {
      blocker = document.createElement('div');
      blocker.id = SCENE_ENABLE_RESTART_BLOCKER_ID;
      blocker.style.position = 'fixed';
      blocker.style.inset = '0';
      blocker.style.zIndex = '300000';
      blocker.style.background = 'rgba(0, 0, 0, 0.92)';
      blocker.style.display = 'flex';
      blocker.style.alignItems = 'center';
      blocker.style.justifyContent = 'center';
      blocker.style.pointerEvents = 'auto';
      blocker.style.color = '#f2f2f2';
      blocker.style.fontFamily = 'Arial, sans-serif';
      blocker.style.fontSize = '18px';
      blocker.style.textAlign = 'center';
      blocker.style.padding = '24px';
      blocker.style.whiteSpace = 'pre-line';
      document.body.appendChild(blocker);
    }
    blocker.textContent = `Enabling Map Shine Advanced for ${name}\n\nReloading Foundry…`;
    globalThis.ui?.notifications?.info?.('Map Shine: Reloading Foundry to activate Map Shine on this scene.');
  } catch (_) {
  }

  setTimeout(() => {
    try {
      window.location.reload();
    } catch (_) {
    }
  }, 150);
}

/**
 * True when the scene has no applied preset and no author-tuned effect stack yet.
 *
 * @param {Scene|null|undefined} scene
 * @returns {boolean}
 */
export function sceneNeedsBaselinePreset(scene) {
  if (!scene) return false;
  if (getActivePresetId(scene)) return false;
  if (sceneSettings.hasImpliedMapShineConfig(scene)) return false;

  try {
    let raw = scene.getFlag('map-shine-advanced', 'settings');
    if (typeof raw === 'string') {
      const s = raw.trim();
      if (s.startsWith('{') || s.startsWith('[')) {
        try {
          raw = JSON.parse(s);
        } catch (_) {
          return true;
        }
      }
    }
    if (!_isPlainObject(raw)) return true;
    const effects = raw.mapMaker?.effects;
    return !_isPlainObject(effects) || Object.keys(effects).length === 0;
  } catch (_) {
    return true;
  }
}

/**
 * Persist preset settings/control state to scene flags (no canvas draw).
 *
 * @param {Scene} scene
 * @param {MapShineScenePreset} preset
 * @returns {Promise<void>}
 */
/**
 * Mirror preset blobs into world-scoped storage for effects in "World Based" mode.
 *
 * @param {MapShineScenePreset} preset
 * @returns {Promise<void>}
 */
async function _syncWorldEffectsFromPreset(preset) {
  const effects = preset?.settings?.mapMaker?.effects;
  if (!_isPlainObject(effects)) return;

  let config;
  try {
    config = sceneSettings.getWorldBasedEffectsConfig();
  } catch (_) {
    return;
  }

  const worldSettings = sceneSettings.getWorldEffectSettings();
  let changed = false;

  for (const effectId of ['lighting', 'colorCorrection']) {
    if (!config?.[effectId]) continue;
    const blob = effects[effectId];
    if (!_isPlainObject(blob)) continue;
    worldSettings[effectId] = { ...blob };
    changed = true;
  }

  if (changed) {
    await sceneSettings.setWorldEffectSettings(worldSettings);
    log.info('Synced world-based effect storage from preset apply');
  }
}

/**
 * @param {Scene} scene
 * @returns {Scene}
 */
function _refreshSceneDocument(scene) {
  try {
    return game.scenes?.get?.(scene?.id) ?? scene;
  } catch (_) {
    return scene;
  }
}

/**
 * @param {Scene} scene
 * @param {string} presetId
 * @returns {Promise<boolean>}
 */
async function _commitActivePresetId(scene, presetId) {
  const id = String(presetId || '').trim();
  if (!id || !scene) return false;
  return setActivePresetId(scene, id);
}

/**
 * @param {Scene} scene
 * @param {MapShineScenePreset} preset
 * @param {{ writeActivePreset?: boolean }} [options]
 * @returns {Promise<void>}
 */
async function _persistPresetToSceneFlags(scene, preset, options = {}) {
  const { writeActivePreset = false } = options;
  extendMsaLocalFlagWriteGuard(4000);

  if (typeof preset.enabled === 'boolean') {
    await scene.setFlag('map-shine-advanced', 'enabled', preset.enabled);
  }
  await sceneSettings.setSceneSettings(scene, preset.settings, { replace: true });
  await _syncWorldEffectsFromPreset(preset);

  const hasControlStatePaste =
    preset.controlState && _isPlainObject(preset.controlState) && !Array.isArray(preset.controlState);

  if (hasControlStatePaste) {
    const clean = cloneAndSanitizeControlState(preset.controlState, { silent: true });
    await scene.setFlag('map-shine-advanced', 'controlState', clean);
  } else {
    await repairSceneControlStateFlag(scene);
  }

  if (writeActivePreset && preset.id !== PRESET_UNDO_SNAPSHOT_ID) {
    await _commitActivePresetId(scene, preset.id);
  }
}

/**
 * Apply the baseline preset when an MSA-enabled scene has no configured stack yet.
 *
 * @param {Scene|null|undefined} scene
 * @param {{ force?: boolean, skipDraw?: boolean, silent?: boolean }} [options]
 * @returns {Promise<boolean>}
 */
export async function ensureBaselinePresetForEnabledScene(scene, options = {}) {
  const { force = false, skipDraw = true, silent = true } = options;
  if (!scene) return false;
  if (!sceneSettings.isEnabled(scene)) return false;
  if (!force && !sceneNeedsBaselinePreset(scene)) return false;
  if (!canPersistSceneDocument()) return false;

  const preset = await getPresetById(BASELINE_PRESET_ID);
  if (!preset) {
    log.warn(`Baseline preset "${BASELINE_PRESET_ID}" not found in ${PRESETS_DIRECTORY}`);
    return false;
  }

  try {
    await _persistPresetToSceneFlags(scene, preset, { writeActivePreset: true });

    if (!skipDraw) {
      const drawScene = game.scenes?.get?.(scene.id) ?? scene;
      await canvas.draw(drawScene);
    }

    if (!silent) {
      ui.notifications?.info?.(`Map Shine: Baseline preset applied to "${scene.name ?? scene.id}"`);
    } else {
      log.info(`Baseline preset applied to scene "${scene.name ?? scene.id}"`);
    }
    return true;
  } catch (e) {
    log.error('ensureBaselinePresetForEnabledScene failed:', e);
    if (!silent) {
      ui.notifications?.error?.('Map Shine: Failed to apply baseline preset — see console');
    }
    return false;
  }
}

/**
 * Clear {@link FORCE_FULL_SCENE_RELOAD_FLAG} after canvas.draw completes.
 *
 * @param {Scene|null|undefined} scene
 */
export function clearForceFullSceneReload(scene) {
  try {
    const sid = scene?.id != null ? String(scene.id) : '';
    if (!sid) return;
    if (String(window.MapShine?.[FORCE_FULL_SCENE_RELOAD_FLAG] ?? '') === sid) {
      delete window.MapShine[FORCE_FULL_SCENE_RELOAD_FLAG];
    }
  } catch (_) {}
}

/** @param {Scene|null|undefined} scene */
function _clearPresetFullSceneReload(scene) {
  clearForceFullSceneReload(scene);
}

/**
 * Apply a loaded preset to a scene (flags + full redraw).
 *
 * @param {Scene} scene
 * @param {MapShineScenePreset} preset
 * @param {{ skipUndoCapture?: boolean, isUndoRestore?: boolean }} [options]
 * @returns {Promise<boolean>}
 */
export async function applyPresetToScene(scene, preset, options = {}) {
  const { skipUndoCapture = false, isUndoRestore = false } = options;
  if (!scene || !preset?.id || !_isPlainObject(preset.settings)) {
    ui.notifications?.warn?.('Map Shine: Invalid preset or no active scene');
    return false;
  }

  _armPresetFullSceneReload(scene);
  armApplyingPreset(scene);
  if (!isUndoRestore && preset.id !== PRESET_UNDO_SNAPSHOT_ID) {
    setPendingActivePreset(scene, preset.id);
  }

  try {
    if (!skipUndoCapture && preset.id !== PRESET_UNDO_SNAPSHOT_ID) {
      capturePresetUndoSnapshot(scene);
    }

    // activePresetId must exist before canvas.draw — full reload disposes and recreates Tweakpane.
    await _persistPresetToSceneFlags(scene, preset, { writeActivePreset: true });

    let doc = _refreshSceneDocument(scene);

    if (isUndoRestore) {
      const previousActivePresetId = preset.previousActivePresetId;
      if (typeof previousActivePresetId === 'string' && previousActivePresetId.trim()) {
        await _commitActivePresetId(doc, previousActivePresetId);
        setPendingActivePreset(doc, previousActivePresetId);
      } else {
        await clearActivePresetId(doc);
        clearPendingActivePreset(doc);
      }
    }

    const drawScene = game.scenes?.get?.(doc.id) ?? doc;
    await canvas.draw(drawScene);

    doc = _refreshSceneDocument(drawScene);
    if (!isUndoRestore && preset.id !== PRESET_UNDO_SNAPSHOT_ID) {
      await _commitActivePresetId(doc, preset.id);
    }

    await _syncPresetsUiAfterApply();

    if (resolveActivePresetIdForScene(doc) === preset.id) {
      clearPendingActivePreset(doc);
    }

    if (!isUndoRestore) {
      const undoHint = hasPresetUndoSnapshot(scene) ? ' — use Revert to restore previous settings' : '';
      ui.notifications?.info?.(`Map Shine: Preset "${preset.name}" applied${undoHint}`);
    }
    return true;
  } catch (e) {
    clearPendingActivePreset(scene);
    log.error('applyPresetToScene failed:', e);
    ui.notifications?.error?.('Map Shine: Failed to apply preset — see console');
    return false;
  } finally {
    _clearPresetFullSceneReload(scene);
    disarmApplyingPreset(scene);
  }
}

/**
 * Clear in-memory preset list (e.g. after adding files in dev).
 */
export function clearPresetCache() {
  presetCache = null;
}
