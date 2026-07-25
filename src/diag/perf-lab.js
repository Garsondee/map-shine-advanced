/**
 * perf-lab.js — the Effect Performance Lab.
 *
 * The author's directive (2026-07-20): NO console commands — one debug-panel button
 * that opens a tool which auto-sweeps every effect and reports, per effect, its real
 * GPU cost. "Run sweep" turns each registered effect off→on in turn and, per config,
 * measures TWO separate things in TWO separate sub-phases (do not merge them — see
 * the post-mortem below):
 *   1. FELT — natural, unthrottled rendering for a stretch, reading the real frame-gap
 *      distribution (vt-pan-viewer's frameGapTimes/hitchLog).
 *   2. GPU — the render loop THROTTLED to one frame in flight at a time (diag/gpu-probe.js
 *      via harness.setGpuProbe; the viewer skips submitting new work while a sample is
 *      awaiting GPU completion), polled until enough samples land.
 * Per-effect GPU cost = its solo GPU reading minus the all-off baseline's. Scene section:
 * baseline vs all-on GPU, felt P50/P95, and an implied "Foundry / everything else" line
 * (MSA's WebGPU device is separate from Foundry's PIXI, so `felt − MSA_gpu` is everything
 * that isn't us).
 *
 * ⚠️ POST-MORTEM (2026-07-20, live, author-caught): the FIRST version measured GPU cost
 * WITHOUT throttling — the render loop kept submitting new frames every ~8ms regardless of
 * probe state, so `onSubmittedWorkDone()` for one frame resolved only after several OTHER
 * frames' pipelined work had ALSO gone through the queue. That measures pipeline QUEUE
 * DEPTH, not per-frame cost. The tell was in the very first live report: "All effects GPU
 * 41.90ms" beside "Frame (felt) P50 8.40ms" — physically impossible for one frame's real
 * execution time (you cannot sustain 8.4ms/frame output while each frame individually costs
 * 41.9ms, unless several frames are pipelined in flight at once, which is exactly what an
 * unthrottled loop does) — plus a negative "UI window shadows: -0.30ms" and a negative
 * "Foundry / other: -33.50ms", both physically impossible for real costs. The fix is the
 * render-loop throttle in vt-pan-viewer.js (gated on gpuProbe.isMeasuring()) plus splitting
 * felt/GPU into separate sub-phases so the throttling's own stalls never pollute felt.
 *
 * INJECTION (boot owns the wiring; this file knows nothing of effects/ or settings):
 *   harness.listEffects(): {id, label}[]
 *   harness.setForcedEnabled(id, boolean|null): transient on/off; null restores the real
 *     cascade. NEVER persists a setting.
 *   harness.setGpuProbe(on): arm/disarm the gated + THROTTLING GPU probe (arming clears
 *     prior samples; while armed the viewer submits one frame at a time).
 *   harness.resetFrameStats(): clear the shared felt rolling windows (frameGapTimes/
 *     hitchLog) — call before each config's felt phase, else one config's reading is
 *     smeared with whatever ran before it (a prior config, or the GPU phase's own throttled
 *     stalls, which would otherwise show up as fake multi-second "hitches").
 *   harness.readCost(): { gpuProbe:{gpuMsMedian, gpuMsP95, gpuMsMax, sampleCount},
 *     hitchStats:{frameGapP50Ms, frameGapP95Ms, hitchCount}, renderMsAvgLast120 }
 *
 * The pure helpers (config list, per-effect delta math, formatting) are Node-tested;
 * runSweep/waitForGpuSamples are testable with an injected harness + frame-waiter; the DOM
 * panel is browser-verified (CONVENTIONS §4).
 */
import { createLogger } from '../core/log.js';

const log = createLogger('perf-lab');

const BASELINE_KEY = '__baseline__';
const ALL_KEY = '__all__';

// ---- pure helpers --------------------------------------------------------

function num(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}
function round2(v) {
  return v == null ? null : Math.round(v * 100) / 100;
}
function round1(v) {
  return v == null ? null : Math.round(v * 10) / 10;
}

/**
 * The ordered configs a sweep runs: an all-OFF baseline (the scene's own cost), then
 * each effect ON alone (its marginal cost = solo − baseline), then all ON together (so
 * `all − baseline` is the whole effect stack and `felt − all` is Foundry/vsync/etc).
 * The all-on row is omitted when there is only one effect (it would duplicate its solo).
 * @param {{id:string,label?:string}[]} effects
 * @returns {{key:string,label:string,on:string[]}[]}
 */
