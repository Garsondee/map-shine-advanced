/**
 * EFFECT PRESET PERSISTENCE — a named, reusable snapshot of ONE effect's
 * authored params, shared across every scene at the table (mythica-machina-
 * press#102: "export a single effect's current configuration as a reusable/
 * shareable preset, distinct from #12" — #12 is scene-to-scene copy, this is
 * effect-to-effect reuse).
 *
 * NOT #177 ("Scene Preset system — capture and apply whole scene setups") —
 * #177 sat needs-research when this module shipped, then resolved and
 * shipped separately as `scene-preset-persistence.js`, reusing this
 * module's own single-JSON-world-setting shape for a WHOLE-SCENE library
 * instead of a per-effect one (see that module's own header for the full
 * design-decision trail). This module stays exactly what it always was:
 * the narrower #102 (one effect, one preset), built on the storage shape
 * #177 went on to reuse rather than reinvent.
 *
 * WORLD-scoped, unlike `effect-param-persistence.js`'s scene flag — a preset
 * is a reusable TEMPLATE, not a fact about any one scene, so it belongs
 * beside the table's shared policy settings (`GLOBAL_SETTING_KEYS` in
 * `effects/effect-settings.js`), not the scene document. Stored as a single
 * JSON string setting, mirroring `sky-persistence.js#WORLD_SKY_KEY`'s own
 * precedent exactly ("the settings adapter deliberately supports only
 * enum/bool... one JSON.parse at the edge is cheaper than a new kind in a
 * module every other setting shares").
 *
 * Shape: `{ [effectId]: { [presetName]: Record<paramKey, value> } }` — one
 * flag for the whole library, not one per effect or per preset, the same
 * "one flat store, not N" reasoning `effect-param-persistence.js`'s own
 * header gives for its single `effectParams` flag.
 *
 * @module foundry/effect-preset-persistence
 */

import { registerSettings, readSetting, writeSetting } from './settings-adapter.js';

/** The module namespace this setting lives under. */
export const EFFECT_PRESET_NAMESPACE = 'map-shine-advanced';
/** The world setting's key. */
export const WORLD_EFFECT_PRESETS_KEY = 'effectPresets';

/**
 * Register the world-scoped effect-presets setting. Call once, in `init`,
 * inside the SAME `Hooks.once('init', ...)` block every sibling persistence
 * setting already shares (`foundry/adapter-only` ratchets every literal
 * `Hooks.*` call in boot.js — a second registration hook would be a genuine
 * new violation, not just a number to bump).
 * @param {{onChange?: () => void}} [options]
 */
export function registerEffectPresetSettings(options = {}) {
  registerSettings(
    EFFECT_PRESET_NAMESPACE,
    [
      {
        key: WORLD_EFFECT_PRESETS_KEY,
        scope: 'world',
        kind: 'enum',
        default: '',
        config: false,
        name: 'Effect presets library',
        hint: 'Named, reusable per-effect look snapshots, shared across every scene at this table.',
      },
    ],
    { onChange: () => options.onChange?.() }
  );
}

/**
 * Read the whole preset library.
 * @returns {{presets: Record<string, Record<string, object>>, reason: string|null}}
 *   `presets: {}` on any failure or absence — an empty library is a valid,
 *   safe fallback, never confused with "the read itself failed" because
 *   `reason` stays distinguishable (feedback_instruments_must_not_lie).
 */
export function readEffectPresets() {
  try {
    const raw = readSetting(EFFECT_PRESET_NAMESPACE, WORLD_EFFECT_PRESETS_KEY);
    if (typeof raw !== 'string' || raw === '') return { presets: {}, reason: null };
    const parsed = JSON.parse(raw);
    return { presets: parsed && typeof parsed === 'object' ? parsed : {}, reason: null };
  } catch (err) {
    return { presets: {}, reason: `reading effect presets failed: ${err?.message ?? err}` };
  }
}

/**
 * Replace the whole preset library. GM-only (Foundry's own world-setting
 * rule) — a player's attempt reports `{ok:false}` rather than throwing.
 * @param {Record<string, Record<string, object>>} presets
 * @returns {Promise<{ok: boolean, reason: string|null}>}
 */
export async function writeEffectPresets(presets) {
  try {
    await writeSetting(EFFECT_PRESET_NAMESPACE, WORLD_EFFECT_PRESETS_KEY, JSON.stringify(presets ?? {}));
    return { ok: true, reason: null };
  } catch (err) {
    return { ok: false, reason: `writing effect presets failed (GM only?): ${err?.message ?? err}` };
  }
}
