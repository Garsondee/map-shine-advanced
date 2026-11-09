/**
 * REGION DARKNESS OVERRIDE — an OPT-IN consistency pass over the viewed scene's
 * "Adjust Darkness Level" region behaviors (the read-side of this same
 * behavior type lives in `scene-regions.js`; see its own header for the
 * schema receipt against the vendored Foundry source).
 *
 * WHAT IT DOES, WHEN A GM TURNS IT ON: pins one number (default 0.75) that
 * every darkening region behavior on the CURRENTLY VIEWED scene is forced to
 * use, re-applied on every scene load and every settings change, so the same
 * nominal "indoors" reads the same map to map.
 *
 * ⚠️ OFF BY DEFAULT SINCE 2026-11-09 (decision mmp-6pc.3). It shipped ON
 * (author, 2026-09-09: "EVERY map in the catalogue darkens interiors by the
 * same amount"). The author reversed that on 2026-11-09: "I was wrong about
 * darkness region uniforms ... carefully adjusted by you on a per scene basis
 * ... splitting the regions up a bit and using different values". Rooms are
 * now judged one by one, and a forced value flattens exactly that work (it
 * rewrote Docklands' DARKEN 0.4 and Speakeasy's DARKEN 0.75 to OVERRIDE 0.9,
 * mmp-6pc.2). So:
 *   1. `regionDarknessOverrideEnabled` defaults OFF. Foundry stores a world
 *      setting only once someone sets it, so a world where a GM ever flipped
 *      the toggle keeps its stored value until it is switched again.
 *   2. Even when ON, a scene flagged `flags["map-shine-advanced"]
 *      .regionDarknessAuthored === true` is never rewritten. Map-agent editions
 *      set it: their per-room values are the authored ones.
 *   3. `restoreRegionDarkness` puts the stashed originals back. It is an
 *      explicit GM command (`MapShine.restoreRegionDarkness`) and NEVER runs on
 *      its own: turning the override off does not undo what it already wrote.
 *
 * TWO WORLD-SCOPED SETTINGS, kept OUT of the per-effect enable/disable
 * cascade in `effects/effect-settings.js` on purpose: this is not a rendered,
 * per-frame "effect" the way Grade or Bloom are (no GPU/shader component at
 * all), and unlike every other effect's params it must NOT have a per-client
 * override layer — it writes scene documents every client shares. Shape
 * borrowed from `sky-persistence.js` instead:
 *   - `regionDarknessOverrideEnabled` (bool, world) — OFF by default (above).
 *   - `regionDarknessOverrideValue` (world) — the override level, 0..1,
 *     default 0.75. Stored as a string: the settings adapter only has
 *     `bool`/`enum` kinds (its own header: "a thin, dumb wrapper... widening
 *     it for one caller is how an adapter grows a special case per
 *     consumer"), the exact gap `sky-persistence.js` already worked around
 *     the same way.
 *   Both `config: false` — edited from the Studio's Region Darkness Override
 *   card, not Foundry's native settings sheet (same reasoning as the sky
 *   setting: a second editing surface for the same value is just a mirror).
 *
 * WHICH BEHAVIORS COUNT AS "DARKENING": a `BRIGHTEN`-mode behavior is, by
 * construction, doing the opposite of this feature's job and is never
 * touched. An `OVERRIDE`-mode behavior with `modifier === 0` is a GM
 * deliberately forcing "always fully lit" (a lit foyer, a magic-lit room) —
 * also never touched. Everything else active (`DARKEN` at any modifier, or
 * `OVERRIDE` with `modifier > 0`) is darkening and gets forced to
 * `{mode: OVERRIDE, modifier: <override value>}` — OVERRIDE because the
 * whole point is one absolute, consistent number. EVERY darkening behavior of
 * a Region is rewritten, not only its first (2026-11-09): MSA now honours every
 * darkness behavior (Foundry's min rule, `scene-regions.js`), so a second one
 * left alone would still win wherever it is brighter. See
 * `isDarkeningRegionBehavior` below for the exact rule, Node-tested.
 *
 * A behavior's pre-override `{mode, modifier}` is stashed once, in a flag
 * (`regionDarknessOverrideOriginal`), on the first write that actually changes
 * it, so the stash always holds the value from BEFORE any override.
 * `restoreRegionDarkness` writes it back and clears the flag.
 *
 * GM-GATED exactly like `pf2e-darkness-standdown.js`: `applyRegionDarknessOverride`
 * is called unconditionally on every client (from `canvasReady` and from the
 * settings' own `onChange`), so it pre-checks `readIsGM()` itself rather than
 * attempting a doomed write from every player's browser. Players need no
 * reactive code of their own: Foundry syncs the GM's document write to
 * everyone, and the existing per-frame region-darkness reader
 * (`scene-regions.js`, already consumed every frame) just sees the new
 * numbers next frame.
 *
 * @module foundry/region-darkness-override
 */
