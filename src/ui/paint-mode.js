/**
 * PAINT MODE — the browser half of the in-app painter (UX + feature pass).
 *
 * A modal AUTHORING surface (map-maker, opt-in). The overlay is VISUAL ONLY
 * (`pointer-events: none`); input is captured at the window in the capture
 * phase so that:
 *   - LEFT        → paint (brush) or place a vertex (point/line/polygon tools)
 *   - RIGHT-drag  → Foundry pans NATIVELY (we don't touch it — confirmed
 *                   against source: board.mjs's `_onDragRightStart` is
 *                   Foundry's OWN canvas-pan handler, distinct from
 *                   `_onDragLeftStart` used for placeable/selection input)
 *   - WHEEL       → Foundry zooms NATIVELY (we don't touch it)
 * LEFT paints because that is the primary-action button in every paint tool
 * (and in Foundry itself); RIGHT was tried first (2026-07-20) and reported
 * broken navigation — it was capturing Foundry's actual pan gesture, not a
 * free button. Swapped the same day.
 *
 * Never touches the gameplay input path beyond suppressing the LEFT button
 * while active (keyhole-input-model-decision: Foundry owns gameplay input;
 * this is authoring, and it un-suppresses on exit). The right button and its
 * context menu are never touched — Foundry owns its own pan/menu handling.
 *
 * UI PASS-THROUGH (2026-07-20 fix): a stroke starts ONLY when the press
 * target is Foundry's own board canvas (`ctx.boardElement`, foundry/paint-
 * adapter.js) — a positive match against the one element that IS the map.
 * The bug this replaces: the window-capture listener checked only the mouse
 * button, so a left-click on the TOOLBAR (or the debug panel, or Foundry's
 * own sidebar/hotbar) still resolved a screen position and painted through
 * it. A hand-excluded list of "not the toolbar" would have fixed the report
 * but kept missing every other panel; checking FOR the board is the one
 * check that can never miss the next one.
 *
 * Pure model/brush/codec/persistence: scene/paint-mask.js (Node-tested).
 * All Foundry/PIXI access: foundry/paint-adapter.js. This file is DOM glue,
 * verified live.
 *
 * SCOPE: any authored mask kind (dropdown), PER-FLOOR masks (a Floor stepper —
 * paint on floor N only ever touches floor N), a 4096² grid with a dirty-rect
 * preview (re-packs only what changed), embed persistence with an unsaved-changes
 * guard (on close + on effect switch), a spray/paint/erase brush, AND the
 * Author-Mode vector tools — point / line (stroked) / polygon (filled) — all
 * rasterizing into the SAME mask the brush writes (Shapes-and-Regions.md), with
 * an optional 4×4 sub-grid snap, shared undo, and a live draft preview. Deferred:
 * retained/editable vector shapes + a Select tool, bake-to-file (Mode B),
 * auto-following the viewed floor, the package gate.
 *
 * @module ui/paint-mode
 */

import {
  createPaintLayer,
  stampBrushWorld,
  rasterizePolygon,
  rasterizeStrokedLine,
  serializePaintedMasks,
  hydratePaintedMasks,
  encodedByteEstimate,
  PAINT_EMBED_BYTE_BUDGET,
  MASK_KINDS,
} from '../scene/index.js';
import { readPaintContext, savePaintedMasks, loadPaintedMasks } from '../foundry/index.js';

const UNDO_LIMIT = 10; // at PAINT_GRID_MAX_DIM=4096 each undo snapshot is ~16MB — keep the stack bounded

/** Preview tints per mask kind (kind IDs, not suffixes — the catalog owns suffixes). */
const KIND_COLORS = {
  fire: [255, 70, 0],
  water: [40, 130, 255],
  dust: [210, 190, 130],
  outdoors: [130, 230, 130],
  shadow: [40, 30, 70],
  specular: [255, 240, 170],
  window: [255, 215, 120],
  tree: [70, 180, 90],
  bush: [110, 200, 110],
};
const colorFor = (kind) => KIND_COLORS[kind] ?? [255, 70, 0];

/** Authored (paintable) kinds only — derived products (skyReach…) have no suffix. */
const PAINTABLE_KINDS = MASK_KINDS.filter((k) => Array.isArray(k.suffixes) && k.suffixes.length > 0);

