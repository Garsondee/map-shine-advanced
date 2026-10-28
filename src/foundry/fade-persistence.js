/**
 * FADE PERSISTENCE — where the live fade state lives: a scene flag, the
 * Testament's own "one writer, many derivers" law (§4.2) made concrete.
 *
 * Fades are a SESSION/table thing, scoped to the scene being played — unlike
 * sky (world-by-default, scene opt-in, two stores), there is no world-level
 * fade here. A "resting look" a map fades back to is itself just another
 * target configuration a GM sets (§4.1's Baseline button), not a second
 * store to keep in sync with this one.
 *
 * This module reads and writes ONE flat map (`Record<string, FadeEntry>`,
 * `world/fade-engine.js`'s own shape) under one scene flag. It decides
 * NOTHING about curves or easing — that is the pure engine's job; this file
 * only ever moves the map in and out of Foundry.
 *
 * ⚠️ WRITES ARE GM-ONLY, Foundry's own rule. `scene.setFlag` rejects a
 * non-GM. Every write below reports `{ok:false, reason}` rather than
 * throwing — same posture as `sky-persistence.js`, which this file mirrors
 * line for line in shape.
 *
 * @module foundry/fade-persistence
 */

import { flattenDottedLeaves, hasOwnTo, nestDottedKeys } from './flag-keys.js';

const FADE_NAMESPACE = 'map-shine-advanced';
const SCENE_FADE_FLAG = 'fadeState';

/**
 * Read the active scene's fade state.
 * @returns {{state: Record<string, object>, reason: string|null}}
 *   `state: {}` on any failure — an empty map is a valid, safe fallback (no
 *   fades running), never confused with "the read itself failed" because
 *   `reason` stays distinguishable (feedback_instruments_must_not_lie).
 */
export function readFadeState() {
  try {
    const scene = typeof canvas !== 'undefined' ? (canvas?.scene ?? null) : null;
    if (!scene) return { state: {}, reason: 'no active scene' };
    const raw = scene.getFlag(FADE_NAMESPACE, SCENE_FADE_FLAG);
    // Keys are dotted fade-source ids, which Foundry's flag write nests —
    // flag-keys.js explains; this restores the flat map the engine expects.
    return { state: flattenDottedLeaves(raw, hasOwnTo), reason: null };
  } catch (err) {
    return { state: {}, reason: `reading fade state failed: ${err?.message ?? err}` };
  }
}

/**
 * Wrap the whole map so Foundry REPLACES the stored flag instead of merging
 * into it.
 *
 * ⚠️ A plain `setFlag` with an object MERGES (Foundry's `update` runs
 * `mergeObject`), so a key missing from `state` was never removed from
 * storage: every fade ever started on a scene stayed in its flag forever.
 * Live incident (2026-10-27, Mad Scientist's Compound): a "Rain 0 → 100%
 * over 1m" entry from a test hours earlier was still stored. After a reload,
 * changing Wind wrote the flag, `watchFadeState`'s echo read the WHOLE flag
 * back, the old entry came back to life and slammed rain to 100%; the sky
 * re-resolve that the same flag write triggers then eased it back down over
 * ~2 minutes, deaf to Fade Time = Now. `fadeWindSpeedTo`'s own
 * `delete rest['wind.speed01']` had never reached storage either.
 *
 * Nested first, because `expandObject` does not look inside an operator, and
 * the stored shape should stay the one `readFadeState` already repairs.
 * Outside Foundry (Node tests) there is no operator: the plain map is
 * returned, the old merge behaviour.
 * @param {Record<string, object>} state
 * @returns {object}
 */
export function fadeStateFlagValue(state) {
  const nested = nestDottedKeys(state ?? {});
  const Replace = globalThis.foundry?.data?.operators?.ForcedReplacement;
  return typeof Replace?.create === 'function' ? Replace.create(nested) : nested;
}

/**
 * Write the active scene's fade state. GM-only. Replaces the stored map
 * whole — see `fadeStateFlagValue`.
 * @param {Record<string, object>} state
 * @returns {Promise<{ok: boolean, reason: string|null}>}
 */
export async function writeFadeState(state) {
  try {
    const scene = typeof canvas !== 'undefined' ? (canvas?.scene ?? null) : null;
    if (!scene) return { ok: false, reason: 'no active scene to write to' };
    await scene.setFlag(FADE_NAMESPACE, SCENE_FADE_FLAG, fadeStateFlagValue(state));
    return { ok: true, reason: null };
  } catch (err) {
    return { ok: false, reason: `writing fade state failed (GM only?): ${err?.message ?? err}` };
  }
}

/**
 * Watch for another GM's client writing a fade, so this client can re-derive
 * immediately rather than waiting for its own next poll — mirrors
 * `sky-persistence.js#watchSceneSky` exactly, filtered to the active scene
 * and this module's own flag key.
 * @param {() => void} onChange
 * @returns {() => void} unsubscribe.
 */
export function watchFadeState(onChange) {
  if (typeof onChange !== 'function' || typeof Hooks === 'undefined') return () => {};
  const id = Hooks.on('updateScene', (doc, change) => {
    try {
      const activeId = typeof canvas !== 'undefined' ? (canvas?.scene?.id ?? null) : null;
      if (!activeId || doc?.id !== activeId) return;
      if (!change?.flags?.[FADE_NAMESPACE] || !(SCENE_FADE_FLAG in change.flags[FADE_NAMESPACE])) return;
      onChange();
    } catch (err) {
      void err; // a mid-teardown update; nothing to recover
    }
  });
  return () => {
    try {
      Hooks.off('updateScene', id);
    } catch (err) {
      void err;
    }
  };
}
