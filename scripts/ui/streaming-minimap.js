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
import { getGpuWorkScheduler } from '../streaming/gpu-work-scheduler.js';
import { getAdaptiveBudgetController } from '../streaming/adaptive-budget-controller.js';
import { lodPixelSize, selectLodFromZoom } from '../streaming/streaming-grid.js';
import { fetchSourceImageMeta, loadFallbackTexture } from '../streaming/texture-pyramid-builder.js';
import { estimateSceneMegapixels } from '../streaming/texture-budget-policy.js';
import {
  getTextureBudgetTracker,
  resolveBudgetState,
  resolveRecommendedTileSize,
} from '../assets/TextureBudgetTracker.js';
import {
  buildTileStreamingReport,
  buildCompositorPopulateSnapshot,
  copyTileStreamingReportToClipboard,
} from './tile-streaming-report.js';

const log = createLogger('StreamingMinimap');

/** @type {StreamingMinimap|null} */
let _instance = null;

/** Minimum ms between full report rebuilds during live update. */
const REPORT_REFRESH_MS = 1000;

/** Minimum ms between dashboard DOM refreshes (live summary still updates here). */
const DASHBOARD_REFRESH_MS = 500;

const STATE_COLORS = {
  'resident-hi': 'rgba(34,197,94,0.82)',
  'resident-lo': 'rgba(132,204,22,0.72)',
  'fallback-only': 'rgba(234,179,8,0.55)',
  loading: 'rgba(59,130,246,0.65)',
  hidden: 'rgba(251,146,60,0.6)',
  culled: 'rgba(71,85,105,0.35)',
  unknown: 'rgba(148,163,184,0.45)',
};

