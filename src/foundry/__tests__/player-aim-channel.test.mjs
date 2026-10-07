/**
 * Node verification for foundry/player-aim-channel.js — the live half of "the
 * flashlight follows its bearer's cursor", driven against a fake `game` +
 * `canvas` the way impulse-broadcast.test.mjs drives its own socket code.
 *
 * What this covers that the pure suite cannot: WHO aims (a non-GM's own viewer
 * token only), WHO is believed (the sender must own the token), what a tick
 * puts on the socket and when, the lifecycle, and the promise that nothing in
 * the per-frame path can throw into the render loop. The real
 * `readActivePlayerCarriedLightTokens`, `resolveViewerToken`,
 * `readScenePlayerLightPermissions` and `readMouseHoverPoint` all run, against
 * the fake, so a drift in any of them shows up here.
 *
 * The one cross-zone import (the beam builder) is test-only: the last link — an
 * aim reaching `beamDirection` — is only worth asserting end to end.
 */
import { createPlayerAimChannel, AIM_SENDER_TICK_MS } from '../player-aim-channel.js';
import { readActivePlayerCarriedLightTokens } from '../player-light-mode.js';
import { buildPlayerLightSources } from '../../effects/lighting/player-light-geometry.js';
import { LogLevel, getLogLevel, setLogLevel, setLogSink } from '../../core/log.js';

const near = (a, b, eps = 1e-6) => Math.abs(a - b) < eps;
const SOCKET = 'module.map-shine-advanced';

/**
 * @param {object} [spec]
 * @param {string} [spec.userId]
 * @param {boolean} [spec.isGM]
 * @param {string} [spec.characterActorId] - the actor `game.user.character` points at.
 * @param {Array<{id: string, actorId?: string, x: number, y: number, mode?: string|null, owners?: string[], rotation?: number, isOwner?: boolean}>} spec.tokens
 *   `isOwner` is what `resolveViewerToken`'s "any token I own" fallback reads; `owners` is what `testUserPermission` answers for a given user.
 * @param {Array<{id: string, active: boolean, isSelf: boolean}>} [spec.users]
 * @param {object|null} [spec.sceneFlag] - the scene's stored player-light permissions.
 * @param {boolean} [spec.withVolatile] - whether the socket has `.volatile` (the real one does).
 */
function makeWorld({
  userId = 'p1',
  isGM = false,
  characterActorId = 'actor-p1',
  tokens,
  users,
  sceneFlag = null,
  withVolatile = true,
}) {
  const emitted = [];
  const listeners = [];
  const tokenObjects = tokens.map((spec) => ({
    id: spec.id,
    actor: { id: spec.actorId ?? `actor-${spec.id}` },
    isOwner: spec.isOwner ?? true,
    center: { x: spec.x, y: spec.y },
    document: {
      id: spec.id,
      hidden: false,
      elevation: 0,
      rotation: spec.rotation ?? 0,
      lockRotation: false,
      getFlag: (ns, key) =>
        ns === 'map-shine-advanced' && key === 'playerLightMode' ? (spec.mode ?? null) : undefined,
      testUserPermission: (user, level) => level === 'OWNER' && (spec.owners ?? []).includes(user?.id),
    },
  }));
  const userList = users ?? [
    { id: 'p1', active: true, isSelf: userId === 'p1' },
    { id: 'p2', active: true, isSelf: userId === 'p2' },
    { id: 'p3', active: true, isSelf: userId === 'p3' },
    { id: 'gm', active: true, isSelf: userId === 'gm' },
  ];
  const socket = {
    on: (name, fn) => listeners.push({ name, fn }),
    off: (name, fn) => {
      const i = listeners.findIndex((l) => l.name === name && l.fn === fn);
      if (i >= 0) listeners.splice(i, 1);
    },
    emit: (name, msg) => emitted.push({ name, msg, volatile: false }),
  };
  if (withVolatile) socket.volatile = { emit: (name, msg) => emitted.push({ name, msg, volatile: true }) };
  const world = {
    emitted,
    listeners,
    userList,
    tokenObjects,
    game: {
      user: { id: userId, isGM, character: { id: characterActorId } },
      users: { get: (id) => userList.find((u) => u.id === id), some: (fn) => userList.some(fn) },
      socket,
    },
    canvas: {
      scene: { id: 's1', getFlag: () => sceneFlag },
      tokens: { placeables: tokenObjects, get: (id) => tokenObjects.find((t) => t.document.id === id) },
      // Foundry's own un-moved default; `setMouse` stands in for a real pointermove.
      mousePosition: { x: 0, y: 0 },
      mousePositionVisible: true,
      mousePositionExplored: true,
    },
    setMouse(x, y) {
      world.canvas.mousePosition.x = x;
      world.canvas.mousePosition.y = y;
    },
    deliver(msg) {
      for (const l of [...listeners]) l.fn(msg);
    },
  };
  return world;
}

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

