/**
 * ANCHOR MODE — click-to-place, click-to-edit, drag-to-move for discrete point
 * effects (a candle flame today; any future anchor kind for free). The "place"
 * sibling of `ui/paint-mode.js`'s "paint" — same proven board-gated input
 * discipline, a much lighter surface (no grid, no brush, no undo stack).
 *
 * ============================================================================
 * SELECTION IS A REAL, CLICKABLE ICON — not proximity math (2026-07-22 rebuild)
 * ============================================================================
 *
 * The first cut of this file hit-tested clicks against a distance search
 * (`nearestAnchor`), reusing the passive diagnostic marker overlay
 * (`diag/marker-overlay.js`) for the only visual. Author feedback, live:
 * *"I can create candle flames, but I can't select them, move them or edit
 * them or remove them easily... we should probably have a unique icon for
 * every effect and use that as a way to select them."* Proximity hit-testing
 * against an overlay that was never meant to be interactive is exactly why it
 * felt unreliable — a miss silently placed a stray candle instead of editing
 * the one you meant. This rebuild draws a REAL, clickable, draggable icon
 * (`opts.icon`, per anchor KIND — `scene/anchor-catalog.js`) at every
 * anchor's screen position, reconciled every animation frame
 * (`reconcileMarkers`) the same way the diagnostic overlay tracks pan/zoom,
 * but as actual DOM elements instead of a canvas: no proximity math anywhere
 * — a click either lands ON an icon (native DOM hit-testing) or it doesn't.
 *
 * ============================================================================
 * WHY THIS STAYS EFFECT-AGNOSTIC (no candle-specific code anywhere in here)
 * ============================================================================
 *
 * Every candle-specific decision — the icon glyph, what an edit FORM looks
 * like, how "effective value" resolves against the shared default — lives in
 * boot.js (the composition root) and `diag/effect-controls.js`. This module
 * is handed a small, effect-agnostic `opts` contract FRESH on every `enter()`
 * call and never imports `effects/` or `scene/anchor-authority.js` directly —
 * the same injection discipline `vt-pan-viewer.js#getCandleRenderState`
 * already uses, applied to authoring instead of rendering. A future
 * lightning-anchor placement tool reuses this file verbatim, with its own icon.
 *
 * ============================================================================
 * INPUT DISCIPLINE (mirrors ui/paint-mode.js — READ that file's header before
 * changing this one; the same live-tested lessons apply verbatim)
 * ============================================================================
 *
 * The chrome (toolbar, icons, edit popup) is real DOM with pointer-events on
 * ITSELF only; "place a new one" is captured at `window` in the CAPTURE
 * phase, gated by a POSITIVE match against Foundry's own board element
 * (`ctx.boardElement`, foundry/paint-adapter.js) — never a hand-maintained
 * "not the toolbar" exclude list (paint-mode's own expensively-learned
 * lesson). A click that lands ON an icon never reaches that handler at all —
 * `e.target` is the icon, not the board, by construction, so "place" and
 * "select" can never race or double-fire. LEFT places/selects/drags;
 * RIGHT-drag pans and WHEEL zooms NATIVELY — this file never touches them.
 *
 * @module ui/anchor-mode
 */

import { readPaintContext } from '../foundry/index.js';

const CYAN = '143,214,255';
/** Total pointer travel (screen px) below which a pointerdown+up on an icon
 * counts as a CLICK (open the edit popup) rather than a DRAG (reposition) —
 * mirrors `debug-panel.js#makeDraggable`'s own click-vs-drag threshold. */
const DRAG_THRESHOLD_PX = 6;
const FALLBACK_ICON = '📍';

function styled(tag, style) {
  const el = document.createElement(tag);
  Object.assign(el.style, style);
  return el;
}

