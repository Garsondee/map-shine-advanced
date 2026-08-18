/**
 * param-groups.js — category grouping/ordering, the FOH/ROH partition,
 * disclosure open/close persistence, collapsed-card status text, and the
 * copy-button payload shape. All pure; the card shells that consume these
 * (diag/effect-controls.js's buildEffectCard today, the Studio's own EFFECTS
 * department shell from U1 on) are DOM and browser-verified live.
 *
 * Moved verbatim from diag/__tests__/effect-controls.test.mjs at U0
 * (docs/holy/UI-Testament.md §9) alongside the logic itself.
 */
import {
  CATEGORY_ORDER,
  groupParamsByCategory,
  rohGroups,
  createSectionStore,
  collapsedStatusLine,
  buildSettingsSnapshot,
} from '../param-groups.js';

export function run(t) {
  const { ok } = t;

  // --- createSectionStore: what survives a card shell's full rebuild --------
  // A shell whose body does `innerHTML = ''` on every registration/refresh
  // cannot rely on `<details open>` persisting — opening "Advanced" and then
  // picking a preset used to slam it shut. The store is module-scope
  // precisely because module scope outlives the DOM.
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
    CATEGORY_ORDER.join(',') ===
      'Presence,Look,Detail,Flame,Ember,Smoke,Light,Motion,Depth,Shape,Extent,Outdoor,Response,Technical'
  );
  // ⚠️ Flame/Ember/Smoke/Depth added 2026-08-09 for fire's particle rebuild, and
  // placed by MEANING rather than appended: the three bodies are SURFACE groups
  // so they sit with Look/Detail, and Depth is a BEHAVIOUR so it sits with
  // Motion. Appending them after Technical would have kept this assertion green
  // while putting the fire's own controls after the machinery block in every
  // panel — the canonical run is the thing being pinned, not the string.
  for (const c of ['Flame', 'Ember', 'Smoke', 'Depth']) {
    ok(`${c} is a real category, not silently swept into Technical`, CATEGORY_ORDER.includes(c));
  }
  ok(
    'the three body groups stay inside the surface block, before Light',
    CATEGORY_ORDER.indexOf('Smoke') < CATEGORY_ORDER.indexOf('Light')
  );
  ok(
    'Depth sits with behaviour, after Motion and before size',
    CATEGORY_ORDER.indexOf('Depth') > CATEGORY_ORDER.indexOf('Motion') &&
      CATEGORY_ORDER.indexOf('Depth') < CATEGORY_ORDER.indexOf('Shape')
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

  // --- buildSettingsSnapshot: the copy-button payload ------------------------
  {
    const schema = {
      flameCount: { type: 'float', category: 'Flame' },
      color: { type: 'color', category: 'Look' },
    };
    const values = { flameCount: 47, color: '#fdba35' };
    const getValue = (k) => values[k];

    const snap = buildSettingsSnapshot({ id: 'fire', title: 'Fire', enabled: true, schema, getValue });
    ok('the effect id rides through', snap.effect === 'fire');
    ok('the title rides through', snap.title === 'Fire');
    ok('enabled rides through', snap.enabled === true);
    ok(
      'every schema key is captured, not just a curated subset',
      snap.values.flameCount === 47 && snap.values.color === '#fdba35'
    );
    ok('the payload is JSON-safe (round-trips)', JSON.parse(JSON.stringify(snap)).values.flameCount === 47);

    const noTitle = buildSettingsSnapshot({ id: 'water', schema: {}, getValue: () => null });
    ok('a missing title falls back to the id', noTitle.title === 'water');
    ok('an empty schema yields an empty values object, not a throw', Object.keys(noTitle.values).length === 0);

    const noEnabled = buildSettingsSnapshot({ id: 'x', schema: {}, getValue: () => null });
    ok('enabled is OMITTED (not `false`) when the caller has no concept of it', !('enabled' in noEnabled));
    const explicitlyOff = buildSettingsSnapshot({ id: 'x', enabled: false, schema: {}, getValue: () => null });
    ok('an explicit `false` is kept, not treated as absent', explicitlyOff.enabled === false);
  }

  // --- THE COPY BUTTON MUST REPORT LIVE STATE (2026-08-17) ------------------
  // The regression this pins is `feedback_instruments_must_not_lie` in its most
  // expensive form: not a crash, not an empty result, but a CONFIDENT WRONG
  // ANSWER. Every boot.js panel did `const readout = effect.getReadout()` and
  // closed `getValue` over that object; a cascade resolve replaces the readout
  // wholesale, and nothing calls `refreshControls()` on a param change — so the
  // export froze at card-build time while the sliders (whose `<input>` holds the
  // dragged value in its own native DOM state) went on showing the truth. The
  // author pasted a flawless set of schema defaults in good faith and lost a
  // round trip to it.
  //
  // `buildSettingsSnapshot` is pure, so what is testable here is precisely the
  // contract that broke: it must read THROUGH `getValue` at CALL time, never
  // pre-read or memoise. The two cases below are the captured-vs-live pair — the
  // first reproduces the bug's mechanism exactly and must show the STALE value,
  // proving this test can actually see the fault (a non-vacuity guard); the
  // second is the fix's shape and must show the live one.
  {
    const schema = { opacity: { type: 'float', category: 'Look' } };
    let live = { params: { opacity: 0.62 } }; // what the card was built with

    // ⛔ THE BUG'S OWN SHAPE: the readout captured once, up front.
    const captured = live;
    const staleGetValue = (id) => captured.params?.[id] ?? 'DEFAULT';
    // ✅ THE FIX'S SHAPE: an accessor, resolved per call.
    const readLive = () => live;
    const liveGetValue = (id) => readLive().params?.[id] ?? 'DEFAULT';

    // The author drags a slider; the cascade resolves and REPLACES the object.
    live = { params: { opacity: 1 } };

    const staleSnap = buildSettingsSnapshot({ id: 'water', schema, getValue: staleGetValue });
    const liveSnap = buildSettingsSnapshot({ id: 'water', schema, getValue: liveGetValue });

    ok(
      'the detector is not vacuous — a CAPTURED readout genuinely still exports the stale value',
      staleSnap.values.opacity === 0.62
    );
    ok('...while an ACCESSOR exports what the author actually set', liveSnap.values.opacity === 1);
    ok('the two disagree, which is the whole bug in one line', staleSnap.values.opacity !== liveSnap.values.opacity);
  }
}
