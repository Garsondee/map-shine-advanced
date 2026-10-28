/**
 * @fileoverview foundry/scene-prepare-channel.js — the module-socket transport for
 * "prepare this scene" (loading audit, 2026-10-25, phase 4).
 *
 * Just transport, like `impulse-broadcast.js` — it carries a scene id and a token,
 * never behaviour. What a client DOES with a request (warm its caches, show its own
 * notification) is the receiver's decision, so a player's own settings and
 * capabilities (MSA off, no WebGPU, a scene it may not see) still decide. It shares
 * the channel `module.json` declares (`"socket": true`) with the impulse and
 * player-aim features; each filters on its own `type`.
 *
 * TRUST: a REQUEST or CANCEL is honoured only if its claimed sender is a GM — the
 * server relays the payload as-is, so a `from` field alone proves nothing, and the
 * check is made against the user record Foundry holds. A READY is honoured only
 * from a user the GM actually asked (that check lives in the coordinator).
 *
 * Registration happens at `ready`: like the other two socket features, the
 * socket does not exist before then. A client still loading when a request arrives
 * simply does not answer; the GM's bounded wait covers it.
 *
 * Nothing here throws.
 *
 * @module foundry/scene-prepare-channel
 */

import { createLogger } from '../core/log.js';
import { PREPARE_MESSAGE } from './prepare-coordinator.js';

const log = createLogger('scene-prepare-channel');

const SOCKET_NAME = 'module.map-shine-advanced';

/** A random id tying replies to one request. */
export function newPrepareToken() {
  return globalThis.foundry?.utils?.randomID?.(12) ?? Math.random().toString(36).slice(2, 14);
}

/**
 * Who a GM request should go to: every connected non-GM user.
 * @returns {string[]}
 */
export function listActivePlayerIds() {
  try {
    if (typeof game === 'undefined' || !game.users) return [];
    return game.users.filter((u) => u.active && !u.isGM && u.id !== game.user?.id).map((u) => u.id);
  } catch (err) {
    log.error('could not list connected players:', err);
    return [];
  }
}

/** @param {string} userId @returns {string} a display name, or the id. */
export function userDisplayName(userId) {
  try {
    return game.users?.get?.(userId)?.name ?? userId;
  } catch {
    return userId;
  }
}

/** Am I a GM? @returns {boolean} */
export function currentUserIsGM() {
  return typeof game !== 'undefined' && !!game.user?.isGM;
}

/** My user id, or null. @returns {string|null} */
export function currentUserId() {
  return typeof game !== 'undefined' ? (game.user?.id ?? null) : null;
}

/** @param {string} sceneId @returns {object|null} the Scene document, or null. */
export function findScene(sceneId) {
  try {
    return game.scenes?.get?.(sceneId) ?? null;
  } catch (err) {
    log.error(`could not look up scene ${sceneId}:`, err);
    return null;
  }
}

/** The id of the scene this client is drawing right now, or null. @returns {string|null} */
export function currentSceneId() {
  return globalThis.canvas?.scene?.id ?? null;
}

/**
 * A scene's name as THIS user may see it in an announcement: the GM sees it, a player
 * NEVER does (2026-10-28 — "we don't want to announce to players where they are going
 * next"). Foundry's own loading bar is looser (`F:canvas/loader.mjs:263-264` also names
 * an active/visible scene); ours is deliberately stricter. Returns `null` for a player,
 * and callers word their message without a name (see `formatPrepareMessage`).
 * @param {object} scene @returns {string|null}
 */
export function sceneNameForUser(scene) {
  try {
    if (!game.user?.isGM) return null;
    return scene.navName || scene.name || 'the next scene';
  } catch (err) {
    log.error('could not work out a scene name for the notification:', err);
    return null;
  }
}

function emit(message, recipients) {
  try {
    if (typeof game === 'undefined' || !game.socket) return { ok: false, reason: 'no socket' };
    game.socket.emit(SOCKET_NAME, message, { recipients });
    return { ok: true, reason: null };
  } catch (err) {
    log.error(`could not send a ${message?.type} message:`, err);
    return { ok: false, reason: String(err?.message ?? err) };
  }
}

/**
 * GM -> players: warm this scene.
 * @param {{token: string, sceneId: string, levelId?: string|null, recipients: string[]}} args
 */
export function sendPrepareRequest({ token, sceneId, levelId = null, recipients }) {
  return emit({ type: PREPARE_MESSAGE.REQUEST, token, sceneId, levelId, from: currentUserId() }, recipients);
}

/** player -> GM: I am here and have the module (sent the moment a request arrives, before any work).
 * @param {{token: string, gmUserId: string}} args */
export function sendPrepareHere({ token, gmUserId }) {
  return emit({ type: PREPARE_MESSAGE.PRESENT, token, userId: currentUserId() }, [gmUserId]);
}

/** player -> GM: ready. @param {{token: string, gmUserId: string, ok?: boolean}} args */
export function sendPrepareReady({ token, gmUserId, ok = true }) {
  return emit({ type: PREPARE_MESSAGE.READY, token, userId: currentUserId(), ok }, [gmUserId]);
}

/** GM -> players: never mind. @param {{token: string, recipients: string[]}} args */
export function sendPrepareCancel({ token, recipients }) {
  return emit({ type: PREPARE_MESSAGE.CANCEL, token, from: currentUserId() }, recipients);
}

/**
 * Start listening. Call once, at `ready`.
 *
 * @param {object} handlers
 * @param {(m: {token: string, sceneId: string, levelId: string|null, from: string}) => void} handlers.onRequest
 * @param {(m: {token: string, userId: string}) => void} handlers.onPresent
 * @param {(m: {token: string, userId: string}) => void} handlers.onReady
 * @param {(m: {token: string}) => void} handlers.onCancel
 * @returns {boolean} whether the listener was installed.
 */
export function listenForPrepareMessages({ onRequest, onPresent, onReady, onCancel }) {
  try {
    if (typeof game === 'undefined' || !game.socket) return false;
    game.socket.on(SOCKET_NAME, (msg) => {
      try {
        if (!msg || typeof msg.token !== 'string') return;
        if (msg.type === PREPARE_MESSAGE.REQUEST) {
          if (typeof msg.sceneId !== 'string') return;
          if (!game.users?.get(msg.from)?.isGM) return; // only a GM can ask a table to prepare
          onRequest?.({ token: msg.token, sceneId: msg.sceneId, levelId: msg.levelId ?? null, from: msg.from });
        } else if (msg.type === PREPARE_MESSAGE.PRESENT) {
          if (typeof msg.userId !== 'string') return;
          onPresent?.({ token: msg.token, userId: msg.userId });
        } else if (msg.type === PREPARE_MESSAGE.READY) {
          if (typeof msg.userId !== 'string') return;
          onReady?.({ token: msg.token, userId: msg.userId });
        } else if (msg.type === PREPARE_MESSAGE.CANCEL) {
          if (!game.users?.get(msg.from)?.isGM) return;
          onCancel?.({ token: msg.token });
        }
      } catch (err) {
        log.error('handling a scene-prepare message failed:', err);
      }
    });
    return true;
  } catch (err) {
    log.error('could not listen for scene-prepare messages:', err);
    return false;
  }
}
