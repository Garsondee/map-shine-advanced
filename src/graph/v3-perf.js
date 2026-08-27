/**
 * @fileoverview v3-perf — the V3 pipeline's performance contract (Forward+ §16.3
 * P1) and dynamic-resolution governor (§16.3 P2).
 *
 * Three pieces, all pure logic (no THREE, no DOM — Node-testable):
 *
 * 1. **The budget table.** Frame-time is the primary metric (Forward+ §16.2 #1):
 *    16.6 ms/frame at the reference tier, split into provisional per-pass
 *    budgets. The numbers are targets to be revised against measurement — the
 *    point is that a number *exists* and every report compares against it.
 *
 * 2. **{@link V3PerfMonitor}** — rolling per-pass statistics (last / EMA /
 *    window-worst) folded from the frame graph's CPU timings and the
 *    GpuPassTimer's (lagging) GPU timings. Feeds `MapShine.v3.perf()` and the
 *    crash-report diagnostics.
 *
 * 3. **{@link RenderScaleGovernor}** — the closed loop (§16.1: "nothing yet
 *    *acts* on a measurement"). Consumes the monitor's cost estimate and walks a
 *    discrete resolution ladder with hysteresis: sustained over-budget steps the
 *    internal render scale down; sustained comfortable headroom (predicted at
 *    the next-higher rung) steps it back up. Discrete rungs + cooldown keep RT
 *    reallocation rare; a warmup window keeps the load storm (shader-compile
 *    spikes behind the curtain) from triggering a bogus downscale.
 *
 * The governor deliberately measures the **graph's own cost** (CPU execute ms,
 * GPU pass ms when available), never RAF-to-RAF wall time — the render loop
 * idle-throttles static scenes to 15 fps by design, and wall time would read
 * that as "over budget" and floor the scale on an idle frame.
 *
 * @module compositor-v3/v3-perf
 */

/** Reference frame budget (ms) — 60 fps on the reference tier (Forward+ §16.2). */
export const FRAME_BUDGET_MS = 16.6;

/**
 * Provisional per-pass budgets (ms) at the reference tier — Forward+ §16.3 P1.
 * Revise against measurement; unknown passes get {@link DEFAULT_PASS_BUDGET_MS}.
 * @type {Record<string, number>}
 */
export const PASS_BUDGETS_MS = {
  sims: 1.0,
  streaming: 1.5,
  unifiedGeometry: 3.5,
  lighting: 3.0,
  effects: 2.0,
  post: 4.5,
  present: 1.0,
};

/** Budget for passes not in {@link PASS_BUDGETS_MS} (future passes default strict). */
export const DEFAULT_PASS_BUDGET_MS = 2.0;

/** The discrete render-scale ladder (descending). Rungs, not a dial: each step
 * change reallocates every screen-sized RT, so changes must be rare and chunky. */
export const SCALE_LADDER = [1.0, 0.85, 0.7, 0.6, 0.5];

/**
 * Resolve the internal render size for a present (drawing-buffer) size and a
 * scale. At scale 1.0 the size is returned EXACTLY (the present blit must stay
 * 1:1 — no resampling softness on the identity path). Below 1.0, dimensions
 * floor to even numbers (≤ the present size, and mip/downsample chains behave
 * better on even sizes) with a floor of 2.
 * @param {number} presentW
 * @param {number} presentH
 * @param {number} scale
 * @returns {{width: number, height: number}}
 */
export function computeRenderSize(presentW, presentH, scale) {
  const w = Math.max(1, Math.floor(presentW) || 1);
  const h = Math.max(1, Math.floor(presentH) || 1);
  const s = Number.isFinite(scale) && scale > 0 ? Math.min(1, scale) : 1;
  if (s >= 0.9995) return { width: w, height: h };
  const snap = (v) => Math.max(2, Math.floor((v * s) / 2) * 2);
  return { width: snap(w), height: snap(h) };
}

/**
 * Rolling per-pass timing statistics with a fixed EMA and a bounded worst-of-
 * window, fed once per rendered frame.
 */
