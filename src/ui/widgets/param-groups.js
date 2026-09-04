/**
 * ui/widgets/param-groups.js — the PURE half of the generic FOH/ROH renderer:
 * category grouping and ordering, the FOH/ROH partition, collapsed-card status
 * text, the copy-button payload shape, and disclosure open/close persistence.
 * Extracted from `diag/effect-controls.js` at U0 (docs/holy/UI-Testament.md
 * §9) alongside `param-control.js` — this half has no DOM in it at all, so it
 * is the part every future card shell (the OLD debug-panel's `buildEffectCard`
 * AND whatever shell the Studio's EFFECTS department builds in U1) can share
 * without also sharing a rendering style. `effect-controls.js` re-exports
 * everything below unchanged.
 *
 * @module ui/widgets/param-groups
 */

/**
 * The fixed ROH category order (Effects-UI.md §2), with `Light` added
 * alongside it — candles and every other lighting effect already declare
 * params under it (`effects/candle-flame.js`), and "colour/reach/animation
 * richness of the light this effect casts" doesn't sit naturally under Look
 * (the effect's own visible surface) or Response (couplings to the world).
 * A param with an unrecognised/absent category falls to Technical — visible,
 * never lost (Effects-UI.md §2's own rule).
 *
 * ⚠️ THE FALLBACK IS A SAFETY NET, NOT A PLACE TO PUT THINGS — and it had
 * quietly become one. `Detail` (fluid's marbling), `Shape` (water's four
 * geometry/threshold knobs) and `Outdoor` (specular's sun bias) were all
 * deliberately authored — `specular.test.mjs` even asserts the last one by
 * name, with a comment explaining why an "Indoor" twin would be an empty group.
 * None of the three was in this list, so `groupParamsByCategory` swept all six
 * params into Technical: the declaration said one thing, the panel drew
 * another, and every test stayed green because the tests checked the
 * DECLARATION while the loss happened in the RENDERER. The categories are
 * real; the vocabulary was just closed against them.
 *
 * Order runs outward from the effect's own surface: what it looks like →
 * what it emits → what it does → how big it is → what it answers to → the
 * machinery. Adding a category here is cheap; an empty one never renders.
 * @type {ReadonlyArray<string>}
 */
export const CATEGORY_ORDER = Object.freeze([
  'Presence',
  'Look',
  'Detail',
  // Fire's per-layer SURFACE groups (2026-08-09). A particle fire has three
  // independent bodies — the flame, the sparks and the plume — each with its own
  // count, lifetime, size and brightness, and lumping ~19 controls into 'Look'
  // makes the card unusable for the tuning it exists to support. They sit inside
  // the surface block because that is what they are, which keeps the canonical
  // surface → emission → behaviour → size → couplings → machinery run intact.
  'Flame',
  'Ember',
  'Smoke',
  // Precipitation's own five bodies (2026-09-04), the identical justification
  // fire's trio has: five independent sub-engines (ground impact, the falling
  // body, the distant atmospheric veil, ground accumulation, roof drips), each
  // with its own size/rate/strength controls — lumping 23 of them into 'Look'
  // would be the exact unusable-card problem Fire's own comment above names.
  'Splash',
  'Fall',
  'Veil',
  'Ground',
  'Drips',
  'Light',
  'Motion',
  // Perspective strength — a BEHAVIOUR of the particles, belonging to none of
  // the three bodies above.
  'Depth',
  'Shape',
  'Extent',
  'Outdoor',
  'Response',
  'Technical',
]);

/**
 * Sort a params schema into the fixed category order, pure — the ROH's
 * navigation structure, shared by every effect's card. Categories with zero
 * params are omitted (never an empty accordion group). Within a category,
 * params keep the schema's own declared order (the author's authoring order
 * is meaningful; this never re-sorts alphabetically).
 * @param {Record<string, object>} schema
 * @returns {Array<{category: string, keys: string[]}>}
 */
