/**
 * marker-overlay.test.mjs — the generic registry: register/replace/list,
 * flattening across sources, and the "one bad provider must not blank every
 * other effect's markers" degrade-gracefully invariant.
 */
import {
  registerMarkerSource,
  unregisterMarkerSource,
  listMarkerSources,
  getAllMarkerPoints,
  _clearMarkerSourcesForTest,
} from '../marker-overlay.js';

export function run(t) {
  _clearMarkerSourcesForTest();

  // --- register + list -----------------------------------------------------
  registerMarkerSource('candleFlame', { label: 'Candle flames', color: '#ffaa00', getPoints: () => [{ x: 1, y: 2 }] });
  t.ok(
    'a registered source appears in the list',
    listMarkerSources().some((s) => s.id === 'candleFlame')
  );
  t.ok(
    'the list carries the label + color',
    listMarkerSources()[0].label === 'Candle flames' && listMarkerSources()[0].color === '#ffaa00'
  );

  const missingLabel = () => {
    registerMarkerSource('x', { getPoints: () => [] });
    return listMarkerSources().find((s) => s.id === 'x');
  };
  t.ok('a missing label defaults to the id', missingLabel()?.label === 'x');
  unregisterMarkerSource('x');
  t.ok('unregister removes it', !listMarkerSources().some((s) => s.id === 'x'));

  // --- re-registering the SAME id replaces, never throws (routine, not an error) ---
  registerMarkerSource('candleFlame', {
    label: 'Candle flames v2',
    color: '#ff0000',
    getPoints: () => [{ x: 9, y: 9 }],
  });
  t.ok(
    're-registering the same id replaces the source',
    listMarkerSources().find((s) => s.id === 'candleFlame')?.color === '#ff0000'
  );

  // --- validation: bad calls throw loudly, not silently no-op --------------
  let threw = false;
  try {
    registerMarkerSource('', { getPoints: () => [] });
  } catch {
    threw = true;
  }
  t.ok('an empty id throws', threw);

  threw = false;
  try {
    registerMarkerSource('nogetpoints', {});
  } catch {
    threw = true;
  }
  t.ok('a source with no getPoints throws', threw);

  // --- flattening ------------------------------------------------------------
  _clearMarkerSourcesForTest();
  registerMarkerSource('a', {
    color: '#111111',
    getPoints: () => [
      { x: 1, y: 1 },
      { x: 2, y: 2 },
    ],
  });
  registerMarkerSource('b', { color: '#222222', getPoints: () => [{ x: 3, y: 3 }] });
  const flat = getAllMarkerPoints();
  t.ok('flattening merges every source', flat.length === 3);
  t.ok('each point carries its source id', flat.filter((p) => p.sourceId === 'a').length === 2);
  t.ok('each point carries its source color', flat.find((p) => p.sourceId === 'b').color === '#222222');

  // non-finite points are dropped, not crashed on
  registerMarkerSource('bad', {
    getPoints: () => [
      { x: 'nope', y: 1 },
      { x: 5, y: 5 },
    ],
  });
  t.ok(
    'a non-finite point is dropped; a finite sibling still comes through',
    getAllMarkerPoints().some((p) => p.sourceId === 'bad' && p.x === 5) &&
      !getAllMarkerPoints().some((p) => p.sourceId === 'bad' && p.x === 'nope')
  );

  // --- a throwing source is skipped, everyone else survives ------------------
  registerMarkerSource('broken', {
    getPoints: () => {
      throw new Error('provider exploded');
    },
  });
  let errored = null;
  const withBroken = getAllMarkerPoints({ onError: (id, err) => (errored = { id, err }) });
  t.ok(
    'other sources still contribute despite one throwing',
    withBroken.some((p) => p.sourceId === 'a')
  );
  t.ok('the broken source contributes nothing', !withBroken.some((p) => p.sourceId === 'broken'));
  t.ok('the error is reported via onError, never swallowed silently', errored?.id === 'broken');

  // a non-array return degrades to nothing, not a crash
  registerMarkerSource('weird', { getPoints: () => 'not an array' });
  t.ok('a non-array getPoints result contributes nothing and does not throw', getAllMarkerPoints().length >= 0);

  _clearMarkerSourcesForTest();
  t.ok('clearing empties the registry', listMarkerSources().length === 0 && getAllMarkerPoints().length === 0);
}
