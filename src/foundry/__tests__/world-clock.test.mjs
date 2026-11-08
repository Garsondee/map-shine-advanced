/**
 * world-clock.test.mjs — the shared world clock against a hand-built Foundry
 * double: a GM's pause must stop lightning and moving tiles with the same
 * five-second coast as every other effect, and a client that only READS the
 * ledger (a player, or a late joiner) must land on the same instant.
 *
 * The double is installed on globalThis for this file only and removed after,
 * so the other foundry suites keep their genuine no-Foundry posture.
 */
import {
  registerWorldClockSettings,
  watchWorldClock,
  worldSimNowMs,
  worldTimeScale,
  sharedFrameScale,
} from '../world-clock.js';
import { playTileVideo, syncTileVideoTimeScale } from '../tile-video.js';
import { DEFAULT_PAUSE_RAMP_SEC, ledgerSimMs, normalizeWorldClockLedger } from '../../core/frame-clock.js';

export async function run(t) {
  const { ok } = t;
  const close = (a, b, eps = 1e-3) => Math.abs(a - b) < eps;
  const had = { game: globalThis.game, Hooks: globalThis.Hooks };

  const T0 = 1_700_000_000_000;
  let server = T0;
  const store = new Map();
  const registry = new Map();
  const hooks = new Map();
  let nextHook = 1;
  globalThis.Hooks = {
    on(name, fn) {
      const id = nextHook++;
      hooks.set(id, { name, fn });
      return id;
    },
    off(_name, id) {
      hooks.delete(id);
    },
  };
  const fire = (name, ...args) => {
    for (const h of hooks.values()) if (h.name === name) h.fn(...args);
  };
  const gm = { id: 'gm1', isGM: true };
  globalThis.game = {
    paused: false,
    user: gm,
    users: { activeGM: gm },
    time: {
      get serverTime() {
        return server;
      },
    },
    settings: {
      settings: registry,
      register(ns, key, data) {
        registry.set(`${ns}.${key}`, data);
      },
      get(ns, key) {
        const id = `${ns}.${key}`;
        return store.has(id) ? store.get(id) : registry.get(id)?.default;
      },
      async set(ns, key, value) {
        const id = `${ns}.${key}`;
        store.set(id, value);
        registry.get(id)?.onChange?.(value);
        return value;
      },
    },
  };

  try {
    registerWorldClockSettings();
    const unwatch = watchWorldClock();
    ok('before any pause the world clock IS server time', worldSimNowMs() === T0);

    server = T0 + 1000;
    fire('pauseGame', true);
    ok(
      'the GM wrote the pause to the shared ledger',
      typeof store.get('map-shine-advanced.worldClockLedger') === 'string'
    );
    server = T0 + 1000 + (DEFAULT_PAUSE_RAMP_SEC / 2) * 1000;
    const midScale = worldTimeScale();
    ok('half-way into the ramp the world is coasting, not frozen', midScale > 0.4 && midScale < 0.6);
    server = T0 + 1000 + 60_000;
    const heldA = worldSimNowMs();
    server = T0 + 1000 + 600_000;
    ok('paused: the world clock stands still (no lightning strikes, no tile turns)', close(worldSimNowMs(), heldA));
    ok('…having coasted half a ramp past the pause', close(heldA, T0 + 1000 + (DEFAULT_PAUSE_RAMP_SEC / 2) * 1000));

    // A player (or a late joiner) never saw the pause happen: it reads the stored ledger alone.
    const stored = normalizeWorldClockLedger(store.get('map-shine-advanced.worldClockLedger'));
    ok(
      'a client reading only the stored ledger gets the same instant',
      close(ledgerSimMs(stored, server), worldSimNowMs())
    );

    const resumeAt = server;
    fire('pauseGame', false);
    server = resumeAt + 30_000;
    const a = worldSimNowMs();
    server = resumeAt + 40_000;
    ok('resumed: the world clock runs at full speed again', close(worldSimNowMs() - a, 10_000));

    // THE FRAME CLOCK'S SCALE comes from this same ledger — but only once it agrees with Foundry's pause.
    globalThis.game.paused = false;
    ok('running and the ledger agrees: the frame clock gets the ledger scale', sharedFrameScale() === worldTimeScale());
    globalThis.game.paused = true; // Foundry paused, the GM's write not arrived yet
    ok(
      'paused but the ledger still says running: null, so the frame clock uses its own ramp',
      sharedFrameScale() === null
    );
    globalThis.game.paused = false;

    // VIDEO TILES pace to the world's scale and pause with it — resuming only what the world paused.
    {
      const makeVideo = () => ({
        paused: false,
        playbackRate: 1,
        plays: 0,
        getAttribute: (k) => (k === 'src' ? 'water.webm' : null),
        pause() {
          this.paused = true;
        },
        play() {
          this.paused = false;
          this.plays++;
          return Promise.resolve();
        },
      });
      const v = makeVideo();
      const gmPaused = makeVideo();
      globalThis.game.video = { play: () => {} };
      playTileVideo(v, { video: { autoplay: true } });
      playTileVideo(gmPaused, { video: { autoplay: true } });
      gmPaused.paused = true; // someone else (a GM's own control) paused this one
      syncTileVideoTimeScale(0.5);
      ok('a slowing world slows its video tiles', v.playbackRate === 0.5);
      syncTileVideoTimeScale(0);
      ok('a stopped world pauses them', v.paused === true);
      syncTileVideoTimeScale(1);
      ok('…and the resumed world plays them again at full speed', v.paused === false && v.playbackRate === 1);
      ok(
        'a video paused by someone else is never resumed by the world',
        gmPaused.paused === true && gmPaused.plays === 0
      );
      const off = makeVideo();
      playTileVideo(off, { video: { autoplay: false } });
      off.paused = true;
      syncTileVideoTimeScale(0);
      syncTileVideoTimeScale(1);
      ok('a tile with autoplay off is never touched', off.paused === true && off.plays === 0);
      delete globalThis.game.video;
    }

    // A player never writes: the ledger stays the GM's.
    globalThis.game.user = { id: 'p1', isGM: false };
    const before = store.get('map-shine-advanced.worldClockLedger');
    fire('pauseGame', true);
    ok("a player's client never writes the ledger", store.get('map-shine-advanced.worldClockLedger') === before);
    unwatch();
  } finally {
    if (had.game === undefined) delete globalThis.game;
    else globalThis.game = had.game;
    if (had.Hooks === undefined) delete globalThis.Hooks;
    else globalThis.Hooks = had.Hooks;
  }
}
