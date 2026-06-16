/**
 * @fileoverview Debug minimap overlay for tile streaming (scene thumb + grid + frustum).
 * @module ui/streaming-minimap
 */

import { createLogger } from '../core/log.js';
import {
  getSceneRectMeta,
  getSceneWorldRect,
  getStableViewRectForMinimap,
  resolveStreamingViewRect,
  worldToSceneUv,
} from '../streaming/view-projection-service.js';
import { getImageCellsForWorldView, imageCellToWorldBounds } from '../streaming/streamed-background-grid.js';
import { getTileStreamingManager } from '../streaming/tile-streaming-manager.js';
import { lodPixelSize } from '../streaming/streaming-grid.js';
import { fetchSourceImageMeta, loadFallbackTexture } from '../streaming/texture-pyramid-builder.js';
import { estimateSceneMegapixels } from '../streaming/texture-budget-policy.js';
import {
  getTextureBudgetTracker,
  resolveBudgetState,
  resolveRecommendedTileSize,
} from '../assets/TextureBudgetTracker.js';

const log = createLogger('StreamingMinimap');

/** @type {StreamingMinimap|null} */
let _instance = null;

const STATE_COLORS = {
  'resident-hi': 'rgba(34,197,94,0.82)',
  'resident-lo': 'rgba(132,204,22,0.72)',
  'fallback-only': 'rgba(234,179,8,0.55)',
  loading: 'rgba(59,130,246,0.65)',
  hidden: 'rgba(251,146,60,0.6)',
  culled: 'rgba(71,85,105,0.35)',
  unknown: 'rgba(148,163,184,0.45)',
};

/** Draw order — resident tiles on top. */
const STATE_DRAW_ORDER = {
  culled: 0,
  hidden: 1,
  'fallback-only': 2,
  loading: 3,
  'resident-lo': 4,
  'resident-hi': 5,
  unknown: 1,
};

/**
 * Pick pyramid LOD so the overview fits the minimap canvas.
 * @param {object} manifest
 * @param {number} cellSize
 * @param {number} targetPx
 * @returns {number}
 */
function pickOverviewLod(manifest, cellSize, targetPx = 220) {
  const cols = Math.max(1, manifest.cols);
  const rows = Math.max(1, manifest.rows);
  const maxLod = Math.max(0, Number(manifest.maxLod) || 4);
  const wantCellPx = targetPx / Math.max(cols, rows);
  let lod = 0;
  while (lod < maxLod && lodPixelSize(cellSize, lod) > wantCellPx * 1.5) {
    lod += 1;
  }
  return lod;
}

/**
 * @param {{ minX: number, minY: number, maxX: number, maxY: number }|null|undefined} rect
 * @returns {boolean}
 */
function isFiniteViewRect(rect) {
  if (!rect) return false;
  const { minX, minY, maxX, maxY } = rect;
  return [minX, minY, maxX, maxY].every((n) => Number.isFinite(n))
    && maxX > minX
    && maxY > minY;
}

/**
 * @param {(wx: number, wy: number) => { x: number, y: number }} toMini
 * @param {{ minX: number, minY: number, maxX: number, maxY: number }|null} cameraView
 * @returns {{ x: number, y: number }|null}
 */
function resolveMinimapCameraCenter(toMini, cameraView) {
  const cam = window.MapShine?.sceneComposer?.camera
    ?? window.MapShine?.floorCompositorV2?.camera
    ?? null;
  const px = cam?.position?.x;
  const py = cam?.position?.y;
  if (Number.isFinite(px) && Number.isFinite(py)) {
    return toMini(px, py);
  }
  if (isFiniteViewRect(cameraView)) {
    return toMini(
      (cameraView.minX + cameraView.maxX) * 0.5,
      (cameraView.minY + cameraView.maxY) * 0.5,
    );
  }
  return null;
}

export class StreamingMinimap {
  constructor() {
    this._root = null;
    this._canvas = null;
    this._ctx = null;
    this._enabled = false;
    this._width = 260;
    this._height = 260;
    this._lastDebug = null;
    /** @type {HTMLCanvasElement|null} */
    this._overviewCanvas = null;
    /** @type {string} */
    this._overviewKey = '';
    /** @type {Promise<void>|null} */
    this._overviewLoad = null;
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
      this.update();
    } else {
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
      'background:rgba(15,23,42,0.94)',
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
      `width:${this._width}px`,
      `height:${this._height}px`,
      'border:1px solid rgba(248,250,252,0.25)',
      'border-radius:4px',
      'background:#0f172a',
    ].join(';');

