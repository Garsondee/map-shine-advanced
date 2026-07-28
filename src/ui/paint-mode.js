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
 * paint on floor N only ever touches floor N, AND drives the live 3D view to
 * floor N via vt/'s own `setVtPanViewerFloor` — the same cheap residency-only
 * path Foundry's native floor navigation already uses, not a fresh reinvention;
 * mask editing itself never depends on that call succeeding), a 4096² grid with
 * a dirty-rect preview (re-packs only what changed), embed persistence with an
 * unsaved-changes guard (on close + on effect switch), a spray/paint/erase
 * brush, AND the Author-Mode vector tools — point / line (stroked) / polygon
 * (filled) — all rasterizing into the SAME mask the brush writes
 * (Shapes-and-Regions.md), with an optional 4×4 sub-grid snap, shared undo,
 * and a live draft preview. Deferred: retained/editable vector shapes + a
 * Select tool, bake-to-file (Mode B), the package gate.
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
import { setVtPanViewerFloor } from '../vt/index.js';
// The painter's DOM chrome + preview renderer, split out 2026-07-25 (the
// size-ratchet god-object reversal — this file was 1,083 lines / an 867-line
// installPainter). Each is a factory bound to the SAME `state` object below,
// so the moved bodies still close over exactly what they always did.
import { createConfirmModal } from './paint-mode-widgets.js';
import { createPaintCanvas } from './paint-mode-canvas.js';
import { createToolbar } from './paint-mode-toolbar.js';

const UNDO_LIMIT = 10; // at PAINT_GRID_MAX_DIM=4096 each undo snapshot is ~16MB — keep the stack bounded

/** Authored (paintable) kinds only — derived products (skyReach…) have no suffix. */
const PAINTABLE_KINDS = MASK_KINDS.filter((k) => Array.isArray(k.suffixes) && k.suffixes.length > 0);

export function installPainter(MapShine) {
  const state = {
    active: false,
    ctx: null,
    kind: PAINTABLE_KINDS[0]?.id ?? 'fire',
    layers: {}, // `${kind}::${floor}` -> MaskGrid
    floor: 0, // which floor these strokes apply to — masks are PER-FLOOR (the Floor stepper picks it)
    floorSwitching: false, // a live setVtPanViewerFloor call is in flight — buttons disable so rapid clicks can't retrigger the flagged rapid-floor-switch residency bug
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

  // ---- the extracted halves, bound to this painter's state ----------------
  // Order matters: the toolbar's callbacks include `markFull` (from the canvas
  // factory) and `confirmModal` (from widgets), so both must exist first. The
  // painter's own actions (setTool/save/undo/…) are function DECLARATIONS
  // below, hoisted, so naming them here is safe.
  const confirmModal = createConfirmModal(state);
  // markCells stays internal to the canvas module — only markWorldDisc/
  // markWorldRect (both there) ever call it; the painter itself never does.
  const { markFull, markWorldDisc, markWorldRect, loop } = createPaintCanvas(state, { activeKey });
  const buildToolbar = createToolbar(state, {
    setTool,
    changeFloor,
    save,
    undo,
    clearActive,
    requestExit,
    layerFor,
    markFull,
    activeKey,
    confirmModal,
    paintableKinds: PAINTABLE_KINDS,
  });

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
  //
  // This ALSO drives the live 3D view to floor N (author ask: the stepper must
  // actually swap floors, not just retarget painting) via vt/'s own
  // `setVtPanViewerFloor` — the same cheap, no-restart path Foundry's native
  // floor navigation already uses (boot.js's canvasReady handler), not a new
  // one. That call is best-effort: mask editing is authoritative regardless of
  // whether the live view can follow (feedback_safety_slide_outranks_doctrine
  // — painting must not depend on the renderer being up), so a failed/absent
  // viewer still lets you paint floor N's mask, just without the live picture.
  // One switch in flight at a time — rapid clicking floors is a KNOWN trigger
  // for a still-open residency bug (keyhole-device-loss-large-map.md).
  async function changeFloor(delta) {
    if (state.floorSwitching) return;
    const max = Math.max(0, (state.ctx?.floorCount ?? 21) - 1);
    const next = Math.max(0, Math.min(max, state.floor + delta));
    if (next === state.floor) return;
    cancelDraft(); // an in-progress shape belonged to the old floor
    state.floorSwitching = true;
    state.refreshToolbar?.();
    try {
      await setVtPanViewerFloor(next);
    } catch (err) {
      notify(
        `Map Shine: live view couldn't follow to floor ${next} (${err?.message || err}) — painting it anyway.`,
        'warn'
      );
    } finally {
      state.floorSwitching = false;
    }
    state.floor = next;
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
  /**
   * @param {object} [opts]
   * @param {string} [opts.kind] - preselect a MASK_KINDS id, so an effect card's
   *   ＋ button opens the brush already loaded with THAT effect's mask. Control-
   *   Panel.md §5.2 step 2 verbatim: "No mask-picker detour; the button already
   *   knew the mask." An unknown or non-paintable id is ignored rather than
   *   throwing — the brush still opens, on whatever kind was last selected,
   *   because a dead ＋ button is worse than a slightly wrong one.
   */
  function enter(opts = {}) {
    if (state.active) return;
    const ctx = readPaintContext();
    if (!ctx.ready) {
      notify('Map Shine: load a scene before painting.', 'warn');
      return;
    }
    if (opts.kind && PAINTABLE_KINDS.some((k) => k.id === opts.kind)) state.kind = opts.kind;
    state.ctx = ctx;
    // Open on whatever floor Foundry is ALREADY showing, not always floor 0 —
    // the auto-follow this project deferred earlier, unlocked for free once
    // the context carries the live viewed-floor index.
    state.floor = Math.max(0, Math.min(Math.max(0, ctx.floorCount - 1), ctx.viewedFloorIndex ?? 0));
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
    /** Open the brush, optionally on a named mask kind — the door every effect
     * card's ＋ button goes through. Private until 2026-07-27; a card that wants
     * to send you straight to painting ITS mask needs to be able to say so. */
    enter,
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
