/**
 * @fileoverview PAINT MODE — the preview canvas + dirty tracking. Everything
 * that turns the painter's mask grids into pixels on screen: which cells
 * changed since the last render (the O(changed) bookkeeping that lets a 4096²
 * grid stay smooth), packing those cells into a per-kind offscreen canvas, the
 * per-frame compositing loop, the brush ring, and the in-progress vector draft.
 *
 * Split out of paint-mode.js on 2026-07-25 (the size-ratchet god-object
 * reversal): that file was 1,083 lines with an 867-line `installPainter`
 * closure. Every body below moved VERBATIM — `createPaintCanvas` is a factory
 * purely so they keep closing over the same `state` object they always did,
 * rather than being rewritten to thread it through as a parameter (the
 * lowest-risk transformation available for code that cannot be Node-tested:
 * it draws).
 *
 * @module ui/paint-mode-canvas
 */

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

/**
 * Bind the preview-canvas renderer to the painter's live `state`.
 * @param {object} state - the painter state (layers, dirty, previewRect, canvas, ctx, brush, draft…).
 * @param {{activeKey: () => string}} deps - `activeKey()` names the layer being painted right now.
 * @returns {{markCells: Function, markFull: Function, markWorldDisc: Function,
 *   markWorldRect: Function, renderGrid: Function, loop: Function}}
 */
export function createPaintCanvas(state, { activeKey }) {
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
    if (!g) {
      state.gridCachePoolStats.canvasMisses += 1;
      g = state.gridCanvases[key] = document.createElement('canvas');
    } else {
      state.gridCachePoolStats.canvasHits += 1;
    }
    const gctx = g.getContext('2d');
    let img = state.gridImageData[key];
    if (g.width !== spec.w || g.height !== spec.h || !img) {
      state.gridCachePoolStats.imageDataMisses += 1;
      g.width = spec.w;
      g.height = spec.h;
      img = state.gridImageData[key] = gctx.createImageData(spec.w, spec.h);
    } else {
      state.gridCachePoolStats.imageDataHits += 1;
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
      const floorSuffix = `::${state.floor}`;
      // Painted kinds under the map, active one brightest, others dimmed —
      // but ONLY this floor. Masks are per-floor (Floor stepper), so another
      // floor's layers must be invisible here, not just dimmed, or switching
      // floors looks like a no-op (the old floor's paint barely fades).
      for (const key of Object.keys(state.layers)) {
        if (!key.endsWith(floorSuffix)) continue;
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

  return { markCells, markFull, markWorldDisc, markWorldRect, renderGrid, loop };
}
