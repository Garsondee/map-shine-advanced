/**
 * ANCHOR VIEW MODE — the unified, all-kinds-at-once sibling of ui/anchor-
 * mode.js's own per-kind place/edit/drag. Shows every anchor of every
 * registered kind at once (candle, lightning, any future kind), lets a GM
 * drag one to move it, click it to edit or delete it, right-click it to
 * flip it on/off, and — via the palette row in its own toolbar — place NEW
 * anchors of a chosen kind without leaving this view. Right-drag and wheel
 * are always left completely alone; a plain left-click/drag on empty map
 * only ever does something when a palette kind is armed (see below).
 *
 * ============================================================================
 * HISTORY: THIS WAS VIEW+TOGGLE ONLY UNTIL mythica-machina-press#517
 * ============================================================================
 *
 * The first cut of this file (2026-08-06) was deliberately read/toggle-only —
 * no drag, no popup, no placement — reasoning that folding "just looking" into
 * ui/anchor-mode.js's already-large per-kind state machine would mean "am I
 * placing, editing or just looking" gets answered by yet another flag threaded
 * through code that was never designed to ask it. Author feedback (2026-09-07,
 * mythica-machina-press#517) asked for real move/delete here too, plus a small
 * icon palette to place new anchors without hopping into each effect's own
 * Workshop card — this file now does all of that.
 *
 * `ui/anchor-mode.js` and its own per-effect "➕ Place" entry points
 * (boot.js's `enterCandlePlacement`/`enterLightningPlacement`) are
 * DELIBERATELY left untouched rather than merged into this file or rewritten
 * to share it: they are an already-proven, single-kind interaction surface,
 * and rebuilding this file's multi-kind view on top of the SAME underlying
 * CRUD functions (`addCandle`/`updateCandleAnchor`/`removeCandleAnchor` and
 * their lightning twins, wired through `boot.js#enterAnchorViewMode`) gets the
 * new capability with zero blast radius on the working single-kind flow. Both
 * entry points end up editing the exact same anchor authority, so a candle
 * moved here and a candle moved from its own Workshop card are indistinguishable
 * afterward — this file is a second door onto the same room, not a fork of it.
 *
 * ============================================================================
 * THE PLACEMENT PALETTE: A KIND IS "ARMED", NOT A ONE-SHOT PICK
 * ============================================================================
 *
 * Clicking a palette icon (opts.kinds[].addAnchor must be present — a kind
 * with no placement helpers yet, like `fire` as of this writing, is simply
 * left out of the palette) arms that kind: a plain click on the map places
 * one and STAYS armed, so "place a few more" (the author's own ask) is just
 * more clicks, not re-opening the palette each time. Clicking the same
 * button again — or Escape, or Done — disarms it. Lightning's own two-click
 * start/end pairing needs no special handling here: `addLightningEndpoint`
 * (boot.js) already carries that state machine entirely on its own side, so
 * this file just calls `kind.addAnchor(worldX, worldY)` once per click
 * exactly like it would for any other kind.
 *
 * When NO kind is armed, a left-click/drag on the board is untouched, exactly
 * as this file has always behaved — arming a kind is what turns board clicks
 * into placements, never a default. A real drag past the click threshold
 * still never places anything even while armed (mirrors ui/anchor-mode.js's
 * own click-vs-drag distinction), so Foundry's native marquee-select and
 * panning underneath stay reachable.
 *
 * ============================================================================
 * WHY RIGHT-CLICK STAYS THE TOGGLE, AND WHY IT IS SAFE NEXT TO NATIVE PANNING
 * ============================================================================
 *
 * Foundry's own canvas uses right-drag to pan; this project's own convention
 * (ui/anchor-mode.js's header) is that no file here touches that gesture.
 * This file doesn't either — `contextmenu` is bound to each ICON element only
 * (a small `pointer-events: auto` glyph), never to the board, so a right-press
 * that starts on empty map is untouched and pans exactly as before. Only a
 * right-click that lands ON a drawn icon is ever seen here, the same
 * "`e.target` IS the icon, by construction" guarantee anchor-mode.js already
 * relies on for its own left-click select/drag split.
 *
 * ============================================================================
 * WHY `anchorsForKindOnFloor`, NOT THE RENDER PATH'S `anchorsForEffect`
 * ============================================================================
 *
 * `anchorsForEffect` (scene/anchor-authority.js) deliberately drops disabled
 * anchors — that is the RENDER path's "only what should currently draw"
 * contract. This mode's whole point is showing a GM the OFF ones too, so they
 * can find and re-enable one — building it on the render read would mean a
 * greyed-out anchor simply never appears at all, which defeats the feature
 * (feedback_discovery_scope_narrower_than_authority). `anchorsForKindOnFloor`
 * (unfiltered by `enabled`, filtered to the viewed floor the same way the
 * render path is) is what `opts.kinds[].listAnchors` is wired to.
 *
 * @module ui/anchor-view-mode
 */

