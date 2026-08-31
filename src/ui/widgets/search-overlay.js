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
/* THE RAIL VARIANT (2026-08-27, author live-testing round: "lots of things
   compressed together, make this UI x2 bigger... a rail of general options
   on the left which allows you to quickly scroll down the full list to get
   to specific [items] within an overall heading"). Opt-in per instance
   (buildSearchOverlay({rail: [...]})) -- search-palette.js's own call
   never passes rail, so it keeps the original compact box unchanged;
   weather-picker.js is the first, and so far only, consumer of this. */
.msa-search-overlay.wide .box{width:860px; display:flex; flex-direction:column}
.msa-search-overlay .pin{display:flex; gap:9px; align-items:center; padding:12px 16px;
  border-bottom:1px solid var(--line)}
.msa-search-overlay .pin input{flex:1; background:none; border:none; font-size:.95rem; color:var(--ink0); pointer-events:auto}
.msa-search-overlay .frame{display:flex; min-height:0}
.msa-search-overlay .rail{width:168px; flex:none; border-right:1px solid var(--line); padding:8px;
  display:flex; flex-direction:column; gap:2px; overflow-y:auto; max-height:600px; scrollbar-width:thin}
.msa-search-overlay .rail button{text-align:left; padding:6px 9px; border-radius:7px; border:none;
  background:none; color:var(--ink2); font-size:.72rem; cursor:pointer; pointer-events:auto}
.msa-search-overlay .rail button:hover{background:var(--bg2); color:var(--ink0)}
.msa-search-overlay .rail button.active{background:var(--shine-soft); color:var(--shine); font-weight:600}
.msa-search-overlay .results{max-height:380px; overflow-y:auto; padding:6px; scrollbar-width:thin; flex:1; min-width:0}
.msa-search-overlay.wide .results{max-height:600px}
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
/* Bigger, less-cramped hit rows for the wide variant specifically (author:
   "lots of things compressed together") -- the compact default stays as-is
   for search-palette.js's own dense Studio-wide param search. */
.msa-search-overlay.wide .hit{padding:9px 12px; font-size:.82rem; gap:11px}
.msa-search-overlay.wide .hit .htext .sub{white-space:normal}
`.trim();
  document.head.appendChild(el);
}

/**
 * @param {object} opts
 * @param {string} opts.ariaLabel
 * @param {string} opts.placeholder
 * @param {(query: string, resultsEl: HTMLElement) => void} opts.onQuery -
 *   called on every open() and on every input event; the caller owns
 *   rendering `resultsEl`'s own children (hit shape is per-consumer). When
 *   `rail` is supplied, the caller is expected to render `.grouphead`
 *   elements carrying `data-group="<id>"` matching the rail's own ids, so
 *   the rail's own click can find and scroll to them — this file has no
 *   opinion about what "grouped" results look like beyond that one attribute
 *   contract.
 * @param {Array<{id: string, label: string}>} [opts.rail] - optional
 *   (2026-08-27): a left-hand jump-nav of group headings, and the `wide`
 *   box variant that has room for one. Omitted entirely (search-palette.js's
 *   own usage) renders exactly the original compact box — this is additive,
 *   never a behaviour change for an existing caller that doesn't ask for it.
 * @returns {{root: HTMLElement, open: (q?: string) => void, close: () => void}}
 *   `root` is NOT appended anywhere by this function — the caller decides
 *   where in the document it belongs, same as every other widget/popover in
 *   this canon (e.g. `camera-path-popover.js`).
 */
export function buildSearchOverlay({ ariaLabel, placeholder, onQuery, rail }) {
  injectStyle();

  const root = document.createElement('div');
  root.className = 'msa-search-overlay';
  if (rail?.length) root.classList.add('wide');
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-label', ariaLabel);
  const railHtml = rail?.length
    ? `<nav class="rail" aria-label="Jump to">${rail
        .map((g) => `<button type="button" data-rail="${g.id}">${g.label}</button>`)
        .join('')}</nav>`
    : '';
  root.innerHTML = `
    <div class="box">
      <div class="pin">${iconMarkup('search', 'style="color:var(--ink2)"')}
        <input placeholder="${placeholder}" autocomplete="off">
        <kbd>esc</kbd></div>
      <div class="frame">${railHtml}<div class="results"></div></div>
    </div>`;
  const input = root.querySelector('input');
  const results = root.querySelector('.results');

  // The rail scrolls the ALREADY-RENDERED results to a matching .grouphead
  // — it never re-queries or re-filters, so it works unchanged whatever the
  // caller's own onQuery just drew (or didn't, if that group has no hits
  // under the current search).
  for (const btn of root.querySelectorAll('.rail button')) {
    btn.addEventListener('click', () => {
      const target = results.querySelector(`[data-group="${btn.dataset.rail}"]`);
      target?.scrollIntoView({ block: 'start' });
      for (const b of root.querySelectorAll('.rail button')) b.classList.toggle('active', b === btn);
    });
  }

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
