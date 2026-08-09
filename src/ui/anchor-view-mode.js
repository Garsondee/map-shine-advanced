/**
 * ANCHOR VIEW MODE — the read/toggle sibling of ui/anchor-mode.js's own
 * place/edit/drag. Shows every anchor of every registered kind at once
 * (candle, lightning, any future kind), ON or OFF, so a GM can find one and
 * flip it without opening each effect's own placement tool first. Right-click
 * an icon toggles it (icon greys when off); left-click, drag, right-drag and
 * wheel are all left completely alone — this mode never places, edits or
 * moves anything, it only shows and flips.
 *
 * ============================================================================
 * WHY THIS IS A SEPARATE FILE, NOT A MODE OF ui/anchor-mode.js
 * ============================================================================
 *
 * anchor-mode.js is a per-KIND session (one "Place candle" / "Place
 * lightning" tool, entered from that effect's own Workshop card) with a real
 * state machine for drag-to-move, marquee-select and a multi-field edit
 * popup. This mode shows EVERY kind at once, has no placement, no drag and no
 * popup — folding a "just looking, toggle only" concern into anchor-mode.js's
 * already-large per-kind state machine would mean "am I placing, editing or
 * just looking" gets answered by yet another flag threaded through code that
 * was never designed to ask it. A second small file, entered from its own
 * scene-controls button (foundry/scene-controls-button.js) rather than a
 * Workshop card, keeps each file's contract simple enough to read in one
 * sitting — the same reasoning that already keeps this file's own sibling,
 * ui/paint-mode.js, separate from this one.
 *
 * ============================================================================
 * WHY RIGHT-CLICK, AND WHY IT IS SAFE NEXT TO NATIVE RIGHT-DRAG PANNING
 * ============================================================================
 *
 * Foundry's own canvas uses right-drag to pan; ui/anchor-mode.js's own header
 * is explicit that no file in this project should touch that gesture. This
 * file doesn't either — `contextmenu` is bound to each ICON element only
 * (a small `pointer-events: auto` glyph), never to the board, so a right-press
 * that starts on empty map is untouched and pans exactly as before. Only a
 * right-click that lands ON a drawn icon is ever seen here, the same
 * "`e.target` IS the icon, by construction" guarantee anchor-mode.js already
 * relies on for its own left-click edit/select split.
 *
 * ============================================================================
 * WHY A NEW `anchorsForKind` READ, NOT THE EXISTING `anchorsForEffect`
 * ============================================================================
 *
 * `anchorsForEffect` (scene/anchor-authority.js) deliberately drops disabled
 * anchors — that is the RENDER path's "only what should currently draw"
 * contract. This mode's whole point is showing a GM the OFF ones too, so they
 * can find and re-enable one — building it on the render read would mean a
 * greyed-out anchor simply never appears at all, which defeats the feature
 * (feedback_discovery_scope_narrower_than_authority). `anchorsForKind`
 * (unfiltered by `enabled`) is what this file's own `opts.kinds[].listAnchors`
 * is expected to be wired to.
 *
 * @module ui/anchor-view-mode
 */

import { readPaintContext } from '../foundry/index.js';

const CYAN = '143,214,255';
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

