/**
 * Node verification for foundry/region-darkness-override.js: the pure "which
 * regions count" rule, the settings round-trip (against a fake `game` global,
 * same double `settings-adapter.test.mjs` uses), and — since 2026-11-09 — the
 * live apply/restore against stand-in `game`/`canvas` globals holding plain
 * scene/region/behaviour objects (enough of the Document API: `flags`,
 * `getFlag`, `update` with dotted keys and a deletion operator).
 *
 * The 2026-11-09 decision (mmp-6pc.3): OFF by default; never rewrite a scene
 * flagged `regionDarknessAuthored`; every darkening behaviour of a Region, not
 * just the first; and an explicit GM restore of the stashed originals.
 *
 * Namespace import, so this file still runs against an older module (the proof
 * that these tests fail on the old code): a missing export is a failed check.
 */
import * as RO from '../region-darkness-override.js';

const NS = 'map-shine-advanced';
const STASH = 'regionDarknessOverrideOriginal';

function fakeGame({ isGM = true, scenes = [] } = {}) {
  const registered = [];
  const store = {};
  return {
    registered,
    store,
    user: { isGM },
    scenes,
    settings: {
      register(namespace, key, data) {
        registered.push({ namespace, key, data });
        store[`${namespace}.${key}`] = data.default;
      },
      get(namespace, key) {
        const k = `${namespace}.${key}`;
        if (!(k in store)) throw new Error(`setting "${k}" was never registered`);
        return store[k];
      },
      set(namespace, key, value) {
        store[`${namespace}.${key}`] = value;
        return Promise.resolve(value);
      },
    },
  };
}

/** Is `v` a deletion operator (the real ForcedDeletion class when one is installed for the test)? */
const isDeletion = (v) => {
  const Del = globalThis.foundry?.data?.operators?.ForcedDeletion;
  return typeof Del === 'function' && v instanceof Del;
};

/** Apply a dotted-key update the way Foundry would, enough for these tests. */
function applyDotted(doc, payload) {
  for (const [key, value] of Object.entries(payload)) {
    const parts = key.split('.');
    let last = parts.pop();
    let node = doc;
    for (const p of parts) {
      if (!node[p] || typeof node[p] !== 'object') node[p] = {};
      node = node[p];
    }
    if (last.startsWith('-=')) {
      last = last.slice(2);
      delete node[last];
    } else if (isDeletion(value)) delete node[last];
    else node[last] = value;
  }
}

function behavior(id, mode, modifier, { type = 'adjustDarknessLevel', disabled = false, stash } = {}) {
  const b = {
    id,
    type,
    disabled,
    system: { mode, modifier },
    flags: stash ? { [NS]: { [STASH]: stash } } : {},
    writes: 0,
    getFlag(scope, key) {
      return this.flags?.[scope]?.[key];
    },
    async update(payload) {
      applyDotted(this, payload);
      this.writes += 1;
      return this;
    },
  };
  return b;
}
const SHAPES = [{ type: 'rectangle', x: 0, y: 0, width: 10, height: 10 }];
const region = (id, behaviors, { hidden = false, shapes = SHAPES } = {}) => ({ id, hidden, shapes, behaviors });
const scene = (id, regions, flags = {}) => ({ id, name: id, regions, flags });
const state = (b) => `${b.system.mode} ${b.system.modifier}`;

/** A scene shaped like the lab's: a DARKEN room, a two-behaviour room, a lit foyer, a skylight, a hidden room. */
function labScene(id, flags) {
  return scene(
    id,
    [
      region('room', [behavior('a', 2, 0.4)]),
      region('dual', [behavior('b1', 0, 0.9), behavior('b2', 0, 0.4)]),
      region('foyer', [behavior('c', 0, 0)]),
      region('sky', [behavior('d', 1, 0.5)]),
      region('hidden', [behavior('e', 2, 0.5)], { hidden: true }),
    ],
    flags
  );
}
const behaviorsOf = (s) => Object.fromEntries(s.regions.flatMap((r) => r.behaviors).map((b) => [b.id, b]));