    const stats = document.createElement('div');
    stats.id = 'msa-streaming-minimap-stats';
    stats.style.marginTop = '6px';
    stats.style.opacity = '0.92';
    stats.style.maxWidth = `${this._width}px`;
    stats.style.lineHeight = '1.45';

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

  /**
   * Resolve the primary streaming background for overview generation.
   * @returns {{ sourceUrl: string, manifest: object, cellSize: number }|null}
   * @private
   */
  _resolvePrimaryStreamInfo() {
    const manager = getTileStreamingManager();
    for (const grid of manager.getGrids().values()) {
      const info = grid.getStreamInfo?.();
      if (info?.manifest && info.sourceUrl) return info;
    }
    return null;
  }

  /**
   * Build a low-res scene overview from pyramid tiles (works on 12k sources).
   * @private
   */
  _kickOverviewLoad(info) {
    const { sourceUrl, manifest, cellSize } = info;
    const key = `${manifest.sourceKey}:${manifest.cols}x${manifest.rows}:cs${cellSize}`;
    if (this._overviewKey === key && this._overviewCanvas) return;
    if (this._overviewLoad) return;

    this._overviewLoad = (async () => {
      try {
        const meta = await fetchSourceImageMeta(sourceUrl);
        if (!meta) {
          await this._trySingleImageOverview(sourceUrl, manifest);
          return;
        }

        const lod = pickOverviewLod(manifest, cellSize, this._width - 16);
        const cs = Math.max(512, cellSize);
        const aspect = manifest.sourceWidth / Math.max(1, manifest.sourceHeight);
        let thumbW = this._width - 16;
        let thumbH = Math.round(thumbW / aspect);
        if (thumbH > this._height - 16) {
          thumbH = this._height - 16;
          thumbW = Math.round(thumbH * aspect);
        }

        const cv = document.createElement('canvas');
        cv.width = thumbW;
        cv.height = thumbH;
        const cx = cv.getContext('2d');
        if (!cx) return;

        cx.fillStyle = '#1e293b';
        cx.fillRect(0, 0, thumbW, thumbH);

        for (let cellY = 0; cellY < manifest.rows; cellY += 1) {
          for (let cellX = 0; cellX < manifest.cols; cellX += 1) {
            const sx = cellX * cs;
            const sy = cellY * cs;
            const sw = Math.min(cs, Math.max(1, manifest.sourceWidth - sx));
            const sh = Math.min(cs, Math.max(1, manifest.sourceHeight - sy));
            const outPx = lodPixelSize(cs, lod);

            let bitmap;
            try {
              bitmap = await createImageBitmap(
                meta.blob,
                sx, sy, sw, sh,
                {
                  resizeWidth: outPx,
                  resizeHeight: Math.max(1, Math.round(outPx * (sh / sw))),
                  resizeQuality: 'medium',
                  premultiplyAlpha: 'none',
                  colorSpaceConversion: 'none',
                },
              );
            } catch (_) {
              continue;
            }

            const dx = (cellX / manifest.cols) * thumbW;
            const dy = (cellY / manifest.rows) * thumbH;
            const dw = thumbW / manifest.cols;
            const dh = thumbH / manifest.rows;
            cx.drawImage(bitmap, dx, dy, dw, dh);
            bitmap.close();
          }
        }

        this._overviewCanvas = cv;
        this._overviewKey = key;
      } catch (err) {
        log.warn('StreamingMinimap overview build failed', err);
      } finally {
        this._overviewLoad = null;
      }
    })();
  }

  /**
   * Fallback for scenes small enough to downscale the full image.
   * @private
   */
  async _trySingleImageOverview(sourceUrl, manifest) {
    const tex = await loadFallbackTexture(sourceUrl, 512);
    const img = tex?.image;
    if (!img || !(img.width > 0)) {
      tex?.dispose?.();
      return;
    }
    const aspect = manifest.sourceWidth / Math.max(1, manifest.sourceHeight);
    let thumbW = this._width - 16;
    let thumbH = Math.round(thumbW / aspect);
    if (thumbH > this._height - 16) {
      thumbH = this._height - 16;
      thumbW = Math.round(thumbH * aspect);
    }
    const cv = document.createElement('canvas');
    cv.width = thumbW;
    cv.height = thumbH;
    const cx = cv.getContext('2d');
    if (!cx) {
      tex?.dispose?.();
      return;
    }
    cx.drawImage(img, 0, 0, thumbW, thumbH);
    tex.dispose?.();
    this._overviewCanvas = cv;
    this._overviewKey = `${manifest.sourceKey}:single`;
  }

