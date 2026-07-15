/**
 * @fileoverview Loading screen preset loading helpers.
 * @module ui/loading-screen/loading-screen-presets
 */

import { createDefaultStyledLoadingScreenConfig, deepClone, normalizeLoadingScreenConfig } from './loading-screen-config.js';

/** @type {Array<any>|null} */
let presetCache = null;

/**
 * Clear the in-memory preset cache so the next loadBuiltInPresets() call
 * fetches fresh data.  Useful when opening the dialog to ensure presets
 * haven't gone stale from an earlier fetch that may have failed.
 */
export function clearPresetCache() {
  presetCache = null;
}

/**
 * @returns {Promise<Array<any>>}
 */
export async function loadBuiltInPresets() {
  if (Array.isArray(presetCache)) return presetCache;

  const fallback = buildFallbackPresets();

  try {
    const url = `modules/map-shine-advanced/data/loading-screen-presets.json`;
    const response = await fetch(url, { cache: 'no-store' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const parsed = await response.json();
    if (!Array.isArray(parsed) || parsed.length === 0) {
      presetCache = fallback;
      return presetCache;
    }

    presetCache = parsed
      .filter((p) => p && typeof p === 'object')
      .map((p) => ({
        id: String(p.id || ''),
        name: String(p.name || p.id || 'Preset'),
        description: String(p.description || ''),
        // Keep the raw (pre-normalization) config so applyPresetToConfig only
        // overwrites keys the original preset JSON explicitly defines.
        rawConfig: deepClone(p.config || {}),
        config: normalizeLoadingScreenConfig(p.config),
      }))
      .filter((p) => p.id);

    console.log(`Map Shine: loaded ${presetCache.length} built-in loading screen presets`);

    if (presetCache.length === 0) presetCache = fallback;
    return presetCache;
  } catch (_) {
    presetCache = fallback;
    return presetCache;
  }
}

/**
 * @param {string} presetId
 * @returns {Promise<any|null>}
 */
export async function getPresetById(presetId) {
  const id = String(presetId || '').trim();
  if (!id) return null;
  const presets = await loadBuiltInPresets();
  return presets.find((p) => p.id === id) || null;
}

/**
 * @param {string} presetId
 * @param {Object|null|undefined} currentConfig
 * @returns {Promise<Object>}
 */
export async function applyPresetToConfig(presetId, currentConfig) {
  const preset = await getPresetById(presetId);
  if (!preset) {
    console.warn(`Map Shine: preset "${presetId}" not found, keeping current config`);
    return normalizeLoadingScreenConfig(currentConfig);
  }

  // Use the raw (pre-normalization) config so that only the keys the preset
  // JSON explicitly defines are overridden.  This preserves the user's custom
  // layout when switching between presets that only define style/fonts/etc.
  const raw = preset.rawConfig || preset.config || {};
  const base = deepClone(currentConfig || createDefaultStyledLoadingScreenConfig());

  // Merge style properties (shallow merge — preset values win, missing ones preserved)
  if (raw.style && typeof raw.style === 'object') {
    base.style = { ...(base.style || {}), ...deepClone(raw.style) };
  }

  // Replace fonts entirely when the preset defines them
  if (raw.fonts && typeof raw.fonts === 'object') {
    base.fonts = { ...(base.fonts || {}), ...deepClone(raw.fonts) };
  }

  // Replace wallpapers entirely when the preset defines them
  if (raw.wallpapers && typeof raw.wallpapers === 'object') {
    base.wallpapers = deepClone(raw.wallpapers);
  }

  // Replace overlay effects entirely when the preset defines them
  if (Array.isArray(raw.overlayEffects)) {
    base.overlayEffects = deepClone(raw.overlayEffects);
  }

  // Only replace layout if the preset explicitly provides one
  if (raw.layout && typeof raw.layout === 'object') {
    base.layout = deepClone(raw.layout);
  }

  base.themeName = preset.name;
  base.basePresetId = preset.id;

  console.log(`Map Shine: applied preset "${preset.name}" (${presetId})`, base.style);
  return normalizeLoadingScreenConfig(base);
}

/**
 * @returns {Array<any>}
 */
function buildFallbackPresets() {
  const defaultConfig = createDefaultStyledLoadingScreenConfig();
  return [
    {
      id: 'map-shine-default',
      name: 'Map Shine Default',
      description: 'Current Map Shine loading screen style.',
      config: normalizeLoadingScreenConfig(defaultConfig),
    },
  ];
}
