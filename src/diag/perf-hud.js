/**
 * perf-hud.js — the LIVE per-zone ranking, embedded in the control panel's
 * Performance Center (diag/perf-strip.js). Show it, pan, zoom, toggle an
 * effect, and watch the ranking move.
 *
 * ============================================================================
 * WHY A LIVE VIEW AND NOT JUST THE REPORT
 * ============================================================================
 *
 * A profile averages a window. That is the right shape for "where does the frame
 * go", and the wrong shape for "what happens WHEN I cross a floor boundary" —
 * the answer to which is a spike that a 600-frame mean flattens into nothing.
 * The HUD keeps a ROLLING window (it re-arms the profiler every tick), so what
 * you see is the last quarter-second, not the session.
 *
 * ============================================================================
 * THE MONITOR MUST NOT BECOME THE THING WORTH MONITORING
 * ============================================================================
 *
 * boot.js's heartbeat strip already states this rule and repaints at ~4Hz to
 * honour it. Same here: one `setInterval` at 250ms, no rAF loop of its own, no
 * per-frame DOM work while hidden (armed only between `show()` and `hide()`).
 * And it MEASURES ITSELF — `overheadMs` is on the panel, so if this ever
 * becomes expensive the evidence is in plain sight rather than in a hunch.
 *
 * REFACTORED 2026-08-06 from a `position:fixed` top-right overlay (own DOM
 * node, `pointer-events:none`, created/destroyed on show/hide) into a plain
 * embeddable element that stays mounted for its whole lifetime — see
 * `createPerfHud`'s own doc.
 *
 * @module diag/perf-hud
 */
import { PASS_ZONE_PREFIX } from './perf-zones.js';

/** Repaint period. 4Hz — fast enough to see a spike, slow enough to be free. */
export const HUD_TICK_MS = 250;
/** Rows shown. More than this and it stops being glanceable. */
export const HUD_ROWS = 10;

const round = (v, dp) => (Number.isFinite(v) ? Math.round(v * 10 ** dp) / 10 ** dp : null);

/**
 * Pick and rank what the HUD shows. Pure, so the ranking rule is a Node test
 * rather than something only visible by squinting at a live overlay.
 *
 * Passes and leaves are ranked TOGETHER but marked, because the interesting
 * question flips between them: "which pass is heavy" and then "which part of it".
 */
export function buildHudRows(snapshot, { limit = HUD_ROWS } = {}) {
  const frames = snapshot?.frames ?? 0;
  const stats = Array.isArray(snapshot?.zoneStats) ? snapshot.zoneStats : [];
  if (frames <= 0 || stats.length === 0) return { frames: 0, rows: [], totalGpuMs: null, totalCpuMs: null };

  const rows = stats.map((z) => {
    const gpu = z.gpu ? z.gpu.sumMs / frames : null;
    const cpu = z.cpu ? z.cpu.sumMs / frames : null;
    return {
      id: z.id,
      isPass: z.id.startsWith(PASS_ZONE_PREFIX),
      label: z.id.startsWith(PASS_ZONE_PREFIX) ? z.id.slice(PASS_ZONE_PREFIX.length) : z.id,
      gpuMs: round(gpu, 3),
      cpuMs: round(cpu, 3),
      // Rank by whichever cost this zone actually has — a CPU-only zone must be
      // able to reach the top of the list, or the HUD would be blind to exactly
      // the sync-and-upload work that causes the hitches people notice.
      sort: Math.max(gpu ?? 0, cpu ?? 0),
    };
  });
  rows.sort((a, b) => b.sort - a.sort);

  // ⚠️ THE TWO COLUMNS SUM DIFFERENTLY, because they nest differently.
  //
  //   GPU is EXCLUSIVE — a timestamped pass is attributed to the innermost open
  //   zone, so every row holds a disjoint slice and ALL rows sum correctly.
  //   Summing pass rows only (the first version) showed "—", because in a fully
  //   bracketed pass every draw belongs to a child and the pass keeps nothing.
  //
  //   CPU is INCLUSIVE — a bracket wraps its children in wall time, so only the
  //   pass rows may be summed or the children get counted twice.
  const totalGpu = rows.reduce((a, r) => a + (r.gpuMs ?? 0), 0);
  const totalCpu = rows.reduce((a, r) => a + (r.isPass ? (r.cpuMs ?? 0) : 0), 0);

  return {
    frames,
    rows: rows.slice(0, limit),
    hidden: Math.max(0, rows.length - limit),
    totalGpuMs: totalGpu > 0 ? round(totalGpu, 3) : null,
    totalCpuMs: totalCpu > 0 ? round(totalCpu, 3) : null,
  };
}

/**
 * @param {object} deps
 * @param {object} deps.profiler
 * @param {() => void} deps.arm     arm the profiler for a fresh rolling window
 * @param {() => void} deps.disarm
 * @param {() => number} deps.now
 * @param {(on: boolean) => void} [deps.setGpuZoneTimer]
 * @param {() => object} [deps.readGpuStatus]
 */
