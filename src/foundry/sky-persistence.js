/**
 * SKY PERSISTENCE — where the world sky and a scene's own sky are STORED.
 *
 * Two stores, one shape (`world/sky-settings.js#DEFAULT_SKY`):
 *
 *   - **world** → a `world`-scoped Foundry setting. One sky for the campaign,
 *     GM-owned, shared by every client. The default.
 *   - **scene** → a flag on the active scene, in the same `setFlag`/`getFlag`
 *     idiom `anchor-adapter.js`/`paint-adapter.js` already use. Opt-in, per the
 *     author's *"an option to make it per scene that you have to enable"*.
 *
 * This module reads and writes. It decides NOTHING about which one wins —
 * `world/sky-settings.js#resolveSky` owns that, purely and Node-tested. The
 * split is the same one `scene-environment.js` draws between `deriveDarkness`
 * (pure) and `readSceneDarkness` (live), and it exists because "could not read"
 * and "read a real value" must stay distinguishable
 * (feedback_instruments_must_not_lie).
 *
 * ⚠️ WRITES ARE GM-ONLY, and that is Foundry's rule, not ours. `game.settings`
 * at world scope and `scene.setFlag` both reject a non-GM. Every write below
 * therefore reports `{ok:false, reason}` rather than throwing — a player
 * nudging the astrolabe should see their own view unchanged and a clear reason,
 * never an exception in the console and a silently-dropped edit.
 *
 * @module foundry/sky-persistence
 */

import { registerSettings, readSetting, writeSetting } from './settings-adapter.js';

/** The module namespace both stores live under. */
export const SKY_NAMESPACE = 'map-shine-advanced';
/** The world setting's key. */
export const WORLD_SKY_KEY = 'worldSky';
/** The scene flag's key — the sky block itself. */
export const SCENE_SKY_FLAG = 'sky';
/** The scene flag's key — the opt-in toggle. Separate from the block so a scene
 * can keep an authored sky while temporarily falling back to the world's. */
export const SCENE_SKY_OVERRIDE_FLAG = 'skyOverride';

/**
 * Register the world-scoped sky setting. Call once, in `init`.
 *
 * Stored as JSON in a String setting rather than as a typed object: the
 * settings adapter deliberately supports only `enum`/`bool` (it is "a thin,
 * dumb wrapper" by its own header, and widening it for one caller is how an
 * adapter grows a special case per consumer). One `JSON.parse` at the edge
 * here is cheaper than a new kind in a module every other setting shares.
 *
 * `config: false` — this is driven by the astrolabe, not by Foundry's settings
 * sheet. A second editing surface for the same value is a mirror, and mirrors
 * are what Environment.md §2.4 is about.
 *
 * @param {{onChange?: () => void}} [options]
 */
export function registerSkySettings(options = {}) {
  registerSettings(
    SKY_NAMESPACE,
    [
      {
        key: WORLD_SKY_KEY,
        scope: 'world',
        kind: 'enum',
        default: '',
        config: false,
        name: 'World sky',
        hint: 'Time of day and weather for the whole world. Edited from the astrolabe.',
      },
    ],
    { onChange: () => options.onChange?.() }
  );
}

/**
 * Read the world sky block.
 * @returns {{sky: object|null, source: 'world-setting'|'unavailable', reason: string|null}}
 *   `sky: null` means "nothing stored or unreadable" — the caller falls back to
 *   the pure defaults, which is a different thing from "stored as the defaults"
 *   and stays distinguishable.
 */
export function readWorldSky() {
  try {
    const raw = readSetting(SKY_NAMESPACE, WORLD_SKY_KEY);
    if (typeof raw !== 'string' || raw === '') {
      return { sky: null, source: 'unavailable', reason: 'no world sky stored yet', reasonIsBenign: true };
    }
    return { sky: JSON.parse(raw), source: 'world-setting', reason: null };
  } catch (err) {
    return { sky: null, source: 'unavailable', reason: `reading the world sky failed: ${err?.message ?? err}` };
  }
}

/**
 * Write the world sky block. GM-only (Foundry's rule).
 * @param {object} sky - a normalized block from `world/sky-settings.js`.
 * @returns {Promise<{ok: boolean, reason: string|null}>}
 */
export async function writeWorldSky(sky) {
  try {
    await writeSetting(SKY_NAMESPACE, WORLD_SKY_KEY, JSON.stringify(sky));
    return { ok: true, reason: null };
  } catch (err) {
    return { ok: false, reason: `writing the world sky failed (GM only?): ${err?.message ?? err}` };
  }
}