export class V3PerfMonitor {
  /**
   * @param {object} [options]
   * @param {number} [options.emaAlpha=0.1]
   * @param {number} [options.windowSize=120] - Frames per worst-of-window bucket.
   * @param {Record<string, number>} [options.budgets] - Pass budget overrides.
   * @param {number} [options.frameBudgetMs]
   */
  constructor(options = {}) {
    this._alpha = Number.isFinite(options.emaAlpha) ? options.emaAlpha : 0.1;
    this._windowSize = Number.isFinite(options.windowSize) ? options.windowSize : 120;
    this._budgets = { ...PASS_BUDGETS_MS, ...(options.budgets ?? {}) };
    this._frameBudgetMs = Number.isFinite(options.frameBudgetMs) ? options.frameBudgetMs : FRAME_BUDGET_MS;

    /** @type {Map<string, {cpuLast: number, cpuEma: number, cpuWorst: number, gpuLast: number|null, gpuEma: number|null}>} */
    this._passes = new Map();
    this._frames = 0;
    this._windowFrame = 0;
    this._cpuTotalLast = 0;
    this._cpuTotalEma = null;
    this._gpuTotalLast = null;
    this._gpuTotalEma = null;
  }

  /** @returns {number} the frame budget in ms. */
  get frameBudgetMs() {
    return this._frameBudgetMs;
  }

  /**
   * Fold one rendered frame's timings in.
   * @param {Map<string, number>} cpuTimings - FrameGraph.getLastTimings().
   * @param {Map<string, number>} [gpuTimings] - FrameGraph.getGpuTimings()
   *   (latest resolved per pass; lags 1–3 frames — treated as "recent").
   */
  update(cpuTimings, gpuTimings = null) {
    if (!(cpuTimings instanceof Map)) return;
    this._frames += 1;
    this._windowFrame += 1;
    const resetWindow = this._windowFrame >= this._windowSize;
    if (resetWindow) this._windowFrame = 0;

    let cpuTotal = 0;
    for (const [name, ms] of cpuTimings) {
      cpuTotal += ms;
      let s = this._passes.get(name);
      if (!s) {
        s = { cpuLast: ms, cpuEma: ms, cpuWorst: ms, gpuLast: null, gpuEma: null };
        this._passes.set(name, s);
      } else {
        s.cpuLast = ms;
        s.cpuEma += this._alpha * (ms - s.cpuEma);
        s.cpuWorst = resetWindow ? ms : Math.max(s.cpuWorst, ms);
      }
    }

    let gpuTotal = null;
    if (gpuTimings instanceof Map && gpuTimings.size) {
      gpuTotal = 0;
      for (const [name, ms] of gpuTimings) {
        gpuTotal += ms;
        const s = this._passes.get(name);
        if (!s) continue; // GPU result for a pass that didn't run this frame
        s.gpuLast = ms;
        s.gpuEma = s.gpuEma == null ? ms : s.gpuEma + this._alpha * (ms - s.gpuEma);
      }
    }

    this._cpuTotalLast = cpuTotal;
    this._cpuTotalEma =
      this._cpuTotalEma == null ? cpuTotal : this._cpuTotalEma + this._alpha * (cpuTotal - this._cpuTotalEma);
    if (gpuTotal != null) {
      this._gpuTotalLast = gpuTotal;
      this._gpuTotalEma =
        this._gpuTotalEma == null ? gpuTotal : this._gpuTotalEma + this._alpha * (gpuTotal - this._gpuTotalEma);
    }
  }

  /**
   * The governor's cost input: the worse of CPU-EMA and GPU-EMA totals. With no
   * GPU timer this is CPU-only — a conservative under-estimate on GPU-bound
   * frames (documented §16.3 P1: extension-less browsers keep CPU timings only).
   * @returns {number} ms
   */
  costEstimateMs() {
    const cpu = this._cpuTotalEma ?? 0;
    const gpu = this._gpuTotalEma ?? 0;
    return Math.max(cpu, gpu);
  }

  /**
   * The cost split the governor's up-predictor needs (Forward+ §16.3 P2, revised
   * against 2026-07-14 hardware data): GPU cost scales ≈ with pixel count, but
   * main-thread CPU cost is ~resolution-independent (measured identical at 0.7
   * and 0.5 scale), so predicting a rung-up must scale only the GPU share.
   * @returns {{cpuMs: number, gpuMs: number|null}}
   */
  costComponents() {
    return {
      cpuMs: this._cpuTotalEma ?? 0,
      gpuMs: this._gpuTotalEma, // null until the GPU timer delivers
    };
  }

  /** @param {string} name @returns {number} the pass's budget in ms. */
  budgetFor(name) {
    const b = this._budgets[name];
    return Number.isFinite(b) ? b : DEFAULT_PASS_BUDGET_MS;
  }

