/**
 * ui/widgets/vertical-fader.js — a vertical mixing-desk fader (author,
 * 2026-08-19, verbatim: "Ideally the vertical sliders would appear soon").
 * A NEW, separate widget from `param-control.js#buildRangeRow` —
 * `dial-control.js`'s own precedent: a control that shares `buildRangeRow`'s
 * write contract (`{value, onChange}`) but needs its own visual shape gets
 * its own file, not a bolted-on orientation option threaded through the
 * shared dispatch table every OTHER room and all 13 Studio effect cards
 * also go through. Only the Remote's own small, focused Channels rack
 * (`ui/rooms/remote/weather-board.js`) opts into this; `buildParamControl`
 * itself, and every dense multi-row effect card, are completely untouched.
 *
 * ============================================================================
 * WHY THIS FILE DRAWS THE WHOLE FADER ITSELF (mythica-machina-press#626)
 * ============================================================================
 * The first version was a real `<input type="range">` stood upright with
 * `writing-mode` and coloured with `accent-color`. Live in Foundry it never
 * looked like that. Foundry v14 styles EVERY range input on the page
 * (`foundry2.css`, inside `@layer elements.forms`): `appearance:none`, a 4px
 * bordered track, and a 12px dark square thumb with a thin orange border.
 * MSA's own rules sat outside any layer, so they won for the two properties
 * they set (the thumb's size and offset) and Foundry supplied everything
 * else: every fader wore a half-Foundry, half-MSA thumb. Worse,
 * `appearance:none` switches `accent-color` off, so no level fill ever drew
 * and a fader at full looked as empty as one at zero. `tools/remote-preview`
 * never loaded Foundry's stylesheet, so the harness never showed any of it
 * (it now injects a copy of those rules — see its own preview.js).
 *
 * Redrawn from the author's approval of an in-session mockup (2026-09-25:
 * "Your proposed faders are very nice... I love the style of them"). The look
 * is now plain elements this file owns outright — a recessed slot, a level
 * fill, quarter ticks, a fader cap — positioned from the value by the pure
 * helpers below. The real range input is still here, visually hidden but
 * focusable, so keyboard control, screen readers, min/max/step snapping and
 * the 'input'/'change' event contract every caller relies on are all still
 * the browser's own. A plain drag on the well is handled HERE (deterministic
 * geometry, no dependence on how a browser lays out a rotated native thumb):
 * it writes `input.value` and dispatches the same events a native drag would.
 *
 * Fine adjustment moved OFF a grip beside the track and ONTO the value
 * readout: drag the number up/down, After Effects' "scrubby number". The side
 * grip took ~25px of a ~44px column, pushed every track off-centre from its
 * own label, and seven of them in a row read as "=" signs between faders.
 * Shift-drag anywhere on the fader still works too (`fine-drag.js`).
 *
 * @module ui/widgets/vertical-fader
 */

import { attachFineDragSurface } from './fine-drag.js';
import { iconMarkup } from './icon-sprite.js';

/** Fader geometry, in CSS px. The cap's CENTRE travels between `capPx / 2`
 * and `heightPx - capPx / 2`, so the cap never overhangs the well at either
 * end — and the SAME numbers drive both drawing and pointer mapping, so the
 * cap always sits exactly under the pointer that is dragging it. */
export const FADER_GEOMETRY = Object.freeze({ heightPx: 96, capPx: 10 });

/** The quarter marks every fader draws (the half mark doubles as a bipolar
 * fader's centre detent, drawn longer). */
const TICKS = Object.freeze([0.25, 0.5, 0.75]);

/**
 * A value's normalised position: 0 at the floor of the travel, 1 at the top.
 * @param {number} value @param {number} min @param {number} max
 * @returns {number} clamped to [0, 1]; 0 for a non-finite value or an empty range.
 */
export function faderNormalize(value, min, max) {
  const span = max - min;
  if (!Number.isFinite(value) || !(span > 0)) return 0;
  return Math.min(1, Math.max(0, (value - min) / span));
}