export function groupParamsByCategory(schema) {
  const buckets = new Map(CATEGORY_ORDER.map((c) => [c, []]));
  for (const [key, decl] of Object.entries(schema ?? {})) {
    const cat = CATEGORY_ORDER.includes(decl?.category) ? decl.category : 'Technical';
    buckets.get(cat).push(key);
  }
  return CATEGORY_ORDER.map((category) => ({ category, keys: buckets.get(category) })).filter((g) => g.keys.length > 0);
}

/**
 * THE ROH HALF OF THE SPLIT: every category group MINUS whatever FOH promoted.
 *
 * ⚠️ ROH IS THE COMPLEMENT OF FOH, NOT THE WHOLE SCHEMA. A card that walked
 * every key here would render a promoted key TWICE — once in the strip and
 * again under Advanced — as two independent DOM controls over one param,
 * neither of which re-renders when the other moved. That is how it was
 * caught: the author's water panel showed Opacity 0.62 in the strip and 1
 * under Advanced, on the same frame (2026-07-26), with the last-dragged one
 * silently winning. It also defeated the point of the split, which the
 * standing FOH/ROH rule puts as *"why are you using the same controls for
 * both?"* — a curated strip means nothing if everything appears in both
 * halves.
 *
 * @param {Record<string, object>} schema
 * @param {string[]} [fohKeys] - the promoted subset. Absent/empty → ROH is the
 *   whole schema, which is the correct degenerate case: an effect with no
 *   curated strip keeps every control, it does not lose them.
 * @returns {{category: string, keys: string[]}[]} Groups in CATEGORY_ORDER,
 *   never containing an empty one — a category whose every key was promoted
 *   yields no group at all rather than a bare heading.
 */
export function rohGroups(schema, fohKeys) {
  const promoted = new Set(fohKeys ?? []);
  const out = [];
  for (const { category, keys } of groupParamsByCategory(schema)) {
    const rest = keys.filter((id) => !promoted.has(id));
    if (rest.length > 0) out.push({ category, keys: rest });
  }
  return out;
}

/**
 * A tiny open/closed registry for disclosure sections, keyed by a stable
 * string. A card shell whose body gets rebuilt from scratch (`innerHTML = ''`
 * then re-render) cannot rely on `<details open>` surviving the rebuild — the
 * element holding it is thrown away — so open/closed state has to live
 * somewhere that outlives the DOM. This factory is that somewhere; each card
 * shell keeps its OWN module-level instance (never share one store across two
 * unrelated shells — see `effect-controls.js`'s own `sections` singleton for
 * the pattern).
 *
 * It lives here rather than on the param declaration because view state is
 * the renderer's business — `core/params-schema.js`'s `FORBIDDEN_IN_CONTRACT`
 * list (which rejects `expanded`/`advanced`/`folder`) exists to keep it out of
 * the contract.
 *
 * Pure and exported so the invariant that matters — two cards never share one
 * key — is a Node test rather than something a future refactor quietly undoes.
 * @returns {{isOpen: (key: string) => boolean, setOpen: (key: string, next: boolean) => void, keys: () => string[]}}
 */
export function createSectionStore() {
  const open = new Set();
  return {
    isOpen: (key) => open.has(key),
    setOpen: (key, next) => {
      if (next) open.add(key);
      else open.delete(key);
    },
    keys: () => [...open].sort(),
  };
}