import { registerSettings, readSetting, writeSetting } from './settings-adapter.js';
import { readIsGM } from './scene-vision.js';

export const REGION_DARKNESS_OVERRIDE_NAMESPACE = 'map-shine-advanced';
export const REGION_DARKNESS_OVERRIDE_ENABLED_KEY = 'regionDarknessOverrideEnabled';
export const REGION_DARKNESS_OVERRIDE_VALUE_KEY = 'regionDarknessOverrideValue';
export const DEFAULT_REGION_DARKNESS_OVERRIDE_VALUE = 0.75;
/** Scene flag: `true` = this scene's Region darkness was set room by room; the override never rewrites it. */
export const REGION_DARKNESS_AUTHORED_FLAG_KEY = 'regionDarknessAuthored';
const NS = REGION_DARKNESS_OVERRIDE_NAMESPACE;
const ORIGINAL_FLAG_KEY = 'regionDarknessOverrideOriginal';

/** `AdjustDarknessLevelRegionBehaviorType.MODES` — verbatim from source
 * (`client/data/region-behaviors/adjust-darkness-level.mjs`). Duplicated
 * rather than imported from `effects/lighting/region-geometry.js`'s own copy
 * of the same constant: `foundry/` never imports `effects/`
 * (`settings-adapter.js`'s own header — the inversion legacy/foundry/ got
 * backwards, `canvas-replacement.js` importing `SpecularEffectV2` by name). */
const MODES = Object.freeze({ OVERRIDE: 0, BRIGHTEN: 1, DARKEN: 2 });

/** The Studio card's schema (`registerSimpleEffectCard`'s generic shape) —
 * one field, the override level itself. The enable toggle is generic
 * (`onToggleEnabled`) and needs no schema entry of its own. */
export const REGION_DARKNESS_OVERRIDE_PARAMS = Object.freeze({
  value: {
    type: 'float',
    min: 0,
    max: 1,
    step: 0.01,
    default: DEFAULT_REGION_DARKNESS_OVERRIDE_VALUE,
    category: 'Darkness',
    label: 'Interior darkness',
    help: 'Off by default. When on, every darkening "Adjust Darkness Level" region on the viewed scene is forced to this value (0 fully lit, 1 fully dark). Scenes tuned room by room (flagged regionDarknessAuthored) are never changed. Originals are kept: MapShine.restoreRegionDarkness() puts them back; switching this off does not.',
  },
});

/** @param {*} v @param {number} fallback @returns {number} clamped to [0,1]; a non-finite input reads as `fallback`. */
function clamp01(v, fallback = DEFAULT_REGION_DARKNESS_OVERRIDE_VALUE) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : fallback;
}

/**
 * Register the two world-scoped settings. Call once, in `init`.
 * @param {{onChange?: () => void}} [options]
 */
export function registerRegionDarknessOverrideSettings(options = {}) {
  registerSettings(
    NS,
    [
      {
        key: REGION_DARKNESS_OVERRIDE_ENABLED_KEY,
        scope: 'world',
        kind: 'bool',
        default: false,
        config: false,
        name: 'Region darkness override',
        hint: "Force the viewed scene's darkening region behaviors to one value (off by default).",
      },
      {
        key: REGION_DARKNESS_OVERRIDE_VALUE_KEY,
        scope: 'world',
        kind: 'enum',
        default: String(DEFAULT_REGION_DARKNESS_OVERRIDE_VALUE),
        config: false,
        name: 'Region darkness override value',
        hint: 'The darkness level (0-1) every darkening region is forced to when the override is on.',
      },
    ],
    { onChange: () => options.onChange?.() }
  );
}

/**
 * Read the two settings. Never throws.
 * @returns {{enabled: boolean, value: number}}
 */
export function readRegionDarknessOverrideSettings() {
  try {
    const enabled = readSetting(NS, REGION_DARKNESS_OVERRIDE_ENABLED_KEY) === true;
    const raw = readSetting(NS, REGION_DARKNESS_OVERRIDE_VALUE_KEY);
    return { enabled, value: clamp01(raw) };
  } catch {
    // A read this early (before `registerRegionDarknessOverrideSettings` has
    // run) is a wiring bug, not a normal state — it falls back to the same OFF
    // the setting itself registers with, so a bug here can never rewrite a
    // scene's hand-set darkness.
    return { enabled: false, value: DEFAULT_REGION_DARKNESS_OVERRIDE_VALUE };
  }
}

/**
 * Write either or both settings. GM-only — Foundry's rule for a world-scoped
 * setting, not ours.
 * @param {{enabled?: boolean, value?: number}} patch
 * @returns {Promise<{ok: boolean, reason: string|null}>}
 */