const STATE_LABELS = {
  'resident-hi': 'Resident hi',
  'resident-lo': 'Resident lo',
  'fallback-only': 'Fallback only',
  loading: 'Loading',
  hidden: 'Hidden',
  culled: 'Culled',
  unknown: 'Unknown',
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

/**
 * Clamp overlay position inside the viewport.
 * @param {number} left
 * @param {number} top
 * @param {number} width
 * @param {number} height
 * @returns {{ left: number, top: number }}
 */
function clampOverlayPosition(left, top, width, height) {
  const pad = 8;
  const maxLeft = Math.max(pad, window.innerWidth - width - pad);
  const maxTop = Math.max(pad, window.innerHeight - height - pad);
  return {
    left: Math.max(pad, Math.min(left, maxLeft)),
    top: Math.max(pad, Math.min(top, maxTop)),
  };
}

/**
 * @param {string} text
 * @returns {string}
 */
function escapeHtml(text) {
  return String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export class StreamingMinimap {
  constructor() {
    this._root = null;
    this._canvas = null;
    this._ctx = null;
    this._dashboardEl = null;
    /** @type {HTMLElement|null} */
    this._tuningBarEl = null;
    /** @type {HTMLButtonElement|null} */
    this._sharpenBtn = null;
    /** @type {HTMLSpanElement|null} */
    this._uploadLabel = null;
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
    /** @type {object|null} */
    this._cachedReport = null;
    /** @type {number} */
    this._lastReportAt = 0;
    /** @type {number} */
    this._lastDashboardRenderAt = 0;
    /** @type {boolean} */
    this._dragInstalled = false;
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

  /** Toggle visibility. @returns {boolean} new enabled state */
  toggle() {
    this.setEnabled(!this._enabled);
    return this._enabled;
  }

  /** @returns {object|null} */
  getDebugState() {
    if (!this._lastDebug && this._enabled) this.update();
    return this._lastDebug;
  }

  _ensureDom() {
    if (this._root && this._canvas && this._ctx && this._dashboardEl) {
      this._root.style.display = 'block';
      return;
    }

    if (this._root) {
      try { this._root.remove(); } catch (_) {}
      this._dragInstalled = false;
    }

    const root = document.createElement('div');
    root.id = 'msa-streaming-minimap';
    root.className = 'map-shine-overlay-ui msa-streaming-minimap';
    root.style.cssText = [
      'position:fixed',
      'bottom:12px',
      'right:12px',
      'z-index:99999',
      'background:rgba(15,23,42,0.96)',
      'border:1px solid rgba(248,250,252,0.35)',
      'border-radius:8px',
      'padding:0',
      'font:11px/1.35 sans-serif',
      'color:#f8fafc',
      'pointer-events:auto',
      'user-select:none',
      'box-shadow:0 8px 24px rgba(0,0,0,0.45)',
      'width:276px',
      'max-width:calc(100vw - 16px)',
      'display:flex',
      'flex-direction:column',
      'overflow:hidden',
    ].join(';');

    const header = document.createElement('div');
    header.className = 'msa-sm-header';
    header.setAttribute('data-drag-handle', '');
    header.style.cssText = [
      'display:flex',
      'align-items:center',
      'gap:6px',
      'padding:6px 8px',
      'border-bottom:1px solid rgba(248,250,252,0.12)',
      'cursor:grab',
      'flex-shrink:0',
    ].join(';');

    const title = document.createElement('div');
    title.className = 'msa-sm-title';
    title.textContent = 'Tile Streaming';
    title.style.cssText = 'flex:1 1 auto;font-weight:600;font-size:11px;min-width:0;';

    const actions = document.createElement('div');
    actions.className = 'msa-sm-actions';
    actions.style.cssText = 'display:flex;gap:4px;flex-shrink:0;';

    const reportBtn = document.createElement('button');
    reportBtn.type = 'button';
    reportBtn.className = 'msa-sm-btn';
    reportBtn.textContent = 'Copy Report';
    reportBtn.title = 'Copy full tile streaming diagnostic report to clipboard';
    reportBtn.style.cssText = this._buttonStyle(false);
    reportBtn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      void this._runReport(true);
    });

    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'msa-sm-btn';
    closeBtn.textContent = 'X';
    closeBtn.title = 'Hide streaming minimap';
    closeBtn.style.cssText = this._buttonStyle(true);
    closeBtn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      this.setEnabled(false);
    });

    actions.appendChild(reportBtn);
    actions.appendChild(closeBtn);
    header.appendChild(title);
    header.appendChild(actions);

    const body = document.createElement('div');
    body.className = 'msa-sm-body';
    body.style.cssText = 'padding:8px;display:flex;flex-direction:column;gap:6px;min-height:0;';

    const canvas = document.createElement('canvas');
    canvas.width = this._width;
    canvas.height = this._height;
    canvas.className = 'msa-sm-canvas';
    canvas.style.cssText = [
      'display:block',
      `width:${this._width}px`,
      `height:${this._height}px`,
      'border:1px solid rgba(248,250,252,0.25)',
      'border-radius:4px',
      'background:#0f172a',
      'flex-shrink:0',
    ].join(';');

    const dashboard = document.createElement('div');
    dashboard.id = 'msa-streaming-minimap-dashboard';
    dashboard.className = 'msa-sm-dashboard';
    dashboard.style.cssText = [
      'max-height:min(340px,40vh)',
      'overflow-y:auto',
      'overflow-x:hidden',
      'font-size:10px',
      'line-height:1.4',
      'scrollbar-width:thin',
      'scrollbar-color:rgba(148,163,184,0.5) rgba(15,23,42,0.5)',
    ].join(';');

    body.appendChild(canvas);
    body.appendChild(this._buildTuningBar());
    body.appendChild(dashboard);
    root.appendChild(header);
    root.appendChild(body);
    document.body.appendChild(root);

    this._root = root;
    this._canvas = canvas;
    this._ctx = canvas.getContext('2d');
    this._dashboardEl = dashboard;
    if (!this._ctx) log.warn('StreamingMinimap: 2D context unavailable');
    this._updateTuningBar();

    if (!this._dragInstalled) {
      this._installDrag(header);
      this._dragInstalled = true;
    }
  }

  /**
   * @param {boolean} [compact]
   * @returns {string}
   * @private
   */
  _buttonStyle(compact = false) {
    return [
      'appearance:none',
      '-webkit-appearance:none',
      'margin:0',
      'padding:2px 6px',
      'border:1px solid rgba(248,250,252,0.22)',
      'border-radius:4px',
      'background:rgba(255,255,255,0.08)',
      'color:#f8fafc',
      'font:inherit',
      `font-size:${compact ? '10px' : '9.5px'}`,
      'line-height:1.2',
      'cursor:pointer',
      'pointer-events:auto',
    ].join(';');
  }

  /**
   * Persistent tuning bar (survives dashboard re-renders): focal LOD-0 sharpen
   * toggle and per-frame GPU upload budget steppers. Wired to the GPU work
   * governor via window.MapShine.streamingTuning semantics.
   * @returns {HTMLElement}
   * @private
   */
  _buildTuningBar() {
    const bar = document.createElement('div');
    bar.className = 'msa-sm-tuning';
    bar.style.cssText = [
      'display:flex', 'align-items:center', 'gap:4px', 'flex-wrap:wrap',
      'font-size:9.5px', 'flex-shrink:0',
    ].join(';');

    const mkBtn = (label, title, onClick) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'msa-sm-btn';
      b.textContent = label;
      b.title = title;
      b.style.cssText = this._buttonStyle(true);
      b.addEventListener('click', (ev) => {
        ev.stopPropagation();
        try { onClick(); } catch (_) {}
        this._updateTuningBar();
      });
      return b;
    };

    this._sharpenBtn = mkBtn('Sharpen: ?', 'Toggle focal LOD-0 sharpening (load finer than zoom on the focal cell)', () => {
      const gov = getGpuWorkScheduler();
      gov.focalSharpenEnabled = gov.focalSharpenEnabled === false;
    });
    const downBtn = mkBtn('Upload -', 'Reduce GPU upload budget per frame (gentler, fewer spikes)', () => {
      const gov = getGpuWorkScheduler();
      gov.setBaseFrameCreditMb(Math.max(8, gov.getBaseFrameCreditMb() - 8));
    });
    const upBtn = mkBtn('Upload +', 'Increase GPU upload budget per frame (faster tiles, more risk)', () => {
      const gov = getGpuWorkScheduler();
      gov.setBaseFrameCreditMb(Math.min(64, gov.getBaseFrameCreditMb() + 8));
    });

    this._uploadLabel = document.createElement('span');
    this._uploadLabel.style.cssText = 'min-width:64px;color:#cbd5e1;';

    bar.appendChild(this._sharpenBtn);
    bar.appendChild(downBtn);
    bar.appendChild(this._uploadLabel);
    bar.appendChild(upBtn);
    this._tuningBarEl = bar;
    return bar;
  }

  /** Refresh tuning-bar labels from the live governor state. @private */
  _updateTuningBar() {
    try {
      const gov = getGpuWorkScheduler();
      if (this._sharpenBtn) {
        this._sharpenBtn.textContent = `Sharpen: ${gov.focalSharpenEnabled === false ? 'OFF' : 'ON'}`;
      }
      if (this._uploadLabel) {
        this._uploadLabel.textContent = `${gov.getBaseFrameCreditMb()} MB/f`;
      }
    } catch (_) {}
  }

  /**
   * @param {HTMLElement} handle
   * @private
   */
  _installDrag(handle) {
    const root = this._root;
    if (!root || !handle) return;

    let dragging = false;
    let startX = 0;
    let startY = 0;
    let baseLeft = 0;
    let baseTop = 0;

    const onMove = (ev) => {
      if (!dragging || !root) return;
      const rect = root.getBoundingClientRect();
      const next = clampOverlayPosition(
        baseLeft + (ev.clientX - startX),
        baseTop + (ev.clientY - startY),
        rect.width,
        rect.height,
      );
      root.style.left = `${next.left}px`;
      root.style.top = `${next.top}px`;
      root.style.right = 'auto';
      root.style.bottom = 'auto';
      root.style.transform = 'none';
    };

    const onUp = () => {
      dragging = false;
      handle.style.cursor = 'grab';
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onUp);
    };

    handle.addEventListener('pointerdown', (ev) => {
      if (ev.target?.closest?.('button')) return;
      dragging = true;
      handle.style.cursor = 'grabbing';
      const rect = root.getBoundingClientRect();
      startX = ev.clientX;
      startY = ev.clientY;
      baseLeft = rect.left;
      baseTop = rect.top;
      root.style.left = `${baseLeft}px`;
      root.style.top = `${baseTop}px`;
      root.style.right = 'auto';
      root.style.bottom = 'auto';
      root.style.transform = 'none';
      document.addEventListener('pointermove', onMove);
      document.addEventListener('pointerup', onUp);
      try { ev.preventDefault(); } catch (_) {}
    });
  }

  /**
   * Build report, copy to clipboard, and refresh dashboard.
   * @param {boolean} [notify=false]
   * @private
   */
  async _runReport(notify = false) {
    try {
      const { report, text, copied } = await copyTileStreamingReportToClipboard();
      this._cachedReport = report;
      this._lastReportAt = performance.now();
      this._renderDashboard(report, this._lastDebug);
      if (notify) {
        const warnCount = report.warnings?.length ?? 0;
        if (copied) {
          ui.notifications?.info?.(
            warnCount
              ? `Tile streaming report copied to clipboard (${warnCount} warning${warnCount === 1 ? '' : 's'})`
              : 'Tile streaming report copied to clipboard',
          );
        } else {
          log.warn('Tile streaming report clipboard unavailable; text logged to console');
          console.log(text);
          ui.notifications?.warn?.(
            warnCount
              ? `Could not copy report — see browser console (${warnCount} warning${warnCount === 1 ? '' : 's'})`
              : 'Could not copy report — see browser console',
          );
        }
      }
    } catch (err) {
      log.warn('StreamingMinimap report failed', err);
      ui.notifications?.error?.(`Tile streaming report failed: ${err?.message || err}`);
    }
  }

  /**
   * @param {object|null} report
   * @param {object|null} live
   * @private
   */
  _maybeRefreshReport(live) {
    const now = performance.now();
    let reportRefreshed = false;

    if (!this._cachedReport || (now - this._lastReportAt) >= REPORT_REFRESH_MS) {
      try {
        this._cachedReport = buildTileStreamingReport();
        this._lastReportAt = now;
        reportRefreshed = true;
      } catch (err) {
        log.warn('StreamingMinimap report build failed', err);
      }
    }

    if (
      reportRefreshed
      || !this._lastDashboardRenderAt
      || (now - this._lastDashboardRenderAt) >= DASHBOARD_REFRESH_MS
    ) {
      this._renderDashboard(this._cachedReport, live);
      this._lastDashboardRenderAt = now;
    }
  }

  /**
   * @param {string} title
   * @param {string} bodyHtml
   * @param {{ tone?: 'warn'|'error'|'ok' }} [opts]
   * @returns {string}
   * @private
   */
  _sectionHtml(title, bodyHtml, opts = {}) {
    const tone = opts.tone ?? 'ok';
    const border = tone === 'warn'
      ? 'rgba(251,191,36,0.35)'
      : tone === 'error'
        ? 'rgba(248,113,113,0.4)'
        : 'rgba(248,250,252,0.1)';
    const bg = tone === 'warn'
      ? 'rgba(251,191,36,0.08)'
      : tone === 'error'
        ? 'rgba(127,29,29,0.25)'
        : 'rgba(255,255,255,0.03)';
    return `
      <section class="msa-sm-section" style="margin-bottom:6px;padding:5px 6px;border:1px solid ${border};border-radius:4px;background:${bg};">
        <div class="msa-sm-section-title" style="font-weight:600;font-size:9.5px;text-transform:uppercase;letter-spacing:0.04em;opacity:0.85;margin-bottom:3px;">${escapeHtml(title)}</div>
        <div class="msa-sm-section-body" style="white-space:pre-wrap;word-break:break-word;">${bodyHtml}</div>
      </section>`;
  }

  /**
   * @param {string} label
   * @param {string} value
   * @returns {string}
   * @private
   */
  _kv(label, value) {
    return `<div><span style="opacity:0.7">${escapeHtml(label)}:</span> ${escapeHtml(value)}</div>`;
  }

  /**
   * @param {object|null} report
   * @param {object|null} live
   * @private
   */
  _renderDashboard(report, live) {
    const el = this._dashboardEl;
    if (!el) return;

    this._updateTuningBar();

    const sections = [];

    if (live?.error) {
      sections.push(this._sectionHtml('Fault', escapeHtml(live.error), { tone: 'error' }));
    }

    const warnList = report?.warnings ?? [];
    if (warnList.length) {
      const body = warnList.map((w) => `• ${escapeHtml(w)}`).join('\n');
      sections.push(this._sectionHtml(`Warnings (${warnList.length})`, body, { tone: 'warn' }));
    } else if (report) {
      sections.push(this._sectionHtml('Warnings', 'None detected', { tone: 'ok' }));
    }

    if (live) {
      const summaryLines = [
        this._kv('Background grids', String(live.grids ?? 0)),
        this._kv('Overlay cells', String(live.streamedCellCount ?? 0)),
        this._kv('Visible resident', String(live.visibleCellCount ?? 0)),
        this._kv('Cell size', `${live.cellSize ?? '?'} px`),
        this._kv('Stream view', live.hasView ? 'active' : 'missing'),
        this._kv('Camera overlay', live.hasCameraView ? 'active' : 'missing'),
      ].join('');
      sections.push(this._sectionHtml('Live Summary', summaryLines));
    }

    if (report) {
      const sceneLines = [
        this._kv('Scene', `${report.scene?.name ?? '?'} (${report.scene?.scenePx?.w ?? '?'}x${report.scene?.scenePx?.h ?? '?'})`),
        this._kv('Megapixels', `${Number(report.scene?.sceneMp ?? 0).toFixed(1)} MP`),
        this._kv('Zoom', `${Number(report.scene?.zoom ?? 0).toFixed(3)}`),
        this._kv('Zoom LOD', `target ${report.scene?.zoomLod ?? '?'}, active ${report.streaming?.lastStreamLod ?? '?'}${report.streaming?.isPanning ? ' (panning)' : ''}`),
        this._kv('View textured cells', String(report.view?.visibleCellsInFrustum ?? 0)),
        this._kv('View padding', String(report.view?.padding ?? '?')),
      ].join('');
      sections.push(this._sectionHtml('Scene / View', sceneLines));

      const budget = report.budget ?? {};
      const budgetLines = [
        this._kv('VRAM', `${budget.usedMB ?? '?'} / ${budget.budgetMB ?? '?'} MB (${budget.usedPct ?? '?'}%)${budget.overBudget ? ' OVER' : ''}`),
        this._kv('Entries', String(budget.entryCount ?? 0)),
        this._kv('Cell size', `${budget.cellSize ?? '?'} px`),
        this._kv('Max LOD', String(budget.maxLod ?? '?')),
        this._kv('Background max', String(budget.backgroundMaxSize ?? '?')),
        this._kv('Tile albedo max', String(budget.tileAlbedoMaxSize ?? '?')),
        this._kv('Downscale', String(budget.downscale ?? '?')),
      ].join('');
      sections.push(this._sectionHtml('VRAM Budget', budgetLines, {
        tone: budget.overBudget ? 'warn' : 'ok',
      }));

      // Memory governor: software budget vs live GPU textures, self-adjusting
      // headroom, crash-adaptive degradation, and per-frame GPU work pacing.
      try {
        const gov = getGpuWorkScheduler();
        const ctrl = getAdaptiveBudgetController();
        const tracker = getTextureBudgetTracker();
        const govStats = gov.getStats();
        const adaptive = ctrl.getState();
        const live = adaptive.liveTextureCount || (window.MapShine?.renderer?.info?.memory?.textures ?? 0);
        const cooldownMs = Math.round(gov.lod0CooldownRemainingMs());
        const govLines = [
          this._kv('Live GPU textures', `${live} (peak ${adaptive.peakTextureCount ?? 0})`),
          this._kv('Software budget', `policy ${tracker.getPolicyBudgetMB?.() ?? '?'} MB + bonus ${adaptive.adaptiveBonusMB ?? 0} MB`),
          this._kv('Downscale', tracker.isDownscaleEngaged?.() ? 'engaged (0.5)' : 'off (1.0)'),
          this._kv('Degradation', `level ${adaptive.degradationLevel ?? 0} (crashes ${adaptive.crashCount ?? 0})`),
          this._kv('Throttle', `level ${govStats.throttleLevel ?? 0}`),
          this._kv('Upload credit', `${gov.getBaseFrameCreditMb()} MB/frame`),
          this._kv('Work last frame', `${govStats.committedLastFrame ?? 0} done / ${govStats.deferredLastFrame ?? 0} deferred`),
          this._kv('Focal LOD-0 sharpen', gov.focalSharpenEnabled === false ? 'disabled' : 'enabled'),
          this._kv('LOD-0 cooldown', cooldownMs > 0 ? `${(cooldownMs / 1000).toFixed(1)}s` : 'none'),
        ].join('');
        sections.push(this._sectionHtml('Memory Governor', govLines, {
          tone: (adaptive.degradationLevel ?? 0) > 0 ? 'warn' : 'ok',
        }));
      } catch (_) {}

      const mgr = report.streaming ?? {};
      const pool = mgr.decodePool ?? {};
      const gridTotals = [
        this._kv('Manager', mgr.managerEnabled ? 'enabled' : 'DISABLED'),
        this._kv('Focal LOD', String(mgr.focalLod ?? '?')),
        this._kv('Detail tier', String(mgr.detailTier ?? '?')),
        this._kv('Panning', mgr.isPanning ? 'yes' : 'no'),
        this._kv('Background grids', String(mgr.backgroundGridCount ?? 0)),
        this._kv('Region grids', String(mgr.regionGridCount ?? 0)),
        this._kv('Bus streaming tiles', String(mgr.busStreamingTiles?.length ?? 0)),
        this._kv('Decode workers', pool.enabled ? `${pool.activeRequests ?? 0} active / q=${pool.queueDepth ?? 0} (${pool.poolSize ?? 0} workers)` : 'legacy main-thread'),
      ].join('');
      sections.push(this._sectionHtml('Grid Totals', gridTotals));

      const bakeEntries = Object.entries(mgr.bakeProgress ?? {});
      if (bakeEntries.length) {
        const bakeLines = bakeEntries.map(([key, p]) => {
          const pct = Math.round((p.fraction ?? 0) * 100);
          return this._kv(key, `${p.done ?? 0}/${p.total ?? 0} (${pct}%)`);
        }).join('');
        sections.push(this._sectionHtml('Pyramid Bake', bakeLines));
      }

      for (const g of mgr.backgroundGrids ?? []) {
        const cs = g.cellSummary ?? {};
        const gridBody = [
          this._kv('Floor', String(g.floorIndex ?? '?')),
          this._kv('Mounted', g.mounted ? 'yes' : 'NO'),
          this._kv('Eff LOD', String(g.effectiveServedLod ?? g.servedLodRaw ?? '?')),
          this._kv('Cells', `${cs.total ?? 0} total, ${cs.visible ?? 0} vis, ${cs.withTexture ?? 0} tex`),
          this._kv('States', `hi=${cs.residentHi ?? 0} lo=${cs.residentLo ?? 0} load=${cs.loading ?? 0} culled=${cs.culled ?? 0}`),
          this._kv('Inflight', String(g.inflightCount ?? 0)),
          g.coarseBaseReady ? this._kv('Coarse base', 'ready') : this._kv('Coarse base', 'pending'),
          g.fallbackMesh
            ? this._kv('Fallback', `vis=${g.fallbackMesh.visible} ${g.fallbackMesh.w}x${g.fallbackMesh.h}`)
            : '',
          g.fallbackCellCount ? this._kv('Coarse fallback cells', String(g.fallbackCellCount)) : '',
        ].filter(Boolean).join('');
        const tone = (!g.mounted || (cs.total > 0 && cs.withTexture === 0)) ? 'warn' : 'ok';
        sections.push(this._sectionHtml(`Background [${g.key ?? '?'}]`, gridBody, { tone }));
      }

      for (const g of mgr.regionGrids ?? []) {
        const cs = g.cellSummary ?? {};
        const gridBody = [
          this._kv('Floor', String(g.floorIndex ?? '?')),
          this._kv('Z', String(g.z ?? '?')),
          this._kv('Cells', `${cs.total ?? 0} total, ${cs.visible ?? 0} vis, ${cs.withTexture ?? 0} tex`),
          this._kv('Inflight', String(g.inflightCount ?? 0)),
        ].join('');
        const tone = (cs.total > 0 && cs.withTexture === 0) ? 'warn' : 'ok';
        sections.push(this._sectionHtml(`Region [${g.key ?? '?'}]`, gridBody, { tone }));
      }
    }

    if (live) {
      const liveExtra = [
        this._kv('Budget reason', String(live.budgetReason ?? '?')),
        live.viewPct ? this._kv('View UV span', live.viewPct) : '',
        live.deviceMem ? this._kv('Device RAM', live.deviceMem) : '',
        live.sceneMp ? this._kv('Scene MP (live)', live.sceneMp) : '',
      ].filter(Boolean).join('');
      if (liveExtra) sections.push(this._sectionHtml('Live Budget', liveExtra));
    }

    const populate = buildCompositorPopulateSnapshot();
    const bus = report?.bus ?? {};
    const busLines = [
      this._kv('Visible max floor', String(bus.visibleMaxFloorIndex ?? '?')),
      this._kv('Bus tile count', String(bus.tileCount ?? populate.busTileCount ?? '?')),
      this._kv('BG solid visible', String(bus.bgSolidVisible ?? '?')),
      this._kv('Populate complete', populate.populateComplete ? 'yes' : 'no'),
      this._kv('Populate in flight', populate.populateInFlight ? 'YES' : 'no'),
      this._kv('Bus populated', populate.busPopulated ? 'yes' : 'no'),
      this._kv('Pending bg jobs', String(populate.pendingBackgroundJobs ?? 0)),
      this._kv('Coordinator', String(populate.coordinatorState ?? '?')),
      this._kv('Scene loading', populate.sceneLoading ? 'YES' : 'no'),
    ].join('');
    sections.push(this._sectionHtml('Bus / Populate', busLines, {
      tone: (populate.populateInFlight || populate.sceneLoading) ? 'warn' : 'ok',
    }));

    const legendItems = Object.entries(STATE_COLORS).map(([state, color]) => {
      const label = STATE_LABELS[state] ?? state;
      return `<span style="display:inline-flex;align-items:center;gap:3px;margin-right:8px;margin-bottom:2px;">
        <span style="display:inline-block;width:8px;height:8px;border-radius:2px;background:${color};"></span>${escapeHtml(label)}
      </span>`;
    }).join('');
    sections.push(this._sectionHtml('Legend', `<div style="display:flex;flex-wrap:wrap;">${legendItems}</div>`));

    if (report?.generatedAt) {
      sections.push(`<div style="opacity:0.55;font-size:9px;padding:2px 0;">Report ${escapeHtml(report.generatedAt)}</div>`);
    }

    el.innerHTML = sections.join('');
  }

  /** Apply a report object from an external caller (e.g. Quick Actions). @param {object} report */
  applyExternalReport(report) {
    if (!report) return;
    this._cachedReport = report;
    this._lastReportAt = performance.now();
    if (this._enabled) {
      this._renderDashboard(report, this._lastDebug);
    }
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
      const regionGrids = manager.getRegionGrids?.() ?? new Map();
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
      ctx.fillRect(margin, margin, 88, 14);
      ctx.fillStyle = '#f8fafc';
      ctx.font = '10px sans-serif';
      ctx.fillText(`g${grids.size} r${regionGrids.size} c${visibleCellCount}`, margin + 4, margin + 10);

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
      const deviceMem = Number(navigator?.deviceMemory) || 0;
      const mp = estimateSceneMegapixels();
      const budgetReason = budget.budgetReason || 'default';
      const zoom = Number(window.MapShine?.sceneComposer?.currentZoom) || 1;
      const zoomLod = selectLodFromZoom(zoom, budget.getMaxLodLevel(), mp);

      const viewPct = streamView && uv
        ? `${((uv.uMax - uv.uMin) * 100).toFixed(0)}x${((uv.vMax - uv.vMin) * 100).toFixed(0)}%`
        : null;

      this._lastDebug = {
        enabled: this._enabled,
        meta,
        sceneWorld,
        scale,
        grids: grids.size,
        regionGrids: regionGrids.size,
        streamedCellCount,
        visibleCellCount,
        hasView: !!streamView,
        hasCameraView: !!cameraView,
        cellSize,
        budgetReason,
        viewPct,
        deviceMem: deviceMem > 0 ? `~${deviceMem} GB` : null,
        sceneMp: mp > 0 ? `${mp.toFixed(1)} MP` : null,
        zoom,
        zoomLod,
        overBudget: !!bs.overBudget,
        budgetUsedMb: (bs.usedBytes / 1024 / 1024).toFixed(0),
        budgetTotalMb: (bs.budgetBytes / 1024 / 1024).toFixed(0),
      };

      this._maybeRefreshReport(this._lastDebug);
    } catch (err) {
      const errText = String(err?.message ?? err ?? 'unknown');
      this._lastDebug = { error: errText, enabled: this._enabled };
      log.warn('StreamingMinimap update failed', err);
      this._renderDashboard(this._cachedReport, this._lastDebug);
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
    this._dashboardEl = null;
    this._overviewCanvas = null;
    this._overviewKey = '';
    this._overviewLoad = null;
    this._lastDebug = null;
    this._cachedReport = null;
    this._lastReportAt = 0;
    this._lastDashboardRenderAt = 0;
    this._dragInstalled = false;
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
      return mm.isEnabled();
    };
  }
  return mm;
}
