/**
 * GRID DEFAULTS PERSISTENCE — the Grid card's values (`effects/grid/grid.js`) as ONE WORLD setting.
 *
 * Every other effect's look-params are a SCENE flag (`effect-param-persistence.js`): a look is tuned for
 * the map it is on. The grid is the exception the author asked for (2026-11-02: *"the GM can change the
 * world default values for all scenes"*): it is table furniture, the same on every map, so a GM's edit
 * here restyles the grid on every scene, for every client, at once (`onChange` fires everywhere).
 *
 * Stored as one JSON string (the Looks library's shape, `looks-persistence.js`): only the keys the GM
 * changed, so a later change to a shipped default still reaches every key nobody touched.
 *
 * @module foundry/grid-defaults-persistence
 */

import { registerSettings, readSetting, writeSetting } from './settings-adapter.js';

export const GRID_DEFAULTS_NAMESPACE = 'map-shine-advanced';
/** The world setting's key. */
export const GRID_DEFAULTS_KEY = 'gridWorldParams';

/**
 * Register the setting. `onChange` fires on every client when any GM saves the card.
 * @param {{onChange?: () => void}} [options]
 */
export function registerGridDefaultsSettings(options = {}) {
  registerSettings(
    GRID_DEFAULTS_NAMESPACE,
    [
      {
        key: GRID_DEFAULTS_KEY,
        scope: 'world',
        kind: 'enum',
        default: '',
        config: false,
        name: 'Grid look (world)',
        hint: "The Grid card's values: how MSA draws the grid on every scene in this world.",
      },
    ],
    { onChange: () => options.onChange?.() }
  );
}

/** Parse the stored JSON (anything unreadable is "nothing stored", never a throw). */
export function parseGridDefaults(raw) {
  if (typeof raw !== 'string' || raw.trim() === '') return {};
  try {
    const v = JSON.parse(raw);
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  } catch (_err) {
    return {};
  }
}

/** @returns {{params: Record<string, unknown>, reason: string|null}} the GM's stored world values. */
export function readGridDefaults() {
  try {
    return { params: parseGridDefaults(readSetting(GRID_DEFAULTS_NAMESPACE, GRID_DEFAULTS_KEY)), reason: null };
  } catch (err) {
    return { params: {}, reason: `reading the world grid look failed: ${err?.message ?? err}` };
  }
}

/**
 * EMPTY the stored world values, so every key is back to the shipped default (the global reset's grid half).
 * Not a merge: `writeGridDefaults({})` would keep what is stored.
 * @returns {Promise<{ok: boolean, reason: string|null}>}
 */
export async function clearGridDefaults() {
  try {
    await writeSetting(GRID_DEFAULTS_NAMESPACE, GRID_DEFAULTS_KEY, '');
    return { ok: true, reason: null };
  } catch (err) {
    return { ok: false, reason: `clearing the world grid look failed (GM only?): ${err?.message ?? err}` };
  }
}

/**
 * Merge `patch` into the stored world values (GM only — Foundry rejects a player's world write).
 * @param {Record<string, unknown>} patch
 * @returns {Promise<{ok: boolean, reason: string|null}>}
 */
export async function writeGridDefaults(patch) {
  try {
    const next = { ...readGridDefaults().params, ...(patch ?? {}) };
    await writeSetting(GRID_DEFAULTS_NAMESPACE, GRID_DEFAULTS_KEY, JSON.stringify(next));
    return { ok: true, reason: null };
  } catch (err) {
    return { ok: false, reason: `writing the world grid look failed (GM only?): ${err?.message ?? err}` };
  }
}
