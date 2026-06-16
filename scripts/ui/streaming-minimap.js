/**

 * @fileoverview Debug minimap overlay for tile streaming (grid + frustum + cell states).

 * @module ui/streaming-minimap

 */



import { createLogger } from '../core/log.js';

import {

  getSceneRectMeta,

  getSceneWorldRect,

  getVisibleWorldRect,

  getVisibleSceneUvRect,

} from '../streaming/view-projection-service.js';

import { getImageCellsForWorldView, imageCellToWorldBounds } from '../streaming/streamed-background-grid.js';

import { getTileStreamingManager } from '../streaming/tile-streaming-manager.js';

import {

  getTextureBudgetTracker,

  resolveBudgetState,

  resolveRecommendedTileSize,

} from '../assets/TextureBudgetTracker.js';



const log = createLogger('StreamingMinimap');



/** @type {StreamingMinimap|null} */

let _instance = null;



const STATE_COLORS = {

  'resident-hi': '#22c55e',

  'resident-lo': '#84cc16',

  'fallback-only': '#eab308',

  loading: '#3b82f6',

  culled: '#475569',

  unknown: '#94a3b8',

};



export class StreamingMinimap {

  constructor() {

    this._root = null;

    this._canvas = null;

    this._ctx = null;

    this._enabled = false;

    this._width = 240;

    this._height = 240;

    this._lastDebug = null;

    /** @type {number} */

    this._rafId = 0;

  }



  /** @param {boolean} enabled */

  setEnabled(enabled) {

    const next = !!enabled;

    if (next === this._enabled) {

      if (next) this._ensureDom();

      return;

    }

    this._enabled = next;

    if (this._enabled) {

      this._ensureDom();

      this._startLoop();

      this.update();

    } else {

      this._stopLoop();

      this._hide();

    }

  }



  /** @returns {boolean} */

  isEnabled() {

    return this._enabled;

  }



  /** @returns {object|null} */

  getDebugState() {

    if (!this._lastDebug && this._enabled) this.update();

    return this._lastDebug;

  }



  _startLoop() {

    if (this._rafId) return;

    const tick = () => {

      this._rafId = 0;

      if (!this._enabled) return;

      this.update();

      this._rafId = requestAnimationFrame(tick);

    };

    this._rafId = requestAnimationFrame(tick);

  }



  _stopLoop() {

    if (!this._rafId) return;

    try { cancelAnimationFrame(this._rafId); } catch (_) {}

    this._rafId = 0;

  }



  _ensureDom() {

    if (this._root && this._canvas && this._ctx) {

      this._root.style.display = 'block';

      return;

    }



    if (this._root) {

      try { this._root.remove(); } catch (_) {}

    }



    const root = document.createElement('div');

    root.id = 'msa-streaming-minimap';

    root.style.cssText = [

      'position:fixed',

      'bottom:12px',

      'right:12px',

      'z-index:99999',

      'background:rgba(15,23,42,0.92)',

      'border:1px solid rgba(248,250,252,0.35)',

      'border-radius:8px',

      'padding:8px',

      'font:11px/1.35 sans-serif',

      'color:#f8fafc',

      'pointer-events:none',

      'user-select:none',

      'box-shadow:0 8px 24px rgba(0,0,0,0.45)',

    ].join(';');



    const title = document.createElement('div');

    title.textContent = 'Tile Streaming';

    title.style.marginBottom = '6px';

    title.style.fontWeight = '600';



    const canvas = document.createElement('canvas');

    canvas.width = this._width;

    canvas.height = this._height;

    canvas.style.cssText = [

      'display:block',

      'width:240px',

      'height:240px',

      'border:1px solid rgba(248,250,252,0.25)',

      'border-radius:4px',

      'background:#1e293b',

      'image-rendering:pixelated',

    ].join(';');



    const stats = document.createElement('div');

    stats.id = 'msa-streaming-minimap-stats';

    stats.style.marginTop = '6px';

    stats.style.opacity = '0.92';

    stats.style.maxWidth = '240px';



    root.appendChild(title);

    root.appendChild(canvas);

    root.appendChild(stats);

    document.body.appendChild(root);



    this._root = root;

    this._canvas = canvas;

    this._ctx = canvas.getContext('2d');

    if (!this._ctx) log.warn('StreamingMinimap: 2D context unavailable');

  }