/**
 * Where the cap's centre sits for a normalised position, in px down from the
 * TOP of the well.
 * @param {number} t - 0..1 (clamped).
 * @param {{heightPx: number, capPx: number}} [geometry]
 */
export function faderCapY(t, geometry = FADER_GEOMETRY) {
  const tt = Math.min(1, Math.max(0, Number.isFinite(t) ? t : 0));
  return geometry.capPx / 2 + (1 - tt) * (geometry.heightPx - geometry.capPx);
}

/**
 * The inverse of {@link faderCapY}: a pointer's y (px down from the top of the
 * well) to a normalised position.
 * @param {number} y @param {{heightPx: number, capPx: number}} [geometry]
 * @returns {number} clamped to [0, 1].
 */
export function faderTFromY(y, geometry = FADER_GEOMETRY) {
  const travel = geometry.heightPx - geometry.capPx;
  if (!(travel > 0) || !Number.isFinite(y)) return 0;
  return Math.min(1, Math.max(0, 1 - (y - geometry.capPx / 2) / travel));
}

/**
 * The level fill's span, px from the top of the well. An ordinary fader
 * fills from the floor up to the cap; a BIPOLAR one (Sun latitude: -90..+90,
 * the equator in the middle) fills from the centre line out to the cap, in
 * whichever direction the cap went.
 * @param {number} t - 0..1.
 * @param {{bipolar?: boolean, geometry?: {heightPx: number, capPx: number}}} [opts]
 * @returns {{top: number, height: number}}
 */
export function faderFillSpan(t, { bipolar = false, geometry = FADER_GEOMETRY } = {}) {
  const cy = faderCapY(t, geometry);
  if (!bipolar) return { top: cy, height: geometry.heightPx - cy };
  const mid = faderCapY(0.5, geometry);
  return { top: Math.min(cy, mid), height: Math.abs(cy - mid) };
}

/**
 * The readout's text, with its unit (#626: a bare "1" or "30" reads as
 * nothing; "100%" and "30°" read as themselves). With no unit declared, the
 * original plain-number formatting.
 * @param {number} v @param {{unit?: 'percent'|'degrees'}} [decl]
 * @returns {string}
 */
export function formatFaderValue(v, decl = {}) {
  const n = Number(v);
  if (!Number.isFinite(n)) return String(v);
  // `+ 0` folds a rounded -0 into 0, so a fader at the floor never reads "-0%".
  if (decl.unit === 'percent') return `${Math.round(n * 100) + 0}%`;
  if (decl.unit === 'degrees') return `${Math.round(n) + 0}°`;
  return Math.abs(n) >= 100 ? Math.round(n).toString() : Math.round(n * 100) / 100 + '';
}

const STYLE_ID = 'msa-vertical-fader-style';

/** Injected once — the fader's own look travels with the widget (the
 * `fine-drag.js`/`scale-control.js` `injectStyle` precedent), rather than
 * living in one room's stylesheet where any other host would render it
 * unstyled. Every colour is a LANTERN token read with a fallback
 * (`ui/tokens-only`'s own recommended pattern), so all four themes follow. */
