/**
 * CUE PERSISTENCE — where a scene's own authored cue stack lives: one scene
 * flag, mirroring `fade-persistence.js`'s exact shape (docs/holy/UI-
 * Testament.md §4.3: "cues travel — they live in scene flags, so a sold map
 * ships with its authored moments"). U3.
 *
 * This module reads and writes an ARRAY of `core/cues-schema.js#Cue`
 * objects. It validates nothing — `validateCueStack` (pure, injected
 * resolver) is the one place that happens; this file only ever moves the
 * array in and out of Foundry.
 *
 * ⚠️ WRITES ARE GM-ONLY, Foundry's own rule — same posture as every other
 * `foundry/` persistence module: a write failure reports `{ok:false,
 * reason}` rather than throwing.
 *
 * @module foundry/cues-persistence
 */

const CUES_NAMESPACE = 'map-shine-advanced';
const SCENE_CUES_FLAG = 'cueStack';

/**
 * Read the active scene's own cue stack.
 * @returns {{cues: object[], reason: string|null}}
 */
export function readCueStack() {
  try {
    const scene = typeof canvas !== 'undefined' ? (canvas?.scene ?? null) : null;
    if (!scene) return { cues: [], reason: 'no active scene' };
    const raw = scene.getFlag(CUES_NAMESPACE, SCENE_CUES_FLAG);
    return { cues: Array.isArray(raw) ? raw : [], reason: null };
  } catch (err) {
    return { cues: [], reason: `reading the cue stack failed: ${err?.message ?? err}` };
  }
}

/**
 * Write the active scene's own cue stack. GM-only.
 * @param {object[]} cues
 * @returns {Promise<{ok: boolean, reason: string|null}>}
 */
export async function writeCueStack(cues) {
  try {
    const scene = typeof canvas !== 'undefined' ? (canvas?.scene ?? null) : null;
    if (!scene) return { ok: false, reason: 'no active scene to write to' };
    await scene.setFlag(CUES_NAMESPACE, SCENE_CUES_FLAG, Array.isArray(cues) ? cues : []);
    return { ok: true, reason: null };
  } catch (err) {
    return { ok: false, reason: `writing the cue stack failed (GM only?): ${err?.message ?? err}` };
  }
}

/**
 * Watch for another GM's own edit to the stack (the Studio's CUES
 * department, once built, is a second door onto the same flag) — mirrors
 * `fade-persistence.js#watchFadeState` exactly.
 * @param {() => void} onChange
 * @returns {() => void} unsubscribe.
 */
export function watchCueStack(onChange) {
  if (typeof onChange !== 'function' || typeof Hooks === 'undefined') return () => {};
  const id = Hooks.on('updateScene', (doc, change) => {
    try {
      const activeId = typeof canvas !== 'undefined' ? (canvas?.scene?.id ?? null) : null;
      if (!activeId || doc?.id !== activeId) return;
      if (!change?.flags?.[CUES_NAMESPACE] || !(SCENE_CUES_FLAG in change.flags[CUES_NAMESPACE])) return;
      onChange();
    } catch (err) {
      void err;
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
