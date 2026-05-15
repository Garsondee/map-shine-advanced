/**
 * @fileoverview Performance Recorder Dialog
 *
 * Custom DOM overlay (no Tweakpane, no Foundry Application) modeled on
 * `CameraPanelManager`. Provides Start/Stop/Reset/Export controls and a live
 * sortable per-effect table backed by `PerformanceRecorder.getSnapshot()`.
 *
 * @module ui/performance-recorder-dialog
 */

import { createLogger } from '../core/log.js';

const log = createLogger('PerfRecorderDialog');

/** Default sort key (computed = cpuAvg + gpuAvg). */
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
        <button type="button" data-action="reset" class="msa-perf__btn">Reset</button>
        <span class="msa-perf__spacer"></span>
        <label class="msa-perf__check" title="Toggle WebGL2 GPU timer queries">
          <input type="checkbox" data-input="gpuTiming" checked>
          GPU timing
        </label>
        <button type="button" data-action="export-json" class="msa-perf__btn">Export JSON</button>
        <button type="button" data-action="export-csv"  class="msa-perf__btn">Export CSV</button>
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

      <div class="msa-perf__summary">
        <div class="msa-perf__summary-header" data-action="toggle-summary">
          <span class="msa-perf__chevron" data-bind="summary-chevron">▶</span>
          Session summary, updatables, pass timings &amp; VRAM
        </div>
        <div class="msa-perf__summary-body" data-bind="summary-body" hidden></div>
      </div>

      <div class="msa-perf__hint">
        Tip: Run typical activity (idle, pan/zoom, weather, multiple tokens, fog reset) for 10-30s for a representative profile.
      </div>
    `;

    parentElement.appendChild(container);
    this.container = container;

    this._renderTableHead();
    this._bindEvents();
    this._refresh();

    log.info('Performance recorder dialog initialized');
  }

  show() {
    if (!this.container) this.initialize();
    if (!this.container) return;
    this.container.style.display = 'block';
    this.visible = true;
    this._refresh();
    this._startRefreshLoop();
  }

  hide() {
    if (!this.container) return;
    this.container.style.display = 'none';
    this.visible = false;
    this._stopRefreshLoop();
  }

  toggle() {
    if (this.visible) this.hide();
    else this.show();
  }

  destroy() {
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
        case 'reset':
          this._onReset();
          break;
        case 'export-json':
          this._onExportJson();
          break;
        case 'export-csv':
          this._onExportCsv();
          break;
        case 'toggle-summary':
          this._toggleSummary();
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
  _onReset() {
    try {
      this.recorder.reset({ keepEnabled: this.recorder.enabled });
      this._refresh();
    } catch (err) {
      log.error('reset failed:', err);
    }
  }

  /** @private */
  _onExportJson() {
    try {
      const { filename } = this.recorder.exportJson();
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
  _toggleSummary() {
    this._expandSummary = !this._expandSummary;
    const body = this.container?.querySelector('[data-bind="summary-body"]');
    const chevron = this.container?.querySelector('[data-bind="summary-chevron"]');
    if (body) body.hidden = !this._expandSummary;
    if (chevron) chevron.textContent = this._expandSummary ? '▼' : '▶';
    if (this._expandSummary) this._refresh();
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
    if (!this.container) return;
    const snap = this.recorder.getSnapshot();

    this._renderStatus(snap);
    this._renderTable(snap);
    this._renderControls(snap);
    if (this._expandSummary) {
      this._renderSummary(snap);
    }
  }

  /** @private */
  _renderStatus(snap) {
    const set = (key, value) => {
      const el = this.container?.querySelector(`[data-bind="${key}"]`);
      if (el) el.textContent = value;
    };

    const gpu = snap.meta.gpuTiming;
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

    set('decimation', `${fmt(snap.session.decimationActivePct, 1)}%`);
    set('drawsPerFrame', `${fmtInt(snap.session.avgDrawCallsPerFrame)} / ${fmtInt(snap.session.avgTrianglesPerFrame)}`);
    set('gpuDiag', `${snap.meta.gpuDisjointEvents} / ${snap.meta.gpuPoolStarvations}`);

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

    const rows = (snap.effects || []).map((r) => ({
      ...r,
      cost: r.cpuAvg + r.gpuAvg,
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
    if (startBtn) startBtn.disabled = this.recorder.enabled === true;
    if (stopBtn)  stopBtn.disabled  = this.recorder.enabled !== true;

    const gpuCheckbox = root.querySelector('input[data-input="gpuTiming"]');
    if (gpuCheckbox) {
      gpuCheckbox.checked = snap.meta.gpuTiming.enabled === true;
      gpuCheckbox.disabled = !snap.meta.gpuTiming.supported;
    }
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

    body.innerHTML = `
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

      <div class="msa-perf__summary-section">
        <h4>Renderer.info (current)</h4>
        ${rendererHtml}
      </div>
    `;
  }
}