  _hide() {

    if (this._root) this._root.style.display = 'none';

  }



  /** @private */

  _drawSceneLocalGrid(ctx, sceneWorld, cellSize, scale, toMini) {

    const cs = Math.max(256, cellSize);

    const worldW = sceneWorld.maxX - sceneWorld.minX;

    const worldH = sceneWorld.maxY - sceneWorld.minY;

    const cols = Math.ceil(worldW / cs);

    const rows = Math.ceil(worldH / cs);



    ctx.strokeStyle = 'rgba(148,163,184,0.35)';

    ctx.lineWidth = 1;



    for (let row = 0; row < rows; row += 1) {

      for (let col = 0; col < cols; col += 1) {

        const minX = sceneWorld.minX + col * cs;

        const minY = sceneWorld.minY + row * cs;

        const maxX = Math.min(sceneWorld.maxX, minX + cs);

        const maxY = Math.min(sceneWorld.maxY, minY + cs);

        const tl = toMini(minX, maxY);

        const w = (maxX - minX) * scale;

        const h = (maxY - minY) * scale;

        ctx.fillStyle = ((col + row) % 2 === 0) ? 'rgba(100,116,139,0.35)' : 'rgba(71,85,105,0.25)';

        ctx.fillRect(tl.x, tl.y, w, h);

        ctx.strokeRect(tl.x + 0.5, tl.y + 0.5, Math.max(0, w - 1), Math.max(0, h - 1));

      }

    }

  }



  /** Draw minimap — also driven by internal requestAnimationFrame loop. */