  /**
   * Structured report for `MapShine.v3.perf()` and crash diagnostics.
   * @returns {{frames: number, frameBudgetMs: number, cpuTotal: object, gpuTotal: object|null, passes: Array<object>}}
   */
  getReport() {
    const passes = [];
    for (const [name, s] of this._passes) {
      const budget = this.budgetFor(name);
      passes.push({
        pass: name,
        budgetMs: budget,
        cpuLastMs: round2(s.cpuLast),
        cpuAvgMs: round2(s.cpuEma),
        cpuWorstMs: round2(s.cpuWorst),
        gpuLastMs: s.gpuLast == null ? null : round2(s.gpuLast),
        gpuAvgMs: s.gpuEma == null ? null : round2(s.gpuEma),
        overBudget: Math.max(s.cpuEma, s.gpuEma ?? 0) > budget,
      });
    }
    return {
      frames: this._frames,
      frameBudgetMs: this._frameBudgetMs,
      cpuTotal: { lastMs: round2(this._cpuTotalLast), avgMs: round2(this._cpuTotalEma ?? 0) },
      gpuTotal:
        this._gpuTotalEma == null
          ? null
          : { lastMs: round2(this._gpuTotalLast ?? 0), avgMs: round2(this._gpuTotalEma) },
      passes,
    };
  }
}

/**
 * The dynamic-resolution control loop (Forward+ §16.3 P2). Pure state machine:
 * feed it a cost estimate once per rendered frame; read `scale`.
 *
 * Behavior contract (the tests encode this):
 *  - While {@link RenderScaleGovernor#setHold held} (scene loading): no changes,
 *    no streak accumulation; releasing the hold imposes a settle cooldown so the
 *    load's tail frames can't trigger a step. This is the primary load-storm
 *    guard (the warmup window only covers cold starts without a load signal —
 *    2026-07-14 hardware run showed real loads outlast any fixed warmup).
 *  - No changes during the first `warmupFrames` frames (cold-start immunity).
 *  - Step DOWN one rung after `downFrames` consecutive frames with
 *    `cost > budget × highWater`, then hold for `cooldownFrames`.
 *  - Step UP one rung after `upFrames` consecutive frames where the *predicted*
 *    cost at the higher rung stays under `budget × lowWater`, then hold for
 *    `cooldownFrames`. Prediction: GPU cost scales with pixels (× r²); CPU cost
 *    does not (measured resolution-independent on hardware) — so with GPU
 *    timings the predictor is `max(cpu, gpu × r²)`, and only without them does
 *    it fall back to scaling the whole cost (conservative).
 *  - Never leaves [minScale, maxScale] ∩ ladder.
 */
export class RenderScaleGovernor {
  /**
   * @param {object} [options]
   * @param {number[]} [options.ladder] - Descending scale rungs.
   * @param {number} [options.frameBudgetMs]
   * @param {number} [options.highWater=1.2] - Downscale pressure threshold (×budget).
   * @param {number} [options.lowWater=0.7] - Upscale headroom threshold (×budget).
   * @param {number} [options.downFrames=15]
   * @param {number} [options.upFrames=180]
   * @param {number} [options.cooldownFrames=90]
   * @param {number} [options.warmupFrames=60]
   * @param {number} [options.postHoldSettleFrames=60] - Cooldown imposed when a
   *   hold releases (a load's last frames are not steady-state evidence).
   * @param {number} [options.minScale=0.5]
   * @param {number} [options.maxScale=1.0]
   */
  constructor(options = {}) {
    const ladder = (
      Array.isArray(options.ladder) && options.ladder.length ? options.ladder.slice() : SCALE_LADDER.slice()
    ).sort((a, b) => b - a);
    const minScale = Number.isFinite(options.minScale) ? options.minScale : 0.5;
    const maxScale = Number.isFinite(options.maxScale) ? options.maxScale : 1.0;
    /** @type {number[]} descending, clamped to [minScale, maxScale]. */
    this._ladder = ladder.filter((s) => s >= minScale - 1e-9 && s <= maxScale + 1e-9);
    if (!this._ladder.length) this._ladder = [Math.max(minScale, Math.min(maxScale, 1))];

    this._budget = Number.isFinite(options.frameBudgetMs) ? options.frameBudgetMs : FRAME_BUDGET_MS;
    this._highWater = Number.isFinite(options.highWater) ? options.highWater : 1.2;
    this._lowWater = Number.isFinite(options.lowWater) ? options.lowWater : 0.7;
    this._downFrames = Number.isFinite(options.downFrames) ? options.downFrames : 15;
    this._upFrames = Number.isFinite(options.upFrames) ? options.upFrames : 180;
    this._cooldownFrames = Number.isFinite(options.cooldownFrames) ? options.cooldownFrames : 90;
    this._warmupFrames = Number.isFinite(options.warmupFrames) ? options.warmupFrames : 60;
    this._postHoldSettleFrames = Number.isFinite(options.postHoldSettleFrames) ? options.postHoldSettleFrames : 60;

    this._rung = 0; // index into _ladder (0 = highest scale)
    this._frames = 0;
    this._cooldown = 0;
    /** @type {number} post-hold settle frames remaining. Distinct from
     * `_cooldown`: cooldown only spaces steps (streaks keep accumulating so a
     * sustained condition steps the moment spacing allows), while settle
     * DISCARDS evidence entirely — the load's tail frames must not feed
     * streaks at all. */
    this._settle = 0;
    this._overStreak = 0;
    this._underStreak = 0;
    this._lastChange = null; // {frame, from, to, reason}
    this._holdActive = false;
    this._holdReason = null;
    this._lastPredictedUpMs = null;
  }

