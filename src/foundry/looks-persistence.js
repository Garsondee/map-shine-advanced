/**
 * LOOKS PERSISTENCE — where the Remote's Looks live (core/looks-schema.js).
 *
 *  - THE LIBRARY is a WORLD setting: a Look recorded on one map plays on every
 *    map at this table (author, 2026-11-01: "record a general atmosphere and use
 *    it across maps"). Stored as one JSON string, the same shape the scene-preset
 *    library already uses (scene-preset-persistence.js).
 *  - THE RUNNING ORDER is a SCENE flag: the ordered Look ids the GO button walks
 *    through on this scene. A scene carries its own running order with it, the
 *    way it used to carry its cue stack.
 *
 * This file only reads and writes; core/looks-schema.js normalises and
 * validates, boot.js decides when.
 *
 * @module foundry/looks-persistence
 */

import { registerSettings, readSetting, writeSetting } from './settings-adapter.js';

/** The module namespace both stores live under. */
export const LOOKS_NAMESPACE = 'map-shine-advanced';
/** The world setting's key. */
export const WORLD_LOOKS_KEY = 'looksLibrary';
/** The scene flag's key. */
export const SCENE_LOOK_SEQUENCE_FLAG = 'lookSequence';

/**
 * Register the library setting. `onChange` fires on every client when any GM
 * saves, renames or deletes a Look, so every open Remote repaints.
 * @param {{onChange?: () => void}} [options]
 */
export function registerLooksSettings(options = {}) {
  registerSettings(
    LOOKS_NAMESPACE,
    [
      {
        key: WORLD_LOOKS_KEY,
        scope: 'world',
        kind: 'enum',
        default: '',
        config: false,
        name: 'Looks library',
        hint: 'Named Looks (time, weather, wind, light, darkness) the Remote can fade any scene to.',
      },
    ],
    { onChange: () => options.onChange?.() }
  );
}

/** @returns {{raw: string, reason: string|null}} the stored JSON, untouched — core/looks-schema.js#normalizeLibrary parses it. */
export function readLooksLibraryRaw() {
  try {
    const raw = readSetting(LOOKS_NAMESPACE, WORLD_LOOKS_KEY);
    return { raw: typeof raw === 'string' ? raw : '', reason: null };
  } catch (err) {
    return { raw: '', reason: `reading the Looks library failed: ${err?.message ?? err}` };
  }
}

/** @param {string} json @returns {Promise<{ok: boolean, reason: string|null}>} */
export async function writeLooksLibraryRaw(json) {
  try {
    await writeSetting(LOOKS_NAMESPACE, WORLD_LOOKS_KEY, typeof json === 'string' ? json : '');
    return { ok: true, reason: null };
  } catch (err) {
    return { ok: false, reason: `writing the Looks library failed (GM only?): ${err?.message ?? err}` };
  }
}

function activeScene() {
  return typeof canvas !== 'undefined' ? (canvas?.scene ?? null) : null;
}

/**
 * This scene's running order. `present` says whether the flag exists at all —
 * the one-time import of an old cue stack runs only when it does not.
 * @returns {{sequence: string[], present: boolean, reason: string|null}}
 */
export function readLookSequence() {
  try {
    const scene = activeScene();
    if (!scene) return { sequence: [], present: false, reason: 'no active scene' };
    const raw = scene.getFlag(LOOKS_NAMESPACE, SCENE_LOOK_SEQUENCE_FLAG);
    if (!Array.isArray(raw)) return { sequence: [], present: raw !== undefined, reason: null };
    return { sequence: raw.filter((id) => typeof id === 'string' && id.length > 0), present: true, reason: null };
  } catch (err) {
    return { sequence: [], present: false, reason: `reading the running order failed: ${err?.message ?? err}` };
  }
}

/** @param {string[]} sequence @returns {Promise<{ok: boolean, reason: string|null}>} */
export async function writeLookSequence(sequence) {
  try {
    const scene = activeScene();
    if (!scene) return { ok: false, reason: 'no active scene to write to' };
    await scene.setFlag(LOOKS_NAMESPACE, SCENE_LOOK_SEQUENCE_FLAG, Array.isArray(sequence) ? sequence : []);
    return { ok: true, reason: null };
  } catch (err) {
    return { ok: false, reason: `writing the running order failed (GM only?): ${err?.message ?? err}` };
  }
}

/**
 * Call `onChange` when the ACTIVE scene's running order changes (this GM's own
 * write echoing back, or a second GM's). Same shape as cues-persistence.js#watchCueStack.
 * @param {() => void} onChange @returns {() => void} unsubscribe
 */
export function watchLookSequence(onChange) {
  if (typeof onChange !== 'function' || typeof Hooks === 'undefined') return () => {};
  const id = Hooks.on('updateScene', (doc, change) => {
    try {
      const activeId = activeScene()?.id ?? null;
      if (!activeId || doc?.id !== activeId) return;
      const flags = change?.flags?.[LOOKS_NAMESPACE];
      if (!flags || !(SCENE_LOOK_SEQUENCE_FLAG in flags || `-=${SCENE_LOOK_SEQUENCE_FLAG}` in flags)) return;
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