export async function run(t) {
  const { ok } = t;

  // ---- isDarkeningRegionBehavior — the pure "which regions count" rule ----
  ok('OVERRIDE with a positive modifier is darkening', RO.isDarkeningRegionBehavior(0, 0.75) === true);
  ok(
    'OVERRIDE with modifier 0 is NOT darkening (deliberately "always fully lit")',
    RO.isDarkeningRegionBehavior(0, 0) === false
  );
  ok('BRIGHTEN is never darkening, regardless of modifier', RO.isDarkeningRegionBehavior(1, 0.9) === false);
  ok('BRIGHTEN at modifier 0 is still never darkening', RO.isDarkeningRegionBehavior(1, 0) === false);
  ok('DARKEN is always darkening, even at a small modifier', RO.isDarkeningRegionBehavior(2, 0.01) === true);
  ok(
    'DARKEN at modifier 0 is still counted as darkening (mode alone decides)',
    RO.isDarkeningRegionBehavior(2, 0) === true
  );
  ok('an unrecognized mode is never guessed into "darkening"', RO.isDarkeningRegionBehavior(99, 0.9) === false);

  // Every global this touches is put back exactly as found (absent stays absent): the
  // foundry suites share one process.
  const saved = ['game', 'canvas', 'foundry'].map((k) => [k, Object.hasOwn(globalThis, k), globalThis[k]]);
  const realFoundry = globalThis.foundry;
  try {
    // ---- settings round-trip, against a fake `game` global -----------------
    globalThis.game = fakeGame();
    RO.registerRegionDarknessOverrideSettings();
    const [enabledCall, valueCall] = globalThis.game.registered;
    ok('both settings register at world scope', enabledCall.data.scope === 'world' && valueCall.data.scope === 'world');
    ok(
      "both settings are config:false — edited from the Studio card, not Foundry's settings sheet",
      enabledCall.data.config === false && valueCall.data.config === false
    );
    ok(
      'the toggle defaults to OFF — per-room darkness is judged scene by scene now (decision mmp-6pc.3, 2026-11-09)',
      enabledCall.data.default === false
    );
    ok(
      'the value defaults to 0.75, stored as a string (the settings adapter has no numeric kind)',
      valueCall.data.default === String(RO.DEFAULT_REGION_DARKNESS_OVERRIDE_VALUE)
    );

    const initial = RO.readRegionDarknessOverrideSettings();
    ok('read reflects the registered defaults (off, 0.75)', initial.enabled === false && initial.value === 0.75);

    await RO.writeRegionDarknessOverrideSettings({ value: 0.4 });
    const afterValueWrite = RO.readRegionDarknessOverrideSettings();
    ok(
      'a value-only write round-trips and leaves the (still-off) toggle untouched',
      afterValueWrite.enabled === false && afterValueWrite.value === 0.4
    );

    await RO.writeRegionDarknessOverrideSettings({ enabled: true });
    ok('a GM can explicitly turn the override on', RO.readRegionDarknessOverrideSettings().enabled === true);

    await RO.writeRegionDarknessOverrideSettings({ enabled: false });
    ok('...and back off again', RO.readRegionDarknessOverrideSettings().enabled === false);

    await RO.writeRegionDarknessOverrideSettings({ value: 5 });
    ok('an out-of-range value is clamped to 1 on write', RO.readRegionDarknessOverrideSettings().value === 1);

    await RO.writeRegionDarknessOverrideSettings({ value: -2 });
    ok('a negative value is clamped to 0 on write', RO.readRegionDarknessOverrideSettings().value === 0);

    const beforeNoopWrite = RO.readRegionDarknessOverrideSettings();
    await RO.writeRegionDarknessOverrideSettings({});
    ok(
      'a patch touching neither field leaves both settings unchanged',
      RO.readRegionDarknessOverrideSettings().enabled === beforeNoopWrite.enabled &&
        RO.readRegionDarknessOverrideSettings().value === beforeNoopWrite.value
    );

    // A read before registration (a wiring bug) falls back to OFF, never to rewriting scenes.
    globalThis.game = fakeGame();
    ok(
      'an unregistered read falls back to OFF (a wiring bug never rewrites a scene)',
      RO.readRegionDarknessOverrideSettings().enabled === false
    );

    // Foundry calls the registered onChange itself, after a value commits —
    // simulated the same way settings-adapter.test.mjs does for the adapter.
    globalThis.game = fakeGame();
    let calls = 0;
    RO.registerRegionDarknessOverrideSettings({ onChange: () => calls++ });
    globalThis.game.registered[0].data.onChange();
    ok('registering wires an onChange that fires on commit', calls === 1);

    // ---- apply: the live rewrite, on stand-in documents ---------------------
    const armed = async (opts) => {
      globalThis.game = fakeGame(opts);
      RO.registerRegionDarknessOverrideSettings();
      await RO.writeRegionDarknessOverrideSettings({ enabled: true, value: 0.9 });
    };
    {
      await armed();
      const s = labScene('plain');
      globalThis.canvas = { scene: s };
      const r = await RO.applyRegionDarknessOverride();
      const b = behaviorsOf(s);
      ok('apply on an unflagged scene succeeds', r.ok === true);
      ok('a DARKEN room is rewritten to OVERRIDE 0.9', state(b.a) === '0 0.9');
      ok(
        'its original {mode, modifier} is stashed',
        b.a.flags[NS]?.[STASH]?.mode === 2 && b.a.flags[NS][STASH].modifier === 0.4
      );
      ok(
        'EVERY darkening behaviour of a Region is rewritten, not just the first (its second, OVERRIDE .4, too)',
        state(b.b2) === '0 0.9' && b.b2.flags[NS]?.[STASH]?.modifier === 0.4
      );
      ok('a behaviour already at the value is not written again', b.b1.writes === 0 && b.b1.flags[NS] === undefined);
      ok('OVERRIDE 0 (a lit foyer) is untouched', state(b.c) === '0 0' && b.c.writes === 0);
      ok('BRIGHTEN (a skylight) is untouched', state(b.d) === '1 0.5' && b.d.writes === 0);
      ok('a hidden Region is untouched', state(b.e) === '2 0.5' && b.e.writes === 0);
      ok('the result counts the two writes', r.updated === 2);
      const again = await RO.applyRegionDarknessOverride();
      ok('a second apply writes nothing (idempotent)', again.updated === 0 && b.a.writes === 1);
    }
    {
      await armed();
      const s = labScene('tuned', { [NS]: { regionDarknessAuthored: true } });
      globalThis.canvas = { scene: s };
      const r = await RO.applyRegionDarknessOverride();
      const b = behaviorsOf(s);
      ok(
        'a scene flagged regionDarknessAuthored is NEVER rewritten, even with the override on',
        state(b.a) === '2 0.4' && state(b.b2) === '0 0.4' && Object.values(b).every((x) => x.writes === 0)
      );
      ok(
        '...and the result says why (ok, nothing updated, a reason)',
        r.ok === true && r.updated === 0 && /authored/i.test(String(r.reason))
      );
    }
    {
      await armed({ isGM: false });
      const s = labScene('player');
      globalThis.canvas = { scene: s };
      const r = await RO.applyRegionDarknessOverride();
      ok('a player client never writes', r.ok === false && Object.values(behaviorsOf(s)).every((x) => x.writes === 0));
    }
    {
      globalThis.game = fakeGame();
      RO.registerRegionDarknessOverrideSettings();
      const s = labScene('default');
      globalThis.canvas = { scene: s };
      const r = await RO.applyRegionDarknessOverride();
      ok(
        'with the shipped default (off) nothing is rewritten',
        Object.values(behaviorsOf(s)).every((x) => x.writes === 0) && r.updated === 0
      );
    }

    // ---- restore: the explicit GM command ------------------------------------
    ok('restoreRegionDarkness is exported', typeof RO.restoreRegionDarkness === 'function');
    if (typeof RO.restoreRegionDarkness === 'function') {
      {
        await armed();
        const s = labScene('viewed');
        globalThis.canvas = { scene: s };
        await RO.applyRegionDarknessOverride();
        await RO.writeRegionDarknessOverrideSettings({ enabled: false });
        const r = await RO.restoreRegionDarkness();
        const b = behaviorsOf(s);
        ok('restore puts the DARKEN room back', state(b.a) === '2 0.4');
        ok('restore puts the second behaviour back', state(b.b2) === '0 0.4');
        ok(
          'restore clears the stash (legacy -= key when no deletion operator exists)',
          b.a.flags[NS]?.[STASH] === undefined
        );
        ok('restore never touches a behaviour without a stash', b.b1.writes === 0 && state(b.b1) === '0 0.9');
        ok('restore reports what it did', r.ok === true && r.restored === 2 && r.scenes === 1 && !r.warning);
        const again = await RO.restoreRegionDarkness();
        ok('a second restore finds nothing to do', again.ok === true && again.restored === 0);
      }
      {
        // With Foundry's own deletion operator present (v14), that is what clears the stash.
        globalThis.foundry = { data: { operators: { ForcedDeletion: class ForcedDeletion {} } } };
        await armed();
        const s = labScene('v14');
        globalThis.canvas = { scene: s };
        await RO.applyRegionDarknessOverride();
        const r = await RO.restoreRegionDarkness();
        const b = behaviorsOf(s);
        ok(
          'v14: restore clears the stash with ForcedDeletion',
          state(b.a) === '2 0.4' && b.a.flags[NS]?.[STASH] === undefined
        );
        ok(
          'restore while the override is still ON warns that the next view rewrites again',
          r.restored === 2 && typeof r.warning === 'string' && r.warning.length > 0
        );
        globalThis.foundry = realFoundry;
      }
      {
        // {all: true}: every scene; a scene flagged authored is kept unless asked.
        await armed();
        const one = labScene('one');
        const two = labScene('two', { [NS]: { regionDarknessAuthored: true } });
        for (const s of [one, two]) {
          globalThis.canvas = { scene: s };
          // `two` is flagged, so apply skips it: stash it by hand, as an old rewrite would have left it
          if (s === two) {
            const b = behaviorsOf(two).a;
            b.flags = { [NS]: { [STASH]: { mode: 2, modifier: 0.4 } } };
            b.system = { mode: 0, modifier: 0.9 };
          } else await RO.applyRegionDarknessOverride();
        }
        globalThis.game.scenes = [one, two];
        globalThis.canvas = { scene: null };
        const viewedNone = await RO.restoreRegionDarkness();
        ok(
          'no viewed scene and no {all}: nothing done, with a reason',
          viewedNone.restored === 0 && !!viewedNone.reason
        );
        const r = await RO.restoreRegionDarkness({ all: true });
        ok('{all: true} restores every unflagged scene', state(behaviorsOf(one).a) === '2 0.4' && r.restored === 2);
        ok(
          '...and keeps a scene flagged regionDarknessAuthored (its rooms were set one by one), naming it',
          state(behaviorsOf(two).a) === '0 0.9' && Array.isArray(r.skippedAuthored) && r.skippedAuthored.includes('two')
        );
        const r2 = await RO.restoreRegionDarkness({ all: true, includeAuthored: true });
        ok(
          'includeAuthored restores the flagged scene too',
          state(behaviorsOf(two).a) === '2 0.4' && r2.restored === 1
        );
      }
      {
        await armed({ isGM: false });
        const s = labScene('player2');
        const b = behaviorsOf(s).a;
        b.flags = { [NS]: { [STASH]: { mode: 2, modifier: 0.4 } } };
        b.system = { mode: 0, modifier: 0.9 };
        globalThis.canvas = { scene: s };
        const r = await RO.restoreRegionDarkness();
        ok('restore is GM-only: a player client writes nothing', r.ok === false && b.writes === 0);
      }
    }
  } finally {
    for (const [k, had, v] of saved) {
      if (had) globalThis[k] = v;
      else delete globalThis[k];
    }
  }
}