  /** @returns {number} the current render scale (a ladder rung). */
  get scale() {
    return this._ladder[this._rung];
  }

  /**
   * Update the frame budget live (2026-08-27 — e.g. the player's own
   * performance-profile tier changed mid-session). Clears in-flight streak
   * evidence: frames counted against the OLD budget are not valid evidence
   * for a step judged against the NEW one. Leaves the current rung,
   * cooldown, and warmup/settle counters alone — a budget change does not
   * itself mean "a reallocation just happened" or "the scene just loaded,"
   * only "re-judge future frames differently." A no-op for a non-finite/
   * non-positive value or one identical to the current budget.
   * @param {number} ms
   */
  setFrameBudgetMs(ms) {
    if (!Number.isFinite(ms) || ms <= 0 || ms === this._budget) return;
    this._budget = ms;
    this._overStreak = 0;
    this._underStreak = 0;
  }

  /**
   * Suspend/resume the control loop. While held the scale is frozen and no
   * streak evidence accumulates (load-time frames are not steady-state
   * evidence). Releasing imposes a settle cooldown. Idempotent per state.
   * @param {boolean} active
   * @param {string|null} [reason]
   */
  setHold(active, reason = null) {
    const on = !!active;
    if (on === this._holdActive) {
      if (on && reason) this._holdReason = reason;
      return;
    }
    this._holdActive = on;
    this._holdReason = on ? (reason ?? 'held') : null;
    this._overStreak = 0;
    this._underStreak = 0;
    if (!on) {
      this._settle = Math.max(this._settle, this._postHoldSettleFrames);
    }
  }

