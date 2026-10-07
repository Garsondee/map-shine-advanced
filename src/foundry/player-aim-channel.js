/**
 * PLAYER AIM CHANNEL — THE LIVE HALF of "a carried flashlight points where its
 * bearer's cursor points" (mythica-machina-press#77). Every decision it makes is
 * delegated to `player-aim.js` (pure, Node-tested); this file only touches the
 * world: Foundry's pointer, the module socket, a timer, the viewing user.
 *
 * ONE INSTANCE PER CLIENT (`createPlayerAimChannel`, owned by boot.js), doing
 * three jobs:
 *
 *   1. ANNOTATE (`annotate`, every frame, from the light-source getter): stamp
 *      each aimable carried light's snapshot with `aimAngleDeg` — from THIS
 *      client's own cursor if the token is the one this user aims, else from
 *      the angle its own client relayed. No aim known → the field stays unset
 *      and `player-light-geometry.js` falls back to the token's stored rotation.
 *   2. SEND (`tick`, every `AIM_SENDER_TICK_MS`, from a timer — NOT from the
 *      frame loop, so a stalled renderer or a hidden tab cannot starve it): if
 *      this user is aiming, put the angle on the module socket under
 *      `player-aim.js#createAimSendPolicy`'s rules.
 *   3. RECEIVE (`handleMessage`, from the socket): keep every OTHER bearer's
 *      latest angle, after checking the sender really owns that token.
 *
 * THE CURSOR IS FOUNDRY'S, NOT OURS. "Foundry owns all input" is a locked
 * decision here (`scene-occlusion-sources.js#readMouseHoverPoint`'s header), so
 * this reads `canvas.mousePosition` — a world-space point Foundry updates on
 * every pointermove over the board and re-derives after every camera pan
 * (`Canvas#pan` emulates a move) — instead of adding a second DOM listener that
 * would have to re-solve client→world conversion. Two consequences worth
 * knowing:
 *   - Foundry starts it at (0, 0) and only moves it on a real pointermove, so
 *     exactly (0, 0) means "no pointer seen yet", never a real cursor.
 *   - With the pointer parked over the sidebar or a dialog Foundry stops
 *     updating it, so the beam holds the last on-canvas aim — what a player
 *     expects — rather than swinging toward the UI.
 * The fog gates `canvas.mousePositionVisible/Explored` are deliberately NOT
 * applied: aiming a flashlight into unexplored dark is the whole point, and a
 * direction reveals nothing the beam does not.
 *
 * WHO AIMS: a non-GM client aims exactly `resolveViewerToken()` — the token the
 * carried-light picker writes to, so "the token I picked a flashlight for" and
 * "the token my cursor steers" cannot drift. A GM aims nothing: the picker
 * already says a GM has no personal carried light, and a GM who selected a
 * player's token to read its sheet must not be able to drag that player's beam
 * around with a mouse. A flashlight on some other token (set by hand or macro)
 * keeps following its stored rotation.
 *
 * WHO IS BELIEVED: a message is accepted only from a user that owns the token it
 * names (`testUserPermission(sender, 'OWNER')`), checked against the sender id
 * the message itself carries — the same convention `impulse-broadcast.js` uses.
 * That stops accidental cross-talk and a player steering someone else's light;
 * it is not authentication (the id is self-declared), which is fine for data
 * whose only effect is where a beam points.
 *
 * NOTHING HERE THROWS INTO THE RENDER LOOP. `annotate` runs inside the
 * per-frame light getter, and a throw there kills the loop for everyone — it
 * already did once today (`a0402af8`, a null animation on this same flashlight).
 * So `annotate` and the timer's tick catch, log ONCE per distinct fault (not at
 * 20 Hz), and carry on with the stored rotation.
 *
 * @module foundry/player-aim-channel
 */

import { createLogger } from '../core/log.js';
import { perfNowMs } from '../core/frame-clock.js';
import { readMouseHoverPoint } from './scene-occlusion-sources.js';
import { resolveViewerToken, isViewingUserGM } from './viewer-token.js';
import { readActivePlayerCarriedLightTokens } from './player-light-mode.js';
import { readScenePlayerLightPermissions } from './player-light-permissions.js';
import {
  PLAYER_AIM_MODES,
  AIM_MESSAGE_TYPE,
  encodeAimMessage,
  decodeAimMessage,
  createLocalAimTracker,
  createAimSendPolicy,
  createRemoteAimStore,
} from './player-aim.js';

