/**
 * @fileoverview foundry/prepare-coordinator.js — the GM side of "prepare the scene
 * on every client, THEN switch" (loading audit, 2026-10-25, phase 4).
 *
 * ============================================================================
 * THE SHAPE OF IT
 * ============================================================================
 * Activating a scene is a table-wide event: Foundry tells every client, and each
 * one loads on its own (`F:documents/scene.mjs:1413` — every client's `_onActivate`
 * calls its own `view`). Nothing makes them ready at the same time, so the slowest
 * client decides when the table has a working screen.
 *
 * So before the GM's activation reaches Foundry, the GM client asks every connected
 * player to PREPARE the scene, and waits for the ones that will answer. This module
 * is the waiting: a session per request, and the ways it can end.
 *
 * TWO ROUNDS, because a player without Map Shine installed never answers, and a
 * wait that runs out for them would hold every scene change for the whole wait:
 *
 *   1. PRESENCE (`presenceMs`): each player who has the module says "here" the moment
 *      the request arrives, before any work. Only those who said so are waited for.
 *   2. READY: the GM waits for each present player's "ready" (or the overall timeout).
 *
 * Ends:
 *
 *   all-ready      every present player answered ready
 *   timeout        the GM's chosen wait ran out; the switch goes ahead regardless
 *   cancelled      the GM changed their mind; the scene is NOT activated
 *   superseded     a newer request replaced this one
 *   no-recipients  nobody to wait for (nobody connected, or nobody with the module)
 *
 * There is NO manual override. The switch goes ahead on its own when the table is
 * ready or the wait runs out; the GM's one way out is cancel. (A "Switch now" button
 * existed and was removed on the author's request, 2026-10-25.)
 *
 * It never decides policy: whether to wait at all, for how long and what to show
 * are the caller's. Pure — injectable clock, no Foundry — Node-tested.
 *
 * @module foundry/prepare-coordinator
 */

/** The message types this feature puts on the module socket. */
export const PREPARE_MESSAGE = Object.freeze({
  /** GM -> players: warm this scene. */
  REQUEST: 'scene-prepare',
  /** player -> GM: I am here, and I have the module. Sent before any work. */
  PRESENT: 'scene-present',
  /** player -> GM: I have warmed it. */
  READY: 'scene-ready',
  /** GM -> players: never mind (the activation was cancelled). */
  CANCEL: 'scene-prepare-cancel',
});

/**
 * @typedef {'all-ready'|'timeout'|'cancelled'|'superseded'|'no-recipients'} PrepareEnd
 * @typedef {{ready: string[], missing: string[], total: number, phase: 'presence'|'ready'|'done'}} PrepareSnapshot
 */

/**
 * @param {object} [deps]
 * @param {(fn: Function, ms: number) => any} [deps.setTimer]
 * @param {(h: any) => void} [deps.clearTimer]
 */
export function createPrepareCoordinator({
  setTimer = (fn, ms) => setTimeout(fn, ms),
  clearTimer = (h) => clearTimeout(h),
} = {}) {
  /** @type {null|{token: string, session: object, finish: (reason: PrepareEnd) => void, handlePresent: (u: string) => void}} */
  let active = null;

  return {
    /**
     * Start waiting. Only one session at a time: a new one supersedes the old.
     *
     * @param {object} args
     * @param {string} args.token - ties replies to THIS request (a late reply to an earlier one is ignored)
     * @param {string[]} args.recipients - user ids asked to prepare
     * @param {number} [args.presenceMs] - if > 0, a presence round of this length runs first and only players
     *   who said "here" in it are waited for. 0 or omitted: everyone in `recipients` must answer ready.
     * @param {number} [args.timeoutMs] - the READY wait's limit; 0, Infinity or omitted = as long as it takes
     * @param {(s: PrepareSnapshot) => void} [args.onChange]
     * @returns {{
     *   token: string,
     *   promise: Promise<{reason: PrepareEnd, ready: string[], missing: string[]}>,
     *   markReady: (userId: string) => boolean,
     *   cancel: () => void,
     *   status: () => PrepareSnapshot & {done: boolean}
     * }}
     */
    begin({ token, recipients, presenceMs = 0, timeoutMs = 0, onChange }) {
      active?.finish('superseded');

      const candidates = new Set(recipients);
      /** @type {Set<string>} players still owed a ready (the READY phase) */
      let owed = new Set();
      let total = 0;
      const ready = [];
      /** @type {Set<string>} players who said "here" in the presence round */
      const present = new Set();
      let phase = presenceMs > 0 ? 'presence' : 'ready';
      let done = false;
      let presenceTimer = null;
      let waitTimer = null;
      /** @type {(v: any) => void} */
      let resolve = () => {};
      const promise = new Promise((r) => {
        resolve = r;
      });

      const snapshot = () => ({ ready: [...ready], missing: [...owed], total, phase: done ? 'done' : phase });

      const finish = (reason) => {
        if (done) return;
        done = true;
        if (presenceTimer !== null) clearTimer(presenceTimer);
        if (waitTimer !== null) clearTimer(waitTimer);
        if (active?.token === token) active = null;
        resolve({ reason, ready: [...ready], missing: [...owed] });
      };

      /** The READY phase: owe a ready to everyone in `who`, and arm the wait's own timeout. */
      const enterReadyPhase = (who) => {
        phase = 'ready';
        presenceTimer = null;
        owed = new Set(who);
        total = owed.size;
        if (total === 0) {
          finish('no-recipients');
          return;
        }
        onChange?.(snapshot());
        if (Number.isFinite(timeoutMs) && timeoutMs > 0) waitTimer = setTimer(() => finish('timeout'), timeoutMs);
      };
      /** The presence round ended: wait only for the players who said "here". */
      const startReadyPhase = () => {
        if (done || phase !== 'presence') return;
        enterReadyPhase(present);
      };

      const session = {
        token,
        promise,
        markReady(userId) {
          if (done || phase !== 'ready' || !owed.has(userId)) return false;
          owed.delete(userId);
          ready.push(userId);
          onChange?.(snapshot());
          if (owed.size === 0) finish('all-ready');
          return true;
        },
        cancel: () => finish('cancelled'),
        status: () => ({ ...snapshot(), done }),
      };

      active = {
        token,
        session,
        finish,
        handlePresent(userId) {
          if (done || phase !== 'presence' || !candidates.has(userId) || present.has(userId)) return false;
          present.add(userId);
          return true;
        },
      };

      if (candidates.size === 0) {
        finish('no-recipients');
      } else if (phase === 'presence') {
        presenceTimer = setTimer(startReadyPhase, presenceMs);
      } else {
        enterReadyPhase(candidates);
      }
      return session;
    },

    /**
     * A PRESENT message arrived from a player.
     * @param {{token?: string, userId?: string}} msg
     * @returns {boolean} whether it counted toward the current session
     */
    handlePresent(msg) {
      if (!active || msg?.token !== active.token || typeof msg.userId !== 'string') return false;
      return active.handlePresent(msg.userId);
    },

    /**
     * A READY message arrived from a player.
     * @param {{token?: string, userId?: string}} msg
     * @returns {boolean} whether it advanced the current session
     */
    handleReady(msg) {
      if (!active || msg?.token !== active.token || typeof msg.userId !== 'string') return false;
      return active.session.markReady(msg.userId);
    },

    /** The live session, if any (for diagnostics). */
    getActive: () => (active ? { token: active.token, ...active.session.status() } : null),
  };
}
