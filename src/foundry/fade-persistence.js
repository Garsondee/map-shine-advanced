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
    return { state: raw && typeof raw === 'object' ? raw : {}, reason: null };
  } catch (err) {
    return { state: {}, reason: `reading fade state failed: ${err?.message ?? err}` };
  }
}

/**
 * Write the active scene's fade state. GM-only.
 * @param {Record<string, object>} state
 * @returns {Promise<{ok: boolean, reason: string|null}>}
 */
export async function writeFadeState(state) {
  try {
    const scene = typeof canvas !== 'undefined' ? (canvas?.scene ?? null) : null;
    if (!scene) return { ok: false, reason: 'no active scene to write to' };
    await scene.setFlag(FADE_NAMESPACE, SCENE_FADE_FLAG, state ?? {});
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