const log = createLogger('player-aim');

/** The module socket `module.json` declares (`"socket": true`) — shared with `impulse-broadcast.js`. */
const SOCKET_NAME = 'module.map-shine-advanced';

/**
 * How often the sender looks at the bearer's aim. Finer than the policy's
 * 100 ms rate cap on purpose, so the cap — not the timer's phase — decides the
 * cadence (a 100 ms timer against a 100 ms cap would send every 200 ms half the
 * time).
 */
export const AIM_SENDER_TICK_MS = 50;

/** `annotate` has not yet looked up this frame's aiming token. */
const UNRESOLVED = Symbol('unresolved');

/**
 * @param {object} [options] - every option is a test seam; production passes none.
 * @param {() => number} [options.now] - monotonic milliseconds (`core/frame-clock.js#perfNowMs`).
 * @param {(fn: () => void, ms: number) => *} [options.setIntervalFn]
 * @param {(handle: *) => void} [options.clearIntervalFn]
 */
export function createPlayerAimChannel({
  now = perfNowMs,
  setIntervalFn = (fn, ms) => setInterval(fn, ms),
  clearIntervalFn = (handle) => clearInterval(handle),
} = {}) {
  const tracker = createLocalAimTracker();
  const store = createRemoteAimStore();
  const policy = createAimSendPolicy();

  const stats = { sent: 0, received: 0, rejected: {}, errors: 0 };
  let timer = null;
  let socketHandler = null;
  let lastErrorMessage = null;

  function reject(reason) {
    stats.rejected[reason] = (stats.rejected[reason] ?? 0) + 1;
    return false;
  }

  /** Log a fault once per distinct message — a persistent one must not flood the flight recorder. */
  function noteError(where, err) {
    const message = `${err?.message ?? err}`;
    if (message === lastErrorMessage) return;
    lastErrorMessage = message;
    stats.errors += 1;
    log.error(`${where} failed (the stored token rotation is used instead):`, err);
  }

  /** @returns {{x: number, y: number}|null} the cursor in world space, or `null` if Foundry has not seen one. */
  function readCursorWorld() {
    const point = readMouseHoverPoint();
    if (!point) return null;
    if (point.x === 0 && point.y === 0) return null; // Foundry's un-moved default — see this file's header
    return { x: point.x, y: point.y };
  }

  /** @returns {string|null} the token this client's cursor steers, or `null` (a GM, or no token). */
  function resolveLocalAimTokenId() {
    if (isViewingUserGM()) return null;
    const token = resolveViewerToken();
    return token?.document?.id ?? token?.id ?? null;
  }

  function hasPeers() {
    return game.users?.some?.((user) => user.active && !user.isSelf) === true;
  }

  /**
   * Stamp `aimAngleDeg` onto every aimable carried light's snapshot, IN PLACE —
   * the snapshots are this frame's own fresh objects
   * (`readActivePlayerCarriedLightTokens` builds them per call).
   * @param {Array<{tokenId: string, x: number, y: number, mode: string, aimAngleDeg?: number}>} snapshots
   * @returns {Array} the same array.
   */
  function annotate(snapshots) {
    if (!Array.isArray(snapshots) || snapshots.length === 0) return snapshots;
    try {
      const nowMs = now();
      let localId = UNRESOLVED;
      let cursor;
      for (const snap of snapshots) {
        if (!PLAYER_AIM_MODES.includes(snap?.mode)) continue;
        if (localId === UNRESOLVED) localId = resolveLocalAimTokenId();
        let angle;
        if (snap.tokenId === localId) {
          if (cursor === undefined) cursor = readCursorWorld();
          angle = tracker.update(snap.tokenId, snap, cursor);
        } else {
          angle = store.sample(snap.tokenId, nowMs);
        }
        if (angle !== null) snap.aimAngleDeg = angle;
      }
    } catch (err) {
      noteError('annotating player aim', err);
    }
    return snapshots;
  }

  /**
   * Only reached with a live `game.socket` (see `tick`).
   * @returns {boolean} whether a message went out.
   */
  function emit(tokenId, angleDeg) {
    const msg = encodeAimMessage({ tokenId, angleDeg, userId: game.user?.id });
    if (!msg) return reject('unencodable');
    const socket = game.socket;
    // `volatile`: a stale aim must be dropped, not queued behind a reconnect —
    // the same choice Foundry makes for its own cursor activity (`User#broadcastActivity`).
    (socket.volatile ?? socket).emit(SOCKET_NAME, msg);
    stats.sent += 1;
    return true;
  }

  /**
   * One sender step.
   * @param {number} [nowMs]
   * @returns {boolean} whether a message went out.
   */
  function tick(nowMs = now()) {
    store.prune(nowMs);
    if (typeof game === 'undefined' || !game?.socket) return false;
    const localId = resolveLocalAimTokenId();
    if (!localId) return false;
    const snap = readActivePlayerCarriedLightTokens().find((s) => s.tokenId === localId);
    if (!snap || !PLAYER_AIM_MODES.includes(snap.mode)) return false;
    const { permissions } = readScenePlayerLightPermissions();
    if (permissions.modes?.[snap.mode] !== true) return false;
    if (!hasPeers()) {
      policy.reset(); // alone at the table: say nothing, and say it all the moment someone joins
      return false;
    }
    const angle = tracker.update(localId, snap, readCursorWorld());
    if (angle === null) return false; // no cursor yet — everyone keeps the stored rotation
    const toSend = policy.decide(localId, angle, nowMs);
    if (toSend === null) return false;
    return emit(localId, toSend);
  }

  /**
   * One incoming socket message (any feature's — the socket is shared).
   * @param {*} raw
   * @returns {boolean} whether it was this feature's and was accepted.
   */
  function handleMessage(raw) {
    if (raw?.type !== AIM_MESSAGE_TYPE) return false; // another feature's message — not ours to count
    const msg = decodeAimMessage(raw);
    if (!msg) return reject('malformed');
    if (typeof game === 'undefined' || typeof canvas === 'undefined') return reject('no-world');
    if (msg.userId === game.user?.id) return reject('own-echo');
    const sender = game.users?.get?.(msg.userId);
    if (!sender) return reject('unknown-sender');
    const token = canvas.tokens?.get?.(msg.tokenId);
    if (!token?.document) return reject('unknown-token'); // not on the scene this client is viewing
    // Fail closed: a missing method reads as "not the owner".
    if (!token.document.testUserPermission?.(sender, 'OWNER')) return reject('not-owner');
    if (!store.receive(msg.tokenId, msg.angleDeg, now())) return reject('unstorable');
    stats.received += 1;
    return true;
  }

  /**
   * Start listening and sending. Call once, at `ready` (the socket does not
   * exist before then). Idempotent.
   * @returns {boolean} whether the channel is running.
   */
  function start() {
    if (typeof game === 'undefined' || !game?.socket) return false;
    if (socketHandler === null) {
      socketHandler = (raw) => {
        try {
          handleMessage(raw);
        } catch (err) {
          noteError('handling a player-aim message', err);
        }
      };
      game.socket.on(SOCKET_NAME, socketHandler);
    }
    if (timer === null) {
      timer = setIntervalFn(() => {
        try {
          tick();
        } catch (err) {
          noteError('the player-aim sender', err);
        }
      }, AIM_SENDER_TICK_MS);
    }
    return true;
  }

  function stop() {
    if (timer !== null) clearIntervalFn(timer);
    timer = null;
    if (socketHandler && typeof game !== 'undefined') game.socket?.off?.(SOCKET_NAME, socketHandler);
    socketHandler = null;
    store.clear();
    policy.reset();
    tracker.reset();
  }

  /** A readout for the console (`MapShine.playerAimStats()`) — what has this client sent, heard and refused, and why. */
  function getStats() {
    return {
      running: timer !== null,
      sent: stats.sent,
      received: stats.received,
      rejected: { ...stats.rejected },
      errors: stats.errors,
      remoteTokens: store.size,
    };
  }

  return { annotate, tick, handleMessage, start, stop, getStats };
}
