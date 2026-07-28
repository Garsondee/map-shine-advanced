/**
 * effect-controls.test.mjs — the PURE half of the generic FOH/ROH renderer:
 * category grouping, ordering, and the "unrecognised category falls to
 * Technical" rule (Effects-UI.md §2). The DOM widget builders + buildEffectCard
 * are browser-verified live (no DOM mock — CONVENTIONS §4).
 */
import {
  CATEGORY_ORDER,
  groupParamsByCategory,
  rohGroups,
  createSectionStore,
  collapsedStatusLine,
} from '../effect-controls.js';

import { routeEntry, sortPanelsForZone } from '../debug-panel-controls.js';

export function run(t) {
  const { ok } = t;

  // --- routeEntry: the line that turned the Lab into a junk drawer ----------
  // `entry.zone ?? ZONES[id] ?? 'lab'` made the Lab the DEFAULT sink, so every
  // diagnostic registered without a zone piled into it — twelve in its catch-all
  // "More" drawer by 2026-07-27, eight of them belonging to a specific effect.
  ok('an entry with no zone still lands somewhere visible', routeEntry('x', {}).zone === 'lab');
  ok('an undefined entry does not throw', routeEntry('x', undefined).zone === 'lab');
  ok('a declared zone wins', routeEntry('x', { zone: 'bridge' }).zone === 'bridge');
  ok('a legacy id→zone override is honoured', routeEntry('x', {}, { x: 'settings' }).zone === 'settings');
  ok(
    'a declared zone beats the legacy table (the call site is the truth)',
    routeEntry('x', { zone: 'bridge' }, { x: 'settings' }).zone === 'bridge'
  );

  // THE SECOND DESTINATION — an effect's own card, not a zone body at all.
  ok('an effect-routed entry is not a zone entry', routeEntry('probe', { effect: 'specular' }).kind === 'effect');
  ok('it names its effect', routeEntry('probe', { effect: 'specular' }).effect === 'specular');
  ok(
    'an effect beats both a declared zone and the legacy table',
    routeEntry('probe', { effect: 'specular', zone: 'lab' }, { probe: 'bridge' }).kind === 'effect'
  );
  ok('an empty effect string is not an effect route', routeEntry('x', { effect: '' }).kind === 'zone');

  // --- sortPanelsForZone: declared order, stable ties -----------------------
  {
    const panels = [
      ['grade', { zone: 'workshop' }],
      ['astrolabe', { zone: 'bridge', order: -1 }],
      ['water', { zone: 'workshop' }],
      ['camera', { zone: 'bridge' }],
      ['probe-card', { effect: 'specular' }],
    ];
    const bridge = sortPanelsForZone(panels, 'bridge').map(([id]) => id);
    ok('a negative order pins to the top of its zone', bridge.join(',') === 'astrolabe,camera');

    const workshop = sortPanelsForZone(panels, 'workshop').map(([id]) => id);
    ok('un-ordered panels keep registration order (stable sort)', workshop.join(',') === 'grade,water');
    ok('an effect-routed panel appears in NO zone body', !workshop.includes('probe-card'));
    ok('a zone with nothing routed to it is empty, not undefined', sortPanelsForZone(panels, 'settings').length === 0);
  }

  // --- REGRESSION (2026-07-28): a panel declaring BOTH zone AND effect -------
  // "the Make rail is broken, there are no effects in there" — every real
  // `registerPanel` call for an actual effect (boot.js: bloom, water, fluid,
  // specular, window, grade, vegetation, candles, sun-shadows, wind) declares
  // BOTH `zone: 'workshop'` (so it renders) AND `effect: '<id>'` (so it can
  // gather its OWN attachments via `attachmentsFor`) — a shape the block above
  // never modelled, because it only ever put `zone` and `effect` on SEPARATE
  // entries. `sortPanelsForZone` used to delegate to `routeEntry`, whose
  // "effect beats zone" rule is correct for controls/actions/reports and wrong
  // here — it silently routed every real effect panel to `kind:'effect'`,
  // which `attachmentsFor` never reads for the `panels` map at all (it only
  // scans controls/actions/reports). Net effect: every effect card in the
  // product UI rendered NOWHERE, with this exact suite fully green throughout.
  {
    const realShapedPanels = [
      ['bloom-panel', { zone: 'workshop', effect: 'bloom', order: 80 }],
      ['water-panel', { zone: 'workshop', effect: 'water', order: 30 }],
      ['astrolabe', { zone: 'bridge', order: -1 }], // the one panel with no `effect` — never broken
    ];
    const workshop = sortPanelsForZone(realShapedPanels, 'workshop').map(([id]) => id);
    ok(
      'a panel declaring BOTH zone and effect still renders in its zone — THE ACTUAL LIVE BUG',
      workshop.join(',') === 'water-panel,bloom-panel'
    );
    ok(
      'declaring `effect` does not evict a panel from its declared zone',
      workshop.includes('bloom-panel') && workshop.includes('water-panel')
    );
    const bridge = sortPanelsForZone(realShapedPanels, 'bridge').map(([id]) => id);
    ok('a panel with no effect at all is unaffected either way', bridge.join(',') === 'astrolabe');
  }

  // --- createSectionStore: what survives the panel's full rebuild -----------
  // debug-panel.js's renderBody() does `innerHTML = ''` on every registration and
  // every refreshControls(), so a `<details open>` attribute cannot persist —
  // opening Advanced and then picking a preset used to slam it shut. The store is
  // module-scope precisely because module scope outlives the DOM.
  {
    const s = createSectionStore();
    ok('a section starts closed', s.isOpen('specular') === false);
    s.setOpen('specular', true);
    ok('opening is remembered', s.isOpen('specular') === true);

    // THE INVARIANT THAT MATTERS: one key per card. Two cards sharing an open
    // state would look like a card opening itself, which is why buildEffectCard
    // throws on a missing id rather than defaulting one.
    ok('a different card is unaffected', s.isOpen('water') === false);
    ok("a card's Advanced is independent of the card itself", s.isOpen('specular:advanced') === false);
    s.setOpen('specular:advanced', true);
    ok('both can be open at once', s.isOpen('specular') && s.isOpen('specular:advanced'));

    s.setOpen('specular', false);
    ok('closing the card leaves its Advanced state alone', s.isOpen('specular:advanced') === true);
    ok('closing is remembered', s.isOpen('specular') === false);
    ok('keys() reports exactly what is open, sorted', s.keys().join(',') === 'specular:advanced');

    ok('two stores never share state', createSectionStore().isOpen('specular:advanced') === false);
    ok('an unknown key is closed, never undefined', s.isOpen('never-registered') === false);
  }

  // --- collapsedStatusLine: the one line you read on a folded card ----------
  // Formatting is where lying instruments are born: "0 candles" and "no candles
  // placed yet" are different claims, and an absent value must produce SILENCE
  // rather than the string "undefined" sitting in the header.
  ok('no information at all yields an empty line', collapsedStatusLine() === '');
  ok('an empty argument object yields an empty line', collapsedStatusLine({}) === '');
  ok('disabled reads "off"', collapsedStatusLine({ enabled: false }) === 'off');
  ok(
    'disabled beats every other fact — an off effect has nothing else to say',
    collapsedStatusLine({ enabled: false, count: 7, noun: 'candle', missing: 'mask' }) === 'off'
  );
  ok(
    'a missing prerequisite is named',
    collapsedStatusLine({ enabled: true, missing: '_Specular mask on this floor' }) ===
      'no _Specular mask on this floor'
  );
  ok('one instance is singular', collapsedStatusLine({ enabled: true, count: 1, noun: 'candle' }) === '1 candle');
  ok('many instances are plural', collapsedStatusLine({ enabled: true, count: 3, noun: 'candle' }) === '3 candles');
  ok(
    'zero instances reads as "none yet", not "0"',
    collapsedStatusLine({ enabled: true, count: 0, noun: 'candle' }) === 'no candles placed yet'
  );
  ok('a count with no noun says nothing rather than guessing', collapsedStatusLine({ count: 3 }) === '');
  ok('a noun with no count says nothing', collapsedStatusLine({ noun: 'candle' }) === '');
  ok('a non-finite count is not rendered', collapsedStatusLine({ count: NaN, noun: 'candle' }) === '');
  ok('an empty missing string is not rendered as "no "', collapsedStatusLine({ missing: '' }) === '');
  ok('enabled true alone is silent — "on" is what the checkbox says', collapsedStatusLine({ enabled: true }) === '');

  // --- the fixed order is stable and Light is a first-class category -------
  ok('CATEGORY_ORDER is frozen (data, not mutable state)', Object.isFrozen(CATEGORY_ORDER));
  ok('Light rides alongside the Effects-UI.md set', CATEGORY_ORDER.includes('Light'));
  ok(
    'the canonical order runs surface → emission → behaviour → size → couplings → machinery',
    CATEGORY_ORDER.join(',') === 'Presence,Look,Detail,Light,Motion,Shape,Extent,Outdoor,Response,Technical'
  );
  // Every category a shipped effect actually declares must be IN the list, or
  // groupParamsByCategory silently sweeps those params into Technical and the
  // panel contradicts the declaration — which is how Detail/Shape/Outdoor were
  // being lost until 2026-07-27, with all their own tests still green.
  for (const c of ['Detail', 'Shape', 'Outdoor']) {
    ok(`${c} is a real category, not silently swept into Technical`, CATEGORY_ORDER.includes(c));
  }

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
