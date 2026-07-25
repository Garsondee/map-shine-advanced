/**
 * THE ANCHOR CATALOG — the single source of truth for what DISCRETE point
 * effects exist: every anchor KIND (its consuming effect, the per-anchor knobs
 * a single placed instance carries, and the V2 map-point `effectTarget`
 * string(s) it imports from).
 *
 * ============================================================================
 * WHAT AN ANCHOR IS (the author's mental model)
 * ============================================================================
 *
 * "Paint for regions, place for anchors" (docs/planning/Authoring-and-
 * Distribution.md §2). Most of what V2's Map Points did — "this hearth is on
 * fire" — is really a PAINTED region and belongs to the mask authority. What is
 * left is the genuinely DISCRETE: a single candle flame, one lightning strike
 * point, the endpoints of a rope. Those are ANCHORS — locators you place, that
 * an effect parents itself to. This catalog is the "place" sibling of
 * scene/mask-catalog.js's "paint".
 *
 * ============================================================================
 * WHY THIS IS THE ONLY PLACE ALLOWED TO KNOW AN ANCHOR KIND ↔ V2 STRING
 * ============================================================================
 *
 * The V2 → V3 importer (foundry/v2-anchor-import.js) must translate the old
 * `effectTarget: 'candleFlame'` string into a V3 anchor kind. If that mapping
 * lived in the importer, and the effect knew its own default intensity, and the
 * UI knew the label, we would have three copies of one fact — exactly the drift
 * the mask catalog's own header catalogues (V2 held mask-suffix knowledge in
 * THREE places and needed a 4,092-line compositor to reconcile the copies). So
 * the mapping is DATA here, validated in Node, and `foundry/` (a leaf that may
 * not import `scene/`) receives the translation from boot rather than knowing
 * the strings itself.
 *
 * TAXONOMY, TIER 0: exactly one kind — `candleFlame`. It is the canonical
 * discrete anchor (one spot, one flame) and the first V2 effect being brought
 * across (author directive, 2026-07-20). Lightning points, rope spans and the
 * rest land as one entry each here the day their effect is ported — or the
 * importer cannot map them, which is the funnel working as designed.
 *
 * @module scene/anchor-catalog
 */

import { validateParamsSchema } from '../core/params-schema.js';

/**
 * @typedef {object} AnchorKind
 * @property {string} id - catalog identity, camelCase ('candleFlame').
 * @property {string} effectId - the registry effect id (effects/registry.js)
 *   that renders anchors of this kind. Its own manifest id.
 * @property {string} label - human name (UI + reports).
 * @property {string} [icon] - a single glyph (emoji) representing this kind's
 *   placed instances on the map — the click/drag handle `ui/anchor-mode.js`
 *   renders per anchor (2026-07-22, author: "a unique icon for every effect,
 *   use that as a way to select them"). Optional so a future kind that forgets
 *   one still works — the renderer falls back to a generic pin, never breaks.
 * @property {string[]} v2EffectTargets - the V2 map-point `effectTarget`
 *   strings that import INTO this kind. THE only place the old strings live;
 *   a target string belongs to exactly one kind (checked below).
 * @property {Record<string, object>} params - the per-anchor param schema
 *   (core/params-schema.js): what a single placed instance carries BEYOND its
 *   position. Validated at ingest, so nothing invalid is ever served — the
 *   authored-content twin of the effect-param write-path check (Params.md §2).
 * @property {string} meaning - what this kind is, one line.
 */

/**
 * Every anchor KIND the system knows. Array order is only for stable
 * iteration/reporting; nothing keys on position.
 * @type {ReadonlyArray<AnchorKind>}
 */
