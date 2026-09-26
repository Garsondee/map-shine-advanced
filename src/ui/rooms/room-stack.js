/**
 * ROOM STACKING — the Remote, Studio and Performance & Graphics rooms share
 * one z-index (100, each room's own CSS), so whichever was appended to the
 * page last always painted on top: opening the Studio while the Remote was
 * up left the Studio underneath it (UI test pass, 2026-09-26). `raiseRoom`
 * lifts one room a step above its siblings; each room calls it on open()
 * and on any press inside it, the usual "the window you touched comes
 * forward" rule. Popovers (wind, camera path, tile motion) sit at 400 and
 * stay above every room regardless.
 *
 * @module ui/rooms/room-stack
 */

const ROOM_IDS = ['msa-remote', 'msa-studio', 'msa-player'];

/** @param {HTMLElement} room */
export function raiseRoom(room) {
  for (const id of ROOM_IDS) {
    const el = document.getElementById(id);
    if (el) el.style.zIndex = el === room ? '101' : '100';
  }
}

/** Raise `room` whenever a press lands anywhere inside it (capture phase, so
 * a child that stops propagation can't prevent it). @param {HTMLElement} room */
export function raiseRoomOnPress(room) {
  room.addEventListener('pointerdown', () => raiseRoom(room), true);
}
