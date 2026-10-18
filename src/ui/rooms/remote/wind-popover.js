/**
 * ui/rooms/remote/wind-popover.js — the astrolabe dial's own wind pill opens
 * this (UI parity plan, phase 6a). `ui/astrolabe.js` has always had a real
 * drag-to-set wind arrow + strength slider directly on its dial; the new
 * dial (`astrolabe-dial.js`) shows wind only as a read-only pill — this is
 * the missing edit surface, a second door onto the exact same
 * `MapShine.setWind({directionDeg, speed01})` the old dial's own
 * `onWindDirectionChange`/`onWindSpeedChange` already call (boot.js), not a
 * second implementation.
 *
 * Shell/structure mirrors `camera-path-popover.js` — a small floating
 * window, same visual language — but the BODY is one row through the
 * SAME widget canon every other control in this codebase renders through
 * (`ui/widgets/param-control.js`'s `angle` type), not hand-built: an
 * `angle` control already IS a compass dial (`buildCompassRow`), which is
 * exactly what a "point the wind" control should look like, and it already
 * has the "live while dragging, commits on release" cadence the old dial's
 * own wind-direction handler explicitly needs (a full wind rebake per
 * pointermove would be far too expensive).
 *
 * ⚠️ DIRECTION ONLY (2026-08-27 fix, author live-testing round: "wind speed
 * should be one of the vertical sliders"). Strength used to live here too,
 * as a second `float` row — it now lives in `weather-board.js`'s own
 * Channels rack instead (see that file's own header for the full
 * reasoning), so this popover dropped its own copy rather than keep two
 * editable homes for the same value. An angle has no vertical-fader
 * equivalent, so direction stays exactly where it was.
 *
 * ⚠️ CLASSES, NOT INLINE STYLES (2026-10-18) — the window is styled in
 * `remote-style.js` with the same rules as the camera-path popover, so its close
 * button has a hover, a press and a focus ring; it opens scaled out of the corner
 * nearest the room it sits beside.
 *
 * @module ui/rooms/remote/wind-popover
 */

import { buildParamControl } from '../../widgets/param-control.js';
import { iconMarkup } from '../../widgets/icon-sprite.js';
import { replayClass } from '../room-style.js';
import { WIND_PANEL_ID } from './remote-style.js';

const PANEL_ID = WIND_PANEL_ID;

const DIRECTION_DECL = Object.freeze({
  type: 'angle',
  label: 'Direction',
  help: 'Which way the wind blows towards.',
});

/**
 * Install the Remote's wind popover, once.
 * @param {{getDirectionDeg?: () => number,
 *   onCommit?: (v: {directionDeg?: number}) => void,
 *   getAnchorRect?: () => DOMRect|null}} [ctx] - `getAnchorRect`: the opening
 *   room's rect; the popover sits beside it (else the fixed top-right spot).
 * @returns {{open: () => void, close: () => void, toggle: () => void, isOpen: () => boolean}}
 */
export function installWindPopover(ctx = {}) {
  if (document.getElementById(PANEL_ID)) return document.getElementById(PANEL_ID)._msaController;

  const win = document.createElement('div');
  win.id = PANEL_ID;
  win.hidden = true;

  const head = document.createElement('div');
  head.className = 'msa-pop-head';
  const title = document.createElement('span');
  title.className = 'msa-pop-title';
  title.innerHTML = `${iconMarkup('wind')}Wind`;
  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'hbtn';
  closeBtn.title = 'Close';
  closeBtn.innerHTML = iconMarkup('x');
  closeBtn.addEventListener('click', () => controller.close());
  head.append(title, closeBtn);

  const bodyHost = document.createElement('div');
  win.append(head, bodyHost);
  document.body.appendChild(win);

  // Rebuilt fresh every open() — the SAME "never a captured readout" rule
  // every other room in this codebase already follows, so a value changed
  // elsewhere (the old panel's own wind slider, a door/gust impulse) is
  // never shown stale the next time this popover opens.
  function render() {
    bodyHost.innerHTML = '';
    bodyHost.append(
      buildParamControl('windDirectionDeg', DIRECTION_DECL, {
        value: ctx.getDirectionDeg?.() ?? 0,
        onChange: (v) => ctx.onCommit?.({ directionDeg: v }),
      })
    );
  }

  // Beside the room that opened it, when the caller says where that is
  // (UI test pass, 2026-09-26): the fixed top-right fallback sat over
  // Foundry's own sidebar, a whole screen away from the wind pill. It grows out of
  // the corner facing the room (a popover scales from its trigger).
  function place() {
    const r = ctx.getAnchorRect?.();
    if (!r || !(r.width > 0)) return;
    const w = win.offsetWidth || 220;
    const fitsRight = r.right + 8 + w <= window.innerWidth - 8;
    const left = fitsRight ? r.right + 8 : Math.max(8, r.left - 8 - w);
    Object.assign(win.style, {
      left: `${left}px`,
      right: 'auto',
      top: `${Math.max(8, r.top + 48)}px`,
      transformOrigin: fitsRight ? '0 0' : '100% 0',
    });
  }

  const controller = {
    open() {
      render();
      win.hidden = false;
      place();
      replayClass(win, 'msa-pop-enter');
    },
    close() {
      win.hidden = true;
    },
    toggle() {
      if (win.hidden) controller.open();
      else controller.close();
    },
    isOpen: () => !win.hidden,
  };
  win._msaController = controller;
  return controller;
}