/**
 * The one-line derived readout on a COLLAPSED card's header — the whole reason a
 * collapsed accordion is useful rather than merely short. With ten cards folded
 * shut, this is the only thing distinguishing "working", "off", and "wired but
 * it will never draw because the mask you'd paint into does not exist yet".
 *
 * It is a READOUT, not a param (Params.md §3.6.2) — derived at render time from
 * whatever the effect's own state object already knows.
 *
 * Pure and exported because formatting is where lying instruments are born
 * (`feedback_instruments_must_not_lie`): "0 candles" and "no candles yet" are
 * different claims, and `undefined` must produce silence, never "undefined".
 *
 * @param {object} [a]
 * @param {boolean} [a.enabled] - false wins over everything: an off effect's
 *   counts and missing pieces are not what you need to be told.
 * @param {string} [a.missing] - what is absent, phrased as a noun to follow "no"
 *   (e.g. `'_Specular mask on this floor'`).
 * @param {number} [a.count] - how many instances this effect is drawing.
 * @param {string} [a.noun] - singular noun for `count` (e.g. `'candle'`).
 * @returns {string} '' when there is nothing worth saying — the caller renders
 *   nothing at all rather than an empty element taking up the row.
 */
export function collapsedStatusLine({ enabled, count, noun, missing } = {}) {
  if (enabled === false) return 'off';
  if (typeof missing === 'string' && missing.length > 0) return `no ${missing}`;
  if (Number.isFinite(count) && typeof noun === 'string' && noun.length > 0) {
    if (count === 0) return `no ${noun}s placed yet`;
    return `${count} ${noun}${count === 1 ? '' : 's'}`;
  }
  return '';
}

/**
 * The copy-button's payload — pure, so the SHAPE is Node-tested even though the
 * button itself is DOM. Covers the WHOLE schema, not just whatever FOH/ROH
 * happened to promote — the FOH/ROH split is a presentation concern, and the
 * point of this snapshot is a complete "here is everything, paste it to
 * Claude" that never depends on which card sections happen to be open.
 *
 * ============================================================================
 * ⚠️ `getValue` MUST READ LIVE STATE — A CAPTURED READOUT MAKES THIS LIE
 * ============================================================================
 * This function is only ever as truthful as the `getValue` it is handed, and
 * on 2026-08-17 it was handed a liar. Every `boot.js` effect panel opened with
 * `const readout = someEffect.getReadout();` and closed `getValue` over THAT
 * object — but a cascade resolve REPLACES the readout with a new object, and
 * nothing calls `refreshControls()` on a param change (a mid-drag DOM rebuild
 * would yank the slider out from under the pointer). So the capture froze at
 * whatever existed when the card was built.
 *
 * **The failure is invisible on the card**, which is what made it expensive: an
 * `<input type=range>` holds the dragged value in its OWN native DOM state, so
 * every slider still displayed the author's real settings while this snapshot
 * exported the build-time ones — a flawless, plausible set of schema defaults.
 * The author pasted it in good faith; it was read back as "those are already
 * the defaults"; a whole round trip was spent on values nobody had chosen.
 * `feedback_instruments_must_not_lie` — and note that it did not fail loudly or
 * return nothing, it returned a *confident wrong answer*, which is the strictly
 * worse mode.
 *
 * The rule for callers, therefore: **pass an accessor, never a snapshot.**
 * `getValue: (id) => readLive().params?.[id] ?? SCHEMA[id]?.default` where
 * `readLive` is `() => effect.getReadout()`. `tools/verify-structure.mjs`'s
 * `panels/no-captured-readout` rule now fails the build on the old shape, so
 * this cannot come back quietly.
 *
 * @param {object} a
 * @param {string} a.id - the effect id, e.g. `'fire'`.
 * @param {string} [a.title] - falls back to `id` when absent.
 * @param {boolean} [a.enabled] - omitted from the payload entirely when the
 *   caller has no concept of enabled/disabled (undefined, not false).
 * @param {Record<string, object>} a.schema
 * @param {(paramId: string) => unknown} a.getValue
 * @returns {{effect: string, title: string, enabled?: boolean, values: Record<string, unknown>}}
 */
export function buildSettingsSnapshot({ id, title, enabled, schema, getValue }) {
  const values = {};
  for (const key of Object.keys(schema ?? {})) values[key] = getValue(key);
  const snapshot = { effect: id, title: title ?? id, values };
  if (enabled !== undefined) snapshot.enabled = enabled;
  return snapshot;
}
