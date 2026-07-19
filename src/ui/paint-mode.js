/**
 * PAINT MODE (tier 0) — the browser half of the in-app painter.
 *
 * A modal AUTHORING surface (map-maker, opt-in): a full-viewport overlay canvas
 * takes pointer input ONLY while active, so it never touches the gameplay input
 * path (keyhole-input-model-decision — Foundry owns gameplay input; this is
 * authoring, not gameplay). Soft round brush → the painted `_Fire` layer; a
 * live red preview tracks the camera; "Save" embeds the mask in the scene flag.
 *
 * The pure model/brush/codec/persistence is scene/paint-mask.js (Node-tested).
 * All Foundry/PIXI access is foundry/paint-adapter.js. This file is DOM glue.
 *
 * ⚠ NOT YET LIVE-VERIFIED. Check, in order: (1) a painted dot lands under the
 * cursor; (2) the red preview sits on the map and tracks pan/zoom; (3) Save →
 * reload the scene → the paint returns. See each is a known first-round risk.
 *
 * TIER 0 SCOPE: one mask (`_Fire`), floor 0, embed persistence. Multi-mask,
 * floor binding, bake-to-file (Mode B), and stamps/anchors are later tiers
 * (docs/planning/Authoring-and-Distribution.md §6).
 *
 * @module ui/paint-mode
 */

import {
  createPaintLayer,
  stampBrushWorld,
  serializePaintedMasks,
  hydratePaintedMasks,
  maskKindById,
} from '../scene/index.js';
import { readPaintContext, savePaintedMasks, loadPaintedMasks } from '../foundry/index.js';

const KIND = 'fire';
const FLOOR = 0;
const KEY = `${KIND}::${FLOOR}`;
// The suffix is the catalog's, never a hardcoded literal (masks/authority-only —
// the one home of suffix knowledge is scene/mask-catalog.js).
const MASK_LABEL = maskKindById(KIND)?.suffixes?.[0] ?? 'Fire';

