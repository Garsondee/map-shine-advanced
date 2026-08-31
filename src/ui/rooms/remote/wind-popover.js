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
 * @module ui/rooms/remote/wind-popover
 */

import { buildParamControl } from '../../widgets/param-control.js';
import { iconMarkup } from '../../widgets/icon-sprite.js';

const PANEL_ID = 'msa-remote-wind';

const DIRECTION_DECL = Object.freeze({
  type: 'angle',
  label: 'Direction',
  help: 'Which way the wind blows towards.',
});

/**
 * Install the Remote's wind popover, once.
 * @param {{getDirectionDeg?: () => number,
 *   onCommit?: (v: {directionDeg?: number}) => void}} [ctx]
 * @returns {{open: () => void, close: () => void, toggle: () => void, isOpen: () => boolean}}
 */
export function installWindPopover(ctx = {}) {
  if (document.getElementById(PANEL_ID)) return document.getElementById(PANEL_ID)._msaController;

  const win = document.createElement('div');
  win.id = PANEL_ID;
  win.hidden = true;
  Object.assign(win.style, {
    position: 'fixed',
    top: '80px',
    right: '20px',
    width: '220px',
    zIndex: '400',
    background: 'var(--glass)',
    backdropFilter: 'blur(var(--glass-blur))',
    border: '1px solid var(--line-strong)',
    borderRadius: 'var(--r-room, 14px)',
    boxShadow: 'var(--shadow3)',
    padding: '10px',
    font: '11px/1.4 var(--font)',
    color: 'var(--ink0)',
  });

  const head = document.createElement('div');
  head.style.cssText = 'display:flex; align-items:center; gap:8px; margin-bottom:8px';
  const title = document.createElement('span');
  title.style.cssText = 'font-weight:700; font-size:.8rem; display:flex; gap:6px; align-items:center';
  title.innerHTML = `${iconMarkup('wind')}Wind`;
  const spacer = document.createElement('span');
  spacer.style.flex = '1';
  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.title = 'Close';
  closeBtn.innerHTML = iconMarkup('x');
  closeBtn.style.cssText = 'color:var(--ink2); background:none; border:none; cursor:pointer';
  closeBtn.addEventListener('click', () => controller.close());
  head.append(title, spacer, closeBtn);

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

  const controller = {
    open() {
      render();
      win.hidden = false;
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