export function buildSweepConfigs(effects) {
  const list = Array.isArray(effects) ? effects.filter((e) => e && typeof e.id === 'string') : [];
  const ids = list.map((e) => e.id);
  const configs = [{ key: BASELINE_KEY, label: 'Scene only (all effects off)', on: [] }];
  for (const e of list) configs.push({ key: e.id, label: e.label || e.id, on: [e.id] });
  if (ids.length > 1) configs.push({ key: ALL_KEY, label: 'All effects on', on: ids.slice() });
  return configs;
}

/**
 * Reduce a sweep's raw per-config readings into a report. Per effect: marginal GPU cost
 * (solo − baseline) and its share of the whole effect stack. Scene: baseline vs all-on
 * GPU + felt, and impliedOtherMs = all-on felt − all-on MSA-GPU (Foundry + vsync + rest).
 * All fields are `null` (never a lying 0) where a reading is missing. `gpuSampleCount` is
 * carried through per config so a thin/zero sample never LOOKS as trustworthy as a solid one.
 * @param {Record<string,{gpuMs?:number,gpuP95?:number,gpuSampleCount?:number,feltP50?:number,feltP95?:number,hitchCount?:number}>} raw
 * @param {{id:string,label?:string}[]} effects
 */
export function summarizeSweep(raw, effects) {
  const safeRaw = raw && typeof raw === 'object' ? raw : {};
  const list = Array.isArray(effects) ? effects.filter((e) => e && typeof e.id === 'string') : [];
  const base = safeRaw[BASELINE_KEY] ?? {};
  const allCfg = safeRaw[ALL_KEY] ?? (list.length === 1 ? (safeRaw[list[0].id] ?? {}) : {});
  const baseGpu = num(base.gpuMs);
  const allGpu = num(allCfg.gpuMs);
  const totalEffectGpu = baseGpu != null && allGpu != null ? allGpu - baseGpu : null;

  const perEffect = list
    .map((e) => {
      const r = safeRaw[e.id] ?? {};
      const solo = num(r.gpuMs);
      const cost = baseGpu != null && solo != null ? solo - baseGpu : null;
      const pct = cost != null && totalEffectGpu ? round1((cost / totalEffectGpu) * 100) : null;
      return {
        id: e.id,
        label: e.label || e.id,
        gpuMsSolo: round2(solo),
        costMs: round2(cost),
        gpuP95: round2(num(r.gpuP95)),
        gpuSampleCount: r.gpuSampleCount ?? 0,
        pctOfEffects: pct,
      };
    })
    // Most expensive first — the whole point is "what's the fat one".
    .sort((a, b) => (b.costMs ?? -Infinity) - (a.costMs ?? -Infinity));

  const allFelt = num(allCfg.feltP50);
  const impliedOtherMs = allGpu != null && allFelt != null ? round2(allFelt - allGpu) : null;

  return {
    perEffect,
    baseline: {
      gpuMs: round2(baseGpu),
      gpuSampleCount: base.gpuSampleCount ?? 0,
      feltP50: round2(num(base.feltP50)),
      feltP95: round2(num(base.feltP95)),
      hitchCount: base.hitchCount ?? null,
    },
    all: {
      gpuMs: round2(allGpu),
      gpuSampleCount: allCfg.gpuSampleCount ?? 0,
      feltP50: round2(allFelt),
      feltP95: round2(num(allCfg.feltP95)),
      hitchCount: allCfg.hitchCount ?? null,
    },
    totalEffectGpuMs: round2(totalEffectGpu),
    impliedOtherMs,
  };
}

/** Display a millisecond value, or an em dash for "not measured" (never a fake 0). */
export function formatMs(v) {
  return num(v) == null ? '—' : `${num(v).toFixed(2)} ms`;
}

/**
 * Display the implied "Foundry / other" line. A SMALL negative value is expected
 * measurement noise (felt frame-gap and throttled-GPU-median are not perfectly
 * commensurate clocks) and must not read as a scary, impossible negative cost — it is
 * clamped to a labelled "≈0". A LARGE negative is left as a real (if surprising) number:
 * it would mean MSA's own GPU work exceeds the observed frame gap, worth seeing plainly
 * rather than hiding.
 */