export async function writeRegionDarknessOverrideSettings(patch) {
  try {
    if (typeof patch?.enabled === 'boolean') {
      await writeSetting(NS, REGION_DARKNESS_OVERRIDE_ENABLED_KEY, patch.enabled);
    }
    if (typeof patch?.value === 'number') {
      await writeSetting(NS, REGION_DARKNESS_OVERRIDE_VALUE_KEY, String(clamp01(patch.value)));
    }
    return { ok: true, reason: null };
  } catch (err) {
    return {
      ok: false,
      reason: `writing the region darkness override settings failed (GM only?): ${err?.message ?? err}`,
    };
  }
}

/**
 * Is this active behavior's CURRENT effect a "darkening" one? Pure, Node-
 * tested — see this module's header for the rule and its reasoning.
 * @param {number} mode @param {number} modifier @returns {boolean}
 */
export function isDarkeningRegionBehavior(mode, modifier) {
  if (mode === MODES.BRIGHTEN) return false;
  if (mode === MODES.OVERRIDE) return Number(modifier) > 0;
  if (mode === MODES.DARKEN) return true;
  return false; // an unrecognized mode is never guessed into "darkening"
}

/**
 * Was this scene's Region darkness set room by room (the override's opt-out)?
 * Reads the flag straight off the document's `flags`, so a plain object works too.
 * @param {*} scene @returns {boolean}
 */
export function isSceneRegionDarknessAuthored(scene) {
  return scene?.flags?.[NS]?.[REGION_DARKNESS_AUTHORED_FLAG_KEY] === true;
}

/** @param {*} behavior @returns {*} the stashed pre-override `{mode, modifier}`, or undefined. */
function readStash(behavior) {
  return behavior?.flags?.[NS]?.[ORIGINAL_FLAG_KEY];
}

/** The update entry that removes the stash: Foundry v14's `ForcedDeletion`, else the legacy `-=` key. */
function stashDeletion() {
  const ForcedDeletion = globalThis.foundry?.data?.operators?.ForcedDeletion;
  return typeof ForcedDeletion === 'function'
    ? { [`flags.${NS}.${ORIGINAL_FLAG_KEY}`]: new ForcedDeletion() }
    : { [`flags.${NS}.-=${ORIGINAL_FLAG_KEY}`]: null };
}

/** Iterate a Foundry Collection, an array, or nothing. */
function each(collection) {
  return collection && typeof collection[Symbol.iterator] === 'function' ? collection : [];
}

/**
 * The override's writes for a set of regions, as data. Pure, Node-tested:
 * every active, darkening `adjustDarknessLevel` behavior of every non-hidden,
 * shaped region that is not already at `value` gets
 * `{system.mode: OVERRIDE, system.modifier: value}`, plus the stash when it has none.
 * @param {Iterable<object>} regions - `canvas.scene.regions`, or stand-ins.
 * @param {number} value
 * @returns {{scanned: number, updates: Array<{behavior: object, payload: object}>}}
 */
export function planRegionDarknessOverride(regions, value) {
  const updates = [];
  let scanned = 0;
  for (const region of each(regions)) {
    if (!region || region.hidden) continue;
    if (!Array.isArray(region.shapes) || region.shapes.length === 0) continue;
    for (const behavior of each(region.behaviors)) {
      if (behavior?.type !== 'adjustDarknessLevel' || behavior?.disabled) continue;
      const mode = behavior?.system?.mode;
      const modifier = behavior?.system?.modifier;
      if (!isDarkeningRegionBehavior(mode, modifier)) continue;
      scanned += 1;
      if (mode === MODES.OVERRIDE && Math.abs(Number(modifier) - value) < 0.001) continue; // already compliant
      const payload = { 'system.mode': MODES.OVERRIDE, 'system.modifier': value };
      if (readStash(behavior) === undefined) payload[`flags.${NS}.${ORIGINAL_FLAG_KEY}`] = { mode, modifier };
      updates.push({ behavior, payload });
    }
  }
  return { scanned, updates };
}

/**
 * The restore's writes for a set of regions, as data. Pure, Node-tested:
 * every darkness behavior carrying a stash gets its `{mode, modifier}` back and
 * the stash removed — hidden regions and disabled behaviors included, since the
 * stash is the only record of what the author typed.
 * @param {Iterable<object>} regions
 * @returns {{updates: Array<{behavior: object, payload: object}>}}
 */
export function planRegionDarknessRestore(regions) {
  const updates = [];
  for (const region of each(regions)) {
    for (const behavior of each(region?.behaviors)) {
      if (behavior?.type !== 'adjustDarknessLevel') continue;
      const stash = readStash(behavior);
      if (!stash || typeof stash !== 'object') continue;
      const payload = { ...stashDeletion() };
      if (Number.isInteger(stash.mode)) payload['system.mode'] = stash.mode;
      if (Number.isFinite(Number(stash.modifier))) payload['system.modifier'] = clamp01(stash.modifier, 0);
      updates.push({ behavior, payload });
    }
  }
  return { updates };
}

