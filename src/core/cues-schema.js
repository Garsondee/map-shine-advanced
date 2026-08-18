/**
 * THE CUES CONTRACT — a staged, named moment (docs/holy/UI-Testament.md
 * §4.3), validated at author time exactly like a param declaration already
 * is (`params-schema.js`'s own doctrine, applied here). U3.
 *
 * ============================================================================
 * WHAT A CUE IS
 * ============================================================================
 *
 * "A cue is a named, authored MOMENT: a partial environment target, optional
 * effect-param targets, a fade time, a curve" (§4.3, verbatim). Concretely,
 * given U2's own record shape (`world/fade-engine.js`), a cue is just a
 * NAMED, ORDERED, PARTIAL fade-target map — the exact same
 * `Record<key, {to, overMs, curve}>` a mood-chip click already builds
 * ad-hoc, except this one has a name, a stable id, and a place in a stack.
 * "Capture-then-name beats form-filling" (§4.3) — an author captures the
 * CURRENT live state as `to` for whichever keys they care about; this
 * module never invents that capture, it only validates and shapes what
 * already got captured.
 *
 * ============================================================================
 * WHY THIS FILE CANNOT IMPORT `world/` (AND DOESN'T NEED TO)
 * ============================================================================
 *
 * `core/` has zero dependents on `world/` anywhere in this codebase —
 * confirmed empirically before this file was written, not assumed — so a
 * cue's `curve` legality and a target's fadeability both come from
 * `core/params-schema.js#FADE_CURVES`/`FADEABLE_PARAM_TYPES`, the SAME
 * canonical lists `world/fade-engine.js` itself re-exports rather than
 * duplicates. Resolving what TYPE a given key actually is (`water.depth` is
 * a `float`; `sky.mode` might not even exist) needs the LIVE fade-source
 * registry (`world/fade-registry.js`), which only exists once boot.js has
 * built one — so every function below that needs an answer takes a
 * `resolveType`/`readLive` FUNCTION as an argument, never imports a
 * registry. Same "pure core, injected resolver" shape `world/fade-engine.js`
 * itself already uses for the identical reason.
 *
 * @module core/cues-schema
 */

import { FADE_CURVES, FADEABLE_PARAM_TYPES, isFadeableParamType } from './params-schema.js';

/** @typedef {{to: unknown, overMs: number, curve: string}} CueTarget */
/** @typedef {{id: string, name: string, order: number, targets: Record<string, CueTarget>}} Cue */

/**
 * Validate ONE cue. "A cue that targets a param the schema doesn't declare
 * fails at author time, not at the table" (§4.3) — `resolveType` returning
 * `undefined` for a key IS that failure, made concrete.
 *
 * @param {Cue} cue
 * @param {(key: string) => string|undefined} resolveType - the SAME shape
 *   `world/fade-registry.js#createFadeSourceRegistry`'s own `typeOf` is.
 * @returns {{ok: boolean, errors: string[]}}
 */
export function validateCue(cue, resolveType) {
  const errors = [];
  const fail = (m) => errors.push(m);

  if (!cue || typeof cue !== 'object' || Array.isArray(cue)) {
    return { ok: false, errors: ['a cue must be an object'] };
  }
  if (typeof cue.id !== 'string' || cue.id.length === 0) fail('needs a stable, non-empty id');
  if (typeof cue.name !== 'string' || cue.name.length === 0) {
    fail('needs a human name — the deck card has nothing else to show (§4.1: "the deck shows the next cue")');
  }
  if (!Number.isFinite(cue.order))
    fail('needs a numeric order — the deck/jump-list sequence has to come from somewhere');

  if (!cue.targets || typeof cue.targets !== 'object' || Array.isArray(cue.targets)) {
    fail('needs a targets object, keyed by fade key (e.g. "weather.cloudCover01")');
    return { ok: errors.length === 0, errors };
  }
  const keys = Object.keys(cue.targets);
  if (keys.length === 0) fail('needs at least one target — a cue that changes nothing is not a moment');

  for (const key of keys) {
    const target = cue.targets[key];
    if (!target || typeof target !== 'object' || Array.isArray(target)) {
      fail(`${key}: target must be an object`);
      continue;
    }
    if (!('to' in target)) fail(`${key}: needs a 'to' value`);
    if (!Number.isFinite(target.overMs) || target.overMs < 0) {
      fail(`${key}: overMs must be a non-negative number, got ${JSON.stringify(target.overMs)}`);
    }
    if (!FADE_CURVES.includes(target.curve)) {
      fail(`${key}: curve '${target.curve}' is not one of: ${FADE_CURVES.join(', ')}`);
    }
    const type = resolveType(key);
    if (type === undefined) {
      fail(`${key}: no fade source resolves this key — it does not exist, or its effect/axis isn't registered`);
    } else if (!isFadeableParamType(type)) {
      fail(`${key}: type '${type}' is not fadeable (${FADEABLE_PARAM_TYPES.join(', ')})`);
    }
  }

  return { ok: errors.length === 0, errors };
}