/**
 * Read the active scene's own sky block and its opt-in toggle.
 * @returns {{sky: object|null, sceneOverrides: boolean, sceneId: string|null, reason: string|null}}
 */
export function readSceneSky() {
  try {
    const scene = typeof canvas !== 'undefined' ? (canvas?.scene ?? null) : null;
    if (!scene) return { sky: null, sceneOverrides: false, sceneId: null, reason: 'no active scene' };
    return {
      sky: scene.getFlag(SKY_NAMESPACE, SCENE_SKY_FLAG) ?? null,
      sceneOverrides: scene.getFlag(SKY_NAMESPACE, SCENE_SKY_OVERRIDE_FLAG) === true,
      sceneId: scene.id ?? null,
      reason: null,
    };
  } catch (err) {
    return {
      sky: null,
      sceneOverrides: false,
      sceneId: null,
      reason: `reading the scene sky failed: ${err?.message ?? err}`,
    };
  }
}

/**
 * Write the active scene's own sky block. GM-only.
 * @param {object} sky
 * @returns {Promise<{ok: boolean, reason: string|null}>}
 */
export async function writeSceneSky(sky) {
  try {
    const scene = typeof canvas !== 'undefined' ? (canvas?.scene ?? null) : null;
    if (!scene) return { ok: false, reason: 'no active scene to write to' };
    await scene.setFlag(SKY_NAMESPACE, SCENE_SKY_FLAG, sky);
    return { ok: true, reason: null };
  } catch (err) {
    return { ok: false, reason: `writing the scene sky failed (GM only?): ${err?.message ?? err}` };
  }
}

/**
 * Turn this scene's own sky on or off.
 *
 * Turning it ON deliberately SEEDS the scene's block with whatever is currently
 * resolved, so enabling the toggle changes nothing visible until something is
 * actually edited. A scene that snapped to a hardcoded noon the moment the box
 * was ticked would read as a bug rather than as an opt-in — and the GM would
 * have lost the sky they were looking at, which is the kind of loss nobody
 * forgives a tool for.
 *
 * Turning it OFF leaves the stored block ALONE. The scene keeps its authored
 * sky, dormant, and re-enabling restores it. Deleting on un-tick would make an
 * accidental click destroy work with no undo.
 *
 * @param {boolean} enabled
 * @param {object} [seedSky] - the currently-resolved sky, used when enabling.
 * @returns {Promise<{ok: boolean, reason: string|null}>}
 */
export async function setSceneSkyOverride(enabled, seedSky) {
  try {
    const scene = typeof canvas !== 'undefined' ? (canvas?.scene ?? null) : null;
    if (!scene) return { ok: false, reason: 'no active scene to write to' };
    if (enabled && seedSky) {
      const existing = scene.getFlag(SKY_NAMESPACE, SCENE_SKY_FLAG);
      // Only seed if the scene has never had one — re-enabling must restore
      // what was authored before, not overwrite it with the world's.
      if (!existing) await scene.setFlag(SKY_NAMESPACE, SCENE_SKY_FLAG, seedSky);
    }
    await scene.setFlag(SKY_NAMESPACE, SCENE_SKY_OVERRIDE_FLAG, !!enabled);
    return { ok: true, reason: null };
  } catch (err) {
    return { ok: false, reason: `changing the scene sky override failed (GM only?): ${err?.message ?? err}` };
  }
}

/**
 * Watch for changes to either store, so a second GM's edit reaches this client.
 *
 * The world setting's own `onChange` is wired by `registerSkySettings`; this
 * adds the scene-flag half (`updateScene`), which Foundry announces for any
 * flag write. Filtered to the ACTIVE scene: a GM editing a different scene's
 * sky in a sidebar must not re-resolve the one being rendered.
 *
 * @param {() => void} onChange
 * @returns {() => void} unsubscribe.
 */
export function watchSceneSky(onChange) {
  if (typeof onChange !== 'function' || typeof Hooks === 'undefined') return () => {};
  const id = Hooks.on('updateScene', (doc, change) => {
    try {
      const activeId = typeof canvas !== 'undefined' ? (canvas?.scene?.id ?? null) : null;
      if (!activeId || doc?.id !== activeId) return;
      if (!change?.flags?.[SKY_NAMESPACE]) return;
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
