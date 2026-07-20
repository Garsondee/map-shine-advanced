/**
 * THE EFFECT CASCADE — one pure, total resolver for "is this effect on, and
 * with what values", over the Creator → GM → Player control hierarchy.
 *
 * ============================================================================
 * WHY THIS EXISTS — the V2 corpse it replaces (docs/planning/Effect-Registration.md §6)
 * ============================================================================
 *
 * V2's `legacy/effects/resolve-effect-enabled.js` answered "is it on?" with
 * EIGHT functions, THREE sources of truth (`effect.enabled` + `effect.params
 * .enabled` + a localStorage client override), hardcoded `['ascii','_ascii
 * Effect']` ID→private-field tables, per-effect `if (effectId === 'visionMode')`
 * special-cases, and — the worst of it — it reached into the UI's DEBOUNCED
 * SAVE QUEUE (`ui.saveQueue`, `ui.dirtyParams`) to decide whether an effect
 * DREW, wrapped in silent `catch (_) {}` so a failed read ungated the effect
 * invisibly. And `legacy/settings/scene-settings.js` line 2 already had this
 * EXACT cascade ("Map Maker → GM → Player") — it lost anyway, because the
 * resolution was ad-hoc, racy, and un-testable.
 *
 * This module is the antidote: ONE function, PURE (no globals, no Foundry, no
 * UI), TOTAL (never throws, never swallows — a malformed layer degrades to a
 * declared default, it does not silently ungate), and Node-TESTED against the
 * precedence invariants. Per-effect behaviour is DATA in the manifest
 * (`enabledFromProfile`, `a11y.photosensitive`), never code here — so there is
 * no place for an `if (effectId === …)` to grow.
 *
 * @module effects/effect-cascade
 */

import { hydrateParams } from '../core/params-schema.js';

/**
 * The performance profiles, LOW→EXTREME (docs/planning/Effect-Registration.md
 * §2.1 — the games-industry front door). Order IS rank: a higher index affords
 * more. An effect declares the lowest profile it turns on at
 * (`manifest.enabledFromProfile`); the governor later drives this same axis
 * (Effects.md §6), so the vocabulary is fixed now.
 * @type {ReadonlyArray<string>}
 */
export const PERFORMANCE_PROFILES = Object.freeze(['low', 'performance', 'standard', 'quality', 'extreme']);

/** The neutral default profile when none is stored or an unknown one is read. */
export const DEFAULT_PERFORMANCE_PROFILE = 'standard';

/**
 * A per-layer enable override. `auto` = inherit (fall through to the layer
 * below); `on`/`off` = an explicit decision by that layer. A plain boolean
 * cannot express "inherit", which is exactly why V2's boolean `enabled` flags
 * could not cascade and needed the whole `resolve-effect-enabled` apparatus.
 * @type {ReadonlyArray<string>}
 */
export const ENABLE_OVERRIDES = Object.freeze(['auto', 'on', 'off']);

/**
 * Rank of a profile (0..N-1). An unknown/absent profile reads as the neutral
 * default — never a throw, never NaN (a broken setting must not crash the
 * frame, and must not silently disable everything either).
 * @param {string} profile
 * @returns {number}
 */
export function profileRank(profile) {
  const i = PERFORMANCE_PROFILES.indexOf(profile);
  return i >= 0 ? i : PERFORMANCE_PROFILES.indexOf(DEFAULT_PERFORMANCE_PROFILE);
}

/**
 * Normalise an enable-override value; anything not `on`/`off` is `auto`
 * (inherit). Total: a corrupt stored value inherits rather than forcing a
 * state.
 * @param {unknown} v
 * @returns {'auto'|'on'|'off'}
 */
function normalizeOverride(v) {
  return v === 'on' || v === 'off' ? v : 'auto';
}

/**
 * Resolve whether an effect is ON, through the full cascade, in ONE place.
 *
 * The precedence, each step overriding the one above, ending with accessibility
 * as a hard override that NOTHING beats:
 *   1. **Profile gate** — the baseline: on iff the active profile's rank ≥ the
 *      manifest's `enabledFromProfile` rank.
 *   2. **GM (world) override** — `on`/`off` decides; `auto` inherits step 1.
 *   3. **Player (client) override** — `on`/`off` decides; `auto` inherits step 2.
 *      The player has final say over their own experience …
 *   4. **… EXCEPT accessibility.** If the player asked to reduce photosensitive
 *      effects AND this effect declares `a11y.photosensitive`, it is forced
 *      OFF — beating even a GM (or the player themselves) who turned it on. A
 *      user's safety outranks a map's look (feedback_safety_slide_outranks_
 *      doctrine). The a11y gate only ever forces OFF; it never forces on.
 *
 * PURE + TOTAL: no throws, no swallowed errors, no reach into UI/Foundry/global
 * state. Every input has a declared fallback, so a malformed layer degrades
 * predictably instead of ungating the effect invisibly (V2's silent-catch bug).
 *
 * @param {{enabledFromProfile?: string, a11y?: {photosensitive?: boolean}}} manifest
 * @param {{profile?: string, gmEnable?: string, playerEnable?: string, reducePhotosensitive?: boolean}} [layers]
 * @returns {boolean}
 */
export function resolveEffectEnabled(manifest, layers = {}) {
  const gmEnable = normalizeOverride(layers?.gmEnable);
  const playerEnable = normalizeOverride(layers?.playerEnable);

  // 1. profile gate — absent enabledFromProfile means "always on" (rank of the
  //    lowest profile), so a manifest that forgets the field is never silently off.
  const floor = manifest?.enabledFromProfile ?? PERFORMANCE_PROFILES[0];
  let enabled = profileRank(layers?.profile ?? DEFAULT_PERFORMANCE_PROFILE) >= profileRank(floor);

  // 2. GM (world) override
  if (gmEnable === 'on') enabled = true;
  else if (gmEnable === 'off') enabled = false;

  // 3. Player (client) override — final say, subject only to a11y below
  if (playerEnable === 'on') enabled = true;
  else if (playerEnable === 'off') enabled = false;

  // 4. Accessibility hard override — force OFF, beats everything above
  if (layers?.reducePhotosensitive === true && manifest?.a11y?.photosensitive === true) {
    enabled = false;
  }

  return enabled;
}

/**
 * Resolve an effect's parameter VALUES through the cascade, on top of the
 * schema's declared defaults.
 *
 * `paramLayers` is the ordered list of stored diffs (Creator standard → scene →
 * world → client), each a `serializeParams`-style "only what differs from
 * default" object. They merge later-wins into one effective diff, which
 * `hydrateParams` overlays on the defaults AND validates on the way in — so an
 * out-of-range or renamed stored value falls back to its default and is
 * REPORTED, never silently coerced (the antidote to V2's `control-state-
 * sanitize` repair shop). Empty layers → pure defaults.
 *
 * @param {Record<string, object>} schema - the effect's params schema.
 * @param {Array<Record<string, unknown>>} [paramLayers]
 * @returns {{values: Record<string, unknown>, rejected: {key: string, reason: string}[]}}
 */
export function resolveEffectParams(schema, paramLayers = []) {
  const merged = {};
  for (const layer of Array.isArray(paramLayers) ? paramLayers : []) {
    if (layer && typeof layer === 'object') Object.assign(merged, layer);
  }
  return hydrateParams(schema, merged);
}
