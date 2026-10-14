/**
 * Node verification for foundry/viewer-token.js#resolveCarriedLightTarget — which
 * token a client's carried light belongs to. A player gets their own character's
 * token; a GM gets the one they have selected, unless an active player steers it.
 * The `reason` codes are what the carried-light picker tells the user, so they are
 * pinned too.
 */
import { resolveCarriedLightTarget, resolveCarriedLightToken } from '../viewer-token.js';

function withGlobals(game, canvas, fn) {
  const priorGame = globalThis.game;
  const priorCanvas = globalThis.canvas;
  globalThis.game = game;
  globalThis.canvas = canvas;
  try {
    return fn();
  } finally {
    if (priorGame === undefined) delete globalThis.game;
    else globalThis.game = priorGame;
    if (priorCanvas === undefined) delete globalThis.canvas;
    else globalThis.canvas = priorCanvas;
  }
}

const makeToken = (id, { actorId, owners = [], hidden = false, name = id } = {}) => ({
  id,
  name,
  isOwner: true,
  actor: { id: actorId ?? `actor-${id}` },
  document: { id, hidden, testUserPermission: (user, level) => level === 'OWNER' && owners.includes(user?.id) },
});

export function run(t) {
  const { ok } = t;
  const users = [
    { id: 'p1', active: true },
    { id: 'p2', active: false },
    { id: 'gm', active: true, isGM: true },
  ];
  const world = (isGM, placeables, controlled = []) => ({
    game: {
      user: { id: isGM ? 'gm' : 'p1', isGM, character: { id: 'actor-mine' } },
      users: { some: (fn) => users.some(fn) },
    },
    canvas: { tokens: { placeables, controlled } },
  });

  {
    const mine = makeToken('mine', { actorId: 'actor-mine' });
    const w = world(false, [makeToken('other'), mine], [makeToken('selected-but-not-mine')]);
    const r = withGlobals(w.game, w.canvas, () => resolveCarriedLightTarget());
    ok('player: their own character token, whatever is selected', r.token === mine && r.reason === null);
  }
  {
    const w = world(false, []);
    const r = withGlobals(w.game, w.canvas, () => resolveCarriedLightTarget());
    ok('player: no token on the scene says so', r.token === null && r.reason === 'no-token');
  }
  {
    const w = world(true, [], []);
    const r = withGlobals(w.game, w.canvas, () => resolveCarriedLightTarget());
    ok('GM: nothing selected says so', r.token === null && r.reason === 'none-selected');
  }
  {
    const npc = makeToken('npc', { owners: ['gm'] });
    const w = world(true, [npc], [npc]);
    const r = withGlobals(w.game, w.canvas, () => resolveCarriedLightToken());
    ok('GM: the selected NPC is their carried-light token', r === npc);
  }
  {
    const pc = makeToken('pc', { owners: ['p1', 'gm'], name: 'Mira' });
    const w = world(true, [pc], [pc]);
    const r = withGlobals(w.game, w.canvas, () => resolveCarriedLightTarget());
    ok('GM: a token an ACTIVE player owns is not theirs to steer', r.token === null && r.reason === 'player-active');
    ok('GM: the player-active reason names that token for the picker', r.blockedName === 'Mira');
  }
  {
    const pc = makeToken('pc', { owners: ['p2', 'gm'] });
    const w = world(true, [pc], [pc]);
    const r = withGlobals(w.game, w.canvas, () => resolveCarriedLightTarget());
    ok('GM: a token only an OFFLINE player owns can be steered', r.token === pc);
  }
  {
    const pc = makeToken('pc', { owners: ['p1', 'gm'] });
    const npc = makeToken('npc', { owners: ['gm'] });
    const w = world(true, [pc, npc], [pc, npc]);
    const r = withGlobals(w.game, w.canvas, () => resolveCarriedLightTarget());
    ok('GM: with a player-steered token and an NPC both selected, the NPC is chosen', r.token === npc);
  }
  {
    const r = withGlobals(undefined, undefined, () => resolveCarriedLightTarget());
    ok('no canvas yet: a clean no-canvas answer, never a throw', r.token === null && r.reason === 'no-canvas');
  }
}
