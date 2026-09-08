/**
 * REGION DARKNESS OVERRIDE — a world-wide consistency pass over every scene's
 * "Adjust Darkness Level" region behaviors (the read-side of this same
 * behavior type lives in `scene-regions.js`; see its own header for the
 * schema receipt against the vendored Foundry source).
 *
 * THE PROBLEM: different scenes/authors hand-type wildly inconsistent
 * `modifier` values (and sometimes different `mode`s) for "darken this
 * building's interior" regions, so the same nominal "indoors" reads
 * differently map to map. This module lets a GM pin one number (default
 * 0.75) that every darkening region on the CURRENTLY VIEWED scene is forced
 * to use, re-applied on every scene load and every settings change.
 *
 * TWO WORLD-SCOPED SETTINGS, kept OUT of the per-effect enable/disable
 * cascade in `effects/effect-settings.js` on purpose: this is not a rendered,
 * per-frame "effect" the way Grade or Bloom are (no GPU/shader component at
 * all), and unlike every other effect's params it must NOT have a per-client
 * override layer — per-client divergence is exactly what this feature exists
 * to eliminate. Shape borrowed from `sky-persistence.js` instead:
 *   - `regionDarknessOverrideEnabled` (bool, world) — ON by default. This is
 *     a deliberate, confirmed choice (author, 2026-09-09): the whole point of
 *     the feature is that EVERY map in the catalogue darkens interiors by the
 *     same amount automatically, not an opt-in a GM has to remember to flip
 *     on per world. It DOES mean updating the module can rewrite a scene's
 *     hand-authored `modifier` the first time it loads post-update — accepted
 *     outright in favour of catalogue-wide consistency, which is exactly why
 *     the pre-override `{mode, modifier}` is still stashed in a flag below
 *     (not a safety rail against this default, just cheap insurance).
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
 * WHICH REGIONS COUNT AS "DARKENING": a `BRIGHTEN`-mode behavior is, by
 * construction, doing the opposite of this feature's job and is never
 * touched. An `OVERRIDE`-mode behavior with `modifier === 0` is a GM
 * deliberately forcing "always fully lit" (a lit foyer, a magic-lit room) —
 * also never touched. Everything else active (`DARKEN` at any modifier, or
 * `OVERRIDE` with `modifier > 0`) is a darkening region and gets forced to
 * `{mode: OVERRIDE, modifier: <override value>}` — OVERRIDE because the
 * whole point is one absolute, consistent number, not a value blended
 * against whatever ambient darkness a scene happens to have at the moment.
 * See `isDarkeningRegionBehavior` below for the exact rule, Node-tested.
 *
 * A region's pre-override `{mode, modifier}` is stashed once, in a flag, on
 * the first write that actually changes it — not surfaced anywhere yet (no
 * restore UI/command exists), but kept rather than lost outright, since this
 * rewrites hand-authored data across the whole map catalogue.
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
    help: 'Every darkening "Adjust Darkness Level" region behavior on the current scene is forced to this value — 0 fully lit, 1 fully dark — so every interior reads the same regardless of what each scene\'s author originally typed in.',
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
    REGION_DARKNESS_OVERRIDE_NAMESPACE,
    [
      {
        key: REGION_DARKNESS_OVERRIDE_ENABLED_KEY,
        scope: 'world',
        kind: 'bool',
        default: true,
        config: false,
        name: 'Region darkness override',
        hint: "Force every scene's darkening region behaviors to one consistent value.",
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
    const enabled = readSetting(REGION_DARKNESS_OVERRIDE_NAMESPACE, REGION_DARKNESS_OVERRIDE_ENABLED_KEY) === true;
    const raw = readSetting(REGION_DARKNESS_OVERRIDE_NAMESPACE, REGION_DARKNESS_OVERRIDE_VALUE_KEY);
    return { enabled, value: clamp01(raw) };
  } catch {
    // A read this early (before `registerRegionDarknessOverrideSettings` has
    // run) is a wiring bug, not a normal state — but if it ever happens, fall
    // back to the same "on" default the setting itself registers with, not
    // the old off-by-default posture, so a bug here never silently reverts
    // the catalogue-wide-consistency intent this feature exists for.
    return { enabled: true, value: DEFAULT_REGION_DARKNESS_OVERRIDE_VALUE };
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
      await writeSetting(REGION_DARKNESS_OVERRIDE_NAMESPACE, REGION_DARKNESS_OVERRIDE_ENABLED_KEY, patch.enabled);
    }
    if (typeof patch?.value === 'number') {
      await writeSetting(
        REGION_DARKNESS_OVERRIDE_NAMESPACE,
        REGION_DARKNESS_OVERRIDE_VALUE_KEY,
        String(clamp01(patch.value))
      );
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
 * Live gather of every non-hidden, shaped region's first active, currently-
 * darkening `adjustDarknessLevel` BEHAVIOR DOCUMENT (not the pure-projected
 * shape `scene-regions.js#readActiveDarknessRegions` returns — this needs
 * the real handle to call `.update()`/`.getFlag()` on) on the currently
 * viewed scene. Browser-only, same split as every other live reader in this
 * zone — left untested under Node, matching `scene-regions.test.mjs`'s own
 * documented split.
 * @returns {object[]} RegionBehavior documents.
 */
function findDarkeningBehaviors() {
  const collection = typeof canvas !== 'undefined' ? (canvas?.scene?.regions ?? null) : null;
  if (!collection) return [];
  const found = [];
  for (const region of collection) {
    if (region?.hidden) continue;
    if (!Array.isArray(region?.shapes) || region.shapes.length === 0) continue;
    const behaviors = region?.behaviors ? [...region.behaviors] : [];
    const behavior = behaviors.find(
      (b) =>
        b?.type === 'adjustDarknessLevel' &&
        !b?.disabled &&
        isDarkeningRegionBehavior(b?.system?.mode, b?.system?.modifier)
    );
    if (behavior) found.push(behavior);
  }
  return found;
}

/**
 * THE MAIN ENTRY POINT — force every darkening region on the current scene to
 * the configured override value. GM-gated (a benign no-op, honestly
 * reported, on every other client); safe and cheap to call unconditionally
 * and often (scene load, settings change) since it skips any behavior
 * already at the target `{mode, modifier}`.
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
    const candidates = findDarkeningBehaviors();
    let updated = 0;
    for (const behavior of candidates) {
      const mode = behavior?.system?.mode;
      const modifier = behavior?.system?.modifier;
      if (mode === MODES.OVERRIDE && Math.abs(Number(modifier) - value) < 0.001) continue; // already compliant
      const payload = { 'system.mode': MODES.OVERRIDE, 'system.modifier': value };
      if (behavior.getFlag(REGION_DARKNESS_OVERRIDE_NAMESPACE, ORIGINAL_FLAG_KEY) === undefined) {
        payload[`flags.${REGION_DARKNESS_OVERRIDE_NAMESPACE}.${ORIGINAL_FLAG_KEY}`] = { mode, modifier };
      }
      await behavior.update(payload);
      updated += 1;
    }
    return { ok: true, reason: null, scanned: candidates.length, updated };
  } catch (err) {
    return {
      ok: false,
      reason: `applying the region darkness override failed: ${err?.message ?? err}`,
      scanned: 0,
      updated: 0,
    };
  }
}
