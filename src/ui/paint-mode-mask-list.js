/**
 * @fileoverview PAINT MODE — the Masks panel (2026-11-01). A side panel the GM
 * opens from the toolbar (☰ Masks, or M): every mask kind Map Shine reads,
 * whether this floor has it and whether it is working, and a one-click way to
 * paint any of them. Hidden until asked for — the author: *"This shouldn't be
 * displayed all the time"*.
 *
 * What each row SAYS is `ui/mask-list-model.js` (pure, Node-tested); this file
 * only draws it and routes the clicks. Switching layer goes through the
 * painter's own `switchKind`, the one place that asks about unsaved work — the
 * Mask dropdown uses the same door, so the two can never guard differently.
 *
 * @module ui/paint-mode-mask-list
 */

import { buildMaskList } from './mask-list-model.js';
import { createLogger } from '../core/log.js';
import { openGuide } from './rooms/guide/guide-room.js';
import { MASK_GUIDE } from './rooms/guide/guide-masks.js';

const log = createLogger('paint-mode');

const TONE_COLOR = {
  ok: '120,230,160',
  wait: '143,214,255',
  warn: '255,200,110',
  bad: '255,120,120',
  off: '150,165,185',
};

/** While a file is still loading, look again this often (only while open). */
const LOADING_RECHECK_MS = 1000;

/** Where the panel sits, in CSS px: clear of Foundry's own scene controls
 * (they end at 88px in v14). The toolbar reads `right` to slide out of its way. */
export const MASK_LIST_BOX = Object.freeze({ left: 96, width: 330, right: 96 + 330 });

/**
 * @param {object} state - the painter state.
 * @param {object} deps
 * @param {ReadonlyArray<object>} deps.paintableKinds
 * @param {(floorIndex:number)=>import('./mask-list-model.js').FloorMaskFacts|null} [deps.getMaskFacts]
 * @param {(kindId:string)=>{painted:boolean, unsaved:boolean}} deps.paintInfoFor
 * @param {(kindId:string)=>Promise<boolean>} deps.switchKind
 * @returns {{build: () => HTMLElement, toggle: (open?: boolean) => void}}
 */
