/**
 * @fileoverview Performance Recorder Dialog
 *
 * Custom DOM overlay (no Tweakpane, no Foundry Application) modeled on
 * `CameraPanelManager`. Provides Start/Stop/Reset/Export controls and a live
 * sortable per-effect table backed by `PerformanceRecorder.getSnapshot()`.
 *
 * @module ui/performance-recorder-dialog
 */

import {
  CLEAN_TEST_DEFAULTS,
  runCleanPerfTest,
} from '../core/diagnostics/performance-recorder-clean-test.js';
import { groupEffectRows } from '../core/diagnostics/performance-recorder-export.js';
import { createLogger } from '../core/log.js';

const log = createLogger('PerfRecorderDialog');
const DEFAULT_SORT_KEY = 'cost';
const DEFAULT_SORT_DIR = 'desc';

const TABLE_COLUMNS = Object.freeze([
  { key: 'effect',        label: 'Effect',        type: 'string' },
  { key: 'phase',         label: 'Phase',         type: 'string' },
  { key: 'cost',          label: 'Cost (ms)',     type: 'number', tip: 'CPU avg + GPU avg per call' },
  { key: 'cpuAvg',        label: 'CPU avg',       type: 'number' },
  { key: 'cpuMax',        label: 'CPU max',       type: 'number' },
  { key: 'cpuLast',       label: 'CPU last',      type: 'number' },
  { key: 'gpuAvg',        label: 'GPU avg',       type: 'number' },
  { key: 'gpuMax',        label: 'GPU max',       type: 'number' },
  { key: 'gpuLast',       label: 'GPU last',      type: 'number' },
  { key: 'drawCallsAvg',  label: 'Draws/call',    type: 'number' },
  { key: 'trianglesAvg',  label: 'Tris/call',     type: 'number' },
  { key: 'cpuCount',      label: 'Calls',         type: 'number' },
  { key: 'cpuTotal',      label: 'CPU total',     type: 'number' },
]);

/**
 * @param {number} v
 * @param {number} [digits]
 */
function fmt(v, digits = 3) {
  if (!Number.isFinite(v)) return '0';
  if (Math.abs(v) >= 1000) return v.toFixed(0);
  return v.toFixed(digits);
}

/**
 * @param {number} v
 */
function fmtInt(v) {
  if (!Number.isFinite(v)) return '0';
  return Math.round(v).toString();
}

/**
 * @param {string} value
 */
