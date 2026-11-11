/**
 * Node verification for foundry/effect-param-persistence.js `watchSceneEffectParams` — the half that tells
 * a client the scene's authored effect params moved. Added by the two-client QA pass (2026-11-11): the
 * flag always synced but a connected player's look never re-resolved from it, and a reset (Foundry reports
 * an unset as `-=effectParams`) never matched the watcher at all. What this proves: it fires for this
 * module's `effectParams` flag on the ACTIVE scene only, also for the `-=` deletion form, and says whether
 * the write was another user's (our own is applied live by the setter that made it).
 */
import { watchSceneEffectParams } from '../effect-param-persistence.js';

function withWorld({ activeSceneId = 's1', me = 'me' }, fn) {
  const prior = { canvas: globalThis.canvas, game: globalThis.game, Hooks: globalThis.Hooks };
  const handlers = [];
  globalThis.canvas = { scene: { id: activeSceneId } };
  globalThis.game = { user: { id: me } };
  globalThis.Hooks = {
    on: (_name, fn2) => handlers.push(fn2),
    off: () => {},
  };
  try {
    return fn((doc, change, userId) => handlers.forEach((h) => h(doc, change, {}, userId)));
  } finally {
    for (const [k, v] of Object.entries(prior)) {
      if (v === undefined) delete globalThis[k];
      else globalThis[k] = v;
    }
  }
}

export function run(t) {
  const NS = 'map-shine-advanced';
  withWorld({}, (fire) => {
    const calls = [];
    watchSceneEffectParams((change, fromOther) => calls.push(fromOther));

    fire({ id: 's1' }, { flags: { [NS]: { effectParams: { grade: { saturation: 0 } } } } }, 'gm');
    t.ok("another user's effectParams write fires, flagged as another user's", calls.length === 1 && calls[0] === true);

    fire({ id: 's1' }, { flags: { [NS]: { effectParams: { grade: { saturation: 0 } } } } }, 'me');
    t.ok('our own write fires but is not flagged as another user', calls.length === 2 && calls[1] === false);

    fire({ id: 's1' }, { flags: { [NS]: { '-=effectParams': null } } }, 'gm');
    t.ok('an unset (-=effectParams, what the global reset writes) fires too', calls.length === 3 && calls[2] === true);

    fire({ id: 's1' }, { flags: { [NS]: { sky: { todHour: 3 } } } }, 'gm');
    t.ok("a different flag of this module's does not fire", calls.length === 3);

    fire({ id: 's2' }, { flags: { [NS]: { effectParams: {} } } }, 'gm');
    t.ok("another scene's change does not fire", calls.length === 3);

    fire({ id: 's1' }, { name: 'renamed' }, 'gm');
    t.ok('a change with no flags does not fire', calls.length === 3);
  });
}
