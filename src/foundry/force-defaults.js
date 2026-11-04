/**
 * FORCE DEFAULTS + GLOBAL RESET — the two ways back to the curated neutral look.
 *
 *  - FORCE DEFAULTS is a world setting (one boolean, GM-written, every client sees it). While it is on,
 *    `effects/registry.js#resolveAndApply` ignores every stored/tuned param layer — scene flags, the
 *    world Grid look, live tweaks — so every effect draws its shipped defaults. Nothing is deleted: turn
 *    it off and each scene's authored look comes straight back. The registry owns the "ignore" (one door,
 *    every effect, nothing to forget per effect); this module owns the setting.
 *  - GLOBAL RESET is the destructive one: it WIPES the authored effect params off every scene in the world
 *    and the world Grid look. Not undoable, so the UI asks twice (`ui/widgets/inline-actions.js`).
 *
 * What neither touches: whether an effect is ON (the enable settings), sky/wind/fades/Looks, paint, anchors,
 * tiles, cues. "Defaults" here means the look-params of the effects.
 *
 * @module foundry/force-defaults
 */

import { registerSettings, readSetting, writeSetting } from './settings-adapter.js';
import { clearGridDefaults } from './grid-defaults-persistence.js';
import { fogOfWarDefaults } from './world-effect-defaults.js';

export const FORCE_DEFAULTS_NAMESPACE = 'map-shine-advanced';
/** The world setting's key. */
export const FORCE_DEFAULTS_KEY = 'forceDefaults';

/** Same flag `effect-param-persistence.js` owns; named here so a reset needs no second import cycle. */
const SCENE_EFFECT_PARAMS_FLAG = 'effectParams';

/**
 * Register the setting. `onChange` fires on every client when the GM flips it.
 * @param {{onChange?: () => void}} [options]
 */
export function registerForceDefaultsSettings(options = {}) {
  registerSettings(
    FORCE_DEFAULTS_NAMESPACE,
    [
      {
        key: FORCE_DEFAULTS_KEY,
        scope: 'world',
        kind: 'bool',
        // ON by default (2026-11-04): the goal is ONE settings arrangement that works for every level, so no
        // scene shows its own tuning unless the GM switches this off.
        default: true,
        config: false,
        name: 'Force default effect settings (world)',
        hint: "Every effect draws Map Shine's shipped defaults, ignoring each scene's tuning. Nothing is deleted.",
      },
    ],
    { onChange: () => options.onChange?.() }
  );
}

/**
 * Is the world forcing defaults right now? Never throws: before the setting is registered (or with no
 * `game`) the answer is "yes", the setting's own default (ON since 2026-11-04).
 * @returns {boolean}
 */
export function isForcingDefaults() {
  try {
    return readSetting(FORCE_DEFAULTS_NAMESPACE, FORCE_DEFAULTS_KEY) !== false;
  } catch (_err) {
    // Not registered yet / no `game`: the setting's own default, so boot never flashes a scene's tuning.
    return true;
  }
}

/**
 * Turn forced defaults on or off (GM only — Foundry rejects a player's world write).
 * @param {boolean} on
 * @returns {Promise<{ok: boolean, reason: string|null}>}
 */
export async function writeForceDefaults(on) {
  try {
    await writeSetting(FORCE_DEFAULTS_NAMESPACE, FORCE_DEFAULTS_KEY, on === true);
    return { ok: true, reason: null };
  } catch (err) {
    return { ok: false, reason: `changing forced defaults failed (GM only?): ${err?.message ?? err}` };
  }
}

/**
 * WIPE every scene's authored effect params and the world Grid look.
 *
 * Takes its collaborators rather than reaching for `game`, so the loop is testable in Node.
 * A scene that fails is reported and the rest still go — one locked scene must not leave the world
 * half-reset without anyone being told which half.
 *
 * @param {object} deps
 * @param {Iterable<{name?: string, getFlag: Function, unsetFlag: Function}>} deps.scenes - every scene in the world.
 * @param {() => Promise<unknown>} deps.clearGrid - empties the world Grid look.
 * @returns {Promise<{ok: boolean, scenesChecked: number, scenesWiped: number, gridCleared: boolean, failures: string[]}>}
 */
export async function resetAllEffectSettings({ scenes, clearGrid }) {
  const failures = [];
  let scenesChecked = 0;
  let scenesWiped = 0;
  for (const scene of scenes ?? []) {
    scenesChecked += 1;
    try {
      const stored = scene.getFlag(FORCE_DEFAULTS_NAMESPACE, SCENE_EFFECT_PARAMS_FLAG);
      if (stored === undefined || stored === null) continue; // nothing authored: nothing to wipe
      await scene.unsetFlag(FORCE_DEFAULTS_NAMESPACE, SCENE_EFFECT_PARAMS_FLAG);
      scenesWiped += 1;
    } catch (err) {
      failures.push(`scene '${scene?.name ?? '?'}': ${err?.message ?? err}`);
    }
  }
  let gridCleared = false;
  try {
    await clearGrid();
    gridCleared = true;
  } catch (err) {
    failures.push(`world grid look: ${err?.message ?? err}`);
  }
  return { ok: failures.length === 0, scenesChecked, scenesWiped, gridCleared, failures };
}

/**
 * The live global reset: the GM's own call, over this world's real scenes and grid setting. Kept here, not
 * in `boot.js`, because `game.user`/`game.scenes` are Foundry access (the `foundry/adapter-only` wall).
 * @returns {Promise<{ok: boolean, reason?: string, scenesWiped?: number, failures: string[]}>}
 */
export async function resetWorldEffectSettings() {
  if (typeof game === 'undefined' || !game.user?.isGM) {
    return { ok: false, reason: 'only a GM can reset every scene', failures: [] };
  }
  const result = await resetAllEffectSettings({
    scenes: game.scenes ?? [],
    // The world-valued cards (Grid, Fog of War) go back to their shipped look with everything else.
    clearGrid: async () => {
      const r = await clearGridDefaults();
      if (!r.ok) throw new Error(r.reason);
      const f = await fogOfWarDefaults.clear();
      if (!f.ok) throw new Error(f.reason);
    },
  });
  return result.ok
    ? { ok: true, scenesWiped: result.scenesWiped, failures: [] }
    : { ok: false, reason: result.failures.join('; '), scenesWiped: result.scenesWiped, failures: result.failures };
}