  /**
   * Draw streaming cell grid lines over the scene thumb.
   * @private
   */
  _drawStreamingGrid(ctx, sceneWorld, cellSize, scale, toMini, meta) {
    const cells = getImageCellsForWorldView(
      sceneWorld,
      sceneWorld,
      cellSize,
      meta.width,
      meta.height,
    );
    ctx.strokeStyle = 'rgba(148,163,184,0.45)';
    ctx.lineWidth = 1;
    for (const cell of cells) {
      const bounds = imageCellToWorldBounds(
        cell.cellX,
        cell.cellY,
        cellSize,
        meta.width,
        meta.height,
        sceneWorld,
      );
      const tl = toMini(bounds.minX, bounds.maxY);
      const w = (bounds.maxX - bounds.minX) * scale;
      const h = (bounds.maxY - bounds.minY) * scale;
      ctx.strokeRect(tl.x + 0.5, tl.y + 0.5, Math.max(0, w - 1), Math.max(0, h - 1));
    }
  }

  /**
   * Draw minimap — driven by FloorCompositor after camera sync (no internal RAF loop).
   */
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
      const margin = 10;

      ctx.fillStyle = '#0f172a';
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      const scale = Math.min(
        (canvas.width - margin * 2) / worldW,
        (canvas.height - margin * 2) / worldH,
      );

      const toMini = (wx, wy) => ({
        x: margin + (wx - sceneWorld.minX) * scale,
        y: margin + (sceneWorld.maxY - wy) * scale,
      });

      const sceneTl = toMini(sceneWorld.minX, sceneWorld.maxY);
      const sceneWpx = worldW * scale;
      const sceneHpx = worldH * scale;

      const streamInfo = this._resolvePrimaryStreamInfo();
      if (streamInfo) {
        this._kickOverviewLoad(streamInfo);
      }

      if (this._overviewCanvas) {
        ctx.drawImage(this._overviewCanvas, sceneTl.x, sceneTl.y, sceneWpx, sceneHpx);
      } else {
        ctx.fillStyle = '#1e293b';
        ctx.fillRect(sceneTl.x, sceneTl.y, sceneWpx, sceneHpx);
      }

      const budget = getTextureBudgetTracker();
      const manager = getTileStreamingManager();
      const grids = manager.getGrids();
      // Streaming tiles use the union frustum; the orange camera overlay uses the
      // stable FOV box so it does not flip between raycast vs stable near the 1.02 area gate.
      const streamView = resolveStreamingViewRect(0);
      const cameraView = getStableViewRectForMinimap();

      let cellSize = resolveRecommendedTileSize(budget);
      for (const grid of grids.values()) {
        const info = grid.getStreamInfo?.();
        if (info?.cellSize > 0) {
          cellSize = info.cellSize;
          break;
        }
      }

      this._drawStreamingGrid(ctx, sceneWorld, cellSize, scale, toMini, meta);

      /** @type {Array<{ bounds: object, state: string, visible?: boolean }>} */
      const overlayCells = [];
      let visibleCellCount = 0;
      for (const grid of grids.values()) {
        try {
          for (const cell of grid.getMinimapDisplayCells?.(streamView) ?? []) {
            overlayCells.push(cell);
            if (cell.visible && (cell.state === 'resident-hi' || cell.state === 'resident-lo')) {
              visibleCellCount += 1;
            }
          }
        } catch (gridErr) {
          log.warn('StreamingMinimap grid snapshot failed', gridErr);
        }
      }
      overlayCells.sort(
        (a, b) => (STATE_DRAW_ORDER[a.state] ?? 1) - (STATE_DRAW_ORDER[b.state] ?? 1),
      );

      for (const { bounds, state } of overlayCells) {
        const tl = toMini(bounds.minX, bounds.maxY);
        const w = (bounds.maxX - bounds.minX) * scale;
        const h = (bounds.maxY - bounds.minY) * scale;
        ctx.fillStyle = STATE_COLORS[state] ?? STATE_COLORS.unknown;
        ctx.fillRect(tl.x, tl.y, w, h);
      }

      const streamedCellCount = overlayCells.length;

