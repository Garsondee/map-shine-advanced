/**
 * Node verification for foundry/impulse-broadcast.js — GM-only send, and a
 * receiver that fires only for a GM sender's well-formed impulse message.
 */
import { broadcastImpulse, listenForImpulses } from '../impulse-broadcast.js';

function withGame(game, fn) {
  const prior = globalThis.game;
  globalThis.game = game;
  try {
    return fn();
  } finally {
    if (prior === undefined) delete globalThis.game;
    else globalThis.game = prior;
  }
}

function mkGame({ isGM }) {
  const emitted = [];
  const listeners = [];
  const users = new Map([
    ['gm1', { isGM: true }],
    ['p1', { isGM: false }],
  ]);
  return {
    emitted,
    deliver: (msg) => listeners.forEach((fn) => fn(msg)),
    game: {
      user: { id: isGM ? 'gm1' : 'p1', isGM },
      users: { get: (id) => users.get(id) },
      socket: {
        emit: (name, msg) => emitted.push({ name, msg }),
        on: (_name, fn) => listeners.push(fn),
      },
    },
  };
}

export function run(t) {
  const gm = mkGame({ isGM: true });
  withGame(gm.game, () => {
    const r = broadcastImpulse('strike');
    t.ok('a GM broadcast emits on the module socket', r.ok && gm.emitted[0]?.name === 'module.map-shine-advanced');
    t.ok(
      'the message carries the impulse id and sender',
      gm.emitted[0]?.msg.id === 'strike' && gm.emitted[0]?.msg.userId === 'gm1'
    );
  });

  const player = mkGame({ isGM: false });
  withGame(player.game, () => {
    t.ok('a player cannot broadcast', !broadcastImpulse('strike').ok && player.emitted.length === 0);
    const fired = [];
    t.ok(
      'the listener installs',
      listenForImpulses((id) => fired.push(id))
    );
    player.deliver({ type: 'impulse', id: 'gust', userId: 'gm1' });
    player.deliver({ type: 'impulse', id: 'strike', userId: 'p1' });
    player.deliver({ type: 'other', id: 'strike', userId: 'gm1' });
    player.deliver(null);
    t.ok('only the GM-sent impulse fires', fired.length === 1 && fired[0] === 'gust');
  });

  withGame(undefined, () => {
    t.ok('no game global: broadcast reports, never throws', broadcastImpulse('strike').ok === false);
    t.ok('no game global: listener does not install', listenForImpulses(() => {}) === false);
  });
}