const withWorld = (world, fn) => withGlobals(world.game, world.canvas, fn);

function makeClock(start = 1000) {
  const clock = {
    t: start,
    now: () => clock.t,
    advance(ms) {
      clock.t += ms;
      return clock.t;
    },
  };
  return clock;
}

function makeTimers() {
  const intervals = [];
  return {
    intervals,
    setIntervalFn: (fn, ms) => {
      const handle = { fn, ms, cleared: false };
      intervals.push(handle);
      return handle;
    },
    clearIntervalFn: (handle) => {
      handle.cleared = true;
    },
  };
}

function makeChannel(clock = makeClock()) {
  const timers = makeTimers();
  const channel = createPlayerAimChannel({ now: clock.now, ...timers });
  return { channel, clock, timers };
}

const ALLOW_FLASHLIGHT = { modes: { flashlight: true } };

export function run(t) {
  const { ok } = t;

  // ======================================================================
  // annotate — what aim each snapshot gets
  // ======================================================================
  {
    const w = makeWorld({
      tokens: [{ id: 't1', actorId: 'actor-p1', x: 100, y: 100, mode: 'flashlight', owners: ['p1'] }],
    });
    const { channel } = makeChannel();
    withWorld(w, () => {
      let snaps = channel.annotate(readActivePlayerCarriedLightTokens());
      ok(
        'annotate: before the pointer has ever moved, nothing is stamped (the stored rotation applies)',
        snaps[0].aimAngleDeg === undefined
      );

      w.setMouse(200, 100);
      snaps = channel.annotate(readActivePlayerCarriedLightTokens());
      ok('annotate: the viewer’s own token aims at the cursor (due east is 90°)', near(snaps[0].aimAngleDeg, 90));
      const [src] = buildPlayerLightSources(snaps, ALLOW_FLASHLIGHT);
      ok(
        'annotate: …and that reaches the beam descriptor, pointing +X',
        near(src.beamDirection.x, 1) && near(src.beamDirection.y, 0)
      );

      w.setMouse(100, 0);
      snaps = channel.annotate(readActivePlayerCarriedLightTokens());
      ok('annotate: moving the cursor north turns it to 0°', near(snaps[0].aimAngleDeg, 0));

      w.setMouse(100, 100);
      snaps = channel.annotate(readActivePlayerCarriedLightTokens());
      ok('annotate: a cursor parked on the token itself holds the last aim', near(snaps[0].aimAngleDeg, 0));

      w.tokenObjects[0].center.x = 300; // the token walks away; the cursor stays where the token was
      snaps = channel.annotate(readActivePlayerCarriedLightTokens());
      ok(
        'annotate: the aim follows the TOKEN moving past a still cursor (now due west, 270°)',
        near(snaps[0].aimAngleDeg, 270)
      );
    });
  }
  {
    // A torch, a vision mode, and a flashlight on the same table: only the flashlight is aimable.
    const w = makeWorld({
      tokens: [
        { id: 't1', actorId: 'actor-p1', x: 100, y: 100, mode: 'torch', owners: ['p1'] },
        { id: 't2', actorId: 'actor-x', x: 500, y: 500, mode: 'nightVision', owners: ['p2'] },
      ],
    });
    const { channel } = makeChannel();
    withWorld(w, () => {
      w.setMouse(300, 100);
      const snaps = channel.annotate(readActivePlayerCarriedLightTokens());
      ok('annotate: a torch is not aimed', snaps[0].aimAngleDeg === undefined);
      ok('annotate: a vision mode is not aimed', snaps[1].aimAngleDeg === undefined);
    });
  }
  {
    // Only the VIEWER token follows this client's cursor; another bearer's token does not.
    const w = makeWorld({
      tokens: [
        { id: 't1', actorId: 'actor-p1', x: 100, y: 100, mode: 'flashlight', owners: ['p1'] },
        { id: 't2', actorId: 'actor-p2', x: 400, y: 400, mode: 'flashlight', owners: ['p2'] },
      ],
    });
    const { channel } = makeChannel();
    withWorld(w, () => {
      w.setMouse(200, 100);
      const snaps = channel.annotate(readActivePlayerCarriedLightTokens());
      ok('annotate: my token aims at my cursor', near(snaps[0].aimAngleDeg, 90));
      ok('annotate: someone else’s token does not borrow my cursor', snaps[1].aimAngleDeg === undefined);
    });
  }
  {
    // A GM aims nothing, even with a token they own and a cursor on the board.
    const w = makeWorld({
      userId: 'gm',
      isGM: true,
      tokens: [{ id: 't1', actorId: 'actor-p1', x: 100, y: 100, mode: 'flashlight', owners: ['p1'] }],
    });
    const { channel, clock } = makeChannel();
    withWorld(w, () => {
      w.setMouse(200, 100);
      const snaps = channel.annotate(readActivePlayerCarriedLightTokens());
      ok('annotate: a GM’s cursor never aims a player’s beam', snaps[0].aimAngleDeg === undefined);
      ok('tick: a GM sends nothing', channel.tick(clock.t) === false && w.emitted.length === 0);
    });
  }
  {
    ok(
      'annotate: an empty or non-array input is returned untouched',
      (() => {
        const { channel } = makeChannel();
        const empty = [];
        return (
          channel.annotate(empty) === empty &&
          channel.annotate(null) === null &&
          channel.annotate(undefined) === undefined
        );
      })()
    );
  }

  // ======================================================================
  // handleMessage — what is believed
  // ======================================================================
  {
    const w = makeWorld({
      tokens: [
        { id: 't1', actorId: 'actor-p1', x: 100, y: 100, mode: 'flashlight', owners: ['p1'] },
        { id: 't2', actorId: 'actor-p2', x: 400, y: 400, mode: 'flashlight', owners: ['p2'] },
      ],
    });
    const { channel, clock } = makeChannel();
    withWorld(w, () => {
      const good = { type: 'playerAim', tokenId: 't2', userId: 'p2', a: 270 };
      ok('receive: an owner’s aim for their own token is accepted', channel.handleMessage(good) === true);
      let snaps = channel.annotate(readActivePlayerCarriedLightTokens());
      ok('receive: …and annotates that token (west = 270°)', near(snaps[1].aimAngleDeg, 270));
      ok('receive: …without touching mine', snaps[0].aimAngleDeg === undefined);

      clock.advance(100);
      channel.handleMessage({ ...good, a: 0 });
      clock.advance(70); // one smoothing time constant after the new target landed
      snaps = channel.annotate(readActivePlayerCarriedLightTokens());
      const moved = snaps[1].aimAngleDeg;
      ok(
        'receive: a new aim is eased toward, along the short arc, not jumped to (270° → 0° passes 300°, not 135°)',
        moved > 270 && moved < 360 && near(moved, 270 + 90 * (1 - Math.exp(-1)), 1e-3)
      );

      clock.advance(9000); // the bearer goes quiet for longer than the stale window
      snaps = channel.annotate(readActivePlayerCarriedLightTokens());
      ok(
        'receive: an aim that is never refreshed expires — the stored rotation takes over again',
        snaps[1].aimAngleDeg === undefined
      );
    });
  }
  {
    const w = makeWorld({
      tokens: [
        { id: 't1', actorId: 'actor-p1', x: 100, y: 100, mode: 'flashlight', owners: ['p1'] },
        { id: 't2', actorId: 'actor-p2', x: 400, y: 400, mode: 'flashlight', owners: ['p2'] },
      ],
    });
    const { channel } = makeChannel();
    withWorld(w, () => {
      ok(
        'receive: a player cannot steer a token they do not own',
        channel.handleMessage({ type: 'playerAim', tokenId: 't2', userId: 'p3', a: 10 }) === false
      );
      ok(
        'receive: an unknown sender is refused',
        channel.handleMessage({ type: 'playerAim', tokenId: 't2', userId: 'nobody', a: 10 }) === false
      );
      ok(
        'receive: a token that is not on this scene is refused',
        channel.handleMessage({ type: 'playerAim', tokenId: 'elsewhere', userId: 'p2', a: 10 }) === false
      );
      ok(
        'receive: an echo of my own message is refused',
        channel.handleMessage({ type: 'playerAim', tokenId: 't1', userId: 'p1', a: 10 }) === false
      );
      ok(
        'receive: a malformed message of ours is refused',
        channel.handleMessage({ type: 'playerAim', tokenId: 't2', userId: 'p2', a: 'ninety' }) === false
      );
      ok(
        'receive: another feature’s message on the shared socket is ignored',
        channel.handleMessage({ type: 'impulse', id: 'gust', userId: 'gm' }) === false &&
          channel.handleMessage(null) === false
      );
      const s = channel.getStats();
      ok(
        'receive: every refusal is counted under its own reason',
        s.rejected['not-owner'] === 1 &&
          s.rejected['unknown-sender'] === 1 &&
          s.rejected['unknown-token'] === 1 &&
          s.rejected['own-echo'] === 1 &&
          s.rejected.malformed === 1
      );
      ok(
        'receive: another feature’s messages are not counted as ours at all',
        s.received === 0 && Object.keys(s.rejected).length === 5
      );
      ok('receive: nothing refused was kept', s.remoteTokens === 0);
    });
    ok(
      'receive: with no world at all it refuses rather than throws',
      withGlobals(undefined, undefined, () =>
        channel.handleMessage({ type: 'playerAim', tokenId: 't', userId: 'u', a: 1 })
      ) === false
    );
  }
  {
    // A sender id that exists but whose token document cannot answer a permission check fails CLOSED.
    const w = makeWorld({
      tokens: [{ id: 't2', actorId: 'actor-p2', x: 0, y: 0, mode: 'flashlight', owners: ['p2'] }],
    });
    delete w.tokenObjects[0].document.testUserPermission;
    const { channel } = makeChannel();
    withWorld(w, () => {
      ok(
        'receive: a token document with no permission test is treated as not owned by the sender',
        channel.handleMessage({ type: 'playerAim', tokenId: 't2', userId: 'p2', a: 10 }) === false
      );
    });
  }

  // ======================================================================
  // tick — what goes on the socket, and when
  // ======================================================================
  {
    const w = makeWorld({
      tokens: [{ id: 't1', actorId: 'actor-p1', x: 100, y: 100, mode: 'flashlight', owners: ['p1'] }],
    });
    const { channel, clock } = makeChannel();
    withWorld(w, () => {
      ok('tick: before the pointer has ever moved there is nothing to say', channel.tick(clock.t) === false);

      w.setMouse(200, 100);
      ok('tick: the first aim is sent at once', channel.tick(clock.t) === true);
      const sent = w.emitted[0];
      ok('tick: …on the shared module socket, as a volatile event', sent.name === SOCKET && sent.volatile === true);
      ok(
        'tick: …carrying our type, the token, the sender and the angle',
        sent.msg.type === 'playerAim' && sent.msg.tokenId === 't1' && sent.msg.userId === 'p1' && near(sent.msg.a, 90)
      );

      clock.advance(50);
      w.setMouse(100, 300);
      ok('tick: a change inside the 100 ms rate cap waits', channel.tick(clock.t) === false);
      clock.advance(60);
      ok('tick: …and goes on the next tick past it', channel.tick(clock.t) === true && near(w.emitted[1].msg.a, 180));

      clock.advance(200);
      ok('tick: an unchanged aim is quiet', channel.tick(clock.t) === false);

      w.tokenObjects[0].center.x = 300; // the token moves; the cursor does not
      clock.advance(100);
      ok('tick: the token moving under a still cursor changes the aim, so it is sent', channel.tick(clock.t) === true);
      ok('tick: …as the new bearing (cursor now south-west of the token)', near(w.emitted[2].msg.a, 225, 0.2));
      ok('tick: stats count what went out', channel.getStats().sent === 3);
    });
  }
  {
    const w = makeWorld({
      tokens: [{ id: 't1', actorId: 'actor-p1', x: 100, y: 100, mode: 'flashlight', owners: ['p1'] }],
      withVolatile: false,
    });
    const { channel, clock } = makeChannel();
    withWorld(w, () => {
      w.setMouse(200, 100);
      ok(
        'tick: a socket with no `.volatile` still sends, as an ordinary event',
        channel.tick(clock.t) === true && w.emitted[0].volatile === false
      );
    });
  }
  {
    // Alone at the table: say nothing — then say it all the moment someone joins.
    const w = makeWorld({
      tokens: [{ id: 't1', actorId: 'actor-p1', x: 100, y: 100, mode: 'flashlight', owners: ['p1'] }],
      users: [{ id: 'p1', active: true, isSelf: true }],
    });
    const { channel, clock } = makeChannel();
    withWorld(w, () => {
      w.setMouse(200, 100);
      ok('tick: with nobody else connected nothing is sent', channel.tick(clock.t) === false && w.emitted.length === 0);
      w.userList.push({ id: 'p2', active: false, isSelf: false });
      clock.advance(100);
      ok('tick: an inactive user does not count as someone listening', channel.tick(clock.t) === false);
      w.userList[1].active = true;
      clock.advance(100);
      ok('tick: the moment someone connects the aim goes out', channel.tick(clock.t) === true);
    });
  }
  {
    const hold = (name, spec, expectation) => {
      const w = makeWorld(spec);
      const { channel, clock } = makeChannel();
      withWorld(w, () => {
        w.setMouse(200, 100);
        ok(name, channel.tick(clock.t) === expectation && (expectation || w.emitted.length === 0));
      });
    };
    hold(
      'tick: a torch is not aimable, so nothing is sent',
      { tokens: [{ id: 't1', actorId: 'actor-p1', x: 100, y: 100, mode: 'torch', owners: ['p1'] }] },
      false
    );
    hold(
      'tick: no carried light at all sends nothing',
      { tokens: [{ id: 't1', actorId: 'actor-p1', x: 100, y: 100, mode: null, owners: ['p1'] }] },
      false
    );
    hold(
      'tick: a scene where the GM has disallowed the flashlight sends nothing',
      {
        tokens: [{ id: 't1', actorId: 'actor-p1', x: 100, y: 100, mode: 'flashlight', owners: ['p1'] }],
        sceneFlag: { modes: { flashlight: false } },
      },
      false
    );
    hold(
      'tick: a user who has no token of their own sends nothing',
      {
        tokens: [
          { id: 't1', actorId: 'actor-other', x: 100, y: 100, mode: 'flashlight', owners: ['p2'], isOwner: false },
        ],
      },
      false
    );
    hold(
      'tick: (control) the same table WITH their own token sends',
      { tokens: [{ id: 't1', actorId: 'actor-p1', x: 100, y: 100, mode: 'flashlight', owners: ['p1'] }] },
      true
    );
  }

  // ======================================================================
  // lifecycle
  // ======================================================================
  {
    const w = makeWorld({
      tokens: [
        { id: 't1', actorId: 'actor-p1', x: 100, y: 100, mode: 'flashlight', owners: ['p1'] },
        { id: 't2', actorId: 'actor-p2', x: 400, y: 400, mode: 'flashlight', owners: ['p2'] },
      ],
    });
    const { channel, timers } = makeChannel();
    withWorld(w, () => {
      ok('start: reports it is running', channel.start() === true);
      ok('start: listens on the shared module socket', w.listeners.length === 1 && w.listeners[0].name === SOCKET);
      ok(
        'start: ticks faster than the policy’s own rate cap, so the cap sets the cadence',
        timers.intervals.length === 1 && timers.intervals[0].ms === AIM_SENDER_TICK_MS && AIM_SENDER_TICK_MS < 100
      );
      channel.start();
      ok(
        'start: is idempotent — still one listener, one timer',
        w.listeners.length === 1 && timers.intervals.length === 1
      );
      ok('start: stats say it is running', channel.getStats().running === true);

      w.setMouse(200, 100);
      timers.intervals[0].fn();
      ok('start: the timer drives the sender', w.emitted.length === 1);

      w.deliver({ type: 'playerAim', tokenId: 't2', userId: 'p2', a: 45 });
      ok(
        'start: the listener routes this feature’s messages',
        channel.getStats().received === 1 && channel.getStats().remoteTokens === 1
      );
      w.deliver({ type: 'impulse', id: 'gust', userId: 'gm' });
      ok(
        'start: …and ignores every other feature’s',
        channel.getStats().received === 1 && Object.keys(channel.getStats().rejected).length === 0
      );

      channel.stop();
      ok('stop: clears the timer', timers.intervals[0].cleared === true);
      ok('stop: removes the listener', w.listeners.length === 0);
      ok(
        'stop: forgets every remote aim',
        channel.getStats().remoteTokens === 0 && channel.getStats().running === false
      );

      ok(
        'start: can be started again after a stop',
        channel.start() === true && w.listeners.length === 1 && timers.intervals.length === 2
      );
      channel.stop();
    });
    ok(
      'start: with no `game` it reports it could not',
      withGlobals(undefined, undefined, () => makeChannel().channel.start()) === false
    );
    ok(
      'start: with no socket it reports it could not',
      withGlobals({ user: { id: 'p1' } }, undefined, () => makeChannel().channel.start()) === false
    );
    ok(
      'stop: is safe on a channel that never started',
      (() => {
        makeChannel().channel.stop();
        return true;
      })()
    );
  }

  // ======================================================================
  // nothing may throw into the render loop
  // ======================================================================
  {
    const records = [];
    const priorLevel = getLogLevel();
    setLogLevel(LogLevel.ERROR + 1); // keep the console clean; the sink still records
    setLogSink((entry) => records.push(entry));
    try {
      const w = makeWorld({
        tokens: [{ id: 't1', actorId: 'actor-p1', x: 100, y: 100, mode: 'flashlight', owners: ['p1'] }],
      });
      Object.defineProperty(w.game, 'user', {
        get() {
          throw new Error('the world is mid-teardown');
        },
      });
      const { channel } = makeChannel();
      withWorld(w, () => {
        const snaps = [{ tokenId: 't1', x: 100, y: 100, mode: 'flashlight' }];
        const out = channel.annotate(snaps);
        ok(
          'fault: annotate contains it — the same array comes back, unaimed',
          out === snaps && snaps[0].aimAngleDeg === undefined
        );
        channel.annotate(snaps);
        channel.annotate(snaps);
        ok('fault: a persistent fault is counted once, not once per frame', channel.getStats().errors === 1);
        ok(
          'fault: …and logged once, with the reason',
          records.filter((r) => r.level === 'error').length === 1 && /player-aim|aim/i.test(records[0].message)
        );
      });

      // The timer callback and the socket listener contain faults the same way.
      const w2 = makeWorld({
        tokens: [{ id: 't1', actorId: 'actor-p1', x: 100, y: 100, mode: 'flashlight', owners: ['p1'] }],
      });
      w2.game.socket.volatile.emit = () => {
        throw new Error('socket exploded');
      };
      const { channel: ch2, timers: tm2 } = makeChannel();
      withWorld(w2, () => {
        ch2.start();
        w2.setMouse(200, 100);
        let threw = false;
        try {
          tm2.intervals[0].fn();
        } catch (err) {
          void err;
          threw = true;
        }
        ok('fault: a failing socket send never escapes the timer', threw === false && ch2.getStats().errors === 1);
        let listenerThrew = false;
        try {
          w2.deliver({ type: 'playerAim', tokenId: 't1', userId: 'p1', a: 'x' });
          w2.canvas.tokens.get = () => {
            throw new Error('canvas gone');
          };
          w2.deliver({ type: 'playerAim', tokenId: 't1', userId: 'p2', a: 10 });
        } catch (err) {
          void err;
          listenerThrew = true;
        }
        ok(
          'fault: a failing message handler never escapes the socket listener',
          listenerThrew === false && ch2.getStats().errors === 2
        );
        ch2.stop();
      });
    } finally {
      setLogSink(null);
      setLogLevel(priorLevel);
    }
  }
}
