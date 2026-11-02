/**
 * WORLD EFFECT DEFAULTS — an effect card whose values are ONE world setting, not a scene flag.
 *
 * The Grid card started this (`grid-defaults-persistence.js`): table furniture that should look the
 * same on every map, where a GM's edit restyles every scene for every client at once (`onChange`
 * fires everywhere). The Fog of War card is the second such card, so the shape lives here once.
 *
 * Stored as one JSON string of only the keys a GM changed, so a later change to a shipped default
 * still reaches every key nobody touched.
 *
 * @module foundry/world-effect-defaults
 */

import { registerSettings, readSetting, writeSetting } from './settings-adapter.js';

export const WORLD_EFFECT_DEFAULTS_NAMESPACE = 'map-shine-advanced';

/** Parse a stored JSON object (anything unreadable is "nothing stored", never a throw). */
export function parseWorldEffectDefaults(raw) {
  if (typeof raw !== 'string' || raw.trim() === '') return {};
  try {
    const v = JSON.parse(raw);
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  } catch (_err) {
    return {};
  }
}

/**
 * One world-defaults store.
 * @param {{key: string, name: string, hint: string, label: string}} spec - `label` names it in reasons.
 */
export function createWorldEffectDefaults({ key, name, hint, label }) {
  const NS = WORLD_EFFECT_DEFAULTS_NAMESPACE;
  /** @returns {{params: Record<string, unknown>, reason: string|null}} */
  function read() {
    try {
      return { params: parseWorldEffectDefaults(readSetting(NS, key)), reason: null };
    } catch (err) {
      return { params: {}, reason: `reading the world ${label} failed: ${err?.message ?? err}` };
    }
  }
  return {
    key,
    /** Register the setting; `onChange` fires on every client when any GM saves the card. */
    register(options = {}) {
      registerSettings(NS, [{ key, scope: 'world', kind: 'enum', default: '', config: false, name, hint }], {
        onChange: () => options.onChange?.(),
      });
    },
    read,
    /** Merge `patch` into the stored values (GM only — Foundry rejects a player's world write). */
    async write(patch) {
      try {
        const next = { ...read().params, ...(patch ?? {}) };
        await writeSetting(NS, key, JSON.stringify(next));
        return { ok: true, reason: null };
      } catch (err) {
        return { ok: false, reason: `writing the world ${label} failed (GM only?): ${err?.message ?? err}` };
      }
    },
    /** EMPTY the stored values, so every key is back to its shipped default (the global reset). */
    async clear() {
      try {
        await writeSetting(NS, key, '');
        return { ok: true, reason: null };
      } catch (err) {
        return { ok: false, reason: `clearing the world ${label} failed (GM only?): ${err?.message ?? err}` };
      }
    },
  };
}

/** The Fog of War card's world values (`effects/vision/fog-of-war.js`). */
export const fogOfWarDefaults = createWorldEffectDefaults({
  key: 'fogWorldParams',
  name: 'Fog of War look (world)',
  hint: "The Fog of War card's values: how MSA draws the fog on every scene in this world.",
  label: 'fog of war look',
});