function button(label, onClick, rgb = CYAN) {
  const b = styled('button', {
    pointerEvents: 'auto',
    background: `rgba(${rgb},0.16)`,
    border: `1px solid rgba(${rgb},0.4)`,
    borderRadius: '6px',
    color: '#eaf4ff',
    font: '10.5px/1.2 Signika, sans-serif',
    padding: '5px 9px',
    cursor: 'pointer',
  });
  b.type = 'button';
  b.textContent = label;
  b.addEventListener('click', onClick);
  return b;
}

export function installAnchorMode(_MapShine) {
  const state = {
    active: false,
    ctx: null,
    opts: null,
    toolbar: null,
    popup: null,
    selectedIds: new Set(), // ids currently selected — popup is open iff this is non-empty
    windowHandlers: null,
    markerLayer: null, // pointer-events:none container; each icon opts back in
    markers: new Map(), // id -> { el, anchor } — the icon + the anchor it currently represents
    draggingId: null, // an id currently being dragged — reconcileMarkers skips repositioning it
    raf: 0,
  };

  function notify(msg, type = 'info') {
    globalThis.ui?.notifications?.[type]?.(msg);
  }

  /**
   * Enter placement/edit mode for one anchor kind. Tears down any prior
   * session first (switching kinds mid-session is safe, not undefined).
   * @param {object} opts
   * @param {string} opts.kindLabel - human name for the hint text ("candle").
   * @param {string} [opts.icon] - the glyph drawn at every anchor of this kind (falls back to a generic pin).
   * @param {() => Array<{id:string,x:number,y:number}>} opts.listAnchors - the CURRENT served anchors (re-read every frame — this file never caches them).
   * @param {(worldX: number, worldY: number) => void} opts.addAnchor
   * @param {(id: string, patch: object) => void} opts.updateAnchor - used for drag-to-move (`{x,y}`) and by the edit form.
   * @param {(id: string) => void} opts.removeAnchor
   * @param {(anchor: object, targetIds: string[]) => HTMLElement} opts.buildEditForm - the effect-specific fields for the popup; Delete/Close chrome is added by this file. `anchor` is a representative selection member (whichever was selected last) to read display values from; every field's `onChange` must patch ALL of `targetIds` (multi-select edits every selected anchor at once), not just `anchor.id`.
   * @returns {{ok: boolean, reason?: string}}
   */
  function enter(opts) {
    if (state.active) exit();
    const ctx = readPaintContext();
    if (!ctx.ready) {
      notify('Map Shine: open a scene before placing anchors.', 'warn');
      return { ok: false, reason: 'no active scene' };
    }
    state.active = true;
    state.ctx = ctx;
    state.opts = opts;
    buildToolbar();
    buildMarkerLayer();
    installHandlers();
    startMarkerLoop();
    return { ok: true };
  }

  function exit() {
    if (!state.active) return;
    stopMarkerLoop();
    removeHandlers();
    closePopup();
    for (const { el } of state.markers.values()) el.remove();
    state.markers.clear();
    state.markerLayer?.remove();
    state.markerLayer = null;
    state.toolbar?.remove();
    state.toolbar = null;
    state.active = false;
    state.ctx = null;
    state.opts = null;
    state.selectedIds = new Set();
    state.draggingId = null;
  }

  function isActive() {
    return state.active;
  }

  // ---- the toolbar (hint + Done) --------------------------------------------

  function buildToolbar() {
    const bar = styled('div', {
      position: 'fixed',
      top: '12px',
      left: '50%',
      transform: 'translateX(-50%)',
      zIndex: '101',
      display: 'flex',
      alignItems: 'center',
      gap: '10px',
      padding: '8px 12px',
      background: 'rgba(12,16,26,0.95)',
      border: `1px solid rgba(${CYAN},0.28)`,
      borderRadius: '10px',
      boxShadow: '0 10px 30px rgba(0,0,0,0.5)',
      font: '11px/1.3 Signika, sans-serif',
      color: '#dcecff',
      pointerEvents: 'auto',
    });
    const hint = styled('span', { opacity: '0.85' });
    hint.innerHTML =
      `Click the map to place a ${state.opts.kindLabel}. Click an existing ${state.opts.icon ?? FALLBACK_ICON} ` +
      'to edit it, or drag it to move it. Shift-click or drag a box over several to select them together — ' +
      'edit all their settings at once, or press Delete to remove them. ' +
      '<span style="opacity:.55">(Right-drag still pans, wheel still zooms.)</span>';
    bar.append(hint, button('Done', exit, '167,255,196'));
    document.body.appendChild(bar);
    state.toolbar = bar;
  }

  // ---- the marker layer — real, clickable, draggable icons -----------------

  function buildMarkerLayer() {
    const layer = styled('div', { position: 'fixed', inset: '0', zIndex: '100', pointerEvents: 'none' });
    document.body.appendChild(layer);
    state.markerLayer = layer;
  }

  function positionIcon(el, anchor) {
    const p = state.ctx.worldToClient(anchor.x, anchor.y);
    el.style.left = `${Math.round(p.x)}px`;
    el.style.top = `${Math.round(p.y)}px`;
  }

  /** Visually mark which icons (if any) are currently selected — the popup's own presence is the source of truth; this only paints it. Supports any number selected, not just one. */
  function paintSelection() {
    for (const [id, { el }] of state.markers) {
      const on = state.selectedIds.has(id);
      el.style.outline = on ? `2px solid rgb(${CYAN})` : 'none';
      el.style.outlineOffset = on ? '2px' : '0';
      el.style.transform = on ? 'translate(-50%, -85%) scale(1.2)' : 'translate(-50%, -85%) scale(1)';
    }
  }

  function makeIconEl(id) {
    const el = styled('div', {
      position: 'fixed',
      zIndex: '100',
      fontSize: '22px',
      lineHeight: '1',
      cursor: 'grab',
      userSelect: 'none',
      pointerEvents: 'auto',
      transform: 'translate(-50%, -85%)',
      filter: 'drop-shadow(0 1px 3px rgba(0,0,0,0.8))',
      transition: 'transform .08s ease',
      touchAction: 'none', // let pointermove reach the drag handler instead of becoming a scroll/pan gesture
    });
    el.textContent = state.opts.icon ?? FALLBACK_ICON;
    el.title = 'Click to edit · drag to move';
    el.addEventListener('pointerdown', (e) => startDrag(e, id, el));
    el.addEventListener('pointerenter', () => {
      if (state.draggingId !== id && !state.selectedIds.has(id))
        el.style.transform = 'translate(-50%, -85%) scale(1.12)';
    });
    el.addEventListener('pointerleave', () => {
      if (state.draggingId !== id && !state.selectedIds.has(id)) el.style.transform = 'translate(-50%, -85%) scale(1)';
    });
    return el;
  }

  /** Re-read the live anchor list and reconcile icons: create for new ids,
   * reposition existing ones (skipping whichever is mid-drag — that one is
   * being positioned live by the drag handler instead), remove for ids that
   * no longer exist. Runs every animation frame while active, the same
   * "re-read fresh, never cache" contract every other live overlay in this
   * project uses (registerCandleMarkerSource's own getPoints, for one). */
  function reconcileMarkers() {
    const anchors = state.opts.listAnchors();
    const seen = new Set();
    for (const anchor of anchors) {
      seen.add(anchor.id);
      let entry = state.markers.get(anchor.id);
      if (!entry) {
        const el = makeIconEl(anchor.id);
        state.markerLayer.appendChild(el);
        entry = { el, anchor };
        state.markers.set(anchor.id, entry);
      } else {
        entry.anchor = anchor; // keep the cached anchor fresh for click/drag handlers
      }
      if (state.draggingId !== anchor.id) positionIcon(entry.el, anchor);
    }
    for (const [id, entry] of state.markers) {
      if (!seen.has(id)) {
        entry.el.remove();
        state.markers.delete(id);
      }
    }
    // Any selected anchor removed elsewhere (e.g. a different edit, or this
    // very Delete-key path) drops out of the selection so the popup never
    // points at nothing — refreshes to the remaining selection, or closes.
    let pruned = false;
    for (const id of state.selectedIds) {
      if (!seen.has(id)) {
        state.selectedIds.delete(id);
        pruned = true;
      }
    }
    if (pruned) {
      paintSelection();
      openPopupForSelection();
    }
  }

  function startMarkerLoop() {
    const tick = () => {
      if (!state.active) return;
      reconcileMarkers();
      state.raf = requestAnimationFrame(tick);
    };
    state.raf = requestAnimationFrame(tick);
  }

  function stopMarkerLoop() {
    if (state.raf) cancelAnimationFrame(state.raf);
    state.raf = 0;
  }

  // ---- click vs. drag on an icon (mirrors debug-panel.js#makeDraggable) ----

  function startDrag(e, id, el) {
    if (e.button !== 0) return;
    closePopup();
    let moved = 0;
    let last = { x: e.clientX, y: e.clientY };
    state.draggingId = id;
    el.style.cursor = 'grabbing';
    try {
      el.setPointerCapture(e.pointerId);
    } catch (_) {}

    const onMove = (ev) => {
      moved += Math.abs(ev.clientX - last.x) + Math.abs(ev.clientY - last.y);
      last = { x: ev.clientX, y: ev.clientY };
      el.style.left = `${ev.clientX}px`;
      el.style.top = `${ev.clientY}px`;
    };
    const onUp = (ev) => {
      el.removeEventListener('pointermove', onMove);
      el.removeEventListener('pointerup', onUp);
      el.removeEventListener('pointercancel', onUp);
      try {
        el.releasePointerCapture(e.pointerId);
      } catch (_) {}
      el.style.cursor = 'grab';
      state.draggingId = null;
      if (moved < DRAG_THRESHOLD_PX) {
        selectIcon(id, ev.shiftKey || ev.ctrlKey || ev.metaKey);
      } else {
        const world = state.ctx.screenToWorld(ev.clientX, ev.clientY);
        state.opts.updateAnchor(id, { x: world.x, y: world.y });
      }
    };
    el.addEventListener('pointermove', onMove);
    el.addEventListener('pointerup', onUp);
    el.addEventListener('pointercancel', onUp);
  }

  // ---- selection --------------------------------------------------------
  // `state.selectedIds` is the one source of truth; the popup is open iff it
  // is non-empty (both `selectIcon` below and the marquee gesture funnel
  // through `openPopupForSelection`, which enforces that invariant).

  /** Click (optionally modified) on one icon. Plain click replaces the whole
   * selection with just this id — the original single-select behaviour.
   * Shift/Ctrl/Cmd-click toggles this id into or out of whatever is already
   * selected, so several candles can be built up one click at a time as an
   * alternative to the marquee drag below. */
  function selectIcon(id, additive) {
    if (additive) {
      if (state.selectedIds.has(id)) state.selectedIds.delete(id);
      else state.selectedIds.add(id);
    } else {
      state.selectedIds = new Set([id]);
    }
    paintSelection();
    openPopupForSelection();
  }

  function isEditableTarget(el) {
    if (!el) return false;
    const tag = el.tagName;
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable === true;
  }

  /** Delete-key handler — removes every currently-selected anchor. Guarded at
   * the call site against firing while the user is typing into a popup field
   * (a custom-colour hex box, say), the same way a page-level Delete listener
   * would misfire on a text input. */
  function deleteSelected() {
    const ids = Array.from(state.selectedIds);
    if (!ids.length) return;
    for (const id of ids) state.opts.removeAnchor(id);
    closePopup();
  }

  // ---- the edit popup ---------------------------------------------------

  function closePopup() {
    state.popup?.remove();
    state.popup = null;
    if (state.selectedIds.size) {
      state.selectedIds.clear();
      paintSelection();
    }
  }

  /** Open (or refresh) the popup for the CURRENT `state.selectedIds`. One
   * anchor → the familiar single edit form. More than one → the same form,
   * built once against a representative anchor (the most recently selected)
   * but wired so every field change patches ALL selected ids at once —
   * `opts.buildEditForm`'s second argument. Reads markers' CACHED anchors
   * (`reconcileMarkers` refreshed at most one frame ago — fresh enough,
   * nobody selects faster than 16ms), avoiding a second live query. */
  function openPopupForSelection() {
    const ids = Array.from(state.selectedIds);
    if (!ids.length) {
      closePopup();
      return;
    }
    const primary = state.markers.get(ids[ids.length - 1]) ?? state.markers.get(ids[0]);
    if (!primary) return;
    state.popup?.remove();
    state.popup = null;
    const opts = state.opts;
    const anchor = primary.anchor;
    const client = state.ctx.worldToClient(anchor.x, anchor.y);

    const popup = styled('div', {
      position: 'fixed',
      left: `${Math.round(client.x + 16)}px`,
      top: `${Math.round(client.y - 8)}px`,
      zIndex: '102',
      display: 'flex',
      flexDirection: 'column',
      gap: '6px',
      minWidth: '220px',
      padding: '9px 10px',
      background: 'rgba(12,16,26,0.97)',
      border: `1px solid rgba(${CYAN},0.32)`,
      borderRadius: '10px',
      boxShadow: '0 10px 30px rgba(0,0,0,0.5)',
      font: '10.5px/1.3 Signika, sans-serif',
      color: '#dcecff',
      pointerEvents: 'auto',
    });

    const head = styled('div', { display: 'flex', alignItems: 'center', gap: '8px' });
    const title = styled('span', { fontWeight: '700', flex: '1' });
    const kindTitle = opts.kindLabel[0].toUpperCase() + opts.kindLabel.slice(1);
    title.textContent =
      ids.length > 1
        ? `${opts.icon ?? FALLBACK_ICON} ${ids.length} ${opts.kindLabel}s selected`
        : `${opts.icon ?? FALLBACK_ICON} ${kindTitle}`;
    const closeBtn = styled('button', {
      pointerEvents: 'auto',
      background: 'transparent',
      border: `1px solid rgba(${CYAN},0.25)`,
      borderRadius: '5px',
      color: '#9fb6d8',
      width: '20px',
      height: '20px',
      cursor: 'pointer',
    });
    closeBtn.type = 'button';
    closeBtn.textContent = '✕';
    closeBtn.addEventListener('click', closePopup);
    head.append(title, closeBtn);
    popup.append(head);

    if (ids.length > 1) {
      const note = styled('div', { opacity: '0.7', fontSize: '9.5px' });
      note.textContent = `Showing the last-selected ${opts.kindLabel}'s values — changes below apply to all ${ids.length}.`;
      popup.append(note);
    }

    popup.append(opts.buildEditForm(anchor, ids));

    const footer = styled('div', { display: 'flex', justifyContent: 'flex-end' });
    footer.append(
      button(
        ids.length > 1 ? `🗑 Delete ${ids.length}` : '🗑 Delete',
        () => {
          for (const id of ids) opts.removeAnchor(id);
          closePopup();
        },
        '255,140,140'
      )
    );
    popup.append(footer);

    document.body.appendChild(popup);
    state.popup = popup;
  }

  // ---- marquee: drag-select several icons at once on empty board ------------
  // Mirrors `startDrag`'s own click-vs-drag distinction: a plain left-press on
  // the board is a PLACE (unchanged); dragging past the same threshold instead
  // rubber-bands a selection rectangle over the icons, so "select several" has
  // an obvious, discoverable gesture alongside shift-click above.

  function makeMarqueeEl() {
    const el = styled('div', {
      position: 'fixed',
      zIndex: '99',
      border: `1px solid rgba(${CYAN},0.9)`,
      background: `rgba(${CYAN},0.12)`,
      pointerEvents: 'none',
    });
    document.body.appendChild(el);
    return el;
  }

  function updateMarqueeRect(el, x0, y0, x1, y1) {
    el.style.left = `${Math.min(x0, x1)}px`;
    el.style.top = `${Math.min(y0, y1)}px`;
    el.style.width = `${Math.abs(x1 - x0)}px`;
    el.style.height = `${Math.abs(y1 - y0)}px`;
  }

  /** Icons whose current on-screen box (post-transform, via getBoundingClientRect
   * so the icon's own centering transform is already accounted for) falls
   * inside the rectangle spanned by the two corner points. */
  function idsInRect(x0, y0, x1, y1) {
    const left = Math.min(x0, x1);
    const right = Math.max(x0, x1);
    const top = Math.min(y0, y1);
    const bottom = Math.max(y0, y1);
    const ids = [];
    for (const [id, { el }] of state.markers) {
      const r = el.getBoundingClientRect();
      const cx = r.left + r.width / 2;
      const cy = r.top + r.height / 2;
      if (cx >= left && cx <= right && cy >= top && cy <= bottom) ids.push(id);
    }
    return ids;
  }

  function startBoardGesture(e) {
    const additive = e.shiftKey || e.ctrlKey || e.metaKey;
    const startX = e.clientX;
    const startY = e.clientY;
    let marqueeEl = null;
    const onMove = (ev) => {
      const dist = Math.max(Math.abs(ev.clientX - startX), Math.abs(ev.clientY - startY));
      if (!marqueeEl && dist >= DRAG_THRESHOLD_PX) marqueeEl = makeMarqueeEl();
      if (marqueeEl) updateMarqueeRect(marqueeEl, startX, startY, ev.clientX, ev.clientY);
    };
    const onUp = (ev) => {
      window.removeEventListener('pointermove', onMove, true);
      window.removeEventListener('pointerup', onUp, true);
      if (marqueeEl) {
        const ids = idsInRect(startX, startY, ev.clientX, ev.clientY);
        marqueeEl.remove();
        if (!additive) state.selectedIds = new Set();
        for (const id of ids) state.selectedIds.add(id);
        paintSelection();
        openPopupForSelection();
      } else {
        // Below the drag threshold — a plain click, unchanged PLACE behaviour.
        closePopup();
        const world = state.ctx.screenToWorld(ev.clientX, ev.clientY);
        state.opts.addAnchor(world.x, world.y);
      }
    };
    window.addEventListener('pointermove', onMove, true);
    window.addEventListener('pointerup', onUp, true);
  }

  // ---- input: window-capture, board-gated, LEFT only ------------------------
  // (select/edit/move are handled by each icon's own listeners above; a click
  // that lands on an icon never has `e.target === ctx.boardElement`, so it
  // never reaches this handler at all — no proximity math, no ambiguity.)

  function installHandlers() {
    const onPointerDown = (e) => {
      if (e.button !== 0) return; // LEFT only — right-drag/wheel are never touched, Foundry owns them natively
      const ctx = state.ctx;
      if (!ctx?.ready || e.target !== ctx.boardElement) return; // positive match — never a hand-excluded panel/icon list
      startBoardGesture(e);
    };
    const onKeyDown = (e) => {
      if (e.key === 'Escape') {
        if (state.popup) closePopup();
        else exit();
        return;
      }
      if ((e.key === 'Delete' || e.key === 'Backspace') && state.selectedIds.size > 0 && !isEditableTarget(e.target)) {
        e.preventDefault();
        deleteSelected();
      }
    };
    window.addEventListener('pointerdown', onPointerDown, true);
    window.addEventListener('keydown', onKeyDown, true);
    state.windowHandlers = { onPointerDown, onKeyDown };
  }

  function removeHandlers() {
    if (!state.windowHandlers) return;
    window.removeEventListener('pointerdown', state.windowHandlers.onPointerDown, true);
    window.removeEventListener('keydown', state.windowHandlers.onKeyDown, true);
    state.windowHandlers = null;
  }

  return { enter, exit, isActive };
}