/**
 * THE MAIN ENTRY POINT — force every darkening region behavior on the current
 * scene to the configured override value, when the override is ON and the scene
 * is not flagged `regionDarknessAuthored`. GM-gated (a benign no-op, honestly
 * reported, on every other client); safe and cheap to call unconditionally and
 * often (scene load, settings change) since it skips any behavior already at
 * the target `{mode, modifier}`.
 *
 * @returns {Promise<{ok: boolean, reason: string|null, scanned: number, updated: number}>}
 */
export async function applyRegionDarknessOverride() {
  const { enabled, value } = readRegionDarknessOverrideSettings();
  if (!enabled) return { ok: true, reason: 'region darkness override is off', scanned: 0, updated: 0 };
  if (!readIsGM()) {
    return {
      ok: false,
      reason: 'not GM — only the GM writes region darkness; waiting for the synced scene instead',
      scanned: 0,
      updated: 0,
    };
  }
  try {
    const scene = typeof canvas !== 'undefined' ? (canvas?.scene ?? null) : null;
    if (isSceneRegionDarknessAuthored(scene)) {
      return {
        ok: true,
        reason: `scene "${scene?.name ?? scene?.id}" is flagged ${REGION_DARKNESS_AUTHORED_FLAG_KEY}: its per-room darkness is kept`,
        scanned: 0,
        updated: 0,
      };
    }
    const { scanned, updates } = planRegionDarknessOverride(scene?.regions, value);
    let updated = 0;
    for (const { behavior, payload } of updates) {
      await behavior.update(payload);
      updated += 1;
    }
    return { ok: true, reason: null, scanned, updated };
  } catch (err) {
    return {
      ok: false,
      reason: `applying the region darkness override failed: ${err?.message ?? err}`,
      scanned: 0,
      updated: 0,
    };
  }
}

/**
 * THE RESTORE — an explicit GM command (`MapShine.restoreRegionDarkness`),
 * NEVER called by MSA itself: puts every stashed pre-override `{mode, modifier}`
 * back and clears the stash, on the viewed scene, or on every scene with
 * `{all: true}`.
 *
 * A scene flagged `regionDarknessAuthored` is skipped unless
 * `{includeAuthored: true}`: its rooms were set one by one after the override
 * ran, and the stash there is history, not the value anyone wants back.
 * While the override is still ON, the next view of an unflagged scene rewrites
 * it again; the result says so (`warning`).
 *
 * @param {{all?: boolean, includeAuthored?: boolean}} [options]
 * @returns {Promise<{ok: boolean, reason: string|null, scenes: number, restored: number,
 *   skippedAuthored: string[], warning: string|null}>}
 */
export async function restoreRegionDarkness({ all = false, includeAuthored = false } = {}) {
  const result = { ok: true, reason: null, scenes: 0, restored: 0, skippedAuthored: [], warning: null };
  if (!readIsGM()) {
    return { ...result, ok: false, reason: 'not GM — only the GM can restore region darkness' };
  }
  try {
    const viewed = typeof canvas !== 'undefined' ? (canvas?.scene ?? null) : null;
    const scenes = all ? [...each(typeof game !== 'undefined' ? game?.scenes : null)] : viewed ? [viewed] : [];
    if (scenes.length === 0) {
      result.reason = all ? 'no scenes in this world' : 'no scene is viewed — pass {all: true} to restore every scene';
      return result;
    }
    for (const scene of scenes) {
      if (!includeAuthored && isSceneRegionDarknessAuthored(scene)) {
        result.skippedAuthored.push(String(scene?.name ?? scene?.id));
        continue;
      }
      const { updates } = planRegionDarknessRestore(scene?.regions);
      if (updates.length === 0) continue;
      for (const { behavior, payload } of updates) {
        await behavior.update(payload);
        result.restored += 1;
      }
      result.scenes += 1;
    }
    if (result.skippedAuthored.length > 0) {
      result.reason = `kept ${result.skippedAuthored.length} scene(s) flagged ${REGION_DARKNESS_AUTHORED_FLAG_KEY} (pass {includeAuthored: true} to restore them too)`;
    }
    if (result.restored > 0 && readRegionDarknessOverrideSettings().enabled) {
      result.warning =
        'the Region darkness override is still ON: the next view of an unflagged scene rewrites it again. Switch it off in Studio → Region Darkness Override.';
    }
    return result;
  } catch (err) {
    return { ...result, ok: false, reason: `restoring region darkness failed: ${err?.message ?? err}` };
  }
}