export function installAnchorViewMode(_MapShine) {
  const state = {
    active: false,
    ctx: null,
    opts: null, // { kinds, onExit? } — fresh every enter()
    toolbar: null,
    markerLayer: null,
    markers: new Map(), // "<kindId>:<anchorId>" -> { el, anchor, kind }
    windowHandlers: null,
    raf: 0,
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

  /**
   * Enter view mode across every supplied anchor kind. Tears down any prior
   * session first, same as ui/anchor-mode.js#enter.
   * @param {object} opts
   * @param {Array<{
   *   kindId: string,
   *   label: string,
   *   icon?: string|((anchor: object) => string),
   *   listAnchors: () => Array<object>,
   *   setEnabled: (id: string, enabled: boolean) => void,
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
    for (const { el } of state.markers.values()) el.remove();
    state.markers.clear();
    state.markerLayer?.remove();
    state.markerLayer = null;
    state.toolbar?.remove();
    state.toolbar = null;
    state.active = false;
    state.ctx = null;
    const onExit = state.opts?.onExit;
    state.opts = null;
    onExit?.();
  }

  function isActive() {
    return state.active;
  }

  // ---- the toolbar (hint + Done) — signposts the right-click gesture -------

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
    const kindNames = state.opts.kinds.map((k) => k.label ?? k.kindId).join(' & ');
    const hint = styled('span', { opacity: '0.85' });
    hint.innerHTML =
      `\u{1F441}\u{FE0F} <b>MSA Anchor View</b> — every ${kindNames} anchor is shown, on or off. ` +
      '<b>Right-click</b> one to switch it on/off (grey = off). ' +
      '<span style="opacity:.55">(Left-click, right-drag and wheel are untouched — pan and zoom as normal.)</span>';
    bar.append(hint, button('Done', exit, '167,255,196'));
    document.body.appendChild(bar);
    state.toolbar = bar;
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

  /** The whole "signposted" affordance for OFF: greyscale + dimmed + a
   * tooltip spelling out the gesture, so a GM never has to guess why one
   * candle looks different from the rest. */
  function paintEnabledState(el, anchor) {
    const on = anchor.enabled !== false;
    el.style.opacity = on ? '1' : '0.4';
    el.style.filter = on
      ? 'drop-shadow(0 1px 3px rgba(0,0,0,0.8))'
      : 'grayscale(1) drop-shadow(0 1px 3px rgba(0,0,0,0.8))';
    el.title = on ? 'Right-click to turn OFF' : 'OFF — right-click to turn back ON';
  }

  function makeIconEl(markerId, kind, initialAnchor) {
    const el = styled('div', {
      position: 'fixed',
      zIndex: '100',
      fontSize: '22px',
      lineHeight: '1',
      cursor: 'context-menu',
      userSelect: 'none',
      pointerEvents: 'auto',
      transform: 'translate(-50%, -85%)',
      transition: 'opacity .12s ease, filter .12s ease, transform .08s ease',
      touchAction: 'none',
    });
    // Set ONCE at creation, matching ui/anchor-mode.js#makeIconEl — a role
    // (what a role-aware icon function keys off) never changes after placement.
    el.textContent = resolveIcon(kind, initialAnchor);
    el.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      // Read the CURRENT anchor off the marker entry, not the closed-over
      // `initialAnchor` — `reconcileMarkers` refreshes `entry.anchor` every
      // frame, so a rapid double right-click always toggles from the real
      // current state instead of racing a stale one.
      const entry = state.markers.get(markerId);
      if (!entry) return;
      const nextEnabled = entry.anchor.enabled === false;
      kind.setEnabled(entry.anchor.id, nextEnabled);
    });
    el.addEventListener('pointerenter', () => {
      el.style.transform = 'translate(-50%, -85%) scale(1.15)';
    });
    el.addEventListener('pointerleave', () => {
      el.style.transform = 'translate(-50%, -85%) scale(1)';
    });
    return el;
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
          const el = makeIconEl(markerId, kind, anchor);
          state.markerLayer.appendChild(el);
          entry = { el, anchor, kind };
          state.markers.set(markerId, entry);
        } else {
          entry.anchor = anchor; // keep the cached anchor fresh for the toggle handler
        }
        positionIcon(entry.el, anchor);
        paintEnabledState(entry.el, anchor);
      }
    }
    for (const [markerId, entry] of state.markers) {
      if (!seen.has(markerId)) {
        entry.el.remove();
        state.markers.delete(markerId);
      }
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

  // ---- input: Escape only — everything else (left-click, right-drag, wheel)
  // reaches Foundry's own canvas untouched, by never being listened for here.

  function installHandlers() {
    const onKeyDown = (e) => {
      if (e.key === 'Escape') exit();
    };
    window.addEventListener('keydown', onKeyDown, true);
    state.windowHandlers = { onKeyDown };
  }

  function removeHandlers() {
    if (!state.windowHandlers) return;
    window.removeEventListener('keydown', state.windowHandlers.onKeyDown, true);
    state.windowHandlers = null;
  }

  return { enter, exit, isActive };
}