/**
 * Validate a whole STACK of cues (one scene's own ordered list) — every
 * cue's own check, plus stack-level invariants a single cue can't see on
 * its own: no two cues sharing an id, no two cues sharing a slot in the
 * deck/jump-list order.
 * @param {Cue[]} cues
 * @param {(key: string) => string|undefined} resolveType
 * @returns {{ok: boolean, errors: string[]}}
 */
export function validateCueStack(cues, resolveType) {
  if (!Array.isArray(cues)) return { ok: false, errors: ['a cue stack must be an array'] };
  const errors = [];
  const seenIds = new Set();
  const seenOrders = new Set();

  for (const cue of cues) {
    const label = typeof cue?.id === 'string' && cue.id.length > 0 ? cue.id : '(no id)';
    const result = validateCue(cue, resolveType);
    for (const e of result.errors) errors.push(`${label}: ${e}`);

    if (typeof cue?.id === 'string' && cue.id.length > 0) {
      if (seenIds.has(cue.id)) errors.push(`${label}: duplicate id — ids must be unique within a stack`);
      seenIds.add(cue.id);
    }
    if (Number.isFinite(cue?.order)) {
      if (seenOrders.has(cue.order))
        errors.push(`${label}: order ${cue.order} collides with another cue in this stack`);
      seenOrders.add(cue.order);
    }
  }

  return { ok: errors.length === 0, errors };
}

/**
 * The deck/jump-list's own sequence. The ONE place "what order do cues
 * play in" is decided — never re-sorted differently at another call site
 * (the same discipline `ui/astrolabe.js`'s own horizon shelf already
 * documents for archetype order: "order is information").
 * @param {Cue[]} cues @returns {Cue[]} a NEW array; never mutates the input.
 */
export function orderedCues(cues) {
  return [...(cues ?? [])].sort((a, b) => (a?.order ?? 0) - (b?.order ?? 0));
}

/**
 * Turn an authored cue into a `mergeFadeState`-ready patch
 * (`world/fade-engine.js`'s own `{id, label, targets}` shape) — the exact
 * "replace, don't queue" capture the Remote's own mood chips already do
 * ad-hoc (`boot.js#fadeWeatherToArchetype`), applied here to an AUTHORED
 * moment instead. `readLive`/`resolveType` are the live fade-source
 * registry's own `readLive`/`typeOf` — injected, per this file's own
 * header, never imported.
 * @param {Cue} cue
 * @param {(key: string) => unknown} readLive
 * @param {(key: string) => string|undefined} resolveType
 * @returns {{id: string, label: string, targets: Record<string, {to: unknown, type: string|undefined, overMs: number, curve: string, from: unknown}>}}
 */
export function cueToFadePatch(cue, readLive, resolveType) {
  const targets = {};
  for (const [key, target] of Object.entries(cue?.targets ?? {})) {
    targets[key] = {
      to: target.to,
      type: resolveType(key),
      overMs: target.overMs,
      curve: target.curve,
      from: readLive(key),
    };
  }
  return { id: `cue:${cue.id}`, label: cue.name, targets };
}