export const ANCHOR_KINDS = Object.freeze([
  {
    id: 'candleFlame',
    effectId: 'candleFlame',
    label: 'Candle flame',
    icon: '🕯️',
    // V2's EFFECT_SOURCE_OPTIONS key (legacy/scene/map-points-manager.js:49).
    v2EffectTargets: ['candleFlame'],
    params: {
      intensity: {
        type: 'float',
        min: 0,
        max: 1,
        step: 0.01,
        default: 1,
        label: 'Flame intensity',
        help: 'How strongly this candle burns (0 = out, 1 = full). Imported from a V2 group’s emission.intensity.',
      },
      // PER-CANDLE OVERRIDES (2026-07-22, author directive via the debug-panel
      // FOH/ROH build: "can we individually recolour candles? things like
      // that" — answered yes, and extended to size + light reach on the
      // author's own pick). Each is a `useCustomX`/`customX` PAIR rather than
      // a nullable value: `core/params-schema.js` has no "unset" sentinel (a
      // color must always be a valid #rrggbb), so "inherit the effect-wide
      // value" is expressed as an explicit bool gate, never an implied one.
      // The renderer (effects/candle-flame-render.js#resolveAnchorColorHex
      // et al.) reads the pair; when the gate is off the effect-wide
      // CANDLE_FLAME_PARAMS value wins, so a scene with zero customised
      // candles renders byte-identical to today.
      useCustomColor: {
        type: 'bool',
        default: false,
        label: 'Custom colour',
        help: 'Give this one candle its own flame colour instead of the shared one every candle uses.',
      },
      customColor: {
        type: 'color',
        space: 'srgb',
        default: '#ffaa00',
        label: 'This candle’s colour',
        help: 'Only used when "Custom colour" is on.',
      },
      useCustomSize: {
        type: 'bool',
        default: false,
        label: 'Custom size',
        help: 'Give this one candle its own flame size instead of the shared one every candle uses.',
      },
      customSizePx: {
        type: 'float',
        min: 1,
        max: 400,
        step: 1,
        default: 24,
        label: 'This candle’s flame size',
        help: 'Only used when "Custom size" is on. Same units as the shared "Flame size" control.',
      },
      useCustomLightRadius: {
        type: 'bool',
        default: false,
        label: 'Custom light reach',
        help: 'Give this one candle its own light radius instead of the shared one every candle uses.',
      },
      customLightRadiusPx: {
        type: 'float',
        min: 0,
        max: 2000,
        step: 1,
        default: 400,
        label: 'This candle’s light reach',
        help: 'Only used when "Custom light reach" is on. Same units as the shared "Light reach" control.',
      },
    },
    meaning: 'A single placed candle flame — the canonical discrete anchor, successor to a V2 candleFlame map point.',
  },
]);

/**
 * Validate the whole catalog as data — the mask-catalog discipline applied
 * here: a malformed anchor kind is a BUILD error (the Node suite runs this),
 * never a runtime surprise. Returns every problem at once.
 *
 * @param {ReadonlyArray<AnchorKind>} [kinds]
 * @returns {{ok: boolean, errors: string[]}}
 */
export function validateAnchorCatalog(kinds = ANCHOR_KINDS) {
  const errors = [];
  const fail = (m) => errors.push(m);

  const ids = new Set();
  const v2TargetOwners = new Map(); // v2 effectTarget -> kind id

  for (const k of kinds) {
    if (!/^[a-z][a-zA-Z0-9]*$/.test(k.id ?? '')) fail(`kind id '${k.id}' must be camelCase`);
    if (ids.has(k.id)) fail(`duplicate kind id '${k.id}'`);
    ids.add(k.id);

    if (!/^[a-z][a-zA-Z0-9]*$/.test(k.effectId ?? '')) {
      fail(`${k.id}: effectId '${k.effectId}' must be camelCase (it is the registry/settings key)`);
    }
    if (typeof k.label !== 'string' || k.label.length === 0) fail(`${k.id}: needs a human label`);
    // icon is OPTIONAL (a future kind that forgets one still validates —
    // ui/anchor-mode.js falls back to a generic pin), but if declared it must
    // be a real glyph, not an accidentally-empty string.
    if ('icon' in k && (typeof k.icon !== 'string' || k.icon.length === 0)) {
      fail(`${k.id}: icon, if declared, must be a non-empty string`);
    }
    if (!k.meaning || k.meaning.length < 10) fail(`${k.id}: must state its meaning`);

    if (!Array.isArray(k.v2EffectTargets) || k.v2EffectTargets.length === 0) {
      fail(`${k.id}: needs at least one v2EffectTargets string (or an explicit note that it has no V2 ancestor)`);
    } else {
      for (const target of k.v2EffectTargets) {
        if (typeof target !== 'string' || target.length === 0) {
          fail(`${k.id}: v2EffectTargets entries must be non-empty strings`);
          continue;
        }
        if (v2TargetOwners.has(target)) {
          fail(`V2 effectTarget '${target}' claimed by both '${v2TargetOwners.get(target)}' and '${k.id}'`);
        }
        v2TargetOwners.set(target, k.id);
      }
    }

    // Per-anchor knobs must be a real params schema — validated exactly like an
    // effect's, because they persist and travel in an adventure the same way.
    const ps = validateParamsSchema(k.params);
    if (!ps.ok) for (const e of ps.errors) fail(`${k.id}: params.${e}`);
  }

  return { ok: errors.length === 0, errors };
}

/** @param {string} id @returns {AnchorKind|null} */
export function anchorKindById(id) {
  return ANCHOR_KINDS.find((k) => k.id === id) ?? null;
}

/** @param {string} effectId @returns {AnchorKind[]} every kind a given effect consumes. */
export function anchorKindsForEffect(effectId) {
  return ANCHOR_KINDS.filter((k) => k.effectId === effectId);
}

/**
 * Translate a V2 map-point `effectTarget` string into the V3 anchor kind it
 * imports into — the importer's one lookup. Boot hands this to `foundry/`
 * (a leaf that cannot import this module) so the old strings stay known in
 * exactly one place.
 * @param {string} target @returns {AnchorKind|null}
 */
export function anchorKindByV2EffectTarget(target) {
  return ANCHOR_KINDS.find((k) => k.v2EffectTargets.includes(target)) ?? null;
}