      ctx.strokeStyle = '#e2e8f0';
      ctx.lineWidth = 1.5;
      ctx.strokeRect(sceneTl.x + 0.5, sceneTl.y + 0.5, Math.max(0, sceneWpx - 1), Math.max(0, sceneHpx - 1));

      if (isFiniteViewRect(cameraView)) {
        const vtl = toMini(cameraView.minX, cameraView.maxY);
        const vw = (cameraView.maxX - cameraView.minX) * scale;
        const vh = (cameraView.maxY - cameraView.minY) * scale;
        ctx.fillStyle = 'rgba(251,146,60,0.12)';
        ctx.fillRect(vtl.x, vtl.y, vw, vh);
        ctx.strokeStyle = '#fb923c';
        ctx.lineWidth = 2;
        ctx.strokeRect(vtl.x + 0.5, vtl.y + 0.5, Math.max(0, vw - 1), Math.max(0, vh - 1));

        const center = resolveMinimapCameraCenter(toMini, cameraView);
        if (center) {
          ctx.fillStyle = '#fb923c';
          ctx.beginPath();
          ctx.arc(center.x, center.y, 3, 0, Math.PI * 2);
          ctx.fill();
        }
      }

      ctx.fillStyle = 'rgba(15,23,42,0.72)';
      ctx.fillRect(margin, margin, 72, 14);
      ctx.fillStyle = '#f8fafc';
      ctx.font = '10px sans-serif';
      ctx.fillText(`g${grids.size} c${visibleCellCount}`, margin + 4, margin + 10);

      const bs = resolveBudgetState(budget);
      const uv = streamView ? (() => {
        const tl = worldToSceneUv(streamView.minX, streamView.maxY);
        const br = worldToSceneUv(streamView.maxX, streamView.minY);
        return {
          uMin: Math.min(tl.u, br.u),
          vMin: Math.min(tl.v, br.v),
          uMax: Math.max(tl.u, br.u),
          vMax: Math.max(tl.v, br.v),
        };
      })() : null;
      const overPct = bs.overBudget ? ' ⚠' : '';
      const deviceMem = Number(navigator?.deviceMemory) || 0;
      const mp = estimateSceneMegapixels();
      const budgetReason = budget.budgetReason || 'default';

      this._lastDebug = {
        enabled: this._enabled,
        meta,
        sceneWorld,
        scale,
        grids: grids.size,
        streamedCellCount,
        visibleCellCount,
        hasView: !!streamView,
        hasCameraView: !!cameraView,
        cellSize,
        budgetReason,
      };

      const statsEl = this._root?.querySelector('#msa-streaming-minimap-stats');
      if (statsEl) {
        const line1 = [
          `grids ${grids.size}`,
          `${Math.round(meta.width)}×${Math.round(meta.height)}`,
          `cell ${cellSize}px`,
          streamView && uv ? `view ${((uv.uMax - uv.uMin) * 100).toFixed(0)}×${((uv.vMax - uv.vMin) * 100).toFixed(0)}%` : 'view —',
        ].join(' · ');
        const line2 = [
          `budget ${(bs.usedBytes / 1024 / 1024).toFixed(0)}/${(bs.budgetBytes / 1024 / 1024).toFixed(0)} MB${overPct}`,
          budgetReason,
          deviceMem > 0 ? `sysRAM~${deviceMem}GB` : null,
          mp > 0 ? `${mp.toFixed(0)} MP` : null,
        ].filter(Boolean).join(' · ');
        statsEl.textContent = `${line1}\n${line2}`;
        statsEl.style.whiteSpace = 'pre-wrap';
      }
    } catch (err) {
      const errText = String(err?.message ?? err ?? 'unknown');
      this._lastDebug = { error: errText, enabled: this._enabled };
      log.warn('StreamingMinimap update failed', err);
      try {
        ctx.fillStyle = '#7f1d1d';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.fillStyle = '#fecaca';
        ctx.font = '11px sans-serif';
        ctx.fillText('minimap error', 8, 20);
        const detail = errText.slice(0, 120);
        if (detail) ctx.fillText(detail, 8, 36);
      } catch (_) {}
    }
  }

  dispose() {
    this._enabled = false;
    try { this._root?.remove(); } catch (_) {}
    this._root = null;
    this._canvas = null;
    this._ctx = null;
    this._overviewCanvas = null;
    this._overviewKey = '';
    this._overviewLoad = null;
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
