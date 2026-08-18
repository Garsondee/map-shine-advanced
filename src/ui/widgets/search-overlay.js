/**
 * ui/widgets/search-overlay.js — the shared `.searchOverlay` shell (mock:
 * `tools/ui-mock/index.html`'s own `.searchOverlay`), extracted 2026-08-18
 * once a SECOND real consumer existed (`ui/rooms/remote/weather-picker.js`).
 *
 * `ui/rooms/studio/search-palette.js` built this shell first (U1) and said so
 * in its own header at the time: "shared shell shape; only this module's own
 * consumer exists in src/ so far." That was a deliberate, logged deferral —
 * Law 8 ("canon is the only toolkit") applies once there is a second real
 * caller to share WITH, not before. This module is that promotion: the DOM/
 * CSS shell and open/close/escape/focus plumbing live here; hit-rendering
 * stays with each caller, since a Studio param row and a weather archetype
 * are genuinely different shapes with nothing generic left to factor out.
 *
 * @module ui/widgets/search-overlay
 */

import { iconMarkup } from './icon-sprite.js';

const STYLE_ID = 'msa-search-overlay-style';

function injectStyle() {
  if (document.getElementById(STYLE_ID)) return;
  const el = document.createElement('style');
  el.id = STYLE_ID;
  // Ported verbatim from the mock's own `.searchOverlay` rules, class-scoped
  // (not id-scoped like the pre-extraction copy) so any number of instances
  // share one injected stylesheet.
  el.textContent = `
.msa-search-overlay{position:fixed; inset:0; z-index:350; display:none; align-items:flex-start;
  justify-content:center; padding-top:14vh; background:rgba(6,8,14,.45)}
.msa-search-overlay.open{display:flex}
.msa-search-overlay .box{width:560px; max-width:92vw; background:var(--glass);
  backdrop-filter:blur(var(--glass-blur)); border:1px solid var(--line-strong);
  border-radius:14px; box-shadow:var(--shadow3); overflow:hidden}
.msa-search-overlay .pin{display:flex; gap:9px; align-items:center; padding:12px 16px;
  border-bottom:1px solid var(--line)}
.msa-search-overlay .pin input{flex:1; background:none; border:none; font-size:.95rem; color:var(--ink0); pointer-events:auto}
.msa-search-overlay .results{max-height:380px; overflow-y:auto; padding:6px; scrollbar-width:thin}
.msa-search-overlay .hit{display:flex; align-items:center; gap:9px; padding:7px 11px; border-radius:8px;
  width:100%; text-align:left; color:var(--ink1); font-size:.78rem; pointer-events:auto}
.msa-search-overlay .hit:hover, .msa-search-overlay .hit.sel{background:var(--bg2); color:var(--ink0)}
.msa-search-overlay .hit .crumb{margin-left:auto; color:var(--ink2); font-size:.64rem}
.msa-search-overlay .hit .dot{width:7px; height:7px; border-radius:50%; background:var(--acc); flex:none}
.msa-search-overlay .hit .htext{display:flex; flex-direction:column; gap:1px; min-width:0}
.msa-search-overlay .hit .htext b{font-weight:600}
.msa-search-overlay .hit .htext .sub{color:var(--ink2); font-size:.66rem; white-space:nowrap;
  overflow:hidden; text-overflow:ellipsis}
.msa-search-overlay .grouphead{padding:9px 11px 4px; font-size:.62rem; letter-spacing:.18em;
  text-transform:uppercase; color:var(--ink2); display:flex; align-items:center}
.msa-search-overlay .grouphead .cnt{margin-left:auto; color:var(--ink2); opacity:.7}
`.trim();
  document.head.appendChild(el);
}

/**
 * @param {object} opts
 * @param {string} opts.ariaLabel
 * @param {string} opts.placeholder
 * @param {(query: string, resultsEl: HTMLElement) => void} opts.onQuery -
 *   called on every open() and on every input event; the caller owns
 *   rendering `resultsEl`'s own children (hit shape is per-consumer).
 * @returns {{root: HTMLElement, open: (q?: string) => void, close: () => void}}
 *   `root` is NOT appended anywhere by this function — the caller decides
 *   where in the document it belongs, same as every other widget/popover in
 *   this canon (e.g. `camera-path-popover.js`).
 */
export function buildSearchOverlay({ ariaLabel, placeholder, onQuery }) {
  injectStyle();

  const root = document.createElement('div');
  root.className = 'msa-search-overlay';
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-label', ariaLabel);
  root.innerHTML = `
    <div class="box">
      <div class="pin">${iconMarkup('search', 'style="color:var(--ink2)"')}
        <input placeholder="${placeholder}" autocomplete="off">
        <kbd>esc</kbd></div>
      <div class="results"></div>
    </div>`;
  const input = root.querySelector('input');
  const results = root.querySelector('.results');

  function open(q = '') {
    root.classList.add('open');
    if (document.activeElement !== input) input.value = q;
    input.focus();
    onQuery(input.value, results);
  }
  function close() {
    root.classList.remove('open');
  }

  input.addEventListener('input', (e) => onQuery(e.target.value, results));
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && root.classList.contains('open')) close();
  });

  return { root, open, close };
}
