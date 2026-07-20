/**
 * PAINT MODE — the browser half of the in-app painter (UX + feature pass).
 *
 * A modal AUTHORING surface (map-maker, opt-in). The overlay is VISUAL ONLY
 * (`pointer-events: none`); input is captured at the window in the capture
 * phase so that:
 *   - LEFT-drag   → paints (captured; Foundry never sees it)
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
 * TIER 1 SCOPE: any authored mask kind (dropdown), floor 0, embed persistence,
 * spray/paint/erase, interpolated strokes, stroke-level undo, a cursor ring,
 * keyboard shortcuts. Deferred: bake-to-file (Mode B), stamps/anchors,
 * per-floor binding, the package gate (docs/planning/Authoring-and-Distribution.md §6).
 *
 * @module ui/paint-mode
 */

import {
  createPaintLayer,
  stampBrushWorld,
  serializePaintedMasks,
  hydratePaintedMasks,
  encodedByteEstimate,
  PAINT_EMBED_BYTE_BUDGET,
  MASK_KINDS,
} from '../scene/index.js';
import { readPaintContext, savePaintedMasks, loadPaintedMasks } from '../foundry/index.js';

const FLOOR = 0;
const UNDO_LIMIT = 16;

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
    layers: {}, // `${kind}::${FLOOR}` -> MaskGrid
    gridCanvases: {}, // key -> offscreen canvas
    gridImageData: {}, // key -> cached ImageData for that canvas (reused, not reallocated, per frame)
    dirty: new Set(), // keys whose gridCanvas needs re-rendering
    overlay: null,
    canvas: null,
    toolbar: null,
    raf: 0,
    painting: false,
    lastWorld: null,
    mouseClient: null,
    hoverOnBoard: false, // is the CURRENT hover over Foundry's board (not a UI panel)? gates the ring
    brush: { radius: 90, strength: 180, hardness: 0.55, mode: 'add' }, // mode: paint | add | erase
    undo: [],
    handlers: null,
    refreshToolbar: null,
  };

  const notify = (msg, type = 'info') => globalThis.ui?.notifications?.[type]?.(msg);
  const keyOf = (kind) => `${kind}::${FLOOR}`;
  const activeKey = () => keyOf(state.kind);

  function layerFor(kind) {
    const key = keyOf(kind);
    if (!state.layers[key]) state.layers[key] = createPaintLayer(state.ctx.sceneRect);
    return state.layers[key];
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
    state.dirty.add(snap.key);
  }

  function stampWorld(wx, wy) {
    stampBrushWorld(layerFor(state.kind), wx, wy, state.brush.radius, {
      value: state.brush.strength,
      hardness: state.brush.hardness,
      mode: state.brush.mode,
    });
    state.dirty.add(activeKey());
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
    state.dirty.add(activeKey());
  }

  // ---- input (window, capture phase — see the file header) ---------------
  function installHandlers() {
    const suppress = (e) => {
      e.preventDefault();
      e.stopPropagation();
    };
    const onDown = (e) => {
      if (e.button !== 0) return; // left button only; right/middle fall through to Foundry (pan)
      if (e.target !== state.ctx.boardElement) return; // not the map -> let the UI (ours or Foundry's) have it
      state.painting = true;
      state.lastWorld = null;
      pushUndo();
      const w = state.ctx.screenToWorld(e.clientX, e.clientY);
      paintTo(w.x, w.y);
      suppress(e);
    };
    const onMove = (e) => {
      state.mouseClient = { x: e.clientX, y: e.clientY };
      // Tracked on every move (not just while painting) so the brush ring hides
      // over UI. Once a stroke is underway, painting deliberately continues even
      // if the drag crosses a panel (matches ordinary paint-tool drag behaviour)
      // — this flag only affects the RING and starting a NEW stroke (onDown).
      state.hoverOnBoard = e.target === state.ctx.boardElement;
      if (!state.painting) return; // not painting → Foundry keeps the move (hover, native drag)
      const w = state.ctx.screenToWorld(e.clientX, e.clientY);
      paintTo(w.x, w.y);
      suppress(e);
    };
    const onUp = (e) => {
      if (!state.painting) return;
      state.painting = false;
      state.lastWorld = null;
      suppress(e);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') return exit();
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
        undo();
        e.preventDefault();
        return;
      }
      if (e.key === '[') state.brush.radius = Math.max(5, state.brush.radius - 10);
      else if (e.key === ']') state.brush.radius = Math.min(400, state.brush.radius + 10);
      else if (e.key.toLowerCase() === 'e') state.brush.mode = state.brush.mode === 'erase' ? 'add' : 'erase';
      else return;
      state.refreshToolbar?.();
    };
    // Capture phase so a left-button event is intercepted BEFORE it descends to
    // Foundry's canvas listeners; right-button/wheel are never touched, so they
    // reach Foundry and pan/zoom natively.
    window.addEventListener('pointerdown', onDown, true);
    window.addEventListener('pointermove', onMove, true);
    window.addEventListener('pointerup', onUp, true);
    window.addEventListener('keydown', onKey, true);
    state.handlers = { onDown, onMove, onUp, onKey };
  }

  function removeHandlers() {
    const h = state.handlers;
    if (!h) return;
    window.removeEventListener('pointerdown', h.onDown, true);
    window.removeEventListener('pointermove', h.onMove, true);
    window.removeEventListener('pointerup', h.onUp, true);
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
    for (const key of Object.keys(state.layers)) state.dirty.add(key);
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
    kindSel.addEventListener('change', () => {
      state.kind = kindSel.value;
      layerFor(state.kind);
      state.dirty.add(activeKey());
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
    const bottom = row();
    bottom.append(
      button('↶ Undo', undo, '143,214,255'),
      button('Clear', clearActive, '255,196,120'),
      button('💾 Save', save, '167,255,196'),
      button('Exit', exit, '143,214,255')
    );

    const legendRow = row();
    Object.assign(legendRow.style, {
      gap: '6px',
      paddingTop: '5px',
      marginTop: '2px',
      borderTop: '1px solid rgba(143,214,255,0.14)',
    });
    legendRow.append(
      legendItem('LMB', 'paint'),
      legendItem('RMB', 'pan'),
      legendItem('Wheel', 'zoom'),
      legendItem('[ ]', 'size'),
      legendItem('E', 'erase'),
      legendItem('Ctrl+Z', 'undo'),
      legendItem('Esc', 'exit')
    );

    bar.append(top, mid, bottom, legendRow);
    state.refreshToolbar = () => {
      sizeR.sync();
      strengthR.sync();
      hardR.sync();
      modeSeg.sync();
    };
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
    notify(msg, heavy.length ? 'warn' : 'info');
  }

  // ---- preview loop ------------------------------------------------------
  // PAINT_GRID_MAX_DIM (2026-07-20: 512 -> 2048, so the smallest brush can
  // actually resolve — see that constant's comment) makes this run against
  // up to 16x more texels than before, so two things that didn't matter at
  // 512 now do: reallocating an ImageData every dirty frame, and writing
  // four separate bytes per texel instead of one.
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
      img = state.gridImageData[key] = gctx.createImageData(spec.w, spec.h); // allocate ONCE, reuse every frame
    }
    // One 32-bit write per texel (packed little-endian RGBA — standard for
    // fast canvas pixel fills) instead of four byte writes; R/G/B are
    // constant per mask, so only the alpha nibble actually varies per texel.
    const packed = new Uint32Array(img.data.buffer);
    const rgbBase = cr | (cg << 8) | (cb << 16);
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

    drawBrushRing(cctx);
  }

  function drawBrushRing(cctx) {
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
        return { loaded: false };
      }
      const { layers, mismatched } = hydratePaintedMasks(payload, ctx.sceneRect);
      state.layers = layers;
      state.undo = [];
      for (const key of Object.keys(layers)) state.dirty.add(key);
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
