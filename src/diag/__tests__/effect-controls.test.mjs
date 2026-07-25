/**
 * effect-controls.test.mjs — the PURE half of the generic FOH/ROH renderer:
 * category grouping, ordering, and the "unrecognised category falls to
 * Technical" rule (Effects-UI.md §2). The DOM widget builders + buildEffectCard
 * are browser-verified live (no DOM mock — CONVENTIONS §4).
 */
import { CATEGORY_ORDER, groupParamsByCategory } from '../effect-controls.js';

export function run(t) {
  const { ok } = t;

  // --- the fixed order is stable and Light is a first-class category -------
  ok('CATEGORY_ORDER is frozen (data, not mutable state)', Object.isFrozen(CATEGORY_ORDER));
  ok('Light rides alongside the Effects-UI.md set', CATEGORY_ORDER.includes('Light'));
  ok(
    'the canonical order is Presence, Look, Light, Motion, Extent, Response, Technical',
    CATEGORY_ORDER.join(',') === 'Presence,Look,Light,Motion,Extent,Response,Technical'
  );

  // --- groupParamsByCategory: real candle-shaped schema ---------------------
  const schema = {
    sizePx: { type: 'float', category: 'Look' },
    color: { type: 'color', category: 'Look' },
    lightRadiusPx: { type: 'float', category: 'Light' },
    animationQuality: { type: 'enum', category: 'Light' },
    windResponse: { type: 'float', category: 'Motion' },
    scanEveryNFrames: { type: 'int', category: 'Technical' },
    mystery: { type: 'float' }, // no category at all
  };
  const groups = groupParamsByCategory(schema);
  ok(
    'groups follow CATEGORY_ORDER, skipping empty categories',
    groups.map((g) => g.category).join(',') === 'Look,Light,Motion,Technical'
  );
  ok(
    'Look keeps the schema’s own declared order (sizePx before color)',
    groups.find((g) => g.category === 'Look').keys.join(',') === 'sizePx,color'
  );
  ok(
    'Light collects both its params',
    groups.find((g) => g.category === 'Light').keys.join(',') === 'lightRadiusPx,animationQuality'
  );
  ok(
    'a param with NO declared category falls to Technical, never dropped',
    groups.find((g) => g.category === 'Technical').keys.includes('mystery')
  );
  ok(
    'a param with an UNRECOGNISED category also falls to Technical, never dropped',
    groupParamsByCategory({ p: { type: 'float', category: 'Nonsense' } })[0].keys.includes('p')
  );

  // --- degenerate inputs are total, never throw ------------------------------
  ok('an empty schema yields zero groups', groupParamsByCategory({}).length === 0);
  ok('a missing schema yields zero groups (never throws)', groupParamsByCategory(undefined).length === 0);
  ok(
    'a category with zero params is OMITTED, not an empty entry',
    groupParamsByCategory({}).every((g) => g.keys.length > 0)
  );
}