export function createMaskList(state, { paintableKinds, getMaskFacts, paintInfoFor, switchKind }) {
  let recheck = 0;

  function model() {
    let facts = null;
    try {
      facts = getMaskFacts?.(state.floor) ?? null;
    } catch (err) {
      // The list is a view: a failed read shows "not checked", it never stops the painter.
      log.warn('mask facts could not be read — the list shows "not checked":', err);
    }
    const paint = {};
    for (const k of paintableKinds) paint[k.id] = paintInfoFor(k.id);
    return buildMaskList({ kinds: paintableKinds, facts, paint, activeKind: state.kind });
  }

  function build() {
    const panel = document.createElement('div');
    Object.assign(panel.style, {
      position: 'fixed',
      top: '12px',
      left: `${MASK_LIST_BOX.left}px`,
      zIndex: '101',
      width: `${MASK_LIST_BOX.width}px`,
      maxHeight: 'calc(100vh - 24px)',
      display: 'none',
      flexDirection: 'column',
      background: 'rgba(12,16,26,0.95)',
      border: '1px solid rgba(143,214,255,0.28)',
      borderRadius: '11px',
      boxShadow: '0 10px 30px rgba(0,0,0,0.5)',
      font: '11px/1.3 Signika, sans-serif',
      color: '#dcecff',
      pointerEvents: 'auto',
    });
    panel.dataset.msaMaskList = '';

    const head = document.createElement('div');
    Object.assign(head.style, {
      display: 'flex',
      alignItems: 'baseline',
      gap: '8px',
      padding: '9px 12px 6px',
      borderBottom: '1px solid rgba(143,214,255,0.14)',
    });
    const title = document.createElement('strong');
    title.style.fontSize = '12px';
    const summary = document.createElement('span');
    Object.assign(summary.style, { flex: '1', opacity: '0.85' });
    const close = document.createElement('button');
    close.textContent = '✕';
    close.title = 'Hide the mask list (M)';
    Object.assign(close.style, {
      background: 'none',
      border: 'none',
      color: '#cfe8ff',
      cursor: 'pointer',
      font: '12px Signika, sans-serif',
      padding: '0 2px',
    });
    close.addEventListener('click', () => toggle(false));
    head.append(title, summary, close);

    const list = document.createElement('div');
    Object.assign(list.style, { overflowY: 'auto', padding: '4px 6px' });

    const foot = document.createElement('div');
    Object.assign(foot.style, {
      padding: '6px 12px 9px',
      borderTop: '1px solid rgba(143,214,255,0.14)',
      opacity: '0.7',
    });
    foot.textContent = 'Click a mask to paint it. ? opens its page in the guide.';

    panel.append(head, list, foot);

    state.refreshMaskList = () => {
      window.clearTimeout(recheck);
      recheck = 0;
      panel.style.display = state.maskListOpen ? 'flex' : 'none';
      if (!state.maskListOpen) return;
      const m = model();
      title.textContent = `Masks · Floor ${state.floor}`;
      summary.textContent = m.summary;
      summary.style.color = `rgb(${TONE_COLOR[m.tone] ?? TONE_COLOR.off})`;
      list.replaceChildren(...m.rows.map(rowEl));
      if (m.rows.some((r) => r.status === 'loading' || r.status === 'unknown')) {
        recheck = window.setTimeout(() => state.refreshMaskList?.(), LOADING_RECHECK_MS);
      }
    };
    state.refreshMaskList();
    return panel;
  }

  /** @param {import('./mask-list-model.js').MaskListRow} r */
  function rowEl(r) {
    const color = TONE_COLOR[r.tone] ?? TONE_COLOR.off;
    const row = document.createElement('div');
    row.dataset.kind = r.id;
    row.dataset.status = r.status;
    row.title = r.detail;
    Object.assign(row.style, {
      display: 'grid',
      gridTemplateColumns: '10px 1fr auto auto',
      alignItems: 'center',
      columnGap: '8px',
      padding: '5px 6px',
      borderRadius: '7px',
      cursor: r.active ? 'default' : 'pointer',
      background: r.active ? 'rgba(143,214,255,0.14)' : 'transparent',
      outline: r.active ? '1px solid rgba(143,214,255,0.45)' : 'none',
    });
    if (!r.active) {
      row.addEventListener('mouseenter', () => (row.style.background = 'rgba(143,214,255,0.07)'));
      row.addEventListener('mouseleave', () => (row.style.background = 'transparent'));
      row.addEventListener('click', () => pick(r.id));
    }

    const dot = document.createElement('span');
    Object.assign(dot.style, {
      width: '9px',
      height: '9px',
      borderRadius: '50%',
      background: r.tone === 'off' ? 'transparent' : `rgb(${color})`,
      border: `1.5px solid rgb(${color})`,
      boxSizing: 'border-box',
    });

    const text = document.createElement('div');
    Object.assign(text.style, { minWidth: '0' });
    const name = document.createElement('div');
    const suffix = document.createElement('strong');
    suffix.textContent = r.suffix + (r.unsaved ? ' •' : '');
    const label = document.createElement('span');
    label.textContent = `  ${r.label}`;
    label.style.opacity = '0.65';
    name.append(suffix, label);
    const status = document.createElement('div');
    status.textContent = r.text;
    Object.assign(status.style, { color: `rgb(${color})`, fontSize: '10px' });
    text.append(name, status);

    const go = document.createElement('button');
    go.textContent = r.active ? 'Painting' : '🖌 Paint';
    go.disabled = r.active;
    Object.assign(go.style, {
      background: r.active ? 'transparent' : 'rgba(167,255,196,0.14)',
      border: `1px solid rgba(${r.active ? '143,214,255' : '167,255,196'},0.45)`,
      borderRadius: '6px',
      color: '#eaf4ff',
      font: '10px Signika, sans-serif',
      padding: '3px 8px',
      cursor: r.active ? 'default' : 'pointer',
      opacity: r.active ? '0.7' : '1',
    });
    go.addEventListener('click', (e) => {
      e.stopPropagation();
      pick(r.id);
    });

    // ? — the Map Shine Guide's page for this mask: what it does and how to paint it well.
    const page = MASK_GUIDE[r.id]?.page;
    const help = document.createElement('button');
    help.textContent = '?';
    help.title = page
      ? `How to make ${r.suffix}: open its page in the Map Shine Guide`
      : 'No guide page for this mask yet';
    help.disabled = !page;
    Object.assign(help.style, {
      width: '22px',
      height: '22px',
      borderRadius: '50%',
      border: '1px solid rgba(231,195,104,0.6)',
      background: 'rgba(231,195,104,0.14)',
      color: '#f3d98f',
      font: 'bold 11px Signika, sans-serif',
      padding: '0',
      cursor: page ? 'pointer' : 'default',
      opacity: page ? '1' : '0.35',
    });
    help.addEventListener('click', (e) => {
      e.stopPropagation();
      if (page) void openGuide(page);
    });

    row.append(dot, text, help, go);
    return row;
  }

  let picking = false;
  async function pick(kindId) {
    if (picking) return;
    picking = true;
    try {
      await switchKind(kindId);
    } finally {
      picking = false;
      state.refreshMaskList?.();
    }
  }

  function toggle(open = !state.maskListOpen) {
    state.maskListOpen = open;
    state.refreshToolbar?.();
    state.refreshMaskList?.();
  }

  return { build, toggle };
}
