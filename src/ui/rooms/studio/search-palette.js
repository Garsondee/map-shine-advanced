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
 * @module ui/rooms/studio/search-palette
 */

import { iconMarkup } from '../../widgets/icon-sprite.js';

const OVERLAY_ID = 'msa-studio-palette';
const STYLE_ID = 'msa-studio-palette-style';
const EMPTY_QUERY_BROWSE_COUNT = 8;
const MAX_RESULTS = 12;

function injectStyle() {
  if (document.getElementById(STYLE_ID)) return;
  const el = document.createElement('style');
  el.id = STYLE_ID;
  // Ported verbatim from the mock's .searchOverlay rules — shared shell
  // shape; only this module's own consumer exists in src/ so far.
  el.textContent = `
#${OVERLAY_ID}{position:fixed; inset:0; z-index:350; display:none; align-items:flex-start;
  justify-content:center; padding-top:14vh; background:rgba(6,8,14,.45)}
#${OVERLAY_ID}.open{display:flex}
#${OVERLAY_ID} .box{width:560px; max-width:92vw; background:var(--glass);
  backdrop-filter:blur(var(--glass-blur)); border:1px solid var(--line-strong);
  border-radius:14px; box-shadow:var(--shadow3); overflow:hidden}
#${OVERLAY_ID} .pin{display:flex; gap:9px; align-items:center; padding:12px 16px;
  border-bottom:1px solid var(--line)}
#${OVERLAY_ID} .pin input{flex:1; background:none; border:none; font-size:.95rem; color:var(--ink0); pointer-events:auto}
#${OVERLAY_ID} .results{max-height:380px; overflow-y:auto; padding:6px; scrollbar-width:thin}
#${OVERLAY_ID} .hit{display:flex; align-items:center; gap:9px; padding:7px 11px; border-radius:8px;
  width:100%; text-align:left; color:var(--ink1); font-size:.78rem; pointer-events:auto}
#${OVERLAY_ID} .hit:hover, #${OVERLAY_ID} .hit.sel{background:var(--bg2); color:var(--ink0)}
#${OVERLAY_ID} .hit .crumb{margin-left:auto; color:var(--ink2); font-size:.64rem}
#${OVERLAY_ID} .hit .dot{width:7px; height:7px; border-radius:50%; background:var(--acc); flex:none}
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

  const overlay = document.createElement('div');
  overlay.id = OVERLAY_ID;
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-label', 'Search everything');
  overlay.innerHTML = `
    <div class="box">
      <div class="pin">${iconMarkup('search', 'style="color:var(--ink2)"')}
        <input placeholder="Search every control — try “opacity”, “glow”, “direction”…" autocomplete="off">
        <kbd>esc</kbd></div>
      <div class="results"></div>
    </div>`;
  document.body.appendChild(overlay);
  const input = overlay.querySelector('input');
  const results = overlay.querySelector('.results');

  function drawHits(q) {
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
        controller.close();
        controller.flashParam(h.effectId, h.paramId);
      });
      results.append(btn);
    });
  }

  const controller = {
    open(q = '') {
      overlay.classList.add('open');
      if (document.activeElement !== input) input.value = q;
      input.focus();
      drawHits(input.value);
    },
    close() {
      overlay.classList.remove('open');
    },
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

  input.addEventListener('input', (e) => drawHits(e.target.value));
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && overlay.classList.contains('open')) controller.close();
  });

  return controller;
}
