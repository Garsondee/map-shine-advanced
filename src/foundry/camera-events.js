/**
 * CAMERA EVENTS (2026-11-08, mmp-ilo.10) — the game moments a camera operator would rack focus on: a token is
 * selected, a combat turn changes. The lens (vt-pan-viewer.js `rackLensFocus`) answers with a brief focus pull.
 * Foundry access stays in src/foundry (the adapter-only rule). Foundry v14 has no ping hook, so pings are not here.
 *
 * @module foundry/camera-events
 */

import { createLogger } from '../core/log.js';

const log = createLogger('camera-events');

/**
 * Call `onEvent(kind)` with 'select' when a token is selected and 'turn' when a combat turn changes.
 * Never throws; returns an unsubscribe.
 * @param {(kind: 'select'|'turn') => void} onEvent
 * @returns {() => void}
 */
export function watchCameraEvents(onEvent) {
  if (typeof onEvent !== 'function' || typeof Hooks === 'undefined') return () => {};
  const fire = (kind) => {
    try {
      onEvent(kind);
    } catch (err) {
      log.error('camera event handler failed:', err);
    }
  };
  const ids = [
    ['controlToken', Hooks.on('controlToken', (_token, controlled) => controlled && fire('select'))],
    ['combatTurnChange', Hooks.on('combatTurnChange', () => fire('turn'))],
  ];
  return () => {
    for (const [hook, id] of ids) {
      try {
        Hooks.off(hook, id);
      } catch (err) {
        log.error('camera event unhook failed:', err);
      }
    }
  };
}