export function formatOther(v) {
  const n = num(v);
  if (n == null) return '—';
  if (n < 0 && n > -2) return '≈0 ms (within noise)';
  return formatMs(n);
}

// ---- orchestration -------------------------------------------------------

/** Wait n animation frames (real rAF). Injected as `waitFrames` in tests. */
function defaultWaitFrames(n) {
  return new Promise((resolve) => {
    let left = Math.max(0, Number(n) | 0);
    const step = () => {
      if (left-- <= 0) resolve();
      else requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  });
}

/**
 * Poll (via `waitFrames`) until the GPU probe has collected `target` samples or `maxPolls`
 * is exhausted. Never hangs a sweep on a probe that yields nothing (e.g. a non-WebGPU
 * backend): it just gives up and returns whatever count it has, which the report then
 * shows honestly (a thin/zero sample never masquerades as a solid reading — see
 * formatMs/gpuSampleCount). Exported and independently testable.
 * @param {object} harness see the file header
 * @param {number} target
 * @param {{waitFrames:Function, pollFrames?:number, maxPolls?:number}} opts
 * @returns {Promise<number>} the sample count actually reached
 */
export async function waitForGpuSamples(harness, target, opts = {}) {
  const { waitFrames, pollFrames = 4, maxPolls = 120 } = opts;
  for (let i = 0; i < maxPolls; i++) {
    const count = harness.readCost()?.gpuProbe?.sampleCount ?? 0;
    if (count >= target) return count;
    await waitFrames(pollFrames);
  }
  return harness.readCost()?.gpuProbe?.sampleCount ?? 0;
}

/**
 * Run the full sweep. Per config, TWO SEPARATE sub-phases (see the file header's
 * post-mortem for why they must not be merged):
 *   1. Settle the effect toggle, then FELT: reset the shared frame-gap window
 *      (harness.resetFrameStats) and let the loop run at its natural, unthrottled
 *      cadence for `feltFrames` ticks — this is the real, felt frame pacing.
 *   2. GPU: arm the probe (which also THROTTLES the render loop to one frame in
 *      flight — vt-pan-viewer.js), poll (waitForGpuSamples) until `gpuSampleTarget`
 *      samples land, then disarm.
 * ALWAYS restores every effect to its real cascade in `finally`, even on error (and
 * disarms the probe + clears frame stats), so a sweep can never leave the scene forced
 * or its own throttling misreported as real hitches in the next diagnostics read.
 * @param {object} harness see the file header
 * @param {{settleFrames?:number, feltFrames?:number, gpuSampleTarget?:number,
 *   pollFrames?:number, maxGpuPolls?:number, onProgress?:Function, waitFrames?:Function}} [opts]
 */
export async function runSweep(harness, opts = {}) {
  const {
    settleFrames = 20,
    feltFrames = 60,
    gpuSampleTarget = 20,
    pollFrames = 4,
    maxGpuPolls = 120,
    onProgress = () => {},
    waitFrames = defaultWaitFrames,
  } = opts;
  const effects = harness.listEffects() ?? [];
  const configs = buildSweepConfigs(effects);
  const raw = {};
  try {
    for (let ci = 0; ci < configs.length; ci++) {
      const cfg = configs[ci];
      harness.setGpuProbe(false);
      for (const e of effects) harness.setForcedEnabled(e.id, cfg.on.includes(e.id));
      await waitFrames(settleFrames);

      // FELT — natural cadence. Reset FIRST so this config's reading is not smeared
      // with whatever ran before it (the shared window is not per-config on its own).
      onProgress({ index: ci, total: configs.length, label: cfg.label, phase: 'felt' });
      harness.resetFrameStats();
      await waitFrames(feltFrames);
      const felt = harness.readCost() ?? {};

      // GPU — throttled single-frame-in-flight (see vt-pan-viewer's renderFrame
      // guard). Arming clears prior samples on its own OFF→ON edge.
      onProgress({ index: ci, total: configs.length, label: cfg.label, phase: 'gpu' });
      harness.setGpuProbe(true);
      await waitForGpuSamples(harness, gpuSampleTarget, { waitFrames, pollFrames, maxPolls: maxGpuPolls });
      harness.setGpuProbe(false);
      const gpu = harness.readCost() ?? {};

      raw[cfg.key] = {
        gpuMs: gpu.gpuProbe?.gpuMsMedian ?? null,
        gpuP95: gpu.gpuProbe?.gpuMsP95 ?? null,
        gpuSampleCount: gpu.gpuProbe?.sampleCount ?? 0,
        feltP50: felt.hitchStats?.frameGapP50Ms ?? null,
        feltP95: felt.hitchStats?.frameGapP95Ms ?? null,
        hitchCount: felt.hitchStats?.hitchCount ?? null,
      };
    }
  } finally {
    harness.setGpuProbe(false);
    for (const e of effects) harness.setForcedEnabled(e.id, null); // restore the real cascade
    harness.resetFrameStats?.(); // leave the session's own diagnostics clean afterward
  }
  return { effects, configs, raw, summary: summarizeSweep(raw, effects) };
}

// ---- UI (browser-verified) ----------------------------------------------

/** Copy text to the clipboard, falling back to a hidden textarea + execCommand where
 * the async Clipboard API is unavailable. Mirrors debug-panel.js's own (unexported)
 * helper — small enough that duplicating it beats coupling the two modules over it. */
async function copyToClipboard(text) {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      /* fall through */
    }
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

/**
 * Create the floating panel. Returns `{ open }` — boot registers a debug-panel action
 * that calls it. The panel builds lazily on first open.
 * @param {object} harness see the file header
 */
export function createPerfLab(harness) {
  let panel = null;
  let running = false;

  function el(tag, style, text) {
    const n = document.createElement(tag);
    if (style) Object.assign(n.style, style);
    if (text != null) n.textContent = text;
    return n;
  }

  function build() {
    const p = el('div', {
      position: 'fixed',
      top: '64px',
      right: '16px',
      zIndex: '2147483646',
      width: '380px',
      maxHeight: '80vh',
      overflow: 'auto',
      background: '#12161c',
      color: '#dce3ea',
      font: '12px/1.45 ui-monospace, Menlo, Consolas, monospace',
      border: '1px solid rgba(143,214,255,0.25)',
      borderRadius: '10px',
      boxShadow: '0 12px 40px rgba(0,0,0,0.5)',
      padding: '12px 14px',
    });

    const head = el('div', {
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      marginBottom: '8px',
    });
    head.appendChild(el('div', { fontWeight: 'bold', color: '#8fd6ff' }, '🔬 Performance Lab'));
    const close = el('button', btnStyle('#2a3340'), '✕');
    close.onclick = () => {
      p.style.display = 'none';
    };
    head.appendChild(close);
    p.appendChild(head);

    p.appendChild(
      el(
        'div',
        { opacity: '0.75', marginBottom: '10px' },
        'Measures each effect’s real GPU cost by turning it off→on. The scene flickers for a few seconds during a run, then restores.'
      )
    );

    const runBtn = el('button', btnStyle('#1f6feb', true), 'Run sweep');
    p.appendChild(runBtn);

    const status = el('div', { margin: '10px 0 6px', minHeight: '16px', opacity: '0.85' }, '');
    p.appendChild(status);

    const results = el('div', {});
    p.appendChild(results);

    runBtn.onclick = async () => {
      if (running) return;
      running = true;
      runBtn.disabled = true;
      runBtn.style.opacity = '0.5';
      results.textContent = '';
      try {
        const out = await runSweep(harness, {
          onProgress: (pr) => {
            const phaseLabel = pr.phase === 'gpu' ? 'GPU (throttled)' : 'felt';
            status.textContent = `Measuring ${pr.index + 1}/${pr.total} — ${pr.label} (${phaseLabel})…`;
          },
        });
        // The full report (not just the summary) — effects, per-config raw readings
        // (incl. sample counts and felt stats the summary doesn't surface per-effect),
        // and the derived summary. Author's ask (2026-07-21): a paste-able JSON report
        // instead of screenshots.
        const json = JSON.stringify({ generatedAt: new Date().toISOString(), ...out }, null, 2);
        const copied = await copyToClipboard(json);
        status.textContent = copied
          ? `Done — JSON report copied to your clipboard (${json.length.toLocaleString()} chars).`
          : 'Done, but clipboard copy failed — the report was logged instead (also in the flight recorder export).';
        if (!copied) log.warn('clipboard copy failed — full report follows:', json);
        renderResults(results, out.summary);
      } catch (err) {
        log.error('perf sweep failed:', err);
        status.textContent = `Sweep failed: ${err?.message ?? err}. Effects restored.`;
      } finally {
        running = false;
        runBtn.disabled = false;
        runBtn.style.opacity = '1';
      }
    };

    document.body.appendChild(p);
    return p;
  }

  function renderResults(container, summary) {
    container.textContent = '';
    const budget = 8.33; // 120Hz frame budget; the line a frame must not cross to feel smooth

    container.appendChild(
      el('div', { fontWeight: 'bold', margin: '6px 0 4px', color: '#8fd6ff' }, 'Per-effect GPU cost')
    );
    const table = el('table', { width: '100%', borderCollapse: 'collapse' });
    table.appendChild(row(['Effect', 'GPU cost', '% of fx', 'P95'], true));
    if (summary.perEffect.length === 0) table.appendChild(row(['(no effects registered)', '', '', '']));
    for (const e of summary.perEffect) {
      const tr = row([
        e.label,
        formatMs(e.costMs),
        e.pctOfEffects == null ? '—' : `${e.pctOfEffects}%`,
        formatMs(e.gpuP95),
      ]);
      tr.title = `n=${e.gpuSampleCount} GPU samples`; // low-confidence readings are visible on hover, not hidden
      table.appendChild(tr);
    }
    container.appendChild(table);

    container.appendChild(el('div', { fontWeight: 'bold', margin: '12px 0 4px', color: '#8fd6ff' }, 'Scene'));
    const s = el('div', { display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '2px 10px' });
    line(s, 'Base scene GPU', formatMs(summary.baseline.gpuMs));
    line(s, 'All effects GPU', formatMs(summary.all.gpuMs));
    line(s, 'Effect stack', formatMs(summary.totalEffectGpuMs));
    line(s, 'Frame (felt) P50', formatMs(summary.all.feltP50));
    line(s, 'Frame (felt) P95', formatMs(summary.all.feltP95));
    line(s, 'Foundry / other', formatOther(summary.impliedOtherMs));
    line(s, 'Hitches (felt)', summary.all.hitchCount == null ? '—' : String(summary.all.hitchCount));
    container.appendChild(s);
    container.appendChild(
      el(
        'div',
        { opacity: '0.6', marginTop: '4px' },
        `GPU readings: ${summary.baseline.gpuSampleCount} baseline / ${summary.all.gpuSampleCount} all-on samples.`
      )
    );

    const allGpu = num(summary.all.gpuMs);
    const verdict =
      allGpu == null
        ? 'GPU probe returned no samples — is the viewer running on WebGPU?'
        : allGpu <= budget
          ? `MSA's GPU work (${allGpu.toFixed(2)} ms/frame) fits inside the 8.33 ms/120fps budget — stutter is coming from elsewhere (see "Foundry / other").`
          : `MSA's GPU work (${allGpu.toFixed(2)} ms/frame) exceeds the 8.33 ms/120fps budget — this is a real per-frame cost, not a hitch.`;
    container.appendChild(
      el(
        'div',
        { marginTop: '10px', padding: '8px', background: '#1a2028', borderRadius: '6px', opacity: '0.95' },
        verdict
      )
    );
  }

  function row(cells, header) {
    const tr = document.createElement('tr');
    for (const c of cells) {
      const td = document.createElement(header ? 'th' : 'td');
      td.textContent = c;
      Object.assign(td.style, {
        textAlign: cells.indexOf(c) === 0 ? 'left' : 'right',
        padding: '3px 4px',
        borderBottom: '1px solid rgba(255,255,255,0.06)',
        whiteSpace: 'nowrap',
        color: header ? '#9fb0c0' : 'inherit',
        fontWeight: header ? '600' : '400',
      });
      tr.appendChild(td);
    }
    return tr;
  }

  function line(grid, k, v) {
    const a = el('div', { opacity: '0.7' }, k);
    const b = el('div', { textAlign: 'right' }, v);
    grid.appendChild(a);
    grid.appendChild(b);
  }

  function btnStyle(bg, primary) {
    return {
      background: bg,
      color: '#fff',
      border: 'none',
      borderRadius: '6px',
      padding: primary ? '7px 14px' : '2px 8px',
      cursor: 'pointer',
      font: 'inherit',
      fontWeight: primary ? '600' : '400',
    };
  }

  return {
    open() {
      if (typeof document === 'undefined') {
        log.error('perf lab needs a DOM (no document)');
        return;
      }
      if (!panel) panel = build();
      panel.style.display = 'block';
    },
  };
}
