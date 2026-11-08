/**
 * THE SHARED WORLD CLOCK — pausing time that every client agrees on.
 *
 * Most effects animate on the frame snapshot's `env.time.tMs`/`dtSec`
 * (`core/frame-clock.js`), which eases to a stop over five seconds when Foundry
 * pauses. A few must also agree ACROSS clients — storm lightning strikes at the
 * same moment for everyone, and a moving tile sits at the same angle on every
 * screen — and those used `game.time.serverTime` directly. Server time never
 * pauses, so lightning kept striking through a pause (author, 2026-11-08: "when
 * I pause they don't pause correctly … make sure EVERYTHING uses the same
 * method").
 *
 * This is the one door for that kind of time: `worldSimNowMs()` is server time
 * minus every millisecond the world has spent stopped, with the SAME five-second
 * cosine ramp as the frame clock (`core/frame-clock.js#pauseRampScale`). The
 * record of past pauses (the "ledger") is a hidden world setting the active GM
 * writes on each pause/unpause; every client reads it, and the math on it is a
 * pure function (`ledgerSimMs`), so a player who joins late lands on exactly the
 * same instant as everyone else.
 *
 * Between a pause and the ledger write reaching a player (~a network round
 * trip) that player runs at full speed; the ramp starts with zero slope, so the
 * catch-up is far below a pixel.
 *
 * @module foundry/world-clock
 */

import {
  wallClockMs,
  captureDriftMs,
  normalizeWorldClockLedger,
  ledgerSimMs,
  ledgerScale,
  retargetWorldClockLedger,
} from '../core/frame-clock.js';
import { registerSettings, readSetting, writeSetting } from './settings-adapter.js';

const NAMESPACE = 'map-shine-advanced';
const LEDGER_KEY = 'worldClockLedger';

/** @type {import('../core/frame-clock.js').WorldClockLedger} */
let ledger = normalizeWorldClockLedger(null);
let registered = false;
let pauseHookId = null;

/**
 * Server time (shared across clients) plus the video capture clock's drift, so
 * a recorded video stays frame-exact; the sanctioned wall clock before Foundry
 * has a server time.
 * @returns {number}
 */
export function serverNowMs() {
  const s = typeof game !== 'undefined' ? Number(game?.time?.serverTime) : NaN;
  return Number.isFinite(s) && s > 0 ? s + captureDriftMs() : wallClockMs();
}

/**
 * THE SHARED SIM CLOCK, in ms. Use this — never `serverNowMs()` or
 * `game.time.serverTime` — for anything that animates and must match across
 * clients. Equal to server time until the world first pauses.
 * @returns {number}
 */
export function worldSimNowMs() {
  return ledgerSimMs(ledger, serverNowMs());
}

/** @returns {number} the shared world's time scale right now (1 running, 0 stopped). */
export function worldTimeScale() {
  return ledgerScale(ledger, serverNowMs());
}

/** @returns {object} the ledger, for diagnostics. */
export function getWorldClockLedger() {
  return { ...ledger, scaleNow: worldTimeScale() };
}

function reload() {
  try {
    ledger = normalizeWorldClockLedger(readSetting(NAMESPACE, LEDGER_KEY));
  } catch (_) {
    // not registered yet: keep the never-paused ledger.
  }
}

/** Is THIS client the one GM who writes the ledger? (One writer, so two GMs never race.) */
function isLedgerWriter() {
  const u = typeof game !== 'undefined' ? game?.user : null;
  if (!u?.isGM) return false;
  const active = game?.users?.activeGM;
  return active ? active.id === u.id : true;
}

/** Write the ledger heading to `targetScale` (only the active GM; a no-op when already heading there). */
function retarget(targetScale, rampSec) {
  if (!isLedgerWriter() || ledger.toScale === targetScale) return;
  const next = retargetWorldClockLedger(ledger, serverNowMs(), targetScale, rampSec);
  if (next === ledger) return;
  ledger = next; // this client follows at once; the write reaches the others
  try {
    void Promise.resolve(writeSetting(NAMESPACE, LEDGER_KEY, JSON.stringify(next))).catch(() => {});
  } catch (_) {
    // a failed write leaves the others on server time for this pause; nothing to recover.
  }
}

/**
 * Register the hidden setting. Call once in `init`. Idempotent.
 * @returns {void}
 */
export function registerWorldClockSettings() {
  if (registered) return;
  registerSettings(
    NAMESPACE,
    [
      {
        key: LEDGER_KEY,
        scope: 'world',
        kind: 'string',
        default: '',
        config: false,
        name: 'Shared world clock (internal)',
        hint: 'When the world last paused or resumed. Written by the GM; read by every client.',
      },
    ],
    { onChange: () => reload() }
  );
  registered = true;
  reload();
}

/**
 * Follow Foundry's pause. Call once at `ready`. The active GM records every
 * pause (ease to 0) and unpause (ease to 1); at ready it also squares the ledger
 * with the pause state the world actually loaded in — at once, the same as the
 * frame clock's own first sync (a world that loads paused is simply stopped).
 * @returns {() => void} unsubscribe.
 */
export function watchWorldClock() {
  reload();
  if (typeof Hooks === 'undefined') return () => {};
  const paused = !!game?.paused;
  if (paused && ledger.toScale !== 0) retarget(0, 0);
  else if (!paused && ledger.toScale !== 1) retarget(1, 0);
  if (pauseHookId === null) {
    pauseHookId = Hooks.on('pauseGame', (isPaused) => {
      try {
        retarget(isPaused ? 0 : 1);
      } catch (_) {
        // mid-teardown; nothing to recover.
      }
    });
  }
  return () => {
    try {
      if (pauseHookId !== null) Hooks.off('pauseGame', pauseHookId);
    } catch (_) {
      // already gone.
    }
    pauseHookId = null;
  };
}
