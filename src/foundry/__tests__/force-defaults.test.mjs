/**
 * force-defaults.test.mjs — the "force defaults" world setting and the global reset.
 *
 * The registry half (a forced resolve ignores every stored layer) is pinned in
 * effects/__tests__/force-defaults-registry.test.mjs; this file pins what lives in Foundry's world:
 * the setting reads as "off" until it is registered, writes through, and the reset wipes exactly the
 * authored effect params (not the other flags), reports a scene that fails, and still clears the grid.
 */
import {
  registerForceDefaultsSettings,
  isForcingDefaults,
  writeForceDefaults,
  resetAllEffectSettings,
  FORCE_DEFAULTS_KEY,
} from '../force-defaults.js';
import { clearGridDefaults, readGridDefaults, writeGridDefaults } from '../grid-defaults-persistence.js';
import { registerGridDefaultsSettings } from '../grid-defaults-persistence.js';

function fakeGame() {
  const store = {};
  const hooks = [];
  return {
    store,
    hooks,
    settings: {
      register(ns, key, data) {
        store[`${ns}.${key}`] = data.default;
        if (data.onChange) hooks.push(data.onChange);
      },
      get(ns, key) {
        const k = `${ns}.${key}`;
        if (!(k in store)) throw new Error(`setting "${k}" was never registered`);
        return store[k];
      },
      async set(ns, key, value) {
        store[`${ns}.${key}`] = value;
        for (const h of hooks) h();
      },
    },
  };
}

function fakeScene(name, flags, { failOn = false } = {}) {
  const calls = [];
  return {
    name,
    flags,
    calls,
    getFlag: (_ns, key) => flags[key],
    async unsetFlag(_ns, key) {
      calls.push(key);
      if (failOn) throw new Error('locked');
      delete flags[key];
    },
  };
}

export async function run(t) {
  const { ok } = t;
  const realGame = globalThis.game;
  try {
    // ---- the setting ----
    delete globalThis.game;
    ok('with no game at all, forcing defaults reads as ON, the default (never a throw)', isForcingDefaults() === true);

    globalThis.game = fakeGame();
    ok('before the setting is registered, it reads as ON, the default', isForcingDefaults() === true);

    let changes = 0;
    registerForceDefaultsSettings({ onChange: () => (changes += 1) });
    ok('registered, it starts ON (one settings arrangement for every level)', isForcingDefaults() === true);
    ok(
      'it is a world-scope bool kept out of Foundry config',
      globalThis.game.store[`map-shine-advanced.${FORCE_DEFAULTS_KEY}`] === true
    );

    const on = await writeForceDefaults(true);
    ok('turning it on reports ok', on.ok === true && on.reason === null);
    ok('it reads ON afterwards', isForcingDefaults() === true);
    ok("the setting's onChange fired so every client re-resolves", changes === 1);
    await writeForceDefaults(false);
    ok('turning it off reads OFF again', isForcingDefaults() === false);
    ok('a truthy non-boolean never counts as ON', (await writeForceDefaults('yes')) && isForcingDefaults() === false);

    globalThis.game.settings.set = async () => {
      throw new Error('player cannot write world settings');
    };
    const denied = await writeForceDefaults(true);
    ok('a refused write is {ok:false, reason}, never a throw', denied.ok === false && /GM only/.test(denied.reason));

    // ---- the global reset ----
    const a = fakeScene('Tavern', { effectParams: { bloom: { strength: 2 } }, sky: { x: 1 } });
    const b = fakeScene('Docks', { effectParams: { water: { foam: 0.9 } } });
    const untouched = fakeScene('Bare', {});
    const sceneLocked = fakeScene('Locked', { effectParams: { fire: { a: 1 } } }, { failOn: true });
    let gridCleared = 0;
    const result = await resetAllEffectSettings({
      scenes: [a, b, untouched, sceneLocked],
      clearGrid: async () => {
        gridCleared += 1;
      },
    });
    ok('every scene is checked', result.scenesChecked === 4);
    ok('only scenes that had authored params are wiped', result.scenesWiped === 2);
    ok('the wiped scenes lose effectParams', !('effectParams' in a.flags) && !('effectParams' in b.flags));
    ok('other flags (sky) are left alone', a.flags.sky?.x === 1);
    ok('a scene with nothing authored is never written to', untouched.calls.length === 0);
    ok(
      'a failing scene is named in the failures',
      result.failures.some((f) => f.includes("'Locked'"))
    );
    ok('one failing scene does not stop the rest, and the result says ok:false', result.ok === false);
    ok('the grid look is cleared too', gridCleared === 1 && result.gridCleared === true);

    const gridFail = await resetAllEffectSettings({
      scenes: [],
      clearGrid: async () => {
        throw new Error('nope');
      },
    });
    ok('a grid failure is reported, not thrown', gridFail.ok === false && gridFail.gridCleared === false);
    const clean = await resetAllEffectSettings({ scenes: [a], clearGrid: async () => {} });
    ok('a clean reset is ok:true with no failures', clean.ok === true && clean.failures.length === 0);

    // ---- clearGridDefaults really empties (writeGridDefaults({}) would only merge) ----
    globalThis.game = fakeGame();
    registerGridDefaultsSettings();
    await writeGridDefaults({ inkDay: 0.5 });
    await writeGridDefaults({});
    ok('writing {} keeps what is stored (the merge the reset must NOT use)', readGridDefaults().params.inkDay === 0.5);
    const cleared = await clearGridDefaults();
    ok(
      'clearGridDefaults empties the world grid look',
      cleared.ok === true && Object.keys(readGridDefaults().params).length === 0
    );
  } finally {
    globalThis.game = realGame;
    if (realGame === undefined) delete globalThis.game;
  }
}