import { readPaintContext } from '../foundry/index.js';
import { createLogger } from '../core/log.js';

const log = createLogger('AnchorViewMode');
const CYAN = '143,214,255';
const FALLBACK_ICON = '📍';
/** Total pointer travel (screen px) below which a pointerdown+up counts as a
 * CLICK (select/edit an icon, or place a new anchor on the board) rather than
 * a DRAG (reposition an icon, or — on the board — leave the gesture to
 * Foundry) — mirrors ui/anchor-mode.js's own identical constant. */
const DRAG_THRESHOLD_PX = 6;

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

export function installAnchorViewMode(_MapShine) {
  const state = {
    active: false,
    ctx: null,
    opts: null, // { kinds, onExit? } — fresh every enter()
    toolbar: null,
    hintEl: null, // the toolbar's hint <span> — mutated live by updateHintText()
    paletteButtons: null, // Map<kindId, HTMLButtonElement> — rebuilt every enter()
    markerLayer: null,
    markers: new Map(), // "<kindId>:<anchorId>" -> { el, anchor, kind }
    selectedId: null, // markerId with its edit popup open, or null
    draggingId: null, // markerId currently being dragged — reconcileMarkers skips repositioning it
    armedKindId: null, // the kind a plain board click currently places, or null
    popup: null,
    windowHandlers: null,
    raf: 0,
    // POOL HEALTH (cache-completeness pass, 2026-08-12) — same doctrine as
    // ui/anchor-mode.js's own markerPoolStats: hits = an existing marker
    // reused; misses = a new markerId, its icon created.
    markerPoolStats: { hits: 0, misses: 0 },
  };

  function notify(msg, type = 'info') {
    globalThis.ui?.notifications?.[type]?.(msg);
  }

  /** Mirrors ui/anchor-mode.js#resolveIcon — a plain glyph or a
   * `(anchor) => glyph` per-kind resolver (lightning's start/end/waypoint). */
  function resolveIcon(kind, anchor) {
    const icon = kind.icon;
    if (typeof icon === 'function') return icon(anchor) ?? FALLBACK_ICON;
    return icon ?? FALLBACK_ICON;
  }

  function kindById(kindId) {
    return state.opts?.kinds.find((k) => k.kindId === kindId) ?? null;
  }

  /**
   * Enter view mode across every supplied anchor kind. Tears down any prior
   * session first, same as ui/anchor-mode.js#enter.
   * @param {object} opts
   * @param {Array<{
   *   kindId: string,
   *   label: string,
   *   icon?: string|((anchor: object) => string),
   *   listAnchors: () => Array<object>,
   *   updateAnchor: (id: string, patch: object) => void,
   *   removeAnchor: (id: string) => void,
   *   addAnchor?: (worldX: number, worldY: number) => void - omit to leave
   *     this kind out of the placement palette (it can still be viewed,
   *     moved, edited, deleted and toggled with no addAnchor at all).
   *   buildEditForm: (anchor: object, targetIds: string[]) => HTMLElement,
   * }>} opts.kinds - one entry per anchor kind to show, ALL at once.
   * @param {() => void} [opts.onExit] - fired when this session ends, for
   *   whatever reason (the toolbar's Done button, Escape, or a caller
   *   re-entering) — lets the caller keep an external toggle (a scene-
   *   controls button) honest without polling `isActive()`.
   * @returns {{ok: boolean, reason?: string}}
   */
  function enter(opts) {
    if (state.active) exit();
    const ctx = readPaintContext();
    if (!ctx.ready) {
      notify('Map Shine: open a scene before viewing anchors.', 'warn');
      return { ok: false, reason: 'no active scene' };
    }
    if (!Array.isArray(opts?.kinds) || opts.kinds.length === 0) {
      return { ok: false, reason: 'no anchor kinds supplied' };
    }
    state.active = true;
    state.ctx = ctx;
    state.opts = opts;
    state.selectedId = null;
    state.draggingId = null;
    state.armedKindId = null;
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
    state.hintEl = null;
    state.paletteButtons = null;
    state.active = false;
    state.ctx = null;
    state.selectedId = null;
    state.draggingId = null;
    state.armedKindId = null;
    const onExit = state.opts?.onExit;
    state.opts = null;
    onExit?.();
  }

  function isActive() {
    return state.active;
  }

  // ---- the toolbar: hint + Done, plus the placement palette -----------------

  function buildToolbar() {
    const bar = styled('div', {
      position: 'fixed',
      top: '12px',
      left: '50%',
      transform: 'translateX(-50%)',
      zIndex: '101',
      display: 'flex',
      flexDirection: 'column',
      gap: '8px',
      padding: '8px 12px',
      background: 'rgba(12,16,26,0.95)',
      border: `1px solid rgba(${CYAN},0.28)`,
      borderRadius: '10px',
      boxShadow: '0 10px 30px rgba(0,0,0,0.5)',
      font: '11px/1.3 Signika, sans-serif',
      color: '#dcecff',
      pointerEvents: 'auto',
    });

    const topRow = styled('div', { display: 'flex', alignItems: 'center', gap: '10px' });
    const hint = styled('span', { opacity: '0.85' });
    topRow.append(hint, button('Done', exit, '167,255,196'));

    const paletteRow = styled('div', { display: 'flex', alignItems: 'center', gap: '6px' });
    const paletteLabel = styled('span', { opacity: '0.55', fontSize: '9.5px', letterSpacing: '0.04em' });
    paletteLabel.textContent = 'PLACE:';
    paletteRow.append(paletteLabel);
    state.paletteButtons = new Map();
    for (const kind of state.opts.kinds) {
      if (!kind.addAnchor) continue; // no placement helpers yet (e.g. fire) — view/move/edit/delete still work
      const btn = makePaletteButton(kind);
      state.paletteButtons.set(kind.kindId, btn);
      paletteRow.append(btn);
    }

    bar.append(topRow, paletteRow);
    document.body.appendChild(bar);
    state.toolbar = bar;
    state.hintEl = hint;
    updateHintText();
  }

  function makePaletteButton(kind) {
    const b = styled('button', {
      pointerEvents: 'auto',
      background: `rgba(${CYAN},0.12)`,
      border: `1px solid rgba(${CYAN},0.35)`,
      borderRadius: '6px',
      fontSize: '16px',
      lineHeight: '1',
      padding: '4px 9px',
      cursor: 'pointer',
      transition: 'background .1s ease, border-color .1s ease, transform .08s ease',
    });
    b.type = 'button';
    b.textContent = resolveIcon(kind, null);
    b.title = `Place a new ${kind.label} — click, then click the map. Click this again to stop.`;
    b.addEventListener('click', () => armKind(kind.kindId));
    return b;
  }

  function paintPaletteState() {
    if (!state.paletteButtons) return;
    for (const [kindId, btn] of state.paletteButtons) {
      const on = state.armedKindId === kindId;
      btn.style.background = on ? `rgba(${CYAN},0.55)` : `rgba(${CYAN},0.12)`;
      btn.style.borderColor = on ? `rgba(${CYAN},0.9)` : `rgba(${CYAN},0.35)`;
      btn.style.transform = on ? 'scale(1.12)' : 'scale(1)';
    }
  }

  /** Toggle whether `kindId` is the one a plain board click places. Closes
   * any open edit popup first — placing and editing are two different
   * intents, and a stale popup left open mid-placement is just clutter. */
  function armKind(kindId) {
    closePopup();
    state.armedKindId = state.armedKindId === kindId ? null : kindId;
    paintPaletteState();
    updateHintText();
  }

  function updateHintText() {
    if (!state.hintEl) return;
    if (state.armedKindId) {
      const kind = kindById(state.armedKindId);
      const glyph = kind ? resolveIcon(kind, null) : FALLBACK_ICON;
      state.hintEl.innerHTML =
        `${glyph} <b>Placing ${kind?.label ?? 'anchor'}s</b> — click the map to drop another. ` +
        `Click ${glyph} again to stop. ` +
        '<span style="opacity:.55">(Right-drag still pans, wheel still zooms.)</span>';
      return;
    }
    const kindNames = state.opts.kinds.map((k) => k.label ?? k.kindId).join(' & ');
    state.hintEl.innerHTML =
      `\u{1F441}\u{FE0F} <b>MSA Anchor View</b> — every ${kindNames} anchor is shown. ` +
      'Drag one to move it, click it to edit or delete it, <b>right-click</b> to switch it on/off. ' +
      'Pick an icon below to place a new one. ' +
      '<span style="opacity:.55">(Right-drag still pans, wheel still zooms.)</span>';
  }

  // ---- the marker layer — real icons, positioned every frame ---------------

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

  /** The "signposted" affordance for OFF: greyscale + dimmed + a tooltip
   * spelling out every gesture, so a GM never has to guess why one candle
   * looks different from the rest or what a click on it will do. */
  function paintEnabledState(el, anchor) {
    const on = anchor.enabled !== false;
    el.style.opacity = on ? '1' : '0.4';
    el.style.filter = on
      ? 'drop-shadow(0 1px 3px rgba(0,0,0,0.8))'
      : 'grayscale(1) drop-shadow(0 1px 3px rgba(0,0,0,0.8))';
    el.title = `${on ? 'On' : 'OFF'} — drag to move · click to edit/delete · right-click to turn ${on ? 'off' : 'back on'}`;
  }

  /** Visually mark the ONE currently-selected icon (if any) — the popup's own
   * presence is the source of truth; this only paints it. Mirrors ui/anchor-
   * mode.js#paintSelection, single-select only (this view has no marquee). */
  function paintSelection() {
    for (const [markerId, entry] of state.markers) {
      const on = state.selectedId === markerId;
      entry.el.style.outline = on ? `2px solid rgb(${CYAN})` : 'none';
      entry.el.style.outlineOffset = on ? '2px' : '0';
      entry.el.style.transform = on ? 'translate(-50%, -85%) scale(1.2)' : 'translate(-50%, -85%) scale(1)';
    }
  }

  function makeIconEl(markerId, kind, initialAnchor) {
    const el = styled('div', {
      position: 'fixed',
      zIndex: '100',
      fontSize: '22px',
      lineHeight: '1',
      cursor: 'grab',
      userSelect: 'none',
      pointerEvents: 'auto',
      transform: 'translate(-50%, -85%)',
      transition: 'opacity .12s ease, filter .12s ease, transform .08s ease',
      touchAction: 'none',
    });
    // Set ONCE at creation, matching ui/anchor-mode.js#makeIconEl — a role
    // (what a role-aware icon function keys off) never changes after placement.
    el.textContent = resolveIcon(kind, initialAnchor);
    el.addEventListener('pointerdown', (e) => startDrag(e, markerId, el));
    el.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      // Read the CURRENT anchor off the marker entry, not the closed-over
      // `initialAnchor` — reconcileMarkers refreshes `entry.anchor` every
      // frame, so a rapid double right-click always toggles from the real
      // current state instead of racing a stale one.
      const entry = state.markers.get(markerId);
      if (!entry) return;
      const nextEnabled = entry.anchor.enabled === false;
      entry.kind.updateAnchor(entry.anchor.id, { enabled: nextEnabled });
    });
    el.addEventListener('pointerenter', () => {
      if (state.draggingId !== markerId && state.selectedId !== markerId)
        el.style.transform = 'translate(-50%, -85%) scale(1.15)';
    });
    el.addEventListener('pointerleave', () => {
      if (state.draggingId !== markerId && state.selectedId !== markerId)
        el.style.transform = 'translate(-50%, -85%) scale(1)';
    });
    return el;
  }

  // ---- click vs. drag on an icon (mirrors ui/anchor-mode.js#startDrag) -----

  function startDrag(e, markerId, el) {
    if (e.button !== 0) return;
    closePopup();
    let moved = 0;
    let last = { x: e.clientX, y: e.clientY };
    state.draggingId = markerId;
    el.style.cursor = 'grabbing';
    try {
      el.setPointerCapture(e.pointerId);
    } catch (err) {
      // Harmless and rare (pointer already released, invalid id) — the drag
      // still works via the plain pointermove/up listeners below, capture
      // only guarantees they keep firing if the cursor leaves the icon.
      log.debug('setPointerCapture failed — drag continues without capture:', err);
    }

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
      } catch (err) {
        log.debug('releasePointerCapture failed — harmless, capture was likely already released:', err);
      }
      el.style.cursor = 'grab';
      state.draggingId = null;
      if (moved < DRAG_THRESHOLD_PX) {
        selectMarker(markerId);
      } else {
        const entry = state.markers.get(markerId);
        if (entry) {
          const world = state.ctx.screenToWorld(ev.clientX, ev.clientY);
          entry.kind.updateAnchor(entry.anchor.id, { x: world.x, y: world.y });
        }
      }
    };
    el.addEventListener('pointermove', onMove);
    el.addEventListener('pointerup', onUp);
    el.addEventListener('pointercancel', onUp);
  }

  // ---- selection + the edit popup -------------------------------------------
  // Single-select only (unlike anchor-mode.js's marquee-capable multi-select)
  // — this view's own job is "find one anchor among all kinds and fix it",
  // not bulk editing; `state.selectedId` is the one source of truth, and the
  // popup is open iff it is non-null.

  function selectMarker(markerId) {
    state.selectedId = markerId;
    paintSelection();
    openPopupFor(markerId);
  }

  function closePopup() {
    state.popup?.remove();
    state.popup = null;
    if (state.selectedId) {
      state.selectedId = null;
      paintSelection();
    }
  }

  function isEditableTarget(el) {
    if (!el) return false;
    const tag = el.tagName;
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable === true;
  }

  /** Delete-key handler — removes the current selection. Guarded at the call
   * site against firing while the user is typing into a popup field (a
   * custom-colour hex box, say), same as ui/anchor-mode.js's own guard. */
  function deleteSelected() {
    if (!state.selectedId) return;
    const entry = state.markers.get(state.selectedId);
    if (!entry) return;
    entry.kind.removeAnchor(entry.anchor.id);
    closePopup();
  }

  /** Open (or refresh) the popup for the current `state.selectedId`. Reuses
   * the SAME per-kind `buildEditForm` (buildCandleEditForm/
   * buildLightningEditForm) ui/anchor-mode.js's own popup already calls —
   * both are boot.js-level closures with no dependency on anchor-mode.js
   * internals, so an edit made from here and one made from the per-effect
   * Place tool go through the identical validate-and-persist path. */
  function openPopupFor(markerId) {
    const entry = state.markers.get(markerId);
    if (!entry) {
      closePopup();
      return;
    }
    state.popup?.remove();
    state.popup = null;
    const { anchor, kind } = entry;
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
    const kindTitle = kind.label[0].toUpperCase() + kind.label.slice(1);
    title.textContent = `${resolveIcon(kind, anchor)} ${kindTitle}`;
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

    popup.append(kind.buildEditForm(anchor, [anchor.id]));

    // Delete on the LEFT, Apply on the right — matches ui/anchor-mode.js's own
    // popup footer exactly (2026-08-06 fix there: Delete must never sit alone
    // in the "OK spot", or a reflexive dismiss-click deletes a good anchor
    // instead of closing the popup). Apply is just another close — every
    // field already commits live via its own onChange.
    const footer = styled('div', { display: 'flex', justifyContent: 'space-between', alignItems: 'center' });
    footer.append(
      button(
        '🗑 Delete',
        () => {
          kind.removeAnchor(anchor.id);
          closePopup();
        },
        '255,140,140'
      ),
      button('✅ Apply', closePopup, '167,255,196')
    );
    popup.append(footer);

    document.body.appendChild(popup);
    state.popup = popup;
  }

  /** Re-read every kind's anchors fresh and reconcile the combined icon set —
   * the same create/reposition/remove shape as ui/anchor-mode.js#
   * reconcileMarkers, fanned out across `opts.kinds` instead of just one.
   * Marker ids are namespaced per kind (`kindId:anchorId`) so two kinds can
   * never collide even if their own anchor ids happen to match. */
  function reconcileMarkers() {
    const seen = new Set();
    for (const kind of state.opts.kinds) {
      const anchors = kind.listAnchors?.() ?? [];
      for (const anchor of anchors) {
        const markerId = `${kind.kindId}:${anchor.id}`;
        seen.add(markerId);
        let entry = state.markers.get(markerId);
        if (!entry) {
          state.markerPoolStats.misses += 1;
          const el = makeIconEl(markerId, kind, anchor);
          state.markerLayer.appendChild(el);
          entry = { el, anchor, kind };
          state.markers.set(markerId, entry);
        } else {
          state.markerPoolStats.hits += 1;
          entry.anchor = anchor; // keep the cached anchor fresh for click/drag/toggle handlers
        }
        if (state.draggingId !== markerId) positionIcon(entry.el, anchor);
        paintEnabledState(entry.el, anchor);
      }
    }
    for (const [markerId, entry] of state.markers) {
      if (!seen.has(markerId)) {
        entry.el.remove();
        state.markers.delete(markerId);
      }
    }
    // A selected anchor removed elsewhere (this very Delete path, or a toggle
    // that dropped it off the current floor) closes its popup instead of
    // leaving it pointing at nothing.
    if (state.selectedId && !seen.has(state.selectedId)) closePopup();
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

  // ---- placing a new anchor on the board (only while a kind is armed) ------
  // Mirrors ui/anchor-mode.js#startBoardGesture's own click-vs-drag threshold,
  // minus the marquee branch (this view has no multi-select): a clean click
  // places, a real drag leaves the gesture to Foundry untouched underneath —
  // the same "never draw an MSA rectangle over Foundry's own" lesson
  // mythica-machina-press#514 already established for anchor-mode.js applies
  // here by construction, since this file never draws one either.

  function startBoardPlacement(e) {
    const startX = e.clientX;
    const startY = e.clientY;
    let dragging = false;
    const onMove = (ev) => {
      const dist = Math.max(Math.abs(ev.clientX - startX), Math.abs(ev.clientY - startY));
      if (dist >= DRAG_THRESHOLD_PX) dragging = true;
    };
    const onUp = (ev) => {
      window.removeEventListener('pointermove', onMove, true);
      window.removeEventListener('pointerup', onUp, true);
      if (dragging || !state.armedKindId) return;
      const kind = kindById(state.armedKindId);
      if (!kind?.addAnchor) return;
      const world = state.ctx.screenToWorld(ev.clientX, ev.clientY);
      kind.addAnchor(world.x, world.y);
    };
    window.addEventListener('pointermove', onMove, true);
    window.addEventListener('pointerup', onUp, true);
  }

  // ---- input: window-capture, board-gated ------------------------------------
  // (select/edit/drag/toggle are handled by each icon's own listeners above; a
  // click that lands on an icon never has `e.target === ctx.boardElement`, so
  // it never reaches this handler at all.)

  function installHandlers() {
    const onPointerDown = (e) => {
      if (e.button !== 0) return; // LEFT only — right-drag/wheel are never touched, Foundry owns them natively
      if (!state.armedKindId) return; // nothing armed — board clicks stay untouched, exactly as before this feature existed
      const ctx = state.ctx;
      if (!ctx?.ready || e.target !== ctx.boardElement) return; // positive match — never a hand-excluded panel/icon list
      startBoardPlacement(e);
    };
    const onKeyDown = (e) => {
      if (e.key === 'Escape') {
        if (state.popup) closePopup();
        else exit();
        return;
      }
      if ((e.key === 'Delete' || e.key === 'Backspace') && state.selectedId && !isEditableTarget(e.target)) {
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

  return {
    enter,
    exit,
    isActive,
    /** POOL HEALTH — see markerPoolStats' own declaration for the exact
     * hit/miss doctrine. */
    getMarkerPoolStats() {
      return { ...state.markerPoolStats };
    },
  };
}
