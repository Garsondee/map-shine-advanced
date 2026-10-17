/**
 * The registration is where a resolved cascade becomes the seam the viewer reads. The bug class it
 * guards is the quiet one this codebase has already paid for twice: a field (the tier, the mask)
 * that is computed upstream and simply never makes it into `getRenderState()`, so a control does
 * nothing and every Node test is green. So these tests drive the REAL factory with a stub registry
 * and check what comes out the far end.
 */
import { createCritterRegistration } from '../critter-registration.js';

function build(overrides = {}) {
  const spy = {
    applies: {},
    resolved: [],
    writes: [],
    sceneWrites: [],
    errors: [],
    warns: [],
    maskCalls: [],
    layers: [],
  };
  const grids = { flies: { tag: 'flies-grid' }, fireflies: { tag: 'fireflies-grid' } };
  const api = createCritterRegistration({
    effectRegistry: {
      register(manifest, apply) {
        spy.applies[manifest.id] = apply;
      },
      resolveAndApply(id, layers) {
        spy.resolved.push(id);
        spy.layers.push(layers);
      },
    },
    deriveEffectLayers: (id) => ({ id }),
    readSetting: () => undefined,
    writeSetting: (moduleId, key, value) => {
      spy.writes.push({ moduleId, key, value });
      return Promise.resolve();
    },
    moduleId: 'map-shine-advanced',
    effectEnableKey: (id, scope) => `${id}.${scope}.enabled`,
    readSceneEffectParams: () => ({ params: { fliesPerZone: 99 }, reason: null }),
    writeSceneEffectParams: (id, patch) => {
      spy.sceneWrites.push({ id, patch });
      return Promise.resolve({ ok: true, reason: null });
    },
    log: {
      error: (...a) => spy.errors.push(a.join(' ')),
      warn: (...a) => spy.warns.push(a.join(' ')),
    },
    getMaskGrid: (kind, floor) => {
      spy.maskCalls.push([kind, floor]);
      return grids[kind] ?? null;
    },
    getFloorContext: () => ({ floorIndex: 2, elevation: 40 }),
    getMaskVersion: () => 7,
    getGridPx: () => 140,
    ...overrides,
  });
  return { api, spy };
}

const settle = () => new Promise((r) => setTimeout(r, 0));

export async function run(t) {
  const { api, spy } = build();

  // ---- both effects register themselves --------------------------------------------------------
  t.ok(
    'registers both manifests with the cascade',
    typeof spy.applies.smellyFlies === 'function' && typeof spy.applies.fireflies === 'function'
  );
  t.ok(
    'before the first resolve both read as off',
    api.smellyFlies.getReadout().enabled === false && api.fireflies.getReadout().enabled === false
  );
  t.ok(
    '…and an effect that is off asks the mask authority nothing',
    (() => {
      const s = api.smellyFlies.getRenderState();
      return s.maskGrid === null && spy.maskCalls.length === 0;
    })()
  );

  // ---- THE TIER AND THE PARAMS SURVIVE THE ROUND TRIP -----------------------------------------
  spy.applies.smellyFlies({
    enabled: true,
    params: { fliesPerZone: 12 },
    perfTier: 4,
    maxPerfTier: 4,
    perfTierSource: 'profile',
  });
  const s = api.smellyFlies.getRenderState();
  t.ok('perfTier reaches the render seam (the bug specular, window and fluid all shipped with)', s.perfTier === 4);
  t.ok('resolved params reach the render seam', s.params.fliesPerZone === 12 && s.enabled === true);
  t.ok('the viewed floor and its ground elevation are served', s.floorIndex === 2 && s.elevation === 40);
  t.ok('the grid size is served (it sizes "a swarm of reference size")', s.gridPx === 140);
  t.ok('the mask version is served (the subsystem gates its rebuild on it)', s.maskVersion === 7);
  t.ok(
    'the painted grid for THIS effect’s kind on THE VIEWED floor is served',
    s.maskGrid?.tag === 'flies-grid' && spy.maskCalls.at(-1)[0] === 'flies' && spy.maskCalls.at(-1)[1] === 2
  );
  t.ok(
    'the readout keeps the tier metadata the card shows',
    api.smellyFlies.getReadout().maxPerfTier === 4 && api.smellyFlies.getReadout().perfTierSource === 'profile'
  );

  spy.applies.fireflies({ enabled: true, params: { countPerZone: 5 }, perfTier: 1 });
  const f = api.fireflies.getRenderState();
  t.ok(
    'fireflies read their OWN mask kind',
    f.maskGrid?.tag === 'fireflies-grid' && spy.maskCalls.at(-1)[0] === 'fireflies'
  );
  t.ok('the two effects do not share a readout', f.perfTier === 1 && api.smellyFlies.getRenderState().perfTier === 4);
  t.ok('hasPaint reflects the mask authority', api.fireflies.hasPaint() === true);
  const none = build({ getMaskGrid: () => null });
  t.ok('hasPaint is false when nothing is painted', none.api.fireflies.hasPaint() === false);
  none.spy.applies.fireflies({ enabled: true, params: {}, perfTier: 2 });
  t.ok('…and the seam carries a null grid, not a throw', none.api.fireflies.getRenderState().maskGrid === null);

  // ---- the console setter ---------------------------------------------------------------------
  const live = api.smellyFlies.set({ fliesPerZone: 20, tint: '#aabbcc' });
  t.ok('set() returns the live override', live.fliesPerZone === 20 && live.tint === '#aabbcc');
  t.ok('it re-resolves the cascade', spy.resolved.includes('smellyFlies'));
  const layers = spy.layers.at(-1);
  t.ok(
    'the override sits ABOVE the scene’s own authored params (highest precedence)',
    layers.paramLayers.length === 2 &&
      layers.paramLayers[0].fliesPerZone === 99 &&
      layers.paramLayers[1].fliesPerZone === 20
  );
  await settle();
  t.ok(
    'the change is written through to the scene’s own params',
    spy.sceneWrites.at(-1)?.id === 'smellyFlies' && spy.sceneWrites.at(-1).patch.fliesPerZone === 20
  );

  const before = spy.sceneWrites.length;
  api.smellyFlies.set({ definitelyNotAParam: 3 });
  t.ok(
    'an unknown key is an error, not a silent no-op',
    spy.errors.length === 1 && /definitelyNotAParam/.test(spy.errors[0])
  );
  t.ok('…and writes nothing', spy.sceneWrites.length === before);
  t.ok(
    'a partial with a bad key and a good key still applies the good one',
    (() => {
      const out = api.smellyFlies.set({ nope: 1, buzz: 900 });
      return out.buzz === 900 && !('nope' in out);
    })()
  );

  api.fireflies.set({ enabled: false });
  await settle();
  t.ok(
    '`enabled` writes the PLAYER setting, not a scene param',
    spy.writes.at(-1)?.key === 'fireflies.player.enabled' && spy.writes.at(-1).value === 'off'
  );
  t.ok('…and does not touch the scene params', !spy.sceneWrites.some((w) => w.id === 'fireflies'));
  api.fireflies.set({ enabled: true });
  await settle();
  t.ok('enabling writes "on"', spy.writes.at(-1).value === 'on');

  // a client-scoped param would not be written to the scene; the schemas declare none today, so assert the contract holds
  t.ok(
    'reapply() is callable and re-resolves',
    (() => {
      const n = spy.resolved.length;
      api.fireflies.reapply();
      return spy.resolved.length === n + 1 && spy.resolved.at(-1) === 'fireflies';
    })()
  );
}