export function installPainter(MapShine) {
  const state = {
    active: false,
    ctx: null,
    kind: PAINTABLE_KINDS[0]?.id ?? 'fire',
    layers: {}, // `${kind}::${floor}` -> MaskGrid
    floor: 0, // which floor these strokes apply to — masks are PER-FLOOR (the Floor stepper picks it)
    gridCanvases: {}, // key -> offscreen canvas
    gridImageData: {}, // key -> cached ImageData for that canvas (reused, not reallocated, per frame)
    dirty: new Set(), // keys whose gridCanvas needs re-rendering
    previewRect: {}, // key -> {x0,y0,x1,y1} cell bounds changed since last render, or `true` for the whole grid
    dirtySinceSave: false, // any unsaved edits? drives the Save indicator + the close/switch guards
    modalOpen: false, // a confirm dialog is up — paint input pauses while it is
    overlay: null,
    canvas: null,
    toolbar: null,
    raf: 0,
    painting: false,
    lastWorld: null,
    mouseClient: null,
    hoverOnBoard: false, // is the CURRENT hover over Foundry's board (not a UI panel)? gates the ring
    brush: { radius: 90, strength: 180, hardness: 0.55, mode: 'add' }, // mode: paint | add | erase
    tool: 'brush', // brush | point | line | polygon
    draft: null, // in-progress line/polygon: { type, vertices: [{x,y}...] }
    snap: false, // 4×4 sub-grid snap for vector vertices — OFF by default (precision-first)
    cursorWorld: null, // live cursor in world coords, for the rubber-band preview
    undo: [],
    handlers: null,
    refreshToolbar: null,
  };

  const notify = (msg, type = 'info') => globalThis.ui?.notifications?.[type]?.(msg);
  const keyOf = (kind) => `${kind}::${state.floor}`;
  const activeKey = () => keyOf(state.kind);

  function layerFor(kind) {
    const key = keyOf(kind);
    if (!state.layers[key]) state.layers[key] = createPaintLayer(state.ctx.sceneRect);
    return state.layers[key];
  }

  // ---- dirty tracking ----------------------------------------------------
  // Which cells changed since the last render, so the preview re-packs ONLY
  // that rectangle (O(changed), not O(grid)) — the whole reason a 4096² grid
  // can stay smooth. `true` means the whole grid changed (undo/clear/switch).
  function markCells(key, x0, y0, x1, y1) {
    const spec = state.layers[key]?.spec;
    if (!spec) return;
    x0 = Math.max(0, Math.floor(x0));
    y0 = Math.max(0, Math.floor(y0));
    x1 = Math.min(spec.w - 1, Math.ceil(x1));
    y1 = Math.min(spec.h - 1, Math.ceil(y1));
    if (x1 < x0 || y1 < y0) return;
    state.dirty.add(key);
    const cur = state.previewRect[key];
    if (cur === true) return;
    if (!cur) state.previewRect[key] = { x0, y0, x1, y1 };
    else {
      cur.x0 = Math.min(cur.x0, x0);
      cur.y0 = Math.min(cur.y0, y0);
      cur.x1 = Math.max(cur.x1, x1);
      cur.y1 = Math.max(cur.y1, y1);
    }
  }
  function markFull(key) {
    state.dirty.add(key);
    state.previewRect[key] = true;
  }
  function markWorldDisc(key, wx, wy, r) {
    const spec = state.layers[key]?.spec;
    if (!spec) return;
    markCells(
      key,
      (wx - r - spec.x) / spec.texelW,
      (wy - r - spec.y) / spec.texelH,
      (wx + r - spec.x) / spec.texelW,
      (wy + r - spec.y) / spec.texelH
    );
  }
  function markWorldRect(key, minX, minY, maxX, maxY, pad = 0) {
    const spec = state.layers[key]?.spec;
    if (!spec) return;
    markCells(
      key,
      (minX - pad - spec.x) / spec.texelW,
      (minY - pad - spec.y) / spec.texelH,
      (maxX + pad - spec.x) / spec.texelW,
      (maxY + pad - spec.y) / spec.texelH
    );
  }

  // Flip the unsaved flag on the first edit of a save-cycle (and refresh the
  // toolbar once on that transition — cheap, not per-stamp).
  function markEdited() {
    if (state.dirtySinceSave) return;
    state.dirtySinceSave = true;
    state.refreshToolbar?.();
  }

  // Masks are per-floor: keying by `state.floor` means paint on floor N only
  // ever touches the floor-N mask, and each floor's masks persist + travel
  // independently (Shapes-and-Regions.md / Authoring-and-Distribution.md).
  function changeFloor(delta) {
    const next = Math.max(0, Math.min(20, state.floor + delta));
    if (next === state.floor) return;
    state.floor = next;
    cancelDraft(); // an in-progress shape belonged to the old floor
    layerFor(state.kind); // ensure the new floor's layer exists
    markFull(activeKey());
    state.refreshToolbar?.();
  }

  // ---- painting ----------------------------------------------------------
  function pushUndo() {
    const key = activeKey();
    const layer = state.layers[key];
    if (!layer) return;
    state.undo.push({ key, data: layer.data.slice() });
    if (state.undo.length > UNDO_LIMIT) state.undo.shift();
  }

  function undo() {
    const snap = state.undo.pop();
    if (!snap || !state.layers[snap.key]) return;
    state.layers[snap.key].data.set(snap.data);
    markFull(snap.key); // undo can change anywhere -> the whole grid re-packs
    markEdited();
  }

  function stampWorld(wx, wy) {
    stampBrushWorld(layerFor(state.kind), wx, wy, state.brush.radius, {
      value: state.brush.strength,
      hardness: state.brush.hardness,
      mode: state.brush.mode,
    });
    markWorldDisc(activeKey(), wx, wy, state.brush.radius);
    markEdited();
  }

  // Interpolate along the stroke so fast drags don't leave gaps (a real brush,
  // not a series of disconnected dabs).
  function paintTo(wx, wy) {
    if (state.lastWorld) {
      const dx = wx - state.lastWorld.x;
      const dy = wy - state.lastWorld.y;
      const dist = Math.hypot(dx, dy);
      const spacing = Math.max(1, state.brush.radius * 0.25);
      const steps = Math.max(1, Math.ceil(dist / spacing));
      for (let i = 1; i <= steps; i++) {
        const t = i / steps;
        stampWorld(state.lastWorld.x + dx * t, state.lastWorld.y + dy * t);
      }
    } else {
      stampWorld(wx, wy);
    }
    state.lastWorld = { x: wx, y: wy };
  }

  function clearActive() {
    const layer = state.layers[activeKey()];
    if (!layer) return;
    pushUndo();
    layer.data.fill(0);
    markFull(activeKey());
    markEdited();
  }

  // ---- vector tools (point / line / polygon) -----------------------------
  // All rasterize into the SAME MaskGrid the brush writes (Shapes-and-Regions.md):
  // a drawn shape and a painted region are one mask. Shapes are NOT retained as
  // editable vector objects yet (that + a Select tool are the next tier) — they
  // commit straight to pixels, undoable as a whole, exactly like a brush stroke.
  function setTool(t) {
    cancelDraft();
    state.tool = t;
    state.refreshToolbar?.();
  }

  function cancelDraft() {
    state.draft = null;
  }

  function commitDraft() {
    const d = state.draft;
    state.draft = null;
    if (!d) return;
    const layer = layerFor(state.kind);
    const opts = { value: state.brush.strength, mode: state.brush.mode };
    const xs = d.vertices.map((v) => v.x);
    const ys = d.vertices.map((v) => v.y);
    const bbox = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
    if (d.type === 'polygon' && d.vertices.length >= 3) {
      pushUndo();
      rasterizePolygon(layer, d.vertices, opts);
      markWorldRect(activeKey(), ...bbox);
      markEdited();
    } else if (d.type === 'line' && d.vertices.length >= 2) {
      pushUndo();
      rasterizeStrokedLine(layer, d.vertices, state.brush.radius * 2, { ...opts, hardness: state.brush.hardness });
      markWorldRect(activeKey(), ...bbox, state.brush.radius);
      markEdited();
    }
  }

  function nearFirstVertex(e) {
    if (!state.draft || !state.draft.vertices.length) return false;
    const p0 = state.ctx.worldToClient(state.draft.vertices[0].x, state.draft.vertices[0].y);
    return Math.hypot(e.clientX - p0.x, e.clientY - p0.y) <= 10;
  }

  // ---- input (window, capture phase — see the file header) ---------------
  function installHandlers() {
    const suppress = (e) => {
      e.preventDefault();
      e.stopPropagation();
    };
    const worldAt = (e) => {
      const raw = state.ctx.screenToWorld(e.clientX, e.clientY);
      return state.snap ? state.ctx.snapWorld(raw.x, raw.y) : raw;
    };
    const onDown = (e) => {
      if (state.modalOpen) return; // a confirm dialog is up
      if (e.button !== 0) return; // left button only; right/middle fall through to Foundry (pan)
      if (e.target !== state.ctx.boardElement) return; // not the map -> let the UI (ours or Foundry's) have it
      if (state.tool === 'brush') {
        state.painting = true;
        state.lastWorld = null;
        pushUndo();
        const raw = state.ctx.screenToWorld(e.clientX, e.clientY); // the brush ignores snap (smooth strokes)
        paintTo(raw.x, raw.y);
        suppress(e);
        return;
      }
      const p = worldAt(e);
      if (state.tool === 'point') {
        pushUndo();
        stampWorld(p.x, p.y);
      } else if (state.tool === 'line' || state.tool === 'polygon') {
        // A click near the first vertex closes a polygon; otherwise add a vertex.
        if (state.tool === 'polygon' && state.draft && state.draft.vertices.length >= 3 && nearFirstVertex(e)) {
          commitDraft();
        } else {
          if (!state.draft) state.draft = { type: state.tool, vertices: [] };
          state.draft.vertices.push(p);
        }
      }
      suppress(e);
    };
    const onMove = (e) => {
      state.mouseClient = { x: e.clientX, y: e.clientY };
      state.hoverOnBoard = e.target === state.ctx.boardElement;
      const raw = state.ctx.screenToWorld(e.clientX, e.clientY);
      state.cursorWorld = state.snap ? state.ctx.snapWorld(raw.x, raw.y) : raw;
      // Once a brush stroke is underway, painting continues even if the drag
      // crosses a panel (ordinary paint-tool behaviour); vector tools are
      // click-based, so a move only updates the rubber-band cursor.
      if (state.tool === 'brush' && state.painting) {
        paintTo(raw.x, raw.y);
        suppress(e);
      }
    };
    const onUp = (e) => {
      if (state.tool === 'brush' && state.painting) {
        state.painting = false;
        state.lastWorld = null;
        suppress(e);
      }
    };
    const onDbl = (e) => {
      if (state.draft) {
        commitDraft(); // double-click finishes a line/polygon
        suppress(e);
      }
    };
    const onKey = (e) => {
      if (state.modalOpen) return; // the dialog owns the keyboard
      if (e.key === 'Escape') {
        if (state.draft) {
          cancelDraft(); // Esc cancels the in-progress shape first; a second Esc closes
          e.preventDefault();
          return;
        }
        return requestExit();
      }
      if (e.key === 'Enter') {
        if (state.draft) {
          commitDraft();
          e.preventDefault();
        }
        return;
      }
      if (e.key === 'Backspace' && state.draft) {
        state.draft.vertices.pop();
        if (!state.draft.vertices.length) state.draft = null;
        e.preventDefault();
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
        undo();
        e.preventDefault();
        return;
      }
      if (e.key === '[') state.brush.radius = Math.max(5, state.brush.radius - 10);
      else if (e.key === ']') state.brush.radius = Math.min(400, state.brush.radius + 10);
      else if (e.key.toLowerCase() === 'e') state.brush.mode = state.brush.mode === 'erase' ? 'add' : 'erase';
      else if (e.key.toLowerCase() === 'b') setTool('brush');
      else if (e.key.toLowerCase() === 'p') setTool('point');
      else if (e.key.toLowerCase() === 'l') setTool('line');
      else if (e.key.toLowerCase() === 'g') setTool('polygon');
      else if (e.key.toLowerCase() === 's') state.snap = !state.snap;
      else return;
      state.refreshToolbar?.();
    };
    // Capture phase so a left-button event is intercepted BEFORE it descends to
    // Foundry's canvas listeners; right-button/wheel are never touched, so they
    // reach Foundry and pan/zoom natively.
    window.addEventListener('pointerdown', onDown, true);
    window.addEventListener('pointermove', onMove, true);
    window.addEventListener('pointerup', onUp, true);
    window.addEventListener('dblclick', onDbl, true);
    window.addEventListener('keydown', onKey, true);
    state.handlers = { onDown, onMove, onUp, onDbl, onKey };
  }

  function removeHandlers() {
    const h = state.handlers;
    if (!h) return;
    window.removeEventListener('pointerdown', h.onDown, true);
    window.removeEventListener('pointermove', h.onMove, true);
    window.removeEventListener('pointerup', h.onUp, true);
    window.removeEventListener('dblclick', h.onDbl, true);
    window.removeEventListener('keydown', h.onKey, true);
    state.handlers = null;
  }

  // ---- lifecycle ---------------------------------------------------------
  function enter() {
    if (state.active) return;
    const ctx = readPaintContext();
    if (!ctx.ready) {
      notify('Map Shine: load a scene before painting.', 'warn');
      return;
    }
    state.ctx = ctx;
    layerFor(state.kind);
    buildOverlay();
    installHandlers();
    state.active = true;
    for (const key of Object.keys(state.layers)) markFull(key);
    loop();
  }

  function exit() {
    if (!state.active) return;
    state.active = false;
    state.painting = false;
    if (state.raf) cancelAnimationFrame(state.raf);
    state.raf = 0;
    removeHandlers();
    state.overlay?.remove();
    state.toolbar?.remove();
    state.overlay = state.toolbar = state.canvas = null;
  }

  // Exit, but guard unsaved work first (the data-loss point — masks live in
  // memory + the scene flag, so closing without saving loses the in-memory edits).
  async function requestExit() {
    if (!state.dirtySinceSave) return exit();
    const choice = await confirmModal(
      'Unsaved painting',
      'You have unsaved changes. Save them to the scene before closing?',
      [
        { action: 'save', label: '💾 Save & close', accent: '167,255,196' },
        { action: 'discard', label: 'Discard & close', accent: '255,120,120' },
        { action: 'cancel', label: 'Keep editing', accent: '143,214,255' },
      ]
    );
    if (choice === 'save') {
      await save();
      exit();
    } else if (choice === 'discard') {
      exit();
    }
    // cancel / dismissed -> stay in Author Mode
  }

  // A small self-contained confirm dialog (no Foundry-Dialog API dependency);
  // resolves to the chosen button's `action`, or 'cancel' if dismissed.
  function confirmModal(title, message, buttons) {
    return new Promise((resolve) => {
      state.modalOpen = true;
      const back = document.createElement('div');
      Object.assign(back.style, {
        position: 'fixed',
        inset: '0',
        zIndex: '200',
        pointerEvents: 'auto',
        background: 'rgba(0,0,0,0.45)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      });
      const card = document.createElement('div');
      Object.assign(card.style, {
        background: 'rgba(14,18,28,0.98)',
        border: '1px solid rgba(143,214,255,0.35)',
        borderRadius: '12px',
        padding: '16px 18px',
        maxWidth: '440px',
        color: '#dcecff',
        font: '12px/1.45 Signika, sans-serif',
        boxShadow: '0 20px 60px rgba(0,0,0,0.6)',
      });
      const finish = (action) => {
        state.modalOpen = false;
        back.remove();
        resolve(action);
      };
      const h = document.createElement('div');
      h.textContent = title;
      Object.assign(h.style, { fontWeight: '700', fontSize: '13px', marginBottom: '8px' });
      const m = document.createElement('div');
      m.textContent = message;
      Object.assign(m.style, { marginBottom: '14px', opacity: '0.9' });
      const btnRow = document.createElement('div');
      Object.assign(btnRow.style, { display: 'flex', gap: '8px', justifyContent: 'flex-end', flexWrap: 'wrap' });
      for (const b of buttons) btnRow.append(button(b.label, () => finish(b.action), b.accent ?? '143,214,255'));
      back.addEventListener('pointerdown', (ev) => {
        if (ev.target === back) finish('cancel');
      });
      card.append(h, m, btnRow);
      back.append(card);
      document.body.appendChild(back);
    });
  }

  // ---- overlay + toolbar -------------------------------------------------
  function buildOverlay() {
    const overlay = document.createElement('div');
    Object.assign(overlay.style, { position: 'fixed', inset: '0', zIndex: '100', pointerEvents: 'none' });
    const canvas = document.createElement('canvas');
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
    Object.assign(canvas.style, { position: 'absolute', inset: '0', width: '100%', height: '100%' });
    overlay.appendChild(canvas);
    document.body.appendChild(overlay);
    state.overlay = overlay;
    state.canvas = canvas;
    state.toolbar = buildToolbar();
    document.body.appendChild(state.toolbar);
  }

  function buildToolbar() {
    const bar = document.createElement('div');
    Object.assign(bar.style, {
      position: 'fixed',
      top: '12px',
      left: '50%',
      transform: 'translateX(-50%)',
      zIndex: '101',
      display: 'flex',
      flexDirection: 'column',
      gap: '6px',
      padding: '9px 13px',
      background: 'rgba(12,16,26,0.95)',
      border: '1px solid rgba(143,214,255,0.28)',
      borderRadius: '11px',
      boxShadow: '0 10px 30px rgba(0,0,0,0.5)',
      font: '11px/1.3 Signika, sans-serif',
      color: '#dcecff',
      pointerEvents: 'auto',
    });
    const row = () => {
      const r = document.createElement('div');
      Object.assign(r.style, { display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' });
      return r;
    };

    // tool switcher — the brush and the vector tools, all feeding the same masks
    const toolSeg = segmented(
      [
        ['🖌 Brush', 'brush'],
        ['• Point', 'point'],
        ['╱ Line', 'line'],
        ['⬠ Poly', 'polygon'],
      ],
      () => state.tool,
      (v) => setTool(v)
    );
    const snapWrap = document.createElement('label');
    Object.assign(snapWrap.style, { display: 'flex', alignItems: 'center', gap: '4px', pointerEvents: 'auto' });
    const snapCb = document.createElement('input');
    snapCb.type = 'checkbox';
    snapCb.checked = state.snap;
    snapCb.addEventListener('change', () => (state.snap = snapCb.checked));
    snapWrap.append(snapCb, document.createTextNode('Snap ¼-grid'));
    // floor stepper — masks are per-floor; this picks which floor you paint
    const floorLabelEl = document.createElement('span');
    Object.assign(floorLabelEl.style, { minWidth: '54px', textAlign: 'center', opacity: '0.9' });
    floorLabelEl.textContent = `Floor ${state.floor}`;
    const floorWrap = document.createElement('div');
    Object.assign(floorWrap.style, { display: 'flex', alignItems: 'center', gap: '3px' });
    floorWrap.append(
      button('◀', () => changeFloor(-1), '143,214,255'),
      floorLabelEl,
      button('▶', () => changeFloor(1), '143,214,255')
    );

    const toolRow = row();
    toolRow.append(label('Tool'), toolSeg.el, snapWrap, label('Floor'), floorWrap);

    // kind picker — labelled by the catalog's own suffix, never a literal
    const kindSel = document.createElement('select');
    styleControl(kindSel);
    for (const k of PAINTABLE_KINDS) {
      const o = document.createElement('option');
      o.value = k.id;
      o.textContent = k.suffixes[0];
      kindSel.append(o);
    }
    kindSel.value = state.kind;
    let revertingKind = false;
    kindSel.addEventListener('change', async () => {
      if (revertingKind) return;
      const target = kindSel.value;
      // Guard unsaved work when swapping effects (author ask): the mask you were
      // on stays in memory either way, but remind so it isn't forgotten.
      if (state.dirtySinceSave) {
        const suffix = PAINTABLE_KINDS.find((k) => k.id === target)?.suffixes[0] ?? target;
        const choice = await confirmModal(
          'Unsaved painting',
          `Save your changes before switching to ${suffix}? Your masks stay in memory either way — Save writes them all to the scene at once.`,
          [
            { action: 'save', label: '💾 Save & switch', accent: '167,255,196' },
            { action: 'switch', label: 'Switch without saving', accent: '143,214,255' },
            { action: 'cancel', label: 'Cancel', accent: '255,196,120' },
          ]
        );
        if (choice === 'cancel') {
          revertingKind = true;
          kindSel.value = state.kind; // put the dropdown back
          revertingKind = false;
          return;
        }
        if (choice === 'save') await save();
      }
      state.kind = target;
      layerFor(state.kind);
      markFull(activeKey());
      state.refreshToolbar?.();
    });

    const modeSeg = segmented(
      [
        ['Spray', 'add'],
        ['Paint', 'paint'],
        ['Erase', 'erase'],
      ],
      () => state.brush.mode,
      (v) => (state.brush.mode = v)
    );

    const sizeR = range(
      'Size',
      5,
      400,
      () => state.brush.radius,
      (v) => (state.brush.radius = v)
    );
    const strengthR = range(
      'Strength',
      5,
      255,
      () => state.brush.strength,
      (v) => (state.brush.strength = v)
    );
    const hardR = range(
      'Hardness',
      0,
      100,
      () => Math.round(state.brush.hardness * 100),
      (v) => (state.brush.hardness = v / 100)
    );

    const top = row();
    top.append(label('Mask'), kindSel, modeSeg.el);
    const mid = row();
    mid.append(sizeR.el, strengthR.el, hardR.el);
    const saveBtn = button('💾 Save', save, '167,255,196');
    const bottom = row();
    bottom.append(
      button('↶ Undo', undo, '143,214,255'),
      button('Clear', clearActive, '255,196,120'),
      saveBtn,
      button('Exit', requestExit, '143,214,255')
    );

    const legendRow = row();
    Object.assign(legendRow.style, {
      gap: '6px',
      paddingTop: '5px',
      marginTop: '2px',
      borderTop: '1px solid rgba(143,214,255,0.14)',
    });
    legendRow.append(
      legendItem('LMB', 'paint / add point'),
      legendItem('RMB', 'pan'),
      legendItem('Wheel', 'zoom'),
      legendItem('Enter', 'finish'),
      legendItem('Bksp', 'undo point'),
      legendItem('Ctrl+Z', 'undo'),
      legendItem('Esc', 'cancel / exit')
    );

    bar.append(toolRow, top, mid, bottom, legendRow);
    state.refreshToolbar = () => {
      toolSeg.sync();
      sizeR.sync();
      strengthR.sync();
      hardR.sync();
      modeSeg.sync();
      snapCb.checked = state.snap;
      kindSel.value = state.kind;
      floorLabelEl.textContent = `Floor ${state.floor}`;
      saveBtn.textContent = state.dirtySinceSave ? '💾 Save •' : '💾 Saved';
      saveBtn.style.opacity = state.dirtySinceSave ? '1' : '0.55';
    };
    state.refreshToolbar();
    return bar;
  }

  async function save() {
    const payload = serializePaintedMasks(state.layers);
    // PAINT_EMBED_BYTE_BUDGET existed but was never actually checked anywhere
    // live — an "unwired museum" piece. The resolution bump (512 -> 2048) makes
    // it meaningfully more likely a detailed mask actually crosses it, so this
    // is the moment to surface the signal instead of leaving it unused.
    const heavy = Object.entries(payload)
      .map(([key, enc]) => ({ key, bytes: encodedByteEstimate(enc) }))
      .filter((x) => x.bytes > PAINT_EMBED_BYTE_BUDGET);
    const r = await savePaintedMasks(payload);
    const n = Object.keys(payload).length;
    if (!r.ok) {
      notify(`Map Shine: save failed — ${r.reason}`, 'error');
      return;
    }
    let msg = `Map Shine: saved ${n} painted mask(s) to the scene.`;
    if (heavy.length) {
      const names = heavy.map((h) => h.key.split('::')[0]).join(', ');
      msg += ` ⚠ ${names} ${heavy.length === 1 ? 'is' : 'are'} getting detailed (${heavy
        .map((h) => Math.round(h.bytes / 1024))
        .join(
          '/'
        )} KB) — saved fine, but very fine painted detail will eventually want file-based storage (not yet built).`;
    }
    state.dirtySinceSave = false;
    state.refreshToolbar?.();
    notify(msg, heavy.length ? 'warn' : 'info');
  }

  // ---- preview loop ------------------------------------------------------
  // At PAINT_GRID_MAX_DIM=4096 a full re-pack is ~16M texels — too slow per
  // frame while painting. So the offscreen ImageData is allocated ONCE and
  // reused, packed as one 32-bit RGBA per texel, and — the load-bearing part —
  // only the DIRTY RECTANGLE is re-packed and uploaded (`putImageData` with a
  // sub-rect). Per-frame cost is O(changed area), independent of grid size.
  // A fresh ImageData is zeroed = transparent, so an unpainted mask needs no
  // full pack; only whole-grid changes (undo/clear/switch -> previewRect===true)
  // pack everything.
  function renderGrid(key) {
    const layer = state.layers[key];
    if (!layer) return;
    const kind = key.split('::')[0];
    const [cr, cg, cb] = colorFor(kind);
    const { spec, data } = layer;
    let g = state.gridCanvases[key];
    if (!g) g = state.gridCanvases[key] = document.createElement('canvas');
    const gctx = g.getContext('2d');
    let img = state.gridImageData[key];
    if (g.width !== spec.w || g.height !== spec.h || !img) {
      g.width = spec.w;
      g.height = spec.h;
      img = state.gridImageData[key] = gctx.createImageData(spec.w, spec.h);
    }
    const packed = new Uint32Array(img.data.buffer);
    const rgbBase = cr | (cg << 8) | (cb << 16);
    const rect = state.previewRect[key];
    delete state.previewRect[key];
    if (rect && rect !== true) {
      const { x0, y0, x1, y1 } = rect;
      for (let y = y0; y <= y1; y++) {
        const base = y * spec.w;
        for (let x = x0; x <= x1; x++) packed[base + x] = rgbBase | (data[base + x] << 24);
      }
      gctx.putImageData(img, 0, 0, x0, y0, x1 - x0 + 1, y1 - y0 + 1);
      return;
    }
    for (let i = 0; i < data.length; i++) packed[i] = rgbBase | (data[i] << 24);
    gctx.putImageData(img, 0, 0);
  }

  function loop() {
    if (!state.active) return;
    state.raf = requestAnimationFrame(loop);
    const cv = state.canvas;
    if (!cv) return;
    if (cv.width !== window.innerWidth || cv.height !== window.innerHeight) {
      cv.width = window.innerWidth;
      cv.height = window.innerHeight;
    }
    for (const key of state.dirty) renderGrid(key);
    state.dirty.clear();

    const cctx = cv.getContext('2d');
    cctx.clearRect(0, 0, cv.width, cv.height);

    const r = state.ctx.sceneRect;
    const tl = state.ctx.worldToClient(r.x, r.y);
    const br = state.ctx.worldToClient(r.x + r.width, r.y + r.height);
    const left = Math.min(tl.x, br.x);
    const top = Math.min(tl.y, br.y);
    const w = Math.abs(br.x - tl.x);
    const h = Math.abs(br.y - tl.y);
    if (w > 0 && h > 0) {
      cctx.imageSmoothingEnabled = true;
      const ak = activeKey();
      // Painted kinds under the map, active one brightest, others dimmed.
      for (const key of Object.keys(state.layers)) {
        const g = state.gridCanvases[key];
        if (!g) continue;
        cctx.globalAlpha = key === ak ? 0.8 : 0.32;
        cctx.drawImage(g, left, top, w, h);
      }
      cctx.globalAlpha = 1;
    }

    drawDraft(cctx);
    drawBrushRing(cctx);
  }

  function drawBrushRing(cctx) {
    if (state.tool !== 'brush' && state.tool !== 'point') return; // vector tools show the draft, not a ring
    const m = state.mouseClient;
    if (!m || !state.hoverOnBoard) return; // don't float a paint-radius circle over the toolbar
    const w0 = state.ctx.screenToWorld(m.x, m.y);
    const a = state.ctx.worldToClient(w0.x, w0.y);
    const b = state.ctx.worldToClient(w0.x + state.brush.radius, w0.y);
    const rpx = Math.hypot(b.x - a.x, b.y - a.y);
    const erase = state.brush.mode === 'erase';
    const [cr, cg, cb] = erase ? [255, 90, 90] : colorFor(state.kind);
    cctx.beginPath();
    cctx.arc(m.x, m.y, Math.max(2, rpx), 0, Math.PI * 2);
    cctx.strokeStyle = `rgba(${cr},${cg},${cb},0.9)`;
    cctx.lineWidth = 1.5;
    cctx.stroke();
    cctx.beginPath();
    cctx.arc(m.x, m.y, Math.max(2, rpx), 0, Math.PI * 2);
    cctx.strokeStyle = 'rgba(0,0,0,0.5)';
    cctx.lineWidth = 0.75;
    cctx.stroke();
  }

  // The in-progress line/polygon: placed vertices, edges, a rubber-band to the
  // live cursor, and (polygon) the closing edge + a ring on the first vertex
  // once it can be clicked to close.
  function drawDraft(cctx) {
    const d = state.draft;
    if (!d || !d.vertices.length) return;
    const pts = d.vertices.map((v) => state.ctx.worldToClient(v.x, v.y));
    const cur = state.cursorWorld ? state.ctx.worldToClient(state.cursorWorld.x, state.cursorWorld.y) : null;
    const [cr, cg, cb] = colorFor(state.kind);
    const col = `rgba(${cr},${cg},${cb},0.95)`;
    cctx.strokeStyle = col;
    cctx.lineWidth = 2;
    cctx.beginPath();
    cctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) cctx.lineTo(pts[i].x, pts[i].y);
    if (cur) cctx.lineTo(cur.x, cur.y);
    if (d.type === 'polygon' && pts.length >= 2) cctx.lineTo(pts[0].x, pts[0].y);
    cctx.stroke();
    for (const p of pts) {
      cctx.beginPath();
      cctx.arc(p.x, p.y, 4, 0, Math.PI * 2);
      cctx.fillStyle = col;
      cctx.fill();
    }
    if (d.type === 'polygon' && pts.length >= 3) {
      cctx.beginPath();
      cctx.arc(pts[0].x, pts[0].y, 8, 0, Math.PI * 2);
      cctx.strokeStyle = 'rgba(255,255,255,0.9)';
      cctx.lineWidth = 2;
      cctx.stroke();
    }
  }

  MapShine.debug?.registerAction(
    'paint',
    '🖌️ Paint masks',
    () => {
      enter();
      return { report: 'paint', entered: state.active, kind: state.kind };
    },
    { primary: true }
  );

  return {
    /** Called from boot's canvasReady: pull any painted masks saved on this scene. */
    hydrateFromScene() {
      const ctx = readPaintContext();
      if (!ctx.ready) return { loaded: false };
      const payload = loadPaintedMasks();
      if (!payload) {
        state.layers = {};
        state.undo = [];
        state.previewRect = {};
        state.dirtySinceSave = false;
        return { loaded: false };
      }
      const { layers, mismatched } = hydratePaintedMasks(payload, ctx.sceneRect);
      state.layers = layers;
      state.undo = [];
      state.previewRect = {};
      state.dirtySinceSave = false; // freshly loaded from the scene = clean
      for (const key of Object.keys(layers)) markFull(key);
      return { loaded: Object.keys(layers).length > 0, mismatched };
    },
  };
}

// ---- small DOM helpers ---------------------------------------------------
function styleControl(el) {
  Object.assign(el.style, {
    pointerEvents: 'auto',
    background: 'rgba(10,14,22,0.9)',
    border: '1px solid rgba(143,214,255,0.4)',
    borderRadius: '5px',
    color: '#cfe8ff',
    font: '10px/1.2 Signika, sans-serif',
    padding: '3px 5px',
  });
}

function label(text) {
  const s = document.createElement('span');
  s.textContent = text;
  s.style.opacity = '0.7';
  return s;
}

/** A keyboard/mouse-button "key" chip — the visible-shortcuts legend's unit. */
function keycap(text) {
  const s = document.createElement('span');
  s.textContent = text;
  Object.assign(s.style, {
    display: 'inline-block',
    fontFamily: "'Courier New', monospace",
    fontSize: '9.5px',
    fontWeight: '700',
    lineHeight: '1',
    padding: '3px 6px',
    borderRadius: '4px',
    border: '1px solid rgba(143,214,255,0.45)',
    background: 'rgba(143,214,255,0.1)',
    color: '#eaf4ff',
  });
  return s;
}

/** One "KEY does X" pair for the legend row. */
function legendItem(keyText, desc) {
  const wrap = document.createElement('span');
  Object.assign(wrap.style, { display: 'inline-flex', alignItems: 'center', gap: '4px', fontSize: '10px' });
  wrap.append(keycap(keyText));
  const d = document.createElement('span');
  d.textContent = desc;
  d.style.opacity = '0.7';
  wrap.append(d);
  return wrap;
}

function button(text, onClick, accent) {
  const b = document.createElement('button');
  b.textContent = text;
  Object.assign(b.style, {
    pointerEvents: 'auto',
    background: `rgba(${accent},0.16)`,
    border: `1px solid rgba(${accent},0.45)`,
    borderRadius: '6px',
    color: '#eaf4ff',
    font: '11px Signika, sans-serif',
    padding: '5px 10px',
    cursor: 'pointer',
  });
  b.addEventListener('click', onClick);
  return b;
}

/** A labelled range that reads its value from a getter and shows the number. */
function range(labelText, min, max, get, set) {
  const wrap = document.createElement('label');
  Object.assign(wrap.style, { display: 'flex', alignItems: 'center', gap: '5px' });
  const name = label(labelText);
  const val = document.createElement('span');
  Object.assign(val.style, { minWidth: '26px', textAlign: 'right', opacity: '0.85' });
  const input = document.createElement('input');
  input.type = 'range';
  input.min = String(min);
  input.max = String(max);
  input.value = String(get());
  input.style.width = '84px';
  input.style.pointerEvents = 'auto';
  const paint = () => (val.textContent = String(get()));
  paint();
  input.addEventListener('input', () => {
    set(Number(input.value));
    paint();
  });
  wrap.append(name, input, val);
  return {
    el: wrap,
    sync: () => {
      input.value = String(get());
      paint();
    },
  };
}

/** A segmented 3-way control (Spray/Paint/Erase). */
function segmented(options, get, set) {
  const el = document.createElement('div');
  Object.assign(el.style, { display: 'inline-flex', gap: '3px' });
  const btns = options.map(([text, value]) => {
    const b = document.createElement('button');
    b.textContent = text;
    Object.assign(b.style, {
      pointerEvents: 'auto',
      border: '1px solid rgba(143,214,255,0.4)',
      borderRadius: '5px',
      color: '#cfe8ff',
      font: '10px Signika, sans-serif',
      padding: '4px 8px',
      cursor: 'pointer',
    });
    b.addEventListener('click', () => {
      set(value);
      sync();
    });
    return { b, value };
  });
  el.append(...btns.map((x) => x.b));
  function sync() {
    const cur = get();
    for (const { b, value } of btns)
      b.style.background = value === cur ? 'rgba(143,214,255,0.32)' : 'rgba(143,214,255,0.1)';
  }
  sync();
  return { el, sync };
}
