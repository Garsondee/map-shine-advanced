/**
 * EFFECT PARAM PERSISTENCE — where a GM's authored effect look-params live.
 * `effect-settings.js#effectEnableKey` already gave every effect's ENABLE
 * state this shape (world default + client override, both real Foundry
 * settings); this is the equivalent for the VALUES, mirroring
 * `sky-persistence.js`/`fade-persistence.js`'s own shape line for line:
 * GM-only writes, `{ok, reason}` never a throw, an `updateScene` watcher for
 * a second GM's edit (mythica-machina-press#288, #389).
 *
 * Scene-scoped only, like fades (`fade-persistence.js`'s own header: "a
 * SESSION/table thing... unlike sky, there is no world-level fade here") —
 * an effect's look is a fact about the SCENE it's tuned for, not the whole
 * campaign. A world-level layer (`Stage C`?) is a separate, later decision,
 * not assumed here.
 *
 * ONE flag (`effectParams`), keyed `{ [effectId]: { [paramKey]: value } }` —
 * not one flag per effect, mirroring `world/fade-engine.js`'s own "one flat
 * map, not N" reasoning: a future effect that joins this pattern costs zero
 * new flag keys.
 *
 * @module foundry/effect-param-persistence
 */

const EFFECT_PARAM_NAMESPACE = 'map-shine-advanced';
const SCENE_EFFECT_PARAMS_FLAG = 'effectParams';

/**
 * Read one effect's authored params from the active scene.
 * @param {string} effectId
 * @returns {{params: Record<string, unknown>|null, reason: string|null}}
 *   `params: null` means "nothing stored for this effect" (or no active
 *   scene, or a read error) — the caller falls back to its schema defaults,
 *   which is a different thing from "stored as the defaults" and stays
 *   distinguishable (feedback_instruments_must_not_lie).
 */
export function readSceneEffectParams(effectId) {
  try {
    const scene = typeof canvas !== 'undefined' ? (canvas?.scene ?? null) : null;
    if (!scene) return { params: null, reason: 'no active scene' };
    const all = scene.getFlag(EFFECT_PARAM_NAMESPACE, SCENE_EFFECT_PARAMS_FLAG);
    const params = all && typeof all === 'object' ? all[effectId] : null;
    return { params: params && typeof params === 'object' ? params : null, reason: null };
  } catch (err) {
    return { params: null, reason: `reading ${effectId}'s scene params failed: ${err?.message ?? err}` };
  }
}

/**
 * Merge `patch` into one effect's authored params on the active scene.
 * GM-only (Foundry's rule, not ours) — `scene.setFlag` rejects a non-GM.
 * @param {string} effectId
 * @param {Record<string, unknown>} patch - only the CHANGED keys; every
 *   other effect's block, and this effect's own other keys, are preserved.
 * @returns {Promise<{ok: boolean, reason: string|null}>}
 */
export async function writeSceneEffectParams(effectId, patch) {
  try {
    const scene = typeof canvas !== 'undefined' ? (canvas?.scene ?? null) : null;
    if (!scene) return { ok: false, reason: 'no active scene to write to' };
    const all = scene.getFlag(EFFECT_PARAM_NAMESPACE, SCENE_EFFECT_PARAMS_FLAG);
    const allObj = all && typeof all === 'object' ? all : {};
    const current = allObj[effectId];
    const next = { ...(current && typeof current === 'object' ? current : {}), ...(patch ?? {}) };
    await scene.setFlag(EFFECT_PARAM_NAMESPACE, SCENE_EFFECT_PARAMS_FLAG, { ...allObj, [effectId]: next });
    return { ok: true, reason: null };
  } catch (err) {
    return { ok: false, reason: `writing ${effectId}'s scene params failed (GM only?): ${err?.message ?? err}` };
  }
}

/**
 * Watch for another GM's client writing an effect's scene params, so this
 * client re-derives at once rather than waiting for its own next scene load.
 * Mirrors `sky-persistence.js#watchSceneSky` exactly, filtered to the active
 * scene and this module's own flag key — fires on ANY effect's change (the
 * caller re-runs its own reapply cheaply; a per-effect-id filter would need
 * this module to parse `change.flags` deeper than "did the flag move at
 * all", for no real gain at today's scale).
 * @param {() => void} onChange
 * @returns {() => void} unsubscribe.
 */
export function watchSceneEffectParams(onChange) {
  if (typeof onChange !== 'function' || typeof Hooks === 'undefined') return () => {};
  const id = Hooks.on('updateScene', (doc, change) => {
    try {
      const activeId = typeof canvas !== 'undefined' ? (canvas?.scene?.id ?? null) : null;
      if (!activeId || doc?.id !== activeId) return;
      if (
        !change?.flags?.[EFFECT_PARAM_NAMESPACE] ||
        !(SCENE_EFFECT_PARAMS_FLAG in change.flags[EFFECT_PARAM_NAMESPACE])
      ) {
        return;
      }
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
