/**
 * effect-controls.test.mjs — the PURE half of the generic FOH/ROH renderer:
 * category grouping, ordering, and the "unrecognised category falls to
 * Technical" rule (Effects-UI.md §2). The DOM widget builders + buildEffectCard
 * are browser-verified live (no DOM mock — CONVENTIONS §4).
 */
import { CATEGORY_ORDER, groupParamsByCategory, rohGroups } from '../effect-controls.js';

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

  // --- rohGroups: FOH and ROH PARTITION the schema, never overlap -----------
  // The regression this pins shipped live: the card rendered the full schema
  // under Advanced regardless of what FOH promoted, so a promoted param had TWO
  // independent controls and they disagreed on screen (water, 2026-07-26).
  {
    const roh = rohGroups(schema, ['sizePx', 'lightRadiusPx']);
    const rohKeys = roh.flatMap((g) => g.keys);
    ok('a promoted key does NOT reappear under Advanced', !rohKeys.includes('sizePx'));
    ok('...nor does a promoted key from another category', !rohKeys.includes('lightRadiusPx'));
    ok('an unpromoted key in a partly-promoted category survives', rohKeys.includes('color'));
    ok(
      'FOH ∪ ROH is the WHOLE schema — promotion moves a control, never deletes it',
      new Set([...rohKeys, 'sizePx', 'lightRadiusPx']).size === Object.keys(schema).length
    );
    ok('...and the two halves share nothing', rohKeys.length + 2 === Object.keys(schema).length);
    ok('ROH keeps CATEGORY_ORDER', roh.map((g) => g.category).join(',') === 'Look,Light,Motion,Technical');
  }
  ok(
    'a FULLY promoted category leaves no bare heading behind',
    rohGroups({ a: { type: 'float', category: 'Look' } }, ['a']).length === 0
  );
  ok(
    'no fohKeys → ROH is the whole schema (an effect without a strip keeps every control)',
    rohGroups(schema, undefined).flatMap((g) => g.keys).length === Object.keys(schema).length
  );
  ok('an empty schema yields zero ROH groups (never throws)', rohGroups(undefined, ['x']).length === 0);
}