function injectFaderStyle() {
  if (document.getElementById(STYLE_ID)) return;
  const { heightPx, capPx } = FADER_GEOMETRY;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
.msa-vf{display:flex; flex-direction:column; align-items:center; gap:3px; flex:1 1 0; min-width:0; max-width:56px}
.msa-vf-readout{font-size:.62rem; line-height:1.35; color:var(--ink1, #a8b1c2); font-variant-numeric:tabular-nums;
  padding:0 5px; border-radius:4px; cursor:ns-resize; user-select:none; touch-action:none; pointer-events:auto;
  white-space:nowrap}
.msa-vf-readout:hover,.msa-vf.is-scrub .msa-vf-readout{background:var(--bg3, #272c3a); color:var(--shine, #e7c368)}
.msa-vf-well{position:relative; width:100%; height:${heightPx}px; cursor:pointer; touch-action:none; pointer-events:auto}
.msa-vf-slot{position:absolute; left:50%; top:0; bottom:0; width:6px; margin-left:-3px; border-radius:3px;
  background:var(--bg0, #14161d); box-shadow:inset 0 0 0 1px var(--line, rgba(196,208,232,.13))}
.msa-vf-fill{position:absolute; left:50%; width:6px; margin-left:-3px; border-radius:3px; background:var(--shine, #e7c368)}
.msa-vf.is-cold .msa-vf-fill{background:var(--c-atmos, #5aa9f2)}
.msa-vf-tick{position:absolute; left:50%; width:14px; margin-left:-7px; height:1px;
  background:var(--line-strong, rgba(196,208,232,.24))}
.msa-vf-tick.is-centre{width:22px; margin-left:-11px}
.msa-vf-mark{position:absolute; left:50%; width:14px; margin-left:-7px; height:1px; background:var(--c-atmos, #5aa9f2)}
.msa-vf-mark-icon{position:absolute; left:50%; margin-left:13px; display:flex; transform:translateY(-50%);
  color:var(--c-atmos, #5aa9f2)}
.msa-vf-mark-icon .ico{width:10px; height:10px}
.msa-vf-band{position:absolute; left:50%; width:3px; margin-left:-12px; border-radius:2px;
  background:color-mix(in oklab, var(--ink1, #a8b1c2) 55%, transparent)}
.msa-vf-cap{position:absolute; left:50%; width:22px; height:${capPx}px; margin:${-capPx / 2}px 0 0 -11px;
  border-radius:3px; background:var(--ink0, #ecEFf5); display:flex; align-items:center; justify-content:center;
  pointer-events:none}
.msa-vf-cap>span{display:block; width:14px; height:2px; border-radius:1px; background:var(--bg1, #191c25)}
.msa-vf-well:hover .msa-vf-cap,.msa-vf.is-held .msa-vf-cap{background:var(--shine, #e7c368)}
.msa-vf.is-focus .msa-vf-cap{outline:2px solid var(--shine, #e7c368); outline-offset:2px}
.msa-vf-input{position:absolute; left:0; top:0; width:1px; height:1px; margin:0; padding:0; border:0;
  opacity:0; pointer-events:none; overflow:hidden}
.msa-vf-icon{display:flex; height:14px; color:var(--ink2, #78829a)}
.msa-vf-icon .ico{width:14px; height:14px}
.msa-vf-label{max-width:100%; font-size:.62rem; line-height:1.2; color:var(--ink1, #a8b1c2);
  overflow:hidden; text-overflow:ellipsis; white-space:nowrap}
`.trim();
  document.head.appendChild(style);
}

function el(tag, className, parent) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (parent) parent.appendChild(node);
  return node;
}

/**
 * @param {string} id
 * @param {{
 *   min?: number, max?: number, step?: number, label: string, help?: string,
 *   shortLabel?: string, icon?: string, unit?: 'percent'|'degrees', bipolar?: boolean,
 *   markers?: Array<{at: number, icon?: string, tone?: 'cold', title?: string}>,
 *   band?: [number, number]|null, bandTitle?: string,
 * }} decl - beyond the range basics: `shortLabel` + `icon` (the column's
 *   caption; the full `label` + `help` become the tooltip), `unit` (readout
 *   formatting), `bipolar` (fill from the centre line), `markers` (a line
 *   across the slot at a value — `tone:'cold'` tints the level icy blue at or
 *   below it, Temperature's snow line), and `band` (a range drawn beside the
 *   slot — Drift mode's wander range, mythica-machina-press#190).
 * @param {{value: number, onChange: (v: number) => void}} io
 * @returns {{root: HTMLElement, update: (v: number) => void}} `root` is the
 *   fader's column (readout/well/icon/label) — callers append extras (the pin
 *   glyph) onto it as plain block children. `update` (2026-09-10 fix, author:
 *   "the sliders and weather buttons feel like two completely detached
 *   systems") repaints from OUTSIDE — a live weather fade pushing its eased
 *   value every frame — the same `root`/`update` shape
 *   `ui/rooms/remote/astrolabe-dial.js` established for its own dial. It
 *   no-ops while a hand is on this control (a plain drag, a Shift fine drag
 *   or a readout scrub): "the hand actually on the control wins".
 */
export function buildVerticalFader(id, decl, { value, onChange }) {
  injectFaderStyle();
  const min = Number.isFinite(decl.min) ? decl.min : 0;
  const max = Number.isFinite(decl.max) ? decl.max : 1;
  const step = Number.isFinite(decl.step) && decl.step > 0 ? decl.step : 0.01;
  const bipolar = decl.bipolar === true;
  const fullLabel = decl.label ?? id;
  const markers = (decl.markers ?? []).filter((m) => Number.isFinite(m?.at));

  const wrap = el('div', 'msa-vf');
  wrap.dataset.msaParam = id;
  wrap.title = decl.help ? `${fullLabel} — ${decl.help}` : fullLabel;

  const readout = el('span', 'msa-vf-readout', wrap);
  readout.title = 'Drag up or down for fine adjustment';

  const well = el('div', 'msa-vf-well', wrap);
  el('div', 'msa-vf-slot', well);
  if (Array.isArray(decl.band) && decl.band.length === 2 && decl.band.every(Number.isFinite)) {
    const band = el('div', 'msa-vf-band', well);
    const yHi = faderCapY(faderNormalize(Math.max(...decl.band), min, max));
    const yLo = faderCapY(faderNormalize(Math.min(...decl.band), min, max));
    band.style.top = `${yHi}px`;
    band.style.height = `${Math.max(2, yLo - yHi)}px`;
    if (decl.bandTitle) band.title = decl.bandTitle;
  }
  const fill = el('div', 'msa-vf-fill', well);
  for (const t of TICKS) {
    const tick = el('div', 'msa-vf-tick', well);
    if (bipolar && t === 0.5) tick.classList.add('is-centre');
    tick.style.top = `${faderCapY(t)}px`;
  }
  for (const m of markers) {
    const y = faderCapY(faderNormalize(m.at, min, max));
    const line = el('div', 'msa-vf-mark', well);
    line.style.top = `${y}px`;
    if (m.title) line.title = m.title;
    if (m.icon) {
      const icon = el('span', 'msa-vf-mark-icon', well);
      icon.style.top = `${y}px`;
      icon.innerHTML = iconMarkup(m.icon);
      if (m.title) icon.title = m.title;
    }
  }
  const cap = el('div', 'msa-vf-cap', well);
  el('span', null, cap);

  // THE REAL INPUT — hidden, not removed (see this file's header). Focusable
  // for the keyboard (arrows/PageUp/Home/End all native), named for screen
  // readers, and still the one place the value lives.
  const input = el('input', 'msa-vf-input', well);
  input.type = 'range';
  input.min = String(min);
  input.max = String(max);
  input.step = String(step);
  input.value = String(value);
  input.setAttribute('aria-label', fullLabel);
  input.setAttribute('aria-orientation', 'vertical');

  if (decl.icon) {
    const icon = el('span', 'msa-vf-icon', wrap);
    icon.innerHTML = iconMarkup(decl.icon);
  }
  const label = el('span', 'msa-vf-label', wrap);
  label.textContent = decl.shortLabel ?? fullLabel;

  function paint() {
    const v = parseFloat(input.value);
    const t = faderNormalize(v, min, max);
    cap.style.top = `${faderCapY(t)}px`;
    const span = faderFillSpan(t, { bipolar });
    fill.style.top = `${span.top}px`;
    fill.style.height = `${span.height}px`;
    readout.textContent = formatFaderValue(v, decl);
    wrap.classList.toggle(
      'is-cold',
      markers.some((m) => m.tone === 'cold' && v <= m.at)
    );
  }

  input.addEventListener('input', paint);
  input.addEventListener('change', () => {
    paint();
    onChange(parseFloat(input.value));
  });

  // A HAND ON THE CONTROL — any press on the well (plain or Shift) or the
  // readout. `update()` below yields to it, and the cap lights while it lasts.
  let held = false;
  const grab = () => {
    held = true;
    wrap.classList.add('is-held');
    wrap.classList.remove('is-focus');
  };
  const release = () => {
    held = false;
    wrap.classList.remove('is-held', 'is-scrub');
  };
  for (const surface of [well, readout]) {
    surface.addEventListener('pointerdown', grab);
    surface.addEventListener('pointerup', release);
    surface.addEventListener('pointercancel', release);
  }
  readout.addEventListener('pointerdown', () => wrap.classList.add('is-scrub'));

  // FINE ADJUSTMENT — the readout is the handle (every press), and Shift
  // held anywhere on the well does the same; both are `fine-drag.js`'s own
  // session, driving the hidden input's value and events.
  attachFineDragSurface(readout, input, { axis: 'y' });
  attachFineDragSurface(well, input, { axis: 'y', shiftOnly: true });

  // THE PLAIN DRAG. A press ON the cap takes hold of it where it is (no jump
  // by the few px between the pointer and the cap's centre line); a press
  // anywhere else on the well jumps the cap there first, like a native track.
  let dragging = false;
  let grabOffsetPx = 0;
  let valueAtPress = input.value;
  // The pointer's y within the well, in the well's OWN px (the unit
  // FADER_GEOMETRY is in). Screen px and the well's px differ whenever an
  // ancestor is scaled — Foundry's interface-scale setting does exactly that
  // with `transform: scale(var(--ui-scale))` (foundry2.css), and CSS zoom
  // does too — so the on-screen height is measured against the layout
  // height rather than assumed equal (found in tools/remote-preview under a
  // 1.6x zoom: a drag meant for ~9% landed on 0%).
  const wellY = (e) => {
    const rect = well.getBoundingClientRect();
    const scale = well.offsetHeight > 0 && rect.height > 0 ? rect.height / well.offsetHeight : 1;
    return (e.clientY - rect.top) / scale;
  };
  const setFromPointer = (e) => {
    const y = wellY(e) - grabOffsetPx;
    const before = input.value;
    // The browser's own sanitising snaps this to `step` and clamps it.
    input.value = String(min + faderTFromY(y) * (max - min));
    if (input.value !== before) input.dispatchEvent(new Event('input', { bubbles: true }));
  };
  well.addEventListener('pointerdown', (e) => {
    if (e.shiftKey || e.button !== 0) return;
    e.preventDefault();
    dragging = true;
    valueAtPress = input.value;
    const y = wellY(e);
    const capY = faderCapY(faderNormalize(parseFloat(input.value), min, max));
    grabOffsetPx = Math.abs(y - capY) <= FADER_GEOMETRY.capPx / 2 + 2 ? y - capY : 0;
    try {
      well.setPointerCapture(e.pointerId);
    } catch (_) {
      /* no capture: a drag that leaves the well just stops tracking */
    }
    input.focus({ preventScroll: true });
    setFromPointer(e);
  });
  well.addEventListener('pointermove', (e) => {
    if (dragging) setFromPointer(e);
  });
  const endDrag = () => {
    if (!dragging) return;
    dragging = false;
    // 'change' only when the value actually moved — a native range's own rule.
    if (input.value !== valueAtPress) input.dispatchEvent(new Event('change', { bubbles: true }));
  };
  well.addEventListener('pointerup', endDrag);
  well.addEventListener('pointercancel', endDrag);

  // Keyboard focus shows as a ring on the cap — only for keyboard use, not
  // after every click (the input is focused on press so arrows work next).
  input.addEventListener('keydown', () => wrap.classList.add('is-focus'));
  input.addEventListener('blur', () => wrap.classList.remove('is-focus'));

  paint();
  return {
    root: wrap,
    update(v) {
      if (held || !Number.isFinite(v)) return;
      input.value = String(v);
      paint();
    },
  };
}