/**
 * REFACTORED 2026-08-06 from a `position:fixed` top-right floating overlay
 * into a plain embeddable element (author directive: every performance tool
 * lives in ONE place, the perf strip's own Performance Center — see
 * diag/perf-strip.js and diag/debug-panel.js's `renderPerformanceCenter`).
 * `root` is built ONCE, eagerly, and stays in the DOM for the component's
 * whole lifetime; `show()`/`hide()` now toggle content and the paint
 * interval/profiler arming, never create or remove the node itself — the
 * SAME stable reference boot.js hands to `registerPanel` every time.
 */
export function createPerfHud({
  profiler,
  arm,
  disarm,
  // Defaulted HERE rather than injected from boot: `time/one-clock` restricts
  // `performance.now()` to `diag/`, so the composition root must not read it.
  now = () => performance.now(),
  setGpuZoneTimer = null,
  readGpuStatus = null,
}) {
  let timer = null;
  let visible = false;
  let overheadMs = 0;

  const root = document.createElement('div');
  root.id = 'msa-perf-hud';
  Object.assign(root.style, {
    width: '100%',
    boxSizing: 'border-box',
    background: '#12161c',
    color: '#d8dee9',
    border: '1px solid #2e333c',
    borderRadius: '6px',
    padding: '8px 10px',
    font: '12px/1.45 ui-monospace, Menlo, Consolas, monospace',
  });

  const head = document.createElement('div');
  Object.assign(head.style, { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px' });
  const title = document.createElement('div');
  Object.assign(title.style, { fontWeight: 'bold', color: '#8fd6ff' });
  title.textContent = '📊 Live zone ranking';
  const toggleBtn = document.createElement('button');
  Object.assign(toggleBtn.style, {
    background: '#1f6feb',
    color: '#fff',
    border: 'none',
    borderRadius: '6px',
    padding: '2px 10px',
    cursor: 'pointer',
    font: 'inherit',
  });
  head.append(title, toggleBtn);

  const readout = document.createElement('div');
  Object.assign(readout.style, { whiteSpace: 'pre', marginTop: '6px' });
  readout.textContent =
    'Off — click Show to arm the profiler and watch costs live while you pan, zoom, or toggle an effect.';

  root.append(head, readout);

  function syncToggleBtn() {
    toggleBtn.textContent = visible ? 'Hide' : 'Show';
  }
  syncToggleBtn();
  toggleBtn.addEventListener('click', () => api.toggle());

  function paint() {
    const t0 = now();
    const snap = profiler.snapshot();
    const view = buildHudRows(snap);
    const gpu = readGpuStatus?.() ?? null;

    const lines = [];
    lines.push(
      `%%HEAD%%PERF · last ${view.frames} frame${view.frames === 1 ? '' : 's'}` +
        (gpu && gpu.capable === false ? '  · GPU: unavailable' : '')
    );
    if (view.rows.length === 0) {
      lines.push('  (no samples yet — the window resets every tick)');
    } else {
      lines.push('  zone                          gpu ms   cpu ms');
      for (const r of view.rows) {
        const name = (r.isPass ? '▸ ' : '  ') + r.label;
        lines.push(`  ${name.padEnd(28).slice(0, 28)} ${fmt(r.gpuMs).padStart(8)} ${fmt(r.cpuMs).padStart(8)}`);
      }
      if (view.hidden > 0) lines.push(`  …${view.hidden} more`);
      // Labelled honestly: the GPU column totals every zone (exclusive), the CPU
      // column only the passes (inclusive). See buildHudRows.
      lines.push(
        `  ${'TOTAL  gpu:all cpu:passes'.padEnd(28)} ${fmt(view.totalGpuMs).padStart(8)} ${fmt(view.totalCpuMs).padStart(8)}`
      );
    }
    if (snap.anomalies?.unbalancedBrackets > 0) {
      lines.push(`  ⚠ ${snap.anomalies.unbalancedBrackets} mispaired bracket(s) — numbers suspect`);
    }
    lines.push(`  hud overhead ${fmt(round(overheadMs, 2))} ms/tick`);

    readout.textContent = lines.join('\n').replace('%%HEAD%%', '');
    // The rolling window: throw away what we just showed and start again, so the
    // next paint describes the next quarter-second rather than the whole session.
    arm();
    overheadMs = now() - t0;
  }

  function fmt(v) {
    // An em dash, never 0 — the HUD obeys the same rule as the report.
    return v === null || v === undefined ? '—' : v.toFixed(3);
  }

  const api = {
    el: root,
    isVisible: () => visible,
    toggle() {
      return visible ? this.hide() : this.show();
    },
    show() {
      if (visible) return { visible: true };
      visible = true;
      syncToggleBtn();
      setGpuZoneTimer?.(true);
      arm();
      timer = setInterval(paint, HUD_TICK_MS);
      paint();
      return { visible: true, tickMs: HUD_TICK_MS };
    },
    hide() {
      if (!visible) return { visible: false };
      visible = false;
      syncToggleBtn();
      if (timer !== null) clearInterval(timer);
      timer = null;
      disarm();
      setGpuZoneTimer?.(false);
      readout.textContent =
        'Off — click Show to arm the profiler and watch costs live while you pan, zoom, or toggle an effect.';
      return { visible: false };
    },
    dispose() {
      this.hide();
    },
    /** The HUD's own cost, so it can be held to the rule in this file's header. */
    overheadMs: () => round(overheadMs, 3),
  };
  return api;
}
