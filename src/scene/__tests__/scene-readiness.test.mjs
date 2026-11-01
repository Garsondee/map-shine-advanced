/**
 * scene-readiness.js — the three-state per-floor model behind the Remote's
 * Scene readiness card. "Couldn't check" must never read as "missing", and
 * neither may ever read as "ready".
 */
import { buildSceneReadiness, shouldAutoOpen, requiredKinds, suffixOf } from '../scene-readiness.js';

const floor = (over = {}) => ({
  index: 0,
  id: 'L0',
  name: 'Ground',
  hostItemIds: ['bg0'],
  artSrc: 'maps/town.webp',
  requiredMissing: [],
  found: new Map(),
  ...over,
});

export function run(t) {
  const req = requiredKinds();
  t.ok('outdoors is the required kind', req.length === 1 && req[0].id === 'outdoors');
  const outSuffix = suffixOf('outdoors');

  {
    const r = buildSceneReadiness({ floors: [floor()], discovery: null });
    t.ok('not checked yet: not ready, no rows', !r.checked && !r.ready && r.floors.length === 0);
    t.ok('not checked never auto-opens', !shouldAutoOpen(r, { snoozed: false }));
  }
  {
    const r = buildSceneReadiness({ floors: [floor()], discovery: { method: 'listing', failures: [] } });
    t.ok('all found: ready', r.checked && r.ready && r.floors[0].status === 'ready');
    t.ok('ready never auto-opens', !shouldAutoOpen(r, { snoozed: false }));
  }
  {
    const r = buildSceneReadiness({
      floors: [floor({ requiredMissing: ['outdoors'] })],
      discovery: { method: 'listing', failures: [] },
    });
    t.ok('listed and absent: missing', r.floors[0].status === 'missing' && !r.ready);
    t.ok(
      'missing names the suffix',
      r.floors[0].missingSuffixes[0] === outSuffix && r.floors[0].detail.includes(outSuffix)
    );
    t.ok('single-floor headline', r.headline.startsWith('This map needs'));
    t.ok('missing auto-opens', shouldAutoOpen(r, { snoozed: false }));
    t.ok('snoozed does not', !shouldAutoOpen(r, { snoozed: true }));
  }
  {
    const r = buildSceneReadiness({
      floors: [floor({ requiredMissing: ['outdoors'] })],
      discovery: { method: 'none', failures: [{ targetId: 'bg0', stage: 'listing', detail: 'denied' }] },
    });
    t.ok('could not list, did not probe: unknown', r.floors[0].status === 'unknown');
    t.ok('unknown says so', /Couldn't check/.test(r.floors[0].detail));
  }
  {
    const r = buildSceneReadiness({
      floors: [floor({ requiredMissing: ['outdoors'] })],
      discovery: { method: 'probe', failures: [{ targetId: 'bg0', stage: 'listing', detail: 'denied' }] },
    });
    t.ok(
      'could not list but probed: missing, with the caveat',
      r.floors[0].status === 'missing' && /guessed/.test(r.floors[0].detail)
    );
  }
  {
    const r = buildSceneReadiness({
      floors: [floor(), floor({ index: 1, id: 'L1', name: '', hostItemIds: ['bg1'], requiredMissing: ['outdoors'] })],
      discovery: { method: 'listing', failures: [] },
    });
    t.ok('two floors, one missing', !r.ready && r.floors[0].status === 'ready' && r.floors[1].status === 'missing');
    t.ok('multi-floor headline counts', r.headline.startsWith('1 of 2 floors'));
    t.ok('nameless floor gets a number', r.floors[1].name === 'Floor 2');
  }
  {
    const r = buildSceneReadiness({
      floors: [floor({ hostItemIds: [], artSrc: null, requiredMissing: ['outdoors'] })],
      discovery: { method: 'listing', failures: [] },
    });
    t.ok(
      'no art at all: missing with its own words',
      r.floors[0].status === 'missing' && /no map art/.test(r.floors[0].detail)
    );
  }
  {
    const found = new Map([['fire', 'maps/town_x.webp']]);
    const r = buildSceneReadiness({ floors: [floor({ found })], discovery: { method: 'listing', failures: [] } });
    t.ok('optional masks it has are listed', r.floors[0].hasOptional.includes(suffixOf('fire')));
  }
  {
    const r = buildSceneReadiness({ floors: [], discovery: { method: 'listing', failures: [] } });
    t.ok('no floors: not ready, says so', !r.ready && /no floors/.test(r.headline));
  }
}
