/**
 * settings-adapter.test.mjs — the thin `game.settings` wrapper. Node-testable
 * against a FAKE `game` global (no real Foundry needed): `registerSettings`
 * only ever calls `game.settings.register/get/set`, so a plain object with
 * those three methods is a faithful enough double for its own contract.
 *
 * Added 2026-07-29 alongside the `requiresReload` passthrough (the master
 * off-switch, effects/effect-settings.js) — the one piece of this file with
 * real branching logic, and the one line a future refactor could drop silently
 * without a test noticing.
 */
import { registerSettings, readSetting, writeSetting } from '../settings-adapter.js';

function fakeGame() {
  const registered = [];
  const store = {};
  return {
    registered,
    store,
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

export function run(t) {
  const { ok, throws } = t;
  const realGame = globalThis.game;

  try {
    // --- the basic shape: descriptor → game.settings.register(...) ----------
    {
      globalThis.game = fakeGame();
      registerSettings('msa', [
        { key: 'profile', scope: 'client', kind: 'enum', choices: { low: 'Low' }, default: 'low', name: 'Profile' },
      ]);
      const call = globalThis.game.registered[0];
      ok('namespace + key passed through', call.namespace === 'msa' && call.key === 'profile');
      ok('client scope maps to scope:"client"', call.data.scope === 'client');
      ok('enum kind carries its choices', call.data.choices.low === 'Low');
      ok('enum kind types as String', call.data.type === String);
      ok('config defaults true when not specified', call.data.config === true);
      ok('an absent requiresReload is not written at all (not even false)', !('requiresReload' in call.data));
    }

    // --- bool kind, world scope, config:false, requiresReload ----------------
    {
      globalThis.game = fakeGame();
      registerSettings('msa', [
        {
          key: 'msaEnabled',
          scope: 'client',
          kind: 'bool',
          default: true,
          config: true,
          requiresReload: true,
          name: 'Enable',
        },
        { key: 'hidden', scope: 'world', kind: 'bool', default: false, config: false, name: 'Internal' },
      ]);
      const [master, hidden] = globalThis.game.registered;
      ok('bool kind types as Boolean', master.data.type === Boolean);
      ok(
        'requiresReload:true is forwarded verbatim — this is the ONE branch this file exists to protect',
        master.data.requiresReload === true
      );
      ok('world scope maps to scope:"world"', hidden.data.scope === 'world');
      ok('config:false is respected, not coerced to true', hidden.data.config === false);
      ok(
        'requiresReload:false is NOT forwarded (falsy stays absent, never a literal false)',
        !('requiresReload' in hidden.data)
      );
    }

    // --- onChange wiring: fires with the KEY that changed, after commit -------
    {
      globalThis.game = fakeGame();
      const seen = [];
      registerSettings('msa', [{ key: 'a', scope: 'client', kind: 'bool', default: false, name: 'A' }], {
        onChange: (key) => seen.push(key),
      });
      globalThis.game.registered[0].data.onChange(); // Foundry calls this AFTER the value commits
      ok('onChange is wired and reports the descriptor key it belongs to', seen[0] === 'a');
    }

    // --- malformed entries are skipped, never thrown into the caller ---------
    {
      globalThis.game = fakeGame();
      registerSettings('msa', [null, {}, { key: 'ok', scope: 'client', kind: 'bool', default: true, name: 'Ok' }]);
      ok(
        'null/keyless entries are silently skipped; a real one still registers',
        globalThis.game.registered.length === 1 && globalThis.game.registered[0].key === 'ok'
      );
    }

    // --- readSetting / writeSetting round-trip -------------------------------
    {
      globalThis.game = fakeGame();
      registerSettings('msa', [{ key: 'x', scope: 'client', kind: 'bool', default: false, name: 'X' }]);
      ok('readSetting returns the registered default', readSetting('msa', 'x') === false);
      writeSetting('msa', 'x', true);
      ok('writeSetting persists through to the next read', readSetting('msa', 'x') === true);
    }

    throws(
      'reading a never-registered key throws loudly (a wiring bug, not a silent default)',
      () => {
        globalThis.game = fakeGame();
        readSetting('msa', 'ghost');
      },
      'never registered'
    );
  } finally {
    globalThis.game = realGame;
  }
}