  update() {

    if (!this._enabled) return;

    this._ensureDom();

    const ctx = this._ctx;

    const canvas = this._canvas;

    if (!ctx || !canvas) return;



    try {

      const meta = getSceneRectMeta();

      const sceneWorld = getSceneWorldRect();

      const worldW = Math.max(1, sceneWorld.maxX - sceneWorld.minX);

      const worldH = Math.max(1, sceneWorld.maxY - sceneWorld.minY);

      const margin = 8;



      ctx.fillStyle = '#1e293b';

      ctx.fillRect(0, 0, canvas.width, canvas.height);



      const scale = Math.min(

        (canvas.width - margin * 2) / worldW,

        (canvas.height - margin * 2) / worldH,

      );



      const toMini = (wx, wy) => ({

        x: margin + (wx - sceneWorld.minX) * scale,

        y: margin + (sceneWorld.maxY - wy) * scale,

      });



      const budget = getTextureBudgetTracker();

      const cellSize = resolveRecommendedTileSize(budget);

      const manager = getTileStreamingManager();

      const grids = manager.getGrids();



      this._drawSceneLocalGrid(ctx, sceneWorld, cellSize, scale, toMini);



      const sceneTl = toMini(sceneWorld.minX, sceneWorld.maxY);

      const sceneWpx = worldW * scale;

      const sceneHpx = worldH * scale;

      ctx.fillStyle = 'rgba(51,65,85,0.55)';

      ctx.fillRect(sceneTl.x, sceneTl.y, sceneWpx, sceneHpx);

      ctx.strokeStyle = '#e2e8f0';

      ctx.lineWidth = 1.5;

      ctx.strokeRect(sceneTl.x + 0.5, sceneTl.y + 0.5, Math.max(0, sceneWpx - 1), Math.max(0, sceneHpx - 1));



      let streamedCellCount = 0;

      for (const grid of grids.values()) {

        for (const { bounds, state } of grid.getDisplayCells?.() ?? []) {

          streamedCellCount += 1;

          const tl = toMini(bounds.minX, bounds.maxY);

          const w = (bounds.maxX - bounds.minX) * scale;

          const h = (bounds.maxY - bounds.minY) * scale;

          ctx.fillStyle = STATE_COLORS[state] ?? STATE_COLORS.unknown;

          ctx.fillRect(tl.x, tl.y, w, h);

        }

      }



      if (streamedCellCount === 0 && grids.size > 0) {

        for (const cell of getImageCellsForWorldView(sceneWorld, sceneWorld, cellSize, meta.width, meta.height)) {

          const bounds = imageCellToWorldBounds(cell.cellX, cell.cellY, cellSize, meta.width, meta.height, sceneWorld);

          const tl = toMini(bounds.minX, bounds.maxY);

          ctx.fillStyle = 'rgba(234,179,8,0.25)';

          ctx.fillRect(tl.x, tl.y, (bounds.maxX - bounds.minX) * scale, (bounds.maxY - bounds.minY) * scale);

        }

      }



      const view = getVisibleWorldRect(0);

      if (view) {

        const vtl = toMini(view.minX, view.maxY);

        ctx.strokeStyle = '#fb923c';

        ctx.lineWidth = 2;

        ctx.strokeRect(vtl.x, vtl.y, (view.maxX - view.minX) * scale, (view.maxY - view.minY) * scale);

        ctx.fillStyle = 'rgba(251,146,60,0.15)';

        ctx.fillRect(vtl.x, vtl.y, (view.maxX - view.minX) * scale, (view.maxY - view.minY) * scale);

      } else {

        ctx.fillStyle = '#fca5a5';

        ctx.font = 'bold 11px sans-serif';

        ctx.fillText('no camera view', margin, canvas.height - margin);

      }



      ctx.fillStyle = '#f8fafc';

      ctx.font = '10px sans-serif';

      ctx.fillText(`g${grids.size}`, margin, 12);



      const bs = resolveBudgetState(budget);

      const uv = getVisibleSceneUvRect(0);

      const overPct = bs.overBudget ? ' ⚠' : '';



      this._lastDebug = {

        enabled: this._enabled,

        meta,

        sceneWorld,

        scale,

        grids: grids.size,

        streamedCellCount,

        hasView: !!view,

        cellSize,

      };



      const statsEl = this._root?.querySelector('#msa-streaming-minimap-stats');

      if (statsEl) {

        statsEl.textContent = [

          `grids ${grids.size}`,

          `${Math.round(meta.width)}×${Math.round(meta.height)}`,

          `VRAM ${(bs.usedBytes / 1024 / 1024).toFixed(0)}/${(bs.budgetBytes / 1024 / 1024).toFixed(0)} MB${overPct}`,

          `cell ${cellSize}px`,

          view && uv ? `cam ${(uv.uMax - uv.uMin).toFixed(2)}×${(uv.vMax - uv.vMin).toFixed(2)}` : 'cam —',

        ].filter(Boolean).join(' · ');

      }

    } catch (err) {

      this._lastDebug = { error: String(err?.message ?? err), enabled: this._enabled };

      log.warn('StreamingMinimap update failed', err);

      try {

        ctx.fillStyle = '#7f1d1d';

        ctx.fillRect(0, 0, canvas.width, canvas.height);

        ctx.fillStyle = '#fecaca';

        ctx.font = '11px sans-serif';

        ctx.fillText('minimap error', 8, 20);

      } catch (_) {}

    }

  }



  dispose() {

    this._stopLoop();

    this._enabled = false;

    try { this._root?.remove(); } catch (_) {}

    this._root = null;

    this._canvas = null;

    this._ctx = null;

    this._lastDebug = null;

  }

}



/** @returns {StreamingMinimap} */

export function getStreamingMinimap() {

  if (!_instance) _instance = new StreamingMinimap();

  if (typeof window !== 'undefined') {

    window.MapShine = window.MapShine || {};

    window.MapShine.streamingMinimap = _instance;

  }

  return _instance;

}



/** @param {boolean} [defaultEnabled=true] */

export function initStreamingMinimap(defaultEnabled = true) {

  const mm = getStreamingMinimap();

  mm.setEnabled(defaultEnabled);

  if (typeof window !== 'undefined') {

    window.MapShine = window.MapShine || {};

    window.MapShine.streamingMinimap = mm;

    window.MapShine.toggleStreamingMinimap = (on) => {

      mm.setEnabled(on !== undefined ? !!on : !mm.isEnabled());

      log.info(`Streaming minimap ${mm.isEnabled() ? 'ON' : 'OFF'}`);

    };

  }

  return mm;

}