export function installPainter(MapShine) {
  const state = {
    active: false,
    layer: null, // the current scene's painted _Fire layer (persists across enter/exit)
    ctx: null, // the live paint context (sceneRect + transforms)
    overlay: null,
    canvas: null,
    toolbar: null,
    gridCanvas: null, // offscreen: the grid rendered to RGBA, blitted each frame
    dirty: true,
    raf: 0,
    painting: false,
    brush: { radius: 90, hardness: 0.6, value: 255, erase: false },
  };

  const notify = (msg, type = 'info') => globalThis.ui?.notifications?.[type]?.(msg);

  function enter() {
    if (state.active) return;
    const ctx = readPaintContext();
    if (!ctx.ready) {
      notify('Map Shine: load a scene before painting.', 'warn');
      return;
    }
    state.ctx = ctx;
    if (!state.layer) state.layer = createPaintLayer(ctx.sceneRect);
    buildOverlay();
    state.active = true;
    state.dirty = true;
    loop();
  }

  function exit() {
    if (!state.active) return;
    state.active = false;
    if (state.raf) cancelAnimationFrame(state.raf);
    state.raf = 0;
    state.overlay?.remove();
    state.toolbar?.remove();
    state.overlay = state.toolbar = state.canvas = null;
  }

  function buildOverlay() {
    const overlay = document.createElement('div');
    Object.assign(overlay.style, {
      position: 'fixed',
      inset: '0',
      zIndex: '100', // above the MSA canvas + heartbeat (90), below Foundry notifications
      pointerEvents: 'auto',
      cursor: 'crosshair',
      touchAction: 'none',
    });
    const canvas = document.createElement('canvas');
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
    Object.assign(canvas.style, { position: 'absolute', inset: '0', width: '100%', height: '100%' });
    overlay.appendChild(canvas);

    const stampAt = (e) => {
      const world = state.ctx.screenToWorld(e.clientX, e.clientY);
      stampBrushWorld(state.layer, world.x, world.y, state.brush.radius, {
        hardness: state.brush.hardness,
        value: state.brush.value,
        mode: state.brush.erase ? 'erase' : 'paint',
      });
      state.dirty = true;
    };
    canvas.addEventListener('pointerdown', (e) => {
      state.painting = true;
      canvas.setPointerCapture(e.pointerId);
      stampAt(e);
      e.preventDefault();
    });
    canvas.addEventListener('pointermove', (e) => {
      if (state.painting) stampAt(e);
    });
    const stop = (e) => {
      state.painting = false;
      if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
    };
    canvas.addEventListener('pointerup', stop);
    canvas.addEventListener('pointercancel', stop);

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
      alignItems: 'center',
      gap: '10px',
      padding: '8px 12px',
      background: 'rgba(12,16,26,0.94)',
      border: '1px solid rgba(143,214,255,0.28)',
      borderRadius: '10px',
      boxShadow: '0 8px 24px rgba(0,0,0,0.45)',
      font: '11px/1.3 Signika, sans-serif',
      color: '#dcecff',
      pointerEvents: 'auto',
    });

    const range = (label, min, max, val, onInput) => {
      const wrap = document.createElement('label');
      Object.assign(wrap.style, { display: 'flex', alignItems: 'center', gap: '5px' });
      wrap.append(label);
      const input = document.createElement('input');
      input.type = 'range';
      input.min = String(min);
      input.max = String(max);
      input.value = String(val);
      input.style.width = '90px';
      input.addEventListener('input', () => onInput(Number(input.value)));
      wrap.append(input);
      return wrap;
    };

    const button = (text, onClick, accent) => {
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
    };

    const title = document.createElement('span');
    title.textContent = `🖌️ Paint ${MASK_LABEL}`;
    title.style.fontWeight = '700';
    bar.append(title);
    bar.append(range('Size', 10, 400, state.brush.radius, (v) => (state.brush.radius = v)));
    bar.append(range('Opacity', 5, 255, state.brush.value, (v) => (state.brush.value = v)));

    const eraseWrap = document.createElement('label');
    Object.assign(eraseWrap.style, { display: 'flex', alignItems: 'center', gap: '4px' });
    const erase = document.createElement('input');
    erase.type = 'checkbox';
    erase.addEventListener('change', () => (state.brush.erase = erase.checked));
    eraseWrap.append(erase, document.createTextNode('Erase'));
    bar.append(eraseWrap);

    bar.append(
      button(
        'Clear',
        () => {
          state.layer.data.fill(0);
          state.dirty = true;
        },
        '255,196,120'
      )
    );
    bar.append(
      button(
        '💾 Save',
        async () => {
          const payload = serializePaintedMasks({ [KEY]: state.layer });
          const r = await savePaintedMasks(payload);
          notify(
            r.ok ? `Map Shine: painted ${MASK_LABEL} saved to the scene.` : `Map Shine: save failed — ${r.reason}`,
            r.ok ? 'info' : 'error'
          );
        },
        '167,255,196'
      )
    );
    bar.append(button('Exit', exit, '143,214,255'));
    return bar;
  }

  // Live preview: render the grid to an offscreen RGBA canvas (only when it
  // changed), then blit it onto the scene's on-screen rect every frame so it
  // tracks pan/zoom. Rotation is assumed off for tier 0 (Foundry canvas
  // rotation is rare) — the mask blits into the sceneRect's screen AABB.
  function renderGridCanvas() {
    const { spec, data } = state.layer;
    if (!state.gridCanvas) state.gridCanvas = document.createElement('canvas');
    const g = state.gridCanvas;
    if (g.width !== spec.w || g.height !== spec.h) {
      g.width = spec.w;
      g.height = spec.h;
    }
    const gctx = g.getContext('2d');
    const img = gctx.createImageData(spec.w, spec.h);
    for (let i = 0; i < data.length; i++) {
      const v = data[i];
      img.data[i * 4] = 255; // R — fire preview is red
      img.data[i * 4 + 1] = 40;
      img.data[i * 4 + 2] = 0;
      img.data[i * 4 + 3] = v; // A — painted strength
    }
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
    if (state.dirty) {
      renderGridCanvas();
      state.dirty = false;
    }
    const cctx = cv.getContext('2d');
    cctx.clearRect(0, 0, cv.width, cv.height);
    const r = state.ctx.sceneRect;
    const tl = state.ctx.worldToClient(r.x, r.y);
    const br = state.ctx.worldToClient(r.x + r.width, r.y + r.height);
    const left = Math.min(tl.x, br.x);
    const top = Math.min(tl.y, br.y);
    const w = Math.abs(br.x - tl.x);
    const h = Math.abs(br.y - tl.y);
    if (state.gridCanvas && w > 0 && h > 0) {
      cctx.imageSmoothingEnabled = true;
      cctx.globalAlpha = 0.75;
      cctx.drawImage(state.gridCanvas, left, top, w, h);
      cctx.globalAlpha = 1;
    }
  }

  MapShine.debug?.registerAction(
    'paint-fire',
    `🖌️ Paint ${MASK_LABEL}`,
    () => {
      enter();
      return { report: 'paint-fire', entered: state.active };
    },
    { primary: true }
  );

  return {
    /** Called from boot's canvasReady: pull any saved paint for the new scene. */
    hydrateFromScene() {
      const ctx = readPaintContext();
      if (!ctx.ready) return { loaded: false };
      const payload = loadPaintedMasks();
      if (!payload) {
        state.layer = null; // fresh scene, nothing painted
        return { loaded: false };
      }
      const { layers, mismatched } = hydratePaintedMasks(payload, ctx.sceneRect);
      state.layer = layers[KEY] ?? null;
      state.dirty = true;
      return { loaded: !!state.layer, mismatched };
    },
  };
}
