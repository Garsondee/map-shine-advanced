/**
 * settings-adapter-cache.test.mjs - the read cache in `readSetting` (frame-rate round, 2026-11-02).
 *
 * Foundry v14's `game.settings.get` builds a whole `Setting` document (a DataModel: clean + validate) on EVERY call for a
 * client-scope setting, and for a world/user setting that was never saved. The engine reads settings from the frame loop,
 * so a still Big Bank scene spent ~2% of its main thread constructing documents to read the same few values. `readSetting`
 * now answers from a cache that cannot go stale: a client setting is keyed on the raw string in localStorage (the only
 * input Foundry's own `get` has besides the registered default), an unsaved world setting on "no document exists" plus the
 * default. The double below mirrors the parts of `ClientSettings` the adapter touches and COUNTS the document builds.
 */
import { readSetting } from '../settings-adapter.js';

function fakeFoundry() {
  const registry = new Map();
  const local = new Map();
  const worldDocs = new Map();
  const counts = { builds: 0 };
  const localStorage = { getItem: (k) => (local.has(k) ? local.get(k) : null), setItem: (k, v) => local.set(k, String(v)) };
  const world = { getSetting: (id) => worldDocs.get(id) };
  const settings = {
    settings: registry,
    storage: new Map([
      ['client', localStorage],
      ['world', world],
      ['user', world],
    ]),
    // Foundry's `get`, with the cost modelled as a counter.
    get(namespace, key) {
      const id = `${namespace}.${key}`;
      const reg = registry.get(id);
      if (!reg) throw new Error(`"${id}" is not a registered game setting`);
      if (reg.scope === 'client') {
        counts.builds++;
        const raw = localStorage.getItem(id);
        return raw === null ? reg.default : JSON.parse(raw);
      }
      const doc = worldDocs.get(id);
      if (doc) return doc.value;
      counts.builds++;
      return reg.default;
    },
  };
  return {
    counts,
    local,
    worldDocs,
    registry,
    game: { settings, userId: 'u1' },
    register: (id, scope, def) => registry.set(id, { id, scope, default: def }),
  };
}

export function run(t) {
  const { ok, throws } = t;
  const realGame = globalThis.game;
  try {
    // --- client scope: keyed on the raw localStorage string ----------------------------------------------------------
    {
      const f = fakeFoundry();
      globalThis.game = f.game;
      f.register('msa.profile', 'client', 'standard');
      ok('first read of a client setting builds the document once and returns the default', readSetting('msa', 'profile') === 'standard' && f.counts.builds === 1);
      for (let i = 0; i < 50; i++) readSetting('msa', 'profile');
      ok('fifty more reads build nothing', f.counts.builds === 1);
      f.local.set('msa.profile', JSON.stringify('low'));
      ok('a changed raw value is seen on the very next read (no stale value)', readSetting('msa', 'profile') === 'low' && f.counts.builds === 2);
      ok('and is then cached again', readSetting('msa', 'profile') === 'low' && f.counts.builds === 2);
      f.local.set('msa.profile', JSON.stringify('standard'));
      ok('changing it back is seen too', readSetting('msa', 'profile') === 'standard');
      f.registry.get('msa.profile').default = 'high';
      f.local.delete('msa.profile');
      ok('a changed registered default invalidates it', readSetting('msa', 'profile') === 'high');
    }

    // --- booleans, numbers, falsy values: cached as the values they are ------------------------------------------------
    {
      const f = fakeFoundry();
      globalThis.game = f.game;
      f.register('msa.flag', 'client', false);
      f.register('msa.zero', 'client', 0);
      ok('false is returned, and cached (falsy is not "missing")', readSetting('msa', 'flag') === false && readSetting('msa', 'flag') === false && f.counts.builds === 1);
      ok('0 is returned, and cached', readSetting('msa', 'zero') === 0 && readSetting('msa', 'zero') === 0 && f.counts.builds === 2);
      f.local.set('msa.flag', 'true');
      ok('a falsy cached value flips to the new one', readSetting('msa', 'flag') === true);
    }

    // --- object values are never shared: Foundry hands each caller a fresh one ------------------------------------------
    {
      const f = fakeFoundry();
      globalThis.game = f.game;
      f.register('msa.blob', 'client', null);
      f.local.set('msa.blob', JSON.stringify({ a: 1 }));
      const a = readSetting('msa', 'blob');
      a.a = 99;
      const b = readSetting('msa', 'blob');
      ok('an object setting is rebuilt per read, so one caller cannot corrupt another', b.a === 1 && a !== b && f.counts.builds === 2);
    }

    // --- world scope: a saved document is Foundry's own cheap lookup; an unsaved one is remembered -----------------------
    {
      const f = fakeFoundry();
      globalThis.game = f.game;
      f.register('msa.w', 'world', 'x');
      ok('an unsaved world setting returns its default', readSetting('msa', 'w') === 'x' && f.counts.builds === 1);
      for (let i = 0; i < 20; i++) readSetting('msa', 'w');
      ok('and builds nothing more while it stays unsaved', f.counts.builds === 1);
      f.worldDocs.set('msa.w', { value: 'saved' });
      ok('a document that appears is read through at once', readSetting('msa', 'w') === 'saved');
      f.worldDocs.set('msa.w', { value: 'changed' });
      ok('and follows its changes', readSetting('msa', 'w') === 'changed');
      f.worldDocs.delete('msa.w');
      ok('a deleted document falls back to the default', readSetting('msa', 'w') === 'x');
    }

    // --- failure stays loud ------------------------------------------------------------------------------------------------
    throws(
      'an unregistered key still throws through the adapter',
      () => {
        globalThis.game = fakeFoundry().game;
        readSetting('msa', 'nope');
      },
      'not a registered game setting'
    );
    // A host without the registry/storage (the older test double) is answered by `game.settings.get` alone.
    {
      globalThis.game = { settings: { get: (n, k) => `${n}.${k}` } };
      ok('a double with no registry falls back to game.settings.get', readSetting('msa', 'k') === 'msa.k');
    }
  } finally {
    globalThis.game = realGame;
  }
}
