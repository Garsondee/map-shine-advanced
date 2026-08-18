/**
 * ui/rooms/studio/search-palette.js — "search everything" (U1, docs/holy/
 * UI-Testament.md §5.2, §9). Ported from the mock's `#palette`/`openPalette`/
 * `drawHits` (`tools/ui-mock/index.html`).
 *
 * ⚠️ PORTED BEHAVIOUR, NOT THE TESTAMENT'S PROSE. §5.2 describes this as
 * "fuzzy-search[ing] every schema label, help string, and glossary term."
 * The mock's actual, author-approved implementation is a plain lowercase
 * `includes()` substring test over `label + effect title + help` — it does
 * NOT search category, and it is not fuzzy. This module ports THAT real
 * behaviour faithfully (U1's own checklist: "a re-home, not a rewrite").
 * True fuzzy matching and a glossary layer are open gaps, named rather than
 * quietly built beyond what was actually validated — see Petition P10.
 *
 * The overlay SHELL itself (2026-08-18 fix) now lives in
 * `ui/widgets/search-overlay.js` — this file used to inject its own copy of
 * the mock's `.searchOverlay` CSS, with its own header noting "only this
 * module's own consumer exists in src/ so far." `weather-picker.js` is now
 * the second real consumer, so the shell got promoted to the canon rather
 * than copied a second time. Only the `.hl` flash-animation stays here — it
 * highlights a found PARAM ROW, a Studio/EFFECTS-department concept the
 * overlay shell itself knows nothing about.
 *
 * @module ui/rooms/studio/search-palette
 */

import { buildSearchOverlay } from '../../widgets/search-overlay.js';

const STYLE_ID = 'msa-studio-palette-style';
const EMPTY_QUERY_BROWSE_COUNT = 8;
const MAX_RESULTS = 12;

function injectStyle() {
  if (document.getElementById(STYLE_ID)) return;
  const el = document.createElement('style');
  el.id = STYLE_ID;
  el.textContent = `
.msa-param-row.hl{animation:msaSearchHl 1.6s cubic-bezier(.22,.7,.3,1)}
@keyframes msaSearchHl{0%{background:var(--shine-soft); box-shadow:0 0 0 4px var(--shine-soft)}
  100%{background:transparent; box-shadow:none}}
`.trim();
  document.head.appendChild(el);
}

/**
 * Flatten every registered effect's schema into search rows. Rebuilt on
 * every open (never cached) — a factory reflects live enable/mask state,
 * and a stale index would offer params from an effect that no longer exists.
 * @param {Map<string, () => object>} effectCardFactories
 * @returns {Array<{effectId: string, effectTitle: string, acc: string, paramId: string, label: string, help: string, category: string}>}
 */
export function buildSearchIndex(effectCardFactories) {
  const rows = [];
  for (const [effectId, factory] of effectCardFactories) {
    const model = factory();
    if (!model?.schema) continue;
    for (const [paramId, decl] of Object.entries(model.schema)) {
      rows.push({
        effectId,
        effectTitle: model.title ?? effectId,
        acc: model.accVar ? `var(${model.accVar})` : 'var(--shine)',
        paramId,
        label: decl.label ?? paramId,
        help: decl.help ?? '',
        category: decl.category ?? 'Technical',
      });
    }
  }
  return rows;
}

/**
 * @param {object} args
 * @param {() => Array} args.buildIndex - called fresh on every open.
 * @param {(effectId: string) => void} args.onOpenCard - switch to the
 *   EFFECTS department and get the target card into the DOM; this module
 *   then locates it on the next frame to scroll/flash.
 * @returns {{open: (q?: string) => void, close: () => void, flashParam: (effectId: string, paramId: string) => void}}
 */
export function installSearchPalette({ buildIndex, onOpenCard }) {
  injectStyle();

  function drawHits(q, results) {
    results.innerHTML = '';
    const ql = q.trim().toLowerCase();
    const index = buildIndex();
    const hits = !ql
      ? index.slice(0, EMPTY_QUERY_BROWSE_COUNT)
      : index
          .filter((h) => (h.label + ' ' + h.effectTitle + ' ' + h.help).toLowerCase().includes(ql))
          .slice(0, MAX_RESULTS);
    if (!hits.length) {
      const empty = document.createElement('div');
      empty.className = 'hit';
      empty.textContent = 'Nothing found.';
      results.append(empty);
      return;
    }
    hits.forEach((h, i) => {
      const btn = document.createElement('button');
      btn.className = 'hit' + (i === 0 ? ' sel' : '');
      btn.innerHTML = `<span class="dot" style="--acc:${h.acc}"></span><b>${h.label}</b><span style="color:var(--ink2)">· ${h.effectTitle}</span><span class="crumb">${h.category}</span>`;
      btn.addEventListener('click', () => {
        overlay.close();
        controller.flashParam(h.effectId, h.paramId);
      });
      results.append(btn);
    });
  }

  const overlay = buildSearchOverlay({
    ariaLabel: 'Search everything',
    placeholder: 'Search every control — try “opacity”, “glow”, “direction”…',
    onQuery: drawHits,
  });
  document.body.appendChild(overlay.root);

  const controller = {
    open: overlay.open,
    close: overlay.close,
    /**
     * Switch to the target card and, once it's actually in the DOM (a room
     * switch is a synchronous rebuild, but this module doesn't own that
     * timing — one frame is the same margin the mock used), open its
     * Advanced section if needed, scroll the specific row to centre, and
     * restart the highlight animation (remove+reflow+re-add — the standard
     * way to replay a CSS animation on an element that already has the class).
     */
    flashParam(effectId, paramId) {
      onOpenCard(effectId);
      requestAnimationFrame(() => {
        const card = document.querySelector(`[data-msa-effect="${effectId}"]`);
        if (!card) return;
        const advanced = card.querySelectorAll('details');
        for (const d of advanced) d.open = true;
        const row = card.querySelector(`[data-msa-param="${paramId}"]`) ?? card;
        row.scrollIntoView({ block: 'center', behavior: 'smooth' });
        row.classList.remove('hl');
        void row.offsetWidth;
        row.classList.add('hl');
      });
    },
  };

  return controller;
}
