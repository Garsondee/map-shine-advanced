/**
 * SCENE PRESET PERSISTENCE — a named, world-scoped, persistent LIBRARY of
 * whole-scene snapshots (mythica-machina-press#177: "Scene Preset system —
 * capture and apply whole scene setups", built scope-narrowed per the design
 * decision posted to the issue).
 *
 * #177 sat `needs-research` until the design question resolved almost
 * mechanically once #12 and #102 (both already shipped) were traced through:
 *   - **#12** (`boot.js`'s `copySceneEffectSettings`/`pasteSceneEffectSettings`)
 *     already defines "a scene's whole authored look" as *every effect's
 *     scene-authored params, as one object* — `readSceneAllEffectParams`/
 *     `writeSceneAllEffectParams` (`effect-param-persistence.js`) — just an
 *     in-memory clipboard, not named or persisted.
 *   - **#102** (`effect-preset-persistence.js`, this file's own shape
 *     template) already proves the "named, world-scoped, persistent library"
 *     storage shape — just scoped to one effect's params at a time.
 * Scene Presets is the overlap: #12's SCOPE (whole scene, every effect) +
 * #102's SHAPE (named, persistent, world library). This module supplies
 * only the storage half of that combination — capture/apply themselves stay
 * in `boot.js`'s `MapShine.saveScenePreset`/`applyScenePreset`, which call
 * the SAME `readSceneAllEffectParams`/`writeSceneAllEffectParams` #12
 * already uses, exactly mirroring how `effect-preset-persistence.js` stays
 * ignorant of `readSceneEffectParams`/`writeSceneEffectParams` too.
 *
 * Deliberately narrow, per the scope decision on the issue (not guessed
 * here — see boot.js's own "SCENE PRESETS" section for the full rationale):
 *   1. Effect params only — not sky/weather/wind/anchors/darkness regions.
 *      A preset is exactly what `readSceneAllEffectParams` already captures.
 *   2. Instant apply, no fade — matches #12's paste (write + `reapplyAll`),
 *      not a new `world/fade-engine.js` integration invented without prior
 *      art for per-effect-type transitions.
 *   3. NOT the Map-Maker-tier "ships with the map as the automatic default"
 *      flavor (that is a separate, still-deferred `PARAM_SCOPE`/`world`-scope
 *      product question, #389's own account). This is an explicit, named,
 *      GM-opt-in snapshot — untouched `core/params-schema.js`, unchanged
 *      defaults for anyone who never applies one.
 *
 * WORLD-scoped, exactly like `effect-preset-persistence.js`'s own reasoning:
 * a preset is a reusable snapshot, not a fact about any one scene, so it
 * belongs beside the table's shared policy settings, not the scene document.
 * One JSON string setting, mirroring `sky-persistence.js#WORLD_SKY_KEY`'s
 * "the settings adapter deliberately supports only enum/bool... one
 * JSON.parse at the edge is cheaper than a new kind in a module every other
 * setting shares" precedent exactly.
 *
 * Shape: `{ [presetName]: { capturedAt: <ISO timestamp>, effects:
 * Record<effectId, Record<paramKey, value>> } }` — one flag for the whole
 * library, not one per preset, the same "one flat store, not N" reasoning
 * `effect-param-persistence.js`/`effect-preset-persistence.js` both give for
 * their own single flag/setting. `effects` is whatever
 * `readSceneAllEffectParams` returned verbatim — this module never inspects
 * or reshapes it, the same "ignorant of what a preset actually IS" posture
 * `effect-preset-persistence.js` already has toward per-effect params.
 *
 * @module foundry/scene-preset-persistence
 */

import { registerSettings, readSetting, writeSetting } from './settings-adapter.js';

/** The module namespace this setting lives under. */
export const SCENE_PRESET_NAMESPACE = 'map-shine-advanced';
/** The world setting's key. */
export const WORLD_SCENE_PRESETS_KEY = 'scenePresets';

/**
 * Register the world-scoped scene-presets setting. Call once, in `init`,
 * inside the SAME `Hooks.once('init', ...)` block every sibling persistence
 * setting already shares (`foundry/adapter-only` ratchets every literal
 * `Hooks.*` call in boot.js — a second registration hook would be a genuine
 * new violation, not just a number to bump).
 * @param {{onChange?: () => void}} [options]
 */
export function registerScenePresetSettings(options = {}) {
  registerSettings(
    SCENE_PRESET_NAMESPACE,
    [
      {
        key: WORLD_SCENE_PRESETS_KEY,
        scope: 'world',
        kind: 'enum',
        default: '',
        config: false,
        name: 'Scene presets library',
        hint: 'Named, reusable whole-scene look snapshots, shared across every scene at this table.',
      },
    ],
    { onChange: () => options.onChange?.() }
  );
}

/**
 * Read the whole scene-preset library.
 * @returns {{presets: Record<string, {capturedAt: string, effects: Record<string, object>}>, reason: string|null}}
 *   `presets: {}` on any failure or absence — an empty library is a valid,
 *   safe fallback, never confused with "the read itself failed" because
 *   `reason` stays distinguishable (feedback_instruments_must_not_lie).
 */
export function readScenePresets() {
  try {
    const raw = readSetting(SCENE_PRESET_NAMESPACE, WORLD_SCENE_PRESETS_KEY);
    if (typeof raw !== 'string' || raw === '') return { presets: {}, reason: null };
    const parsed = JSON.parse(raw);
    return { presets: parsed && typeof parsed === 'object' ? parsed : {}, reason: null };
  } catch (err) {
    return { presets: {}, reason: `reading scene presets failed: ${err?.message ?? err}` };
  }
}

/**
 * Replace the whole scene-preset library. GM-only (Foundry's own
 * world-setting rule) — a player's attempt reports `{ok:false}` rather than
 * throwing.
 * @param {Record<string, {capturedAt: string, effects: Record<string, object>}>} presets
 * @returns {Promise<{ok: boolean, reason: string|null}>}
 */
export async function writeScenePresets(presets) {
  try {
    await writeSetting(SCENE_PRESET_NAMESPACE, WORLD_SCENE_PRESETS_KEY, JSON.stringify(presets ?? {}));
    return { ok: true, reason: null };
  } catch (err) {
    return { ok: false, reason: `writing scene presets failed (GM only?): ${err?.message ?? err}` };
  }
}
