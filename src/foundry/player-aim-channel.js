/**
 * PLAYER AIM CHANNEL — THE LIVE HALF of "a carried light follows its bearer's
 * cursor" (mythica-machina-press#77): a flashlight's beam POINTS at it, a torch
 * is HELD OUT at it. Every decision it makes is
 * delegated to `player-aim.js` (pure, Node-tested); this file only touches the
 * world: Foundry's pointer, the module socket, a timer, the viewing user.
 *
 * ONE INSTANCE PER CLIENT (`createPlayerAimChannel`, owned by boot.js), doing
 * three jobs:
 *
 *   1. ANNOTATE (`annotate`, every frame, from the light-source getter AND the
 *      torch-flame getter): stamp each aimable carried light's snapshot with
 *      `aimAngleDeg` (and, for a torch, `offsetX/Y`, where its bearer holds it)
 *      — from THIS client's own cursor if the token is the one this user aims,
 *      else from the aim its own client relayed. No aim known → the fields stay
 *      unset and `player-light-geometry.js` falls back to the token's stored
 *      rotation (flashlight) or the token's centre (torch).
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
 * A TORCH GUTTERS when the cursor is dragged past that leash: its burn falls from
 * full to nothing over 3 more grid squares (a dimmer, smaller light and flame),
 * and once it is out it stays out until the cursor touches its bearer. The owner's
 * client keeps that memory and relays the burn, so every screen shows one torch.
 *
 * A HELD TORCH'S REACH is as far as the cursor, no further than 6 grid squares,
 * and stopping 12 px short of the first wall that blocks movement
 * (`Token#checkCollision`). The OWNER's client works that out once and relays
 * the result, so every screen agrees where the torch is; the owner's own torch
 * is eased toward it (an arm, not a laser pointer).
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
import { readMouseHoverPoint, readGridSizePixels } from './scene-occlusion-sources.js';
import { resolveViewerToken, isViewingUserGM } from './viewer-token.js';
import { readActivePlayerCarriedLightTokens } from './player-light-mode.js';
import { readScenePlayerLightPermissions } from './player-light-permissions.js';
import {
  PLAYER_AIM_MODES,
  PLAYER_AIM_REACH_MODES,
  PLAYER_AIM_HELD_MODES,
  AIM_FLASHLIGHT_REACH_CAP_PX,
  AIM_MESSAGE_TYPE,
  AIM_TORCH_LEASH_SQUARES,
  AIM_TORCH_EASE_TAU_MS,
  AIM_TORCH_FADE_SQUARES,
  AIM_TORCH_TOUCH_MARGIN_PX,
  encodeAimMessage,
  decodeAimMessage,
  clampTorchReachPx,
  offsetFromAim,
  createLocalAimTracker,
  createTorchBurn,
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
  // The bearer's OWN held torch is eased through the same machinery other
  // bearers' aims are: each frame's target is `receive`d and `sampleAim`ed, so
  // the torch lags the cursor like an arm instead of snapping to it.
  const torchEase = createRemoteAimStore({ tauMs: AIM_TORCH_EASE_TAU_MS, maxEntries: 8 });
  const policy = createAimSendPolicy();
  const torchBurn = createTorchBurn();
  /** The wall test for the same (origin, destination) is asked every frame the cursor is still. */
  let wallMemo = { key: null, hitPx: null };

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
    log.error(`${where} failed:`, err);
  }

  /** @returns {{x: number, y: number}|null} the cursor in world space, or `null` if Foundry has not seen one. */
  function readCursorWorld() {
    const point = readMouseHoverPoint();
    if (!point) return null;
    if (point.x === 0 && point.y === 0) return null; // Foundry's un-moved default — see this file's header
    return { x: point.x, y: point.y };
  }

  /** @returns {object|null} the Token this client's cursor steers, or `null` (a GM, or no token). */
  function resolveLocalAimToken() {
    if (isViewingUserGM()) return null;
    return resolveViewerToken();
  }

  const tokenIdOf = (token) => token?.document?.id ?? token?.id ?? null;

  /**
   * How far along `from -> to` the first wall that blocks MOVEMENT is, or `null`
   * if the way is clear. Foundry's own `Token#checkCollision` (v14: level- and
   * elevation-aware, and independent of the token's animation). A fault is
   * logged once and reads as "no wall" - a torch that can briefly reach through
   * a wall is a smaller harm than no torch.
   */
  function readWallHitDistancePx(token, from, to) {
    const key = `${Math.round(from.x)},${Math.round(from.y)}>${Math.round(to.x)},${Math.round(to.y)}`;
    if (wallMemo.key === key) return wallMemo.hitPx;
    let hitPx = null;
    try {
      const hit = token?.checkCollision?.(
        { x: to.x, y: to.y },
        { origin: { x: from.x, y: from.y }, type: 'move', mode: 'closest' }
      );
      if (hit && Number.isFinite(hit.x) && Number.isFinite(hit.y)) hitPx = Math.hypot(hit.x - from.x, hit.y - from.y);
    } catch (err) {
      noteError('testing a held torch against walls', err);
    }
    wallMemo = { key, hitPx };
    return hitPx;
  }

  /**
   * What the bearer's cursor asks of their own light right now: a bearing, and
   * for a held torch the reach - as far as the cursor, no further than the
   * leash, stopping short of the first wall. `null` until a cursor has been seen.
   * Shared by the renderer (`annotate`) and the sender (`tick`), so what this
   * client draws and what everyone else is told come from one calculation.
   * @returns {{angleDeg: number, reachPx: number|null, burn01: number|null}|null}
   */
  function localAimTarget(token, snap) {
    const cursor = readCursorWorld();
    const angleDeg = tracker.update(snap.tokenId, snap, cursor);
    if (angleDeg === null) return null;
    if (!PLAYER_AIM_REACH_MODES.includes(snap.mode)) return { angleDeg, reachPx: null, burn01: null };
    const cursorDistancePx = cursor ? Math.hypot(cursor.x - snap.x, cursor.y - snap.y) : 0;
    // A flashlight is not displaced, so walls do not clamp it (its light sweep
    // already stops at them); its reach just says how far away the cursor is.
    if (!PLAYER_AIM_HELD_MODES.includes(snap.mode)) {
      return { angleDeg, reachPx: Math.min(cursorDistancePx, AIM_FLASHLIGHT_REACH_CAP_PX), burn01: null };
    }
    const gridPx = readGridSizePixels().gridSizePixels;
    const leashPx = gridPx * AIM_TORCH_LEASH_SQUARES;
    // Dragged past the leash the torch gutters, and once out it only relights when
    // the cursor touches its bearer: the bearer's own radius, plus a margin.
    const doc = token?.document;
    const radiusPx = 0.5 * Math.min(Number(doc?.width) || 1, Number(doc?.height) || 1) * gridPx;
    const burn01 = torchBurn.update(snap.tokenId, {
      cursorDistancePx,
      leashPx,
      fadeBandPx: gridPx * AIM_TORCH_FADE_SQUARES,
      touchPx: radiusPx + AIM_TORCH_TOUCH_MARGIN_PX,
    });
    const wanted = Math.min(cursorDistancePx, leashPx);
    const end = offsetFromAim(angleDeg, wanted);
    const wallHitDistancePx =
      wanted > 0 ? readWallHitDistancePx(token, snap, { x: snap.x + end.x, y: snap.y + end.y }) : null;
    return { angleDeg, reachPx: clampTorchReachPx({ cursorDistancePx, leashPx, wallHitDistancePx }), burn01 };
  }

  function hasPeers() {
    return game.users?.some?.((user) => user.active && !user.isSelf) === true;
  }

  /**
   * Stamp every aimable carried light's snapshot with the aim to draw, IN PLACE -
   * the snapshots are this frame's own fresh objects
   * (`readActivePlayerCarriedLightTokens` builds them per call):
   *   - `aimAngleDeg`, the bearing (a flashlight's beam direction);
   *   - `reachPx`: how far the cursor is — a flashlight's beam is that long
   *     (`player-light-geometry.js#resolveBeamReach01`);
   *   - for a held torch also `offsetX`/`offsetY`, where its bearer holds it
   *     relative to their token (`player-light-geometry.js#resolveLightPosition`),
   *     and `burn01`, how brightly it burns — 1 until the cursor is dragged past
   *     the leash, falling to 0 (out) over the fade band.
   * Called by BOTH the light getter and the torch-flame getter each frame. That
   * is safe by construction: the ease is time-composable, so two calls a few
   * milliseconds apart each return the eased aim for their own instant - the
   * light and its flame differ by a sub-frame of travel, never accumulate error.
   * @param {Array<{tokenId: string, x: number, y: number, mode: string}>} snapshots
   * @returns {Array} the same array.
   */
  function annotate(snapshots) {
    if (!Array.isArray(snapshots) || snapshots.length === 0) return snapshots;
    try {
      const nowMs = now();
      let localToken = UNRESOLVED;
      for (const snap of snapshots) {
        if (!PLAYER_AIM_MODES.includes(snap?.mode)) continue;
        if (localToken === UNRESOLVED) localToken = resolveLocalAimToken();
        let aim = null;
        if (localToken && snap.tokenId === tokenIdOf(localToken)) {
          const target = localAimTarget(localToken, snap);
          if (target && !PLAYER_AIM_HELD_MODES.includes(snap.mode)) {
            aim = target; // a beam follows the cursor exactly - no lag
          } else if (target) {
            torchEase.receive(snap.tokenId, target.angleDeg, nowMs, target.reachPx, target.burn01);
            aim = torchEase.sampleAim(snap.tokenId, nowMs);
          }
        } else {
          aim = store.sampleAim(snap.tokenId, nowMs);
        }
        if (!aim) continue;
        snap.aimAngleDeg = aim.angleDeg;
        if (aim.reachPx !== null && PLAYER_AIM_REACH_MODES.includes(snap.mode)) {
          snap.reachPx = aim.reachPx;
          if (PLAYER_AIM_HELD_MODES.includes(snap.mode)) {
            if (aim.burn01 !== null) snap.burn01 = aim.burn01;
            const offset = offsetFromAim(aim.angleDeg, aim.reachPx);
            snap.offsetX = offset.x;
            snap.offsetY = offset.y;
          }
        }
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
  function emit(tokenId, angleDeg, reachPx, burn01) {
    const msg = encodeAimMessage({ tokenId, angleDeg, userId: game.user?.id, reachPx, burn01 });
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
    torchEase.prune(nowMs);
    if (typeof game === 'undefined' || !game?.socket) return false;
    const token = resolveLocalAimToken();
    const localId = tokenIdOf(token);
    if (!localId) return false;
    const snap = readActivePlayerCarriedLightTokens().find((s) => s.tokenId === localId);
    if (!snap || !PLAYER_AIM_MODES.includes(snap.mode)) return false;
    const { permissions } = readScenePlayerLightPermissions();
    if (permissions.modes?.[snap.mode] !== true) return false;
    if (!hasPeers()) {
      policy.reset(); // alone at the table: say nothing, and say it all the moment someone joins
      return false;
    }
    const target = localAimTarget(token, snap);
    if (!target) return false; // no cursor yet — everyone keeps the stored rotation
    const toSend = policy.decide(localId, target.angleDeg, nowMs, target.reachPx, target.burn01);
    if (toSend === null) return false;
    return emit(localId, toSend, target.reachPx, target.burn01);
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
    if (!store.receive(msg.tokenId, msg.angleDeg, now(), msg.reachPx, msg.burn01)) return reject('unstorable');
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
    torchEase.clear();
    wallMemo = { key: null, hitPx: null };
    policy.reset();
    tracker.reset();
    torchBurn.reset();
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