  /**
   * Feed one rendered frame's cost estimate.
   * @param {number} costMs - e.g. {@link V3PerfMonitor#costEstimateMs}.
   * @param {{cpuMs?: number, gpuMs?: number|null}} [components] - Optional cost
   *   split (see {@link V3PerfMonitor#costComponents}) for the resolution-aware
   *   up-predictor; omitted → the whole cost is assumed to scale with pixels.
   * @returns {{changed: boolean, scale: number}}
   */
  update(costMs, components = null) {
    this._frames += 1;
    if (this._cooldown > 0) this._cooldown -= 1;
    const cost = Number.isFinite(costMs) ? costMs : 0;

    if (this._holdActive) {
      this._overStreak = 0;
      this._underStreak = 0;
      return { changed: false, scale: this.scale };
    }

    // Post-hold settle: discard this frame's evidence entirely (see the
    // `_settle` field comment for how this differs from `_cooldown`).
    if (this._settle > 0) {
      this._settle -= 1;
      this._overStreak = 0;
      this._underStreak = 0;
      return { changed: false, scale: this.scale };
    }

    if (this._frames <= this._warmupFrames) {
      return { changed: false, scale: this.scale };
    }

    // Downscale pressure: sustained cost over the high-water line.
    if (cost > this._budget * this._highWater) {
      this._overStreak += 1;
      this._underStreak = 0;
    } else {
      this._overStreak = 0;
      // Upscale headroom: predicted cost at the next rung UP must stay
      // comfortably under budget. GPU cost scales ≈ with pixel count (× r²);
      // CPU submission cost does not (measured identical across scales on
      // hardware, 2026-07-14) — so with a known split, only the GPU share is
      // scaled and CPU acts as a floor. Without GPU timings, conservatively
      // scale the whole cost.
      if (this._rung > 0) {
        const cur = this.scale;
        const up = this._ladder[this._rung - 1];
        const r2 = (up * up) / (cur * cur);
        const gpu = Number.isFinite(components?.gpuMs) ? components.gpuMs : null;
        const cpu = Number.isFinite(components?.cpuMs) ? components.cpuMs : null;
        const predicted = gpu != null ? Math.max(cpu ?? 0, gpu * r2) : cost * r2;
        this._lastPredictedUpMs = predicted;
        if (predicted < this._budget * this._lowWater) this._underStreak += 1;
        else this._underStreak = 0;
      } else {
        this._underStreak = 0;
        this._lastPredictedUpMs = null;
      }
    }

    if (this._cooldown === 0) {
      if (this._overStreak >= this._downFrames && this._rung < this._ladder.length - 1) {
        return this._step(this._rung + 1, 'over-budget');
      }
      if (this._underStreak >= this._upFrames && this._rung > 0) {
        return this._step(this._rung - 1, 'headroom');
      }
    }
    return { changed: false, scale: this.scale };
  }

  /**
   * @param {number} rung
   * @param {string} reason
   * @returns {{changed: true, scale: number}}
   * @private
   */
  _step(rung, reason) {
    const from = this.scale;
    this._rung = rung;
    this._cooldown = this._cooldownFrames;
    this._overStreak = 0;
    this._underStreak = 0;
    this._lastChange = { frame: this._frames, from, to: this.scale, reason };
    return { changed: true, scale: this.scale };
  }

  /** Reset all streaks/warmup (e.g. on scene change). Keeps the current rung. */
  reset() {
    this._frames = 0;
    this._cooldown = 0;
    this._settle = 0;
    this._overStreak = 0;
    this._underStreak = 0;
  }

  /** @returns {object} diagnostics snapshot. */
  state() {
    return {
      scale: this.scale,
      ladder: this._ladder.slice(),
      frames: this._frames,
      warmupRemaining: Math.max(0, this._warmupFrames - this._frames),
      cooldownRemaining: this._cooldown,
      settleRemaining: this._settle,
      overStreak: this._overStreak,
      underStreak: this._underStreak,
      frameBudgetMs: this._budget,
      holdActive: this._holdActive,
      holdReason: this._holdReason,
      predictedUpMs: this._lastPredictedUpMs == null ? null : round2(this._lastPredictedUpMs),
      upThresholdMs: round2(this._budget * this._lowWater),
      lastChange: this._lastChange ? { ...this._lastChange } : null,
    };
  }
}

/**
 * Flatten a monitor report + scale state into console.table-friendly rows for
 * `MapShine.v3.perf()`.
 * @param {ReturnType<V3PerfMonitor['getReport']>} report
 * @returns {Array<object>}
 */
export function buildPerfRows(report) {
  const rows = (report?.passes ?? []).map((p) => ({
    pass: p.pass,
    'cpu ms (last)': p.cpuLastMs,
    'cpu ms (avg)': p.cpuAvgMs,
    'cpu ms (worst)': p.cpuWorstMs,
    'gpu ms (recent)': p.gpuLastMs ?? '—',
    'budget ms': p.budgetMs,
    over: p.overBudget ? '⚠' : '',
  }));
  if (report) {
    rows.push({
      pass: 'TOTAL',
      'cpu ms (last)': report.cpuTotal.lastMs,
      'cpu ms (avg)': report.cpuTotal.avgMs,
      'cpu ms (worst)': '',
      'gpu ms (recent)': report.gpuTotal ? report.gpuTotal.avgMs : '—',
      'budget ms': report.frameBudgetMs,
      over: Math.max(report.cpuTotal.avgMs, report.gpuTotal?.avgMs ?? 0) > report.frameBudgetMs ? '⚠' : '',
    });
  }
  return rows;
}

/** @param {number} v @returns {number} */
function round2(v) {
  return Math.round(v * 100) / 100;
}
