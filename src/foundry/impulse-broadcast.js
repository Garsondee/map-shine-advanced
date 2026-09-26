/**
 * IMPULSE BROADCAST — a GM's Remote/Studio impulse (Strike, Gust) reaching
 * every connected client, over the module socket `module.json` declares
 * (`"socket": true`). Until this existed (UI test pass, 2026-09-26) an
 * impulse ran only on the GM's own client: the GM saw the strike, the
 * players saw nothing.
 *
 * Deliberately just transport: it carries an impulse ID, never behaviour.
 * Each receiving client runs its OWN local fire for that id, so that
 * player's own settings (a photosensitive lock, no lightning on their floor)
 * still decide what they see. GM-sent only — a message naming a non-GM
 * sender is ignored on receipt. Nothing here throws.
 *
 * @module foundry/impulse-broadcast
 */

const SOCKET_NAME = 'module.map-shine-advanced';
const MESSAGE_TYPE = 'impulse';

/**
 * Send an impulse id to every OTHER connected client (Foundry's socket does
 * not echo to the sender). A no-op for a non-GM.
 * @param {string} id
 * @returns {{ok: boolean, reason: string|null}}
 */
export function broadcastImpulse(id) {
  try {
    if (typeof game === 'undefined' || !game.user?.isGM) return { ok: false, reason: 'only a GM broadcasts impulses' };
    if (!game.socket) return { ok: false, reason: 'no socket' };
    game.socket.emit(SOCKET_NAME, { type: MESSAGE_TYPE, id, userId: game.user.id });
    return { ok: true, reason: null };
  } catch (err) {
    return { ok: false, reason: `impulse broadcast failed: ${err?.message ?? err}` };
  }
}

/**
 * Listen for GM impulses from other clients. Call once, at `ready` (the
 * socket does not exist before then).
 * @param {(id: string) => void} onImpulse
 * @returns {boolean} whether the listener was installed.
 */
export function listenForImpulses(onImpulse) {
  try {
    if (typeof game === 'undefined' || !game.socket || typeof onImpulse !== 'function') return false;
    game.socket.on(SOCKET_NAME, (msg) => {
      if (msg?.type !== MESSAGE_TYPE || typeof msg.id !== 'string') return;
      if (!game.users?.get(msg.userId)?.isGM) return;
      onImpulse(msg.id);
    });
    return true;
  } catch (_) {
    return false;
  }
}
