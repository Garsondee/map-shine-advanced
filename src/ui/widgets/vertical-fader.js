/**
 * ui/widgets/vertical-fader.js — a vertical mixing-board-style fader
 * (author, 2026-08-19, verbatim: "Ideally the vertical sliders would appear
 * soon"). A NEW, separate widget from `param-control.js#buildRangeRow` —
 * `dial-control.js`'s own precedent: a control that shares `buildRangeRow`'s
 * write contract (`{value, onChange}`) but needs its own visual shape gets
 * its own file, not a bolted-on orientation option threaded through the
 * shared dispatch table every OTHER room and all 13 Studio effect cards
 * also go through. Only the Remote's own small, focused Channels rack
 * (`ui/rooms/remote/weather-board.js`) opts into this; `buildParamControl`
 * itself, and every dense multi-row effect card built this session, are
 * completely untouched.
 *
 * A real `<input type="range">` underneath — `writing-mode: vertical-lr` +
 * `direction: rtl` turns it into a genuine vertical slider, not a rotated
 * horizontal one via `transform`. min/max/step/value and the 'input'/
 * 'change' events all work completely unchanged, so this is a presentation
 * layer over the exact same range-input contract `buildRangeRow` already
 * has, never a reimplementation of range semantics (no coordinate math of
 * any kind lives in this file). `direction: rtl` specifically is what makes
 * the BOTTOM of the track read as the minimum and the TOP read as the
 * maximum — the "push up for more" feel every physical fader has; writing-
 * mode alone runs top-to-bottom, backwards from that.
 *
 * @module ui/widgets/vertical-fader
 */

import { attachFineDrag, createFineDragHandle } from './fine-drag.js';

const ACCENT = 'var(--shine, rgb(143,214,255))';
const TEXT = 'var(--ink0, #dcecff)';
const MUTED = 'var(--ink2, #7f97ba)';

function styled(tag, style) {
  const el = document.createElement(tag);
  Object.assign(el.style, style);
  return el;
}

function formatNum(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return String(v);
  return Math.abs(n) >= 100 ? Math.round(n).toString() : Math.round(n * 100) / 100 + '';
}

/**
 * @param {string} id
 * @param {{min?: number, max?: number, step?: number, label: string, help?: string}} decl
 * @param {{value: number, onChange: (v: number) => void}} io
 * @returns {{root: HTMLElement, update: (v: number) => void}} `root` is a
 *   small vertical stack (readout/track/label) — callers append extras (a
 *   drift-bracket caption, a pin glyph) onto `root` the same way
 *   `renderFaders()` already appended onto `buildParamControl`'s own
 *   horizontal rows; both are plain block children of a flex column there.
 *   `update` (2026-09-10 fix, author: "the sliders and weather buttons feel
 *   like two completely detached systems") repaints the thumb/readout from
 *   OUTSIDE — a live weather fade pushing its eased value every frame — the
 *   same `root`/`update` shape `ui/rooms/remote/astrolabe-dial.js` already
 *   established for its own dial, instead of the caller tearing the whole
 *   control down and rebuilding it. No-ops while the user's own pointer is
 *   down on this control (a native drag OR a fine-drag session, either) —
 *   the same "the hand actually on the control wins" rule that dial's own
 *   `isDragging` guard already applies to its ring.
 */
export function buildVerticalFader(id, decl, { value, onChange }) {
  const wrap = styled('div', {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: '4px',
    width: '52px',
    flex: '0 0 auto',
  });
  wrap.dataset.msaParam = id;
  wrap.title = decl.help ?? '';

  const readout = styled('span', {
    fontSize: '.62rem',
    color: MUTED,
    fontVariantNumeric: 'tabular-nums',
  });
  readout.textContent = formatNum(value);

  const trackWrap = styled('div', {
    height: '96px',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: '3px',
  });
  // `accent-color` only paints the FILLED portion of the track plus the
  // thumb — the unfilled remainder falls back to the browser's own default,
  // which on a dark theme is a near-invisible hairline (confirmed live,
  // author screenshot 2026-08-19: thumbs read fine, the channel they sit in
  // barely does). `.msa-vfader-input`'s track pseudo-elements carry the
  // actual fix (shell.js#injectStyle) since pseudo-elements can't be reached
  // from an inline style object here.
  const input = styled('input', {
    writingMode: 'vertical-lr',
    direction: 'rtl',
    accentColor: ACCENT,
    width: '8px',
    height: '96px',
    margin: '0',
    pointerEvents: 'auto',
  });
  input.className = 'msa-vfader-input';
  input.type = 'range';
  input.min = String(decl.min ?? 0);
  input.max = String(decl.max ?? 1);
  input.step = String(decl.step ?? 0.01);
  input.value = String(value);
  input.addEventListener('input', () => {
    readout.textContent = formatNum(input.value);
  });
  input.addEventListener('change', () => {
    onChange(parseFloat(input.value));
  });
  // `axis: 'y'`: this range is visually vertical (writing-mode/direction
  // trick above), so a fine drag must read the pointer's Y movement, not X.
  attachFineDrag(input, { axis: 'y' });
  trackWrap.appendChild(input);
  const handle = createFineDragHandle(input, { axis: 'y' });
  trackWrap.appendChild(handle);

  // Tracked independently of fine-drag.js's own private `dragging` flag
  // (2026-09-10 fix) — a pointerdown on EITHER `input` (a native drag or a
  // Shift-held fine drag) or `handle` (a handle-driven fine drag) starts
  // SOME kind of drag on this control; `update()` below must not fight
  // whichever one is currently live by yanking the thumb to a fade's own
  // value mid-gesture.
  let dragging = false;
  const markDragging = () => {
    dragging = true;
  };
  const markReleased = () => {
    dragging = false;
  };
  input.addEventListener('pointerdown', markDragging);
  input.addEventListener('pointerup', markReleased);
  input.addEventListener('pointercancel', markReleased);
  handle.addEventListener('pointerdown', markDragging);
  handle.addEventListener('pointerup', markReleased);
  handle.addEventListener('pointercancel', markReleased);

  const label = styled('span', {
    fontSize: '.64rem',
    color: TEXT,
    textAlign: 'center',
    lineHeight: '1.15',
  });
  label.textContent = decl.label ?? id;

  wrap.append(readout, trackWrap, label);
  return {
    root: wrap,
    update(v) {
      if (dragging || !Number.isFinite(v)) return;
      input.value = String(v);
      readout.textContent = formatNum(v);
    },
  };
}