function escapeHtml(value) {
  const s = String(value ?? '');
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export class PerformanceRecorderDialog {
  /**
   * @param {import('../core/diagnostics/PerformanceRecorder.js').PerformanceRecorder} recorder
   */
  constructor(recorder) {
    /** @type {import('../core/diagnostics/PerformanceRecorder.js').PerformanceRecorder} */
    this.recorder = recorder;
    /** @type {HTMLElement|null} */
    this.container = null;
    /** @type {boolean} */
    this.visible = false;

    /** @type {number} */
    this._refreshTimer = 0;

    /** @type {string} */
    this._sortKey = DEFAULT_SORT_KEY;
    /** @type {'asc'|'desc'} */
    this._sortDir = DEFAULT_SORT_DIR;

    /** @type {boolean} Detail expansion for session summary. */
    this._expandSummary = false;

    /** @type {boolean} Detail expansion for stutter timeline. */
    this._expandStutter = false;

    /** @type {boolean} Roll up dotted effect keys in the table. */
    this._groupByPrefix = false;

    /** @type {boolean} Clean 10s test mode in progress. */
    this._cleanTestRunning = false;

    /** @type {AbortController|null} */
    this._cleanTestAbort = null;
  }

  /**
   * Build DOM and append to parent. Idempotent.
   * @param {HTMLElement} [parentElement]
   */
  initialize(parentElement = document.body) {
    if (this.container) return;

    const container = document.createElement('div');
    container.id = 'map-shine-performance-recorder';
    container.className = 'map-shine-performance-recorder map-shine-overlay-ui';
    container.style.display = 'none';

    container.innerHTML = `
      <div class="msa-perf__header" data-drag-handle>
        <div class="msa-perf__title">Performance Recorder</div>
        <div class="msa-perf__capability" data-bind="capability">…</div>
        <button type="button" class="msa-perf__close" data-action="close" aria-label="Close">×</button>
      </div>

      <div class="msa-perf__controls">
        <button type="button" data-action="start" class="msa-perf__btn msa-perf__btn--primary">Start</button>
        <button type="button" data-action="stop"  class="msa-perf__btn msa-perf__btn--warn" disabled>Stop</button>
        <button type="button" data-action="clean-test-10s" class="msa-perf__btn" title="Hide all MSA UI, settle 1s, record 10s, settle 1s, restore UI">10s Clean Test</button>
        <button type="button" data-action="reset" class="msa-perf__btn">Reset</button>
        <span class="msa-perf__spacer"></span>
        <label class="msa-perf__check" title="Toggle WebGL2 GPU timer queries">
          <input type="checkbox" data-input="gpuTiming" checked>
          GPU timing
        </label>
        <button type="button" data-action="export-json" class="msa-perf__btn" title="Grouped effects, insights, stutter summary — no frame/tick timelines">Export JSON</button>
        <button type="button" data-action="export-json-full" class="msa-perf__btn" title="Full frames[], ticks[], and per-span effects for deep debugging">Export full JSON</button>
        <button type="button" data-action="export-csv"  class="msa-perf__btn">Export CSV</button>
        <button type="button" data-action="export-md"   class="msa-perf__btn">Export Markdown</button>
        <button type="button" data-action="copy-report" class="msa-perf__btn">Copy report</button>
      </div>

      <div class="msa-perf__status">
        <div class="msa-perf__status-row">
          <span class="msa-perf__status-label">State</span>
          <span class="msa-perf__status-value" data-bind="state">idle</span>
        </div>
        <div class="msa-perf__status-row">
          <span class="msa-perf__status-label">Duration</span>
          <span class="msa-perf__status-value" data-bind="duration">0.00s</span>
        </div>
        <div class="msa-perf__status-row">
          <span class="msa-perf__status-label">Frames</span>
          <span class="msa-perf__status-value" data-bind="frames">0</span>
        </div>
        <div class="msa-perf__status-row">
          <span class="msa-perf__status-label">FPS (avg/p95-low)</span>
          <span class="msa-perf__status-value" data-bind="fps">0 / 0</span>
        </div>
        <div class="msa-perf__status-row">
          <span class="msa-perf__status-label">Frame (avg/p95)</span>
          <span class="msa-perf__status-value" data-bind="frameTime">0 / 0 ms</span>
        </div>
        <div class="msa-perf__status-row">
          <span class="msa-perf__status-label">Continuous</span>
          <span class="msa-perf__status-value" data-bind="continuous">none</span>
        </div>
        <div class="msa-perf__status-row">
          <span class="msa-perf__status-label">Presents / gated</span>
          <span class="msa-perf__status-value" data-bind="pacing">—</span>
        </div>
        <div class="msa-perf__status-row">
          <span class="msa-perf__status-label">Pacing health</span>
          <span class="msa-perf__status-value" data-bind="pacingHealth">—</span>
        </div>
        <div class="msa-perf__status-row">
          <span class="msa-perf__status-label">Target FPS</span>
          <span class="msa-perf__status-value" data-bind="targetFps">—</span>
        </div>
        <div class="msa-perf__status-row">
          <span class="msa-perf__status-label">Decimation</span>
          <span class="msa-perf__status-value" data-bind="decimation">0%</span>
        </div>
        <div class="msa-perf__status-row">
          <span class="msa-perf__status-label">Draws/Tris per frame</span>
          <span class="msa-perf__status-value" data-bind="drawsPerFrame">0 / 0</span>
        </div>
        <div class="msa-perf__status-row">
          <span class="msa-perf__status-label">GPU disjoints / pool starv.</span>
          <span class="msa-perf__status-value" data-bind="gpuDiag">0 / 0</span>
        </div>
        <div class="msa-perf__status-row">
          <span class="msa-perf__status-label">Stutters</span>
          <span class="msa-perf__status-value" data-bind="stutters">—</span>
        </div>
        <div class="msa-perf__status-row">
          <span class="msa-perf__status-label">Present p95</span>
          <span class="msa-perf__status-value" data-bind="presentP95">—</span>
        </div>
        <div class="msa-perf__status-row">
          <span class="msa-perf__status-label">Over-budget ticks</span>
          <span class="msa-perf__status-value" data-bind="overBudget">—</span>
        </div>
      </div>

      <div class="msa-perf__findings" data-bind="findings" hidden></div>

      <div class="msa-perf__table-toolbar">
        <label class="msa-perf__check" title="Roll up dotted spans (e.g. cloud.update.* → cloud.update)">
          <input type="checkbox" data-input="groupByPrefix">
          Group by prefix
        </label>
      </div>

      <div class="msa-perf__table-wrap">
        <table class="msa-perf__table">
          <thead>
            <tr data-bind="table-head"></tr>
          </thead>
          <tbody data-bind="table-body">
            <tr><td class="msa-perf__empty" colspan="13">No samples yet — click Start, then exercise the scene.</td></tr>
          </tbody>
        </table>
      </div>

      <div class="msa-perf__stutter">
        <div class="msa-perf__stutter-header" data-action="toggle-stutter">
          <span class="msa-perf__chevron" data-bind="stutter-chevron">▶</span>
          Stutter timeline
        </div>
        <div class="msa-perf__stutter-body" data-bind="stutter-body" hidden></div>
      </div>

      <div class="msa-perf__summary">
        <div class="msa-perf__summary-header" data-action="toggle-summary">
          <span class="msa-perf__chevron" data-bind="summary-chevron">▶</span>
          Session summary, updatables, Sequencer, pass timings &amp; VRAM
        </div>
        <div class="msa-perf__summary-body" data-bind="summary-body" hidden></div>
      </div>

      <div class="msa-perf__hint">
        Tip: Expand <strong>Stutter timeline</strong> for idle hitch diagnosis. See <code>docs/performance-recorder.md</code> for rAF gaps, long tasks, and cache stats.
      </div>
    `;

    parentElement.appendChild(container);
    this.container = container;

    this._renderTableHead();
    this._bindEvents();
    try {
      this._refresh();
    } catch (err) {
      log.warn('Performance recorder dialog initial refresh failed:', err);
    }

    log.info('Performance recorder dialog initialized');
  }

  /**
   * Lazily create or recover the dialog when MapShine lost the reference after a
   * partial init (e.g. refresh threw before canvas-replacement assigned globals).
   * @returns {PerformanceRecorderDialog|null}
   */
  static ensureAvailable() {
    try {
      const existing = window.MapShine?.performanceRecorderDialog;
      if (existing?.container?.isConnected) return existing;

      const recorder = window.MapShine?.performanceRecorder;
      if (!recorder) return null;

      const dlg = new PerformanceRecorderDialog(recorder);
      dlg.initialize();
      if (window.MapShine) window.MapShine.performanceRecorderDialog = dlg;
      return dlg.container ? dlg : null;
    } catch (err) {
      log.warn('Performance recorder dialog ensureAvailable failed:', err);
      return null;
    }
  }

  show() {
    if (!this.container) this.initialize();
    if (!this.container) return;
    this.container.style.display = 'flex';
    this.visible = true;
    try {
      this._refresh();
    } catch (err) {
      log.warn('Performance recorder dialog refresh failed:', err);
    }
    this._startRefreshLoop();
  }

  hide() {
    if (!this.container) return;
    this.container.style.display = 'none';
    this.visible = false;
    this._stopRefreshLoop();
  }

  toggle() {
    const domShown = this.container
      && this.container.isConnected
      && this.container.style.display !== 'none';
    if (domShown) this.hide();
    else this.show();
  }

  destroy() {
    this._cancelCleanTest();
    this._stopRefreshLoop();
    if (this.container) {
      try { this.container.remove(); } catch (_) {}
    }
    this.container = null;
    this.visible = false;
  }

  // ────────────────────────────────────────────────────────────────────────
  // Event wiring
  // ────────────────────────────────────────────────────────────────────────

  /** @private */
  _bindEvents() {
    const root = this.container;
    if (!root) return;

    const stop = (e) => { try { e.stopPropagation(); } catch (_) {} };
    for (const type of ['pointerdown', 'mousedown', 'click', 'dblclick', 'keydown']) {
      root.addEventListener(type, stop);
    }
    root.addEventListener('wheel', stop, { passive: true });
    root.addEventListener('contextmenu', (e) => {
      try { e.preventDefault(); } catch (_) {}
      stop(e);
    });

    root.addEventListener('click', (event) => {
      const actionEl = event.target?.closest?.('[data-action]');
      if (!actionEl) return;
      switch (actionEl.dataset.action) {
        case 'close':
          this.hide();
          break;
        case 'start':
          this._onStart();
          break;
        case 'stop':
          this._onStop();
          break;
        case 'clean-test-10s':
          void this._onCleanTest10s();
          break;
        case 'reset':
          this._onReset();
          break;
        case 'export-json':
          this._onExportJson('summary');
          break;
        case 'export-json-full':
          this._onExportJson('full');
          break;
        case 'export-csv':
          this._onExportCsv();
          break;
        case 'export-md':
          this._onExportMarkdown();
          break;
        case 'copy-report':
          this._onCopyReport();
          break;
        case 'toggle-summary':
          this._toggleSummary();
          break;
        case 'toggle-stutter':
          this._toggleStutter();
          break;
        case 'copy-stutter-event':
          this._onCopyStutterEvent(actionEl);
          break;
      }
    });

    root.addEventListener('change', (event) => {
      const input = event.target?.closest?.('[data-input]');
      if (!input) return;
      if (input.dataset.input === 'gpuTiming') {
        this.recorder.setGpuTimingEnabled(!!input.checked);
        this._refresh();
      }
      if (input.dataset.input === 'groupByPrefix') {
        this._groupByPrefix = !!input.checked;
        this._refresh();
      }
    });

    // Sort-header clicks
    root.addEventListener('click', (event) => {
      const th = event.target?.closest?.('th[data-sort-key]');
      if (!th) return;
      const key = th.dataset.sortKey;
      if (!key) return;
      if (this._sortKey === key) {
        this._sortDir = this._sortDir === 'desc' ? 'asc' : 'desc';
      } else {
        this._sortKey = key;
        this._sortDir = 'desc';
      }
      this._renderTableHead();
      this._refresh();
    });

    this._installDrag();
  }

  /** @private */
  _installDrag() {
    const root = this.container;
    const handle = root?.querySelector('[data-drag-handle]');
    if (!root || !handle) return;

    let dragging = false;
    let startX = 0;
    let startY = 0;
    let baseLeft = 0;
    let baseTop = 0;

    const onMove = (ev) => {
      if (!dragging) return;
      const dx = ev.clientX - startX;
      const dy = ev.clientY - startY;
      root.style.left = `${baseLeft + dx}px`;
      root.style.top = `${baseTop + dy}px`;
      root.style.right = 'auto';
      root.style.bottom = 'auto';
    };
    const onUp = () => {
      dragging = false;
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onUp);
    };
    handle.addEventListener('pointerdown', (ev) => {
      if (ev.target?.closest?.('button')) return;
      dragging = true;
      const rect = root.getBoundingClientRect();
      startX = ev.clientX;
      startY = ev.clientY;
      baseLeft = rect.left;
      baseTop = rect.top;
      document.addEventListener('pointermove', onMove);
      document.addEventListener('pointerup', onUp);
      try { ev.preventDefault(); } catch (_) {}
    });
  }

  // ────────────────────────────────────────────────────────────────────────
  // Actions
  // ────────────────────────────────────────────────────────────────────────

  /** @private */
  _onStart() {
    try {
      const gpuCheckbox = this.container?.querySelector('input[data-input="gpuTiming"]');
      const gpuTiming = gpuCheckbox ? gpuCheckbox.checked : true;
      this.recorder.start({ gpuTiming });
      this._refresh();
    } catch (err) {
      log.error('start failed:', err);
      ui?.notifications?.warn?.('Performance recorder: failed to start. See console.');
    }
  }

  /** @private */
  _onStop() {
    try {
      this.recorder.stop();
      this._refresh();
    } catch (err) {
      log.error('stop failed:', err);
    }
  }

  /** @private */
  _cancelCleanTest() {
    try {
      this._cleanTestAbort?.abort?.();
    } catch (_) {}
    this._cleanTestAbort = null;
    this._cleanTestRunning = false;
  }

  /** @private */
  async _onCleanTest10s() {
    if (this._cleanTestRunning) return;
    if (this.recorder?.enabled) {
      ui?.notifications?.warn?.('Stop the current recording before starting a clean test.');
      return;
    }

    const gpuCheckbox = this.container?.querySelector('input[data-input="gpuTiming"]');
    const gpuTiming = gpuCheckbox ? gpuCheckbox.checked : true;
    const reopenRecorder = this.visible === true;

    this._cleanTestRunning = true;
    this._cleanTestAbort = new AbortController();
    this._renderControls(this.recorder.getSnapshot());

    const notify = (message, type = 'info') => {
      try {
        ui?.notifications?.[type]?.(message);
      } catch (_) {}
    };

    try {
      notify('Clean test: hiding MSA UI…');
      const { snapshot } = await runCleanPerfTest(this.recorder, {
        ...CLEAN_TEST_DEFAULTS,
        gpuTiming,
        signal: this._cleanTestAbort.signal,
        onPhase: (phase, detail) => {
          if (phase === 'settle-before') notify(`Clean test: settling ${detail ?? ''}…`);
          if (phase === 'recording') notify(`Clean test: recording ${detail ?? ''}…`);
          if (phase === 'settle-after') notify(`Clean test: finishing ${detail ?? ''}…`);
        },
      });

      const frames = Number(snapshot?.meta?.framesRecorded) || 0;
      const duration = Number(snapshot?.session?.durationSec) || 0;
      const stutters = Number(snapshot?.stutterAnalysis?.totalEvents) || 0;
      notify(
        `Clean test complete — ${frames} frames, ${duration.toFixed(1)}s, ${stutters} stutter events. UI restored.`,
      );

      if (reopenRecorder) {
        this.show();
      } else {
        try { this._refresh(); } catch (_) {}
      }
    } catch (err) {
      if (err?.name === 'AbortError' || err?.message === 'aborted') {
        notify('Clean test cancelled.', 'warn');
      } else {
        log.error('clean test failed:', err);
        notify('Clean test failed — see console.', 'error');
      }
      if (reopenRecorder) this.show();
    } finally {
      this._cancelCleanTest();
      try { this._refresh(); } catch (_) {}
    }
  }

  /** @private */
  _onExportMarkdown() {
    try {
      const { filename } = this.recorder.exportMarkdown();
      ui?.notifications?.info?.(`Exported ${filename}`);
    } catch (err) {
      log.error('export Markdown failed:', err);
      ui?.notifications?.warn?.('Performance recorder: Markdown export failed. See console.');
    }
  }

  /** @private */
  async _onCopyReport() {
    try {
      const text = this.recorder.buildMarkdownReport();
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
        ui?.notifications?.info?.('Performance report copied to clipboard');
      } else {
        const { filename } = this.recorder.exportMarkdown();
        ui?.notifications?.info?.(`Clipboard unavailable — downloaded ${filename}`);
      }
    } catch (err) {
      log.error('copy report failed:', err);
      ui?.notifications?.warn?.('Performance recorder: copy failed. See console.');
    }
  }

  /** @private */
  _onReset() {
    try {
      this.recorder.reset({ keepEnabled: this.recorder.enabled });
      this._refresh();
    } catch (err) {
      log.error('reset failed:', err);
    }
  }

  /**
   * @param {'summary'|'full'} [mode]
   * @private
   */
  _onExportJson(mode = 'summary') {
    try {
      const { filename } = this.recorder.exportJson({ mode });
      ui?.notifications?.info?.(`Exported ${filename}`);
    } catch (err) {
      log.error('export JSON failed:', err);
      ui?.notifications?.warn?.('Performance recorder: JSON export failed. See console.');
    }
  }

  /** @private */
  _onExportCsv() {
    try {
      const { filename } = this.recorder.exportCsv();
      ui?.notifications?.info?.(`Exported ${filename}`);
    } catch (err) {
      log.error('export CSV failed:', err);
      ui?.notifications?.warn?.('Performance recorder: CSV export failed. See console.');
    }
  }

  /** @private */
  _toggleStutter() {
    this._expandStutter = !this._expandStutter;
    const body = this.container?.querySelector('[data-bind="stutter-body"]');
    const chevron = this.container?.querySelector('[data-bind="stutter-chevron"]');
    if (body) body.hidden = !this._expandStutter;
    if (chevron) chevron.textContent = this._expandStutter ? '▼' : '▶';
    if (this._expandStutter) this._refresh();
  }

  /**
   * @param {HTMLElement} actionEl
   * @private
   */
  async _onCopyStutterEvent(actionEl) {
    try {
      const raw = actionEl.dataset.eventJson;
      if (!raw) return;
      const text = JSON.stringify(JSON.parse(decodeURIComponent(raw)), null, 2);
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
        ui?.notifications?.info?.('Stutter event copied to clipboard');
      }
    } catch (err) {
      log.warn('copy stutter event failed:', err);
    }
  }

  /** @private */
  _toggleSummary() {
    this._expandSummary = !this._expandSummary;
    const body = this.container?.querySelector('[data-bind="summary-body"]');
    const chevron = this.container?.querySelector('[data-bind="summary-chevron"]');
    if (body) body.hidden = !this._expandSummary;
    if (chevron) chevron.textContent = this._expandSummary ? '▼' : '▶';
    if (this._expandSummary) this._refresh();
  }

  /** @private */
  _renderStutterTimeline(snap) {
    const body = this.container?.querySelector('[data-bind="stutter-body"]');
    if (!body) return;

    const events = snap.stutterEvents ?? [];
    if (!events.length) {
      body.innerHTML = '<div class="msa-perf__stutter-empty">No stutter events exceeded thresholds in this capture.</div>';
      return;
    }

    const rows = events.map((ev) => {
      const sec = (ev.tMs / 1000).toFixed(2);
      const ms = ev.gapMs ?? ev.frameTimeMs ?? ev.tickMs ?? ev.sinceLastPresentMs ?? 0;
      const severityCls = `msa-perf__stutter-row--${ev.severity ?? 'warn'}`;
      const detailParts = [];
      if (ev.frameTimeMs != null) detailParts.push(`frame ${fmt(ev.frameTimeMs, 2)} ms`);
      if (ev.tickMs != null) detailParts.push(`tick ${fmt(ev.tickMs, 2)} ms`);
      if (ev.compositorMs != null) detailParts.push(`comp ${fmt(ev.compositorMs, 2)} ms`);
      if (ev.handlerOverheadMs != null) detailParts.push(`overhead ${fmt(ev.handlerOverheadMs, 2)} ms`);
      if (ev.continuousReason) detailParts.push(escapeHtml(ev.continuousReason));
      if (ev.topEffects?.length) {
        const tops = ev.topEffects.slice(0, 3).map((e) => `${escapeHtml(e.effect)}/${e.phase} ${fmt(e.cpuMs, 2)}ms`).join(', ');
        detailParts.push(tops);
      }
      if (ev.longTasks?.length) {
        const lt = ev.longTasks[0];
        detailParts.push(`long task ${fmt(lt.durationMs, 1)} ms${lt.name ? ` (${escapeHtml(lt.name)})` : ''}`);
      }
      const eventJson = encodeURIComponent(JSON.stringify(ev));
      return `
        <tr class="msa-perf__stutter-row ${severityCls}" data-action="copy-stutter-event" data-event-json="${eventJson}" title="Click to copy JSON snippet">
          <td>${escapeHtml(ev.kind)}</td>
          <td>${sec}s</td>
          <td class="msa-perf__num">${fmt(ms, 2)}</td>
          <td class="msa-perf__num">${ev.seq != null ? ev.seq : '—'}</td>
          <td class="msa-perf__stutter-detail">${detailParts.join(' · ') || '—'}</td>
        </tr>
      `;
    }).join('');

    body.innerHTML = `
      <p class="msa-perf__stutter-hint">Worst events first. Click a row to copy JSON for bug reports.</p>
      <table class="msa-perf__sub-table msa-perf__stutter-table">
        <thead>
          <tr>
            <th>Kind</th>
            <th>Time</th>
            <th>Ms</th>
            <th>Frame</th>
            <th>Detail</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    `;
  }

  // ────────────────────────────────────────────────────────────────────────
  // Refresh loop / render
  // ────────────────────────────────────────────────────────────────────────

  /** @private */
  _startRefreshLoop() {
    this._stopRefreshLoop();
    this._refreshTimer = setInterval(() => this._refresh(), 500);
  }

  /** @private */
  _stopRefreshLoop() {
    if (this._refreshTimer) {
      clearInterval(this._refreshTimer);
      this._refreshTimer = 0;
    }
  }

  /** @private */
  _renderTableHead() {
    const head = this.container?.querySelector('[data-bind="table-head"]');
    if (!head) return;
    const cells = TABLE_COLUMNS.map((col) => {
      const active = col.key === this._sortKey;
      const arrow = active ? (this._sortDir === 'desc' ? ' ▼' : ' ▲') : '';
      const tip = col.tip ? ` title="${escapeHtml(col.tip)}"` : '';
      return `<th data-sort-key="${col.key}" class="${active ? 'msa-perf__th--active' : ''}"${tip}>${escapeHtml(col.label)}${arrow}</th>`;
    }).join('');
    head.innerHTML = cells;
  }

  /** @private */
  _refresh() {
    if (!this.container || !this.recorder) return;
    const snap = this.recorder.getSnapshot();

    this._renderStatus(snap);
    this._renderFindings(snap);
    this._renderTable(snap);
    this._renderControls(snap);
    if (this._expandSummary) {
      this._renderSummary(snap);
    }
    if (this._expandStutter) {
      this._renderStutterTimeline(snap);
    }
  }

  /** @private */
  _renderFindings(snap) {
    const el = this.container?.querySelector('[data-bind="findings"]');
    if (!el) return;

    const insights = this.recorder.getInsights?.() ?? [];

    if (!insights.length || (snap.meta.framesRecorded ?? 0) === 0) {
      el.hidden = true;
      el.innerHTML = '';
      return;
    }

    el.hidden = false;
    const items = insights.map((i) => {
      const cls = `msa-perf__finding msa-perf__finding--${i.severity}`;
      return `<div class="${cls}"><strong>${escapeHtml(i.title)}</strong><span>${escapeHtml(i.detail)}</span></div>`;
    }).join('');
    el.innerHTML = `<div class="msa-perf__findings-title">Key findings</div>${items}`;
  }

  /** @private */
  _renderStatus(snap) {
    const set = (key, value) => {
      const el = this.container?.querySelector(`[data-bind="${key}"]`);
      if (el) el.textContent = value;
    };

    const gpu = snap.meta?.gpuTiming ?? { supported: false, enabled: false };
    const capabilityText = gpu.supported
      ? (gpu.enabled ? 'GPU timing: ON' : 'GPU timing: OFF (CPU + draws only)')
      : 'GPU timing: unsupported (CPU + draws only)';
    set('capability', capabilityText);

    set('state', this.recorder.enabled ? 'RECORDING' : 'idle');
    set('duration', `${(snap.meta.durationMs / 1000).toFixed(2)}s`);
    set('frames', `${snap.meta.framesRecorded} (buffered ${snap.meta.framesBuffered})`);
    set('fps', `${fmt(snap.session.fps.avg, 1)} avg / ${fmt(snap.session.fps.p05, 1)} low5%`);
    set('frameTime', `${fmt(snap.session.frameTime.avg, 2)} / ${fmt(snap.session.frameTime.p95, 2)} ms`);

    const reasons = snap.session.continuousReasons || {};
    const totalReasonFrames = Object.values(reasons).reduce((s, v) => s + v, 0);
    let topReason = 'none';
    let topReasonShare = 0;
    for (const [k, v] of Object.entries(reasons)) {
      const share = totalReasonFrames > 0 ? v / totalReasonFrames : 0;
      if (k !== 'none' && share > topReasonShare) {
        topReason = k;
        topReasonShare = share;
      }
    }
    const noneShare = totalReasonFrames > 0 ? (reasons.none || 0) / totalReasonFrames : 0;
    set('continuous', topReasonShare > 0
      ? `${topReason} (${(topReasonShare * 100).toFixed(0)}%, idle ${(noneShare * 100).toFixed(0)}%)`
      : `idle ${(noneShare * 100).toFixed(0)}%`);

    const pacing = snap.session.pacing || {};
    const pa = snap.pacingAnalysis;
    if (pacing.ticksRecorded > 0) {
      const gatePct = pa?.skip?.byReason?.presentation_gate?.pct
        ?? pacing.skipReasons?.presentation_gate
          ? ((pacing.skipReasons.presentation_gate / pacing.ticksRecorded) * 100)
          : null;
      const gateTxt = gatePct != null ? `, ${fmt(gatePct, 0)}% gate` : '';
      const presentsFps = pa?.presentedFpsApprox;
      const presentsTxt = presentsFps != null ? ` (~${fmt(presentsFps, 0)} presents/s)` : '';
      set('pacing', `${fmt(pacing.presentedPct, 0)}% present / ${fmt(pacing.skippedPct, 0)}% gated${gateTxt}${presentsTxt}`);
    } else {
      set('pacing', '—');
    }

    if (pa?.diagnosis && pa.diagnosis !== 'insufficient_data') {
      const label = {
        healthy_intentional_gating: 'healthy (intentional gate)',
        irregular_present_spacing: 'irregular presents',
        unexpected_skips: 'unexpected skips',
        mixed_tiers: 'mixed tiers',
      }[pa.diagnosis] ?? pa.diagnosis;
      const delta = pa.skipDelta != null ? ` Δ${pa.skipDelta >= 0 ? '+' : ''}${fmt(pa.skipDelta, 0)}%` : '';
      set('pacingHealth', `${label}${delta}`);
    } else {
      set('pacingHealth', '—');
    }
    try {
      const ps = window.MapShine?.__presentationState;
      set('targetFps', ps?.targetFps ? `${fmt(ps.targetFps, 0)} (${ps.tier || '?'})` : '—');
    } catch (_) {
      set('targetFps', '—');
    }
    set('decimation', `${fmt(snap.session.decimationActivePct, 1)}%`);
    set('drawsPerFrame', `${fmtInt(snap.session.avgDrawCallsPerFrame)} / ${fmtInt(snap.session.avgTrianglesPerFrame)}`);
    set('gpuDiag', `${snap.meta.gpuDisjointEvents} / ${snap.meta.gpuPoolStarvations}`);

    const stutterCounts = snap.stutterSummary?.countsByKind ?? {};
    const rafGap = stutterCounts.raf_gap ?? 0;
    const compositorSpike = stutterCounts.compositor_spike ?? 0;
    const freeze = stutterCounts.freeze ?? 0;
    const presentGap = stutterCounts.present_gap ?? 0;
    const tickOver = stutterCounts.tick_overbudget ?? 0;
    const stutterParts = [];
    if (rafGap) stutterParts.push(`raf ${rafGap}`);
    if (compositorSpike) stutterParts.push(`comp ${compositorSpike}`);
    if (freeze) stutterParts.push(`freeze ${freeze}`);
    if (presentGap) stutterParts.push(`present ${presentGap}`);
    if (tickOver) stutterParts.push(`tick ${tickOver}`);
    set('stutters', stutterParts.length ? stutterParts.join(' · ') : 'none');

    const presentP95 = snap.stutterSummary?.sinceLastPresentMs?.p95 ?? 0;
    set('presentP95', presentP95 > 0 ? `${fmt(presentP95, 2)} ms` : '—');

    const overPct = snap.session?.pacing?.overBudgetPresentPct ?? 0;
    set('overBudget', pacing.ticksRecorded > 0 ? `${fmt(overPct, 1)}%` : '—');

    const cap = this.container?.querySelector('[data-bind="capability"]');
    if (cap) {
      cap.classList.toggle('msa-perf__capability--ok', gpu.supported && gpu.enabled);
      cap.classList.toggle('msa-perf__capability--off', !(gpu.supported && gpu.enabled));
    }
  }

  /** @private */
  _renderTable(snap) {
    const body = this.container?.querySelector('[data-bind="table-body"]');
    if (!body) return;

    const groupCheckbox = this.container?.querySelector('input[data-input="groupByPrefix"]');
    if (groupCheckbox) groupCheckbox.checked = this._groupByPrefix;

    const sourceRows = this._groupByPrefix
      ? groupEffectRows(snap.effects)
      : (snap.effects || []);

    const rows = sourceRows.map((r) => ({
      ...r,
      cost: r.cost ?? (r.cpuAvg + r.gpuAvg),
    }));

    if (rows.length === 0) {
      body.innerHTML = `<tr><td class="msa-perf__empty" colspan="${TABLE_COLUMNS.length}">No samples yet — click Start, then exercise the scene.</td></tr>`;
      return;
    }

    const key = this._sortKey;
    const dir = this._sortDir === 'desc' ? -1 : 1;
    const col = TABLE_COLUMNS.find((c) => c.key === key) || { type: 'number' };
    rows.sort((a, b) => {
      const av = a[key];
      const bv = b[key];
      if (col.type === 'string') {
        return (String(av).localeCompare(String(bv))) * dir;
      }
      const an = Number(av) || 0;
      const bn = Number(bv) || 0;
      return (an - bn) * dir;
    });

    // Highlight top 5 by cost
    const sortedByCost = rows.slice().sort((a, b) => b.cost - a.cost);
    const topSet = new Set(sortedByCost.slice(0, 5).map((r) => `${r.effect}/${r.phase}`));

    let html = '';
    for (const r of rows) {
      const id = `${r.effect}/${r.phase}`;
      const cls = topSet.has(id) ? 'msa-perf__row msa-perf__row--top' : 'msa-perf__row';
      html += `<tr class="${cls}">`;
      html += `<td>${escapeHtml(r.effect)}</td>`;
      html += `<td>${escapeHtml(r.phase)}</td>`;
      html += `<td class="msa-perf__num">${fmt(r.cost)}</td>`;
      html += `<td class="msa-perf__num">${fmt(r.cpuAvg)}</td>`;
      html += `<td class="msa-perf__num">${fmt(r.cpuMax)}</td>`;
      html += `<td class="msa-perf__num">${fmt(r.cpuLast)}</td>`;
      html += `<td class="msa-perf__num">${fmt(r.gpuAvg)}</td>`;
      html += `<td class="msa-perf__num">${fmt(r.gpuMax)}</td>`;
      html += `<td class="msa-perf__num">${fmt(r.gpuLast)}</td>`;
      html += `<td class="msa-perf__num">${fmt(r.drawCallsAvg, 1)}</td>`;
      html += `<td class="msa-perf__num">${fmtInt(r.trianglesAvg)}</td>`;
      html += `<td class="msa-perf__num">${fmtInt(r.cpuCount)}</td>`;
      html += `<td class="msa-perf__num">${fmt(r.cpuTotal, 1)}</td>`;
      html += `</tr>`;
    }
    body.innerHTML = html;
  }

  /** @private */
  _renderControls(snap) {
    const root = this.container;
    if (!root) return;

    const startBtn = root.querySelector('button[data-action="start"]');
    const stopBtn  = root.querySelector('button[data-action="stop"]');
    const cleanBtn = root.querySelector('button[data-action="clean-test-10s"]');
    const busy = this.recorder.enabled === true || this._cleanTestRunning === true;
    if (startBtn) startBtn.disabled = busy;
    if (stopBtn)  stopBtn.disabled  = this.recorder.enabled !== true || this._cleanTestRunning === true;
    if (cleanBtn) cleanBtn.disabled = busy;

    const gpuCheckbox = root.querySelector('input[data-input="gpuTiming"]');
    if (gpuCheckbox) {
      gpuCheckbox.checked = snap.meta.gpuTiming.enabled === true;
      gpuCheckbox.disabled = !snap.meta.gpuTiming.supported;
    }

    const groupCheckbox = root.querySelector('input[data-input="groupByPrefix"]');
    if (groupCheckbox) groupCheckbox.checked = this._groupByPrefix;
  }

  /**
   * @param {object} snap
   * @returns {string}
   * @private
   */
  _renderPacingSummaryHtml(snap) {
    const pa = snap.pacingAnalysis;
    const pacing = snap.session?.pacing ?? {};
    if (!pa || pa.diagnosis === 'insufficient_data') {
      return '<em>Record longer to analyze pacing.</em>';
    }

    const skipRows = Object.entries(pa.skip?.byReason ?? pacing.skipReasons ?? {})
      .filter(([k]) => k !== 'none')
      .sort((a, b) => (Number(b[1]?.count ?? b[1]) || 0) - (Number(a[1]?.count ?? a[1]) || 0))
      .map(([reason, data]) => {
        const count = Number(data?.count ?? data) || 0;
        const pct = data?.pct != null ? fmt(data.pct, 1) : fmt((count / Math.max(1, pacing.ticksRecorded)) * 100, 1);
        return `<tr><td>${escapeHtml(reason)}</td><td class="msa-perf__num">${count}</td><td class="msa-perf__num">${pct}%</td></tr>`;
      }).join('');

    const tierRows = Object.entries(pa.tiers ?? {})
      .sort((a, b) => b[1] - a[1])
      .map(([tier, pct]) => `<li>${escapeHtml(tier)}: ${fmt(pct, 1)}%</li>`)
      .join('');

    return `
      <ul class="msa-perf__inline-list">
        <li>Diagnosis: <strong>${escapeHtml(pa.diagnosis)}</strong></li>
        <li>rAF ~${fmt(pa.rafHz, 0)} Hz · target ~${fmt(pa.targetFps?.median ?? 0, 0)} fps · ~${fmt(pa.presentedFpsApprox ?? 0, 0)} presents/s</li>
        <li>Skipped ${fmt(pa.actualSkipPct ?? 0, 1)}% (expected ~${fmt(pa.expectedSkipPct ?? 0, 1)}%, Δ ${fmt(pa.skipDelta ?? 0, 1)}%)</li>
        <li>Cadence flips ${fmt(pa.presentSkipFlipsPerSec ?? 0, 1)}/s</li>
      </ul>
      ${pa.note ? `<p class="msa-perf__seq-micro">${escapeHtml(pa.note)}</p>` : ''}
      <h5 class="msa-perf__subhead">Skip reasons</h5>
      <table class="msa-perf__sub-table">
        <thead><tr><th>Reason</th><th>Ticks</th><th>%</th></tr></thead>
        <tbody>${skipRows || '<tr><td colspan="3"><em>none</em></td></tr>'}</tbody>
      </table>
      ${tierRows ? `<h5 class="msa-perf__subhead">Presentation tiers</h5><ul class="msa-perf__inline-list">${tierRows}</ul>` : ''}
    `;
  }

  /** @private */
  _renderSummary(snap) {
    const body = this.container?.querySelector('[data-bind="summary-body"]');
    if (!body) return;

    const reasons = snap.session.continuousReasons || {};
    const totalReason = Object.values(reasons).reduce((s, v) => s + v, 0);

    const reasonRows = Object.entries(reasons)
      .sort((a, b) => b[1] - a[1])
      .map(([k, v]) => {
        const pct = totalReason > 0 ? (v / totalReason) * 100 : 0;
        return `<tr><td>${escapeHtml(k)}</td><td class="msa-perf__num">${v}</td><td class="msa-perf__num">${fmt(pct, 1)}%</td></tr>`;
      }).join('');

    const updatableRows = (snap.updatables || []).slice(0, 20).map((u) => `
      <tr>
        <td>${escapeHtml(u.name)}</td>
        <td class="msa-perf__num">${fmtInt(u.count)}</td>
        <td class="msa-perf__num">${fmt(u.avgMs)}</td>
        <td class="msa-perf__num">${fmt(u.totalMs, 1)}</td>
      </tr>
    `).join('');

    const seq = snap.sequencer ?? { phases: [], mirrors: [], live: null, note: '' };

    const seqPhaseRows = (seq.phases || []).map((p) => `
      <tr>
        <td>${escapeHtml(String(p.phase ?? ''))}</td>
        <td class="msa-perf__num">${fmt(p.avgMs ?? 0)}</td>
        <td class="msa-perf__num">${fmt(p.maxMs ?? 0)}</td>
        <td class="msa-perf__num">${fmt(p.lastMs ?? 0)}</td>
        <td class="msa-perf__num">${fmtInt(p.count ?? 0)}</td>
        <td class="msa-perf__num">${fmt(p.totalMs ?? 0, 2)}</td>
      </tr>
    `).join('');

    const seqMirrorRows = (seq.mirrors || []).map((p) => `
      <tr>
        <td>${escapeHtml(String(p.textureKind ?? ''))}</td>
        <td>${escapeHtml(String(p.adapterKey ?? ''))}</td>
        <td class="msa-perf__num">${fmt(p.avgMs ?? 0)}</td>
        <td class="msa-perf__num">${fmt(p.maxMs ?? 0)}</td>
        <td class="msa-perf__num">${fmt(p.lastMs ?? 0)}</td>
        <td class="msa-perf__num">${fmtInt(p.count ?? 0)}</td>
        <td class="msa-perf__num">${fmt(p.totalMs ?? 0, 2)}</td>
      </tr>
    `).join('');

    let liveSeqHtml = '<em>No live diagnostics (external effects unloaded or sequencer adapter missing).</em>';
    try {
      if (seq.live && typeof seq.live === 'object') {
        liveSeqHtml = `<pre class="msa-perf__pre-diag">${escapeHtml(JSON.stringify(seq.live, null, 2))}</pre>`;
      }
    } catch (_) {}

    const seqExplain = seq.note
      ? `<div class="msa-perf__seq-note">${escapeHtml(seq.note)}</div>`
      : '';

    const passRows = Object.entries(snap.v2PassTimings || {})
      .sort((a, b) => (b[1]?.avg ?? 0) - (a[1]?.avg ?? 0))
      .map(([name, data]) => `
        <tr>
          <td>${escapeHtml(name)}</td>
          <td class="msa-perf__num">${fmt(data?.avg ?? 0)}</td>
          <td class="msa-perf__num">${fmt(data?.last ?? 0)}</td>
          <td class="msa-perf__num">${fmtInt(data?.count ?? 0)}</td>
          <td class="msa-perf__num">${fmt(data?.total ?? 0, 1)}</td>
        </tr>
      `).join('');

    const vram = snap.vramBudget;
    let vramHtml = '<em>no VRAM tracker</em>';
    if (vram) {
      const used = (vram.usedBytes || 0) / 1024 / 1024;
      const budget = (vram.budgetBytes || 0) / 1024 / 1024;
      const frac = (vram.usedFraction || 0) * 100;
      vramHtml = `${used.toFixed(1)} / ${budget.toFixed(0)} MB (${frac.toFixed(1)}%, ${vram.entryCount} entries, overBudget=${vram.overBudget ? 'YES' : 'no'})`;
    }

    const infoCur = snap.rendererInfo?.current;
    const rendererHtml = infoCur ? `
      <ul class="msa-perf__inline-list">
        <li>draws: ${fmtInt(infoCur.render?.calls ?? 0)}</li>
        <li>triangles: ${fmtInt(infoCur.render?.triangles ?? 0)}</li>
        <li>programs: ${fmtInt(infoCur.programs ?? 0)}</li>
        <li>geometries: ${fmtInt(infoCur.memory?.geometries ?? 0)}</li>
        <li>textures: ${fmtInt(infoCur.memory?.textures ?? 0)}</li>
      </ul>
    ` : '<em>renderer.info unavailable</em>';

    let gpuBlockedHtml = '<em>none</em>';
    let blockedSpans = 0;
    let blockedSamples = 0;
    for (const row of snap.effects ?? []) {
      const blocked = Number(row.gpuBlocked) || 0;
      const count = Number(row.cpuCount) || 0;
      if (blocked > count * 0.5 && blocked > 0) {
        blockedSpans += 1;
        blockedSamples += blocked;
      }
    }
    if (blockedSpans > 0) {
      gpuBlockedHtml = `${blockedSpans} span(s), ${blockedSamples} blocked samples — GPU totals are sampled`;
    }

    let lightingHtml = '<em>no lighting samples</em>';
    const lighting = snap.lighting;
    if (lighting) {
      const live = lighting.live ?? {};
      const counts = live.sourceCounts ?? {};
      const topSpan = (lighting.spans ?? [])[0];
      const topSpanTxt = topSpan
        ? `${escapeHtml(topSpan.span)} cpu ${fmt(topSpan.cpuTotal, 1)} gpu ${fmt(topSpan.gpuTotal, 1)}`
        : 'n/a';
      const passTxt = (lighting.passes ?? []).slice(0, 2)
        .map((p) => `${escapeHtml(p.pass)} ${fmt(p.avg, 2)}ms`)
        .join(' · ') || 'n/a';
      lightingHtml = [
        `${counts.foundryLights ?? 0} lights (${counts.visibleLights ?? 0} vis) · ${counts.foundryDarkness ?? 0} darkness`,
        live.estimatedRtVramMb != null ? `~${fmt(live.estimatedRtVramMb, 1)} MB RTs` : null,
        `top span: ${topSpanTxt}`,
        `passes: ${passTxt}`,
      ].filter(Boolean).join('<br>');
    }

    let cloudCacheHtml = '<em>cloud effect not active</em>';
    const cache = snap.cloudShadowCache;
    if (cache) {
      cloudCacheHtml = `raw ${(cache.rawHitPct ?? 0).toFixed(1)}% hit · mask ${(cache.maskHitPct ?? 0).toFixed(1)}% · cloudTop ${(cache.cloudTopHitPct ?? 0).toFixed(1)}% · last miss: ${escapeHtml(String(cache.lastMissReason ?? 'n/a'))}`;
    }

    let weatherHtml = '<em>no weather particle samples</em>';
    const weather = snap.weatherParticles;
    if (weather?.spans?.length) {
      const top = weather.spans[0];
      const live = weather.live ?? {};
      weatherHtml = [
        `top: ${escapeHtml(top.span)} cpu ${fmt(top.cpuTotal, 2)} ms`,
        `precip ${fmt(live.precipitation ?? 0, 2)} · ash ${fmt(live.ashIntensity ?? 0, 2)}`,
        `${live.batchSystems ?? 0} systems · ${live.culledSystems ?? 0} culled`,
        live.wantsContinuousRender ? 'continuous render: yes' : null,
      ].filter(Boolean).join('<br>');
    }

    let windowLightHtml = '<em>no window light samples</em>';
    const windowLight = snap.windowLight;
    if (windowLight?.spans?.length) {
      const topRender = (windowLight.spans ?? []).find((s) => s.phase === 'render') ?? windowLight.spans[0];
      const live = windowLight.live ?? {};
      const counters = live.sessionCounters ?? {};
      windowLightHtml = [
        `top render: ${escapeHtml(topRender.span)} cpu ${fmt(topRender.cpuTotal, 2)} gpu ${fmt(topRender.gpuTotal, 2)} ms`,
        live.emitRt ? `emit ${live.emitRt.w}×${live.emitRt.h} @ ${fmt(live.emitRt.scale ?? 1, 2)}` : null,
        counters.skippedFullDraws != null
          ? `cache skips ${counters.skippedFullDraws} / draws ${counters.fullDraws ?? 0}`
          : null,
      ].filter(Boolean).join('<br>');
    }

    body.innerHTML = `
      <div class="msa-perf__summary-section msa-perf__summary-span2">
        <h4>Presentation pacing</h4>
        <p class="msa-perf__seq-micro">
          <strong>Gated</strong> rAF ticks intentionally skip the compositor (<code>presentation_gate</code>) to cap present rate (idle 15 fps, continuous 30 fps, pan 60 fps).
          Present/skip <em>flips</em> are not visible hitches — check <code>present_gap</code> stutters instead.
        </p>
        <div>${this._renderPacingSummaryHtml(snap)}</div>
      </div>

      <div class="msa-perf__summary-section">
        <h4>Frame stats</h4>
        <ul class="msa-perf__inline-list">
          <li>FPS avg ${fmt(snap.session.fps.avg, 1)}, p50 ${fmt(snap.session.fps.p50, 1)}, p05 ${fmt(snap.session.fps.p05, 1)}</li>
          <li>Frame time avg ${fmt(snap.session.frameTime.avg, 2)}ms, p95 ${fmt(snap.session.frameTime.p95, 2)}ms, p99 ${fmt(snap.session.frameTime.p99, 2)}ms, max ${fmt(snap.session.frameTime.max, 2)}ms</li>
          <li>Decimation active: ${fmt(snap.session.decimationActivePct, 1)}%</li>
        </ul>
      </div>

      <div class="msa-perf__summary-section">
        <h4>Continuous-render reasons</h4>
        <table class="msa-perf__sub-table">
          <thead><tr><th>Reason</th><th>Frames</th><th>%</th></tr></thead>
          <tbody>${reasonRows || '<tr><td colspan="3"><em>no data</em></td></tr>'}</tbody>
        </table>
      </div>

      <div class="msa-perf__summary-section">
        <h4>Top updatables (EffectComposer loop)</h4>
        <table class="msa-perf__sub-table">
          <thead><tr><th>Updatable</th><th>Count</th><th>Avg ms</th><th>Total ms</th></tr></thead>
          <tbody>${updatableRows || '<tr><td colspan="4"><em>no data</em></td></tr>'}</tbody>
        </table>
      </div>

      <div class="msa-perf__summary-section msa-perf__summary-span2">
        <h4>Sequencer → Map Shine mirrors (JB2A / condition videos)</h4>
        ${seqExplain}
        <p class="msa-perf__seq-micro">
          Accumulated phases and per‑mirror CPU appear while Recording. By default mirrors sync once per FloorCompositor frame (tickBeforeFloorBus).
          Rows use prefixes <strong>sequencer ›</strong> / <strong>seqMirror ›</strong>. CSV / JSON exports include <code>sequencer-phases</code> + <code>sequencer-mirrors</code> sections.
        </p>
        <h5 class="msa-perf__subhead">Recorded phases</h5>
        <table class="msa-perf__sub-table">
          <thead><tr><th>Phase</th><th>Avg ms</th><th>Max</th><th>Last</th><th>Calls</th><th>Total ms</th></tr></thead>
          <tbody>${seqPhaseRows || '<tr><td colspan="6"><em>start recording — no samples yet</em></td></tr>'}</tbody>
        </table>
        <h5 class="msa-perf__subhead">Recorded per‑mirror syncFromPixi (tickBeforeFloorBus; legacy doubles on PIXI ticker)</h5>
        <table class="msa-perf__sub-table">
          <thead><tr><th>Kind</th><th>Mirror key</th><th>Avg ms</th><th>Max</th><th>Last</th><th>Calls</th><th>Total ms</th></tr></thead>
          <tbody>${seqMirrorRows || '<tr><td colspan="7"><em>start recording — no mirror samples yet</em></td></tr>'}</tbody>
        </table>
        <h5 class="msa-perf__subhead">Live adapter inventory</h5>
        ${liveSeqHtml}
      </div>

      <div class="msa-perf__summary-section">
        <h4>V2 pass timings (__v2PassProfiler)</h4>
        <table class="msa-perf__sub-table">
          <thead><tr><th>Pass</th><th>Avg ms</th><th>Last</th><th>Count</th><th>Total ms</th></tr></thead>
          <tbody>${passRows || '<tr><td colspan="5"><em>no data</em></td></tr>'}</tbody>
        </table>
      </div>

      <div class="msa-perf__summary-section">
        <h4>VRAM budget tracker</h4>
        <div>${vramHtml}</div>
      </div>

      <div class="msa-perf__summary-section msa-perf__summary-span2">
        <h4>Lighting system</h4>
        <p class="msa-perf__seq-micro">
          Summary JSON includes <code>lighting.spans</code> (unrolled <code>lighting.render.*</code> / <code>lighting.update.*</code>),
          <code>lighting.live</code> RT inventory, and <code>lighting.passes</code> (<code>perLevel_lighting_*</code>).
        </p>
        <div>${lightingHtml}</div>
      </div>

      <div class="msa-perf__summary-section">
        <h4>Cloud shadow cache</h4>
        <div>${cloudCacheHtml}</div>
      </div>

      <div class="msa-perf__summary-section">
        <h4>Weather particles</h4>
        <p class="msa-perf__seq-micro">Sub-spans: <code>weatherParticles.update.attach|controller|particles|cull|quarks</code></p>
        <div>${weatherHtml}</div>
      </div>

      <div class="msa-perf__summary-section">
        <h4>Window light</h4>
        <p class="msa-perf__seq-micro">Sub-spans: <code>windowLight.render.emitDraw</code>, <code>syncOcclusion</code>, <code>emitCached</code></p>
        <div>${windowLightHtml}</div>
      </div>

      <div class="msa-perf__summary-section">
        <h4>GPU timing coverage</h4>
        <div>${gpuBlockedHtml}</div>
      </div>

      <div class="msa-perf__summary-section">
        <h4>Renderer.info (current)</h4>
        ${rendererHtml}
      </div>
    `;
  }
}
