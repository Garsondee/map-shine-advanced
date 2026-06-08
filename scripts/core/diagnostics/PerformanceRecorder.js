/**
 * @fileoverview Performance Recorder
 *
 * Per-effect CPU/GPU timing instrumentation surfaced by the Quick Actions
 * "Performance Recorder" dialog. Captures:
 *   - CPU update / render ms per effect (last / avg / max / total / count)
 *   - GPU ms via WebGL2 `EXT_disjoint_timer_query_webgl2` (when supported)
 *   - Draw-call and triangle deltas per effect call via `renderer.info`
 *   - Session-level frame stats (FPS, frame-time, continuous-render reasons,
 *     decimation activation %, renderer.info totals, VRAM budget)
 *   - Sequencer integration: per-mirror sync + phase rows (default: one
 *     `syncFromPixi` path per compositor frame unless legacy post-PIX doubling is on)
 *     — helps profile JB2A / condition-video overlays.
 *   - Frame timeline ring buffer for spike analysis (JSON / CSV export)
 *
 * Zero-cost when idle: a single `recorder?.enabled === true` check short-
 * circuits the hot path. Designed to be safe to leave instantiated in
 * production builds.
 *
 * @module core/diagnostics/PerformanceRecorder
 */

import { createLogger } from '../log.js';
import { buildPerformanceInsights, formatInsightsMarkdown } from './performance-recorder-insights.js';
import {
  buildExportFilename,
  buildFullPayload,
  buildSummaryPayload,
  resolveExportMode,
} from './performance-recorder-export.js';
import { buildFrameBudgetSection } from './performance-recorder-frame-budget.js';
import { buildLightingPerfSection, resolveLightingEffect } from './performance-recorder-lighting.js';
import { buildWorldOverlaysPerfSection } from './performance-recorder-world-overlays.js';
import { analyzeStutters } from './performance-recorder-stutters.js';

const log = createLogger('PerfRecorder');

/** Default ring-buffer capacity for the frame timeline (~10s @ 60fps). */
const DEFAULT_MAX_FRAMES = 600;

/** Pool size for WebGL2 timer-query handles. */
const DEFAULT_QUERY_POOL_SIZE = 512;

/** Max long-task entries retained per session. */
const MAX_LONG_TASKS = 100;

/** Max compositor spike detail records (ring buffer). */
const MAX_SPIKE_DETAILS = 64;

/** Max frames a GPU timer query may remain pending before it is discarded. */
const MAX_PENDING_QUERY_AGE = 10;

/**
 * Per-effect-phase running statistic. avg derived on read.
 * @typedef {{ last:number, max:number, total:number, count:number }} Stat
 */

/**
 * Create a fresh `Stat`.
 * @returns {Stat}
 */
function makeStat() {
  return { last: 0, max: 0, total: 0, count: 0 };
}

/**
 * Add a sample to a `Stat`. Ignores non-finite values defensively.
 * @param {Stat} stat
 * @param {number} value
 */
function addSample(stat, value) {
  if (!Number.isFinite(value)) return;
  stat.last = value;
  if (value > stat.max) stat.max = value;
  stat.total += value;
  stat.count += 1;
}

/**
 * Compute the average of a stat. Returns 0 when no samples recorded.
 * @param {Stat} stat
 * @returns {number}
 */
function statAvg(stat) {
  return stat.count > 0 ? stat.total / stat.count : 0;
}

/**
 * Compute a percentile from an array of numbers. Mutates the array in-place
 * (sorts it). Returns 0 for an empty array.
 * @param {number[]} arr
 * @param {number} p - 0..1
 * @returns {number}
 */
function percentile(arr, p) {
  if (!arr || arr.length === 0) return 0;
  arr.sort((a, b) => a - b);
  const idx = Math.min(arr.length - 1, Math.max(0, Math.floor(p * (arr.length - 1))));
  return arr[idx];
}

/**
 * Aggregated per-effect statistics keyed by effect name. Each entry holds
 * separate Stats for `update` and `render` phases (both CPU and GPU plus
 * draw-call / triangle deltas).
 *
 * @typedef {{
 *   update: { cpuMs: Stat, gpuMs: Stat, draws: Stat, triangles: Stat, lines: Stat, points: Stat },
 *   render: { cpuMs: Stat, gpuMs: Stat, draws: Stat, triangles: Stat, lines: Stat, points: Stat },
 *   firstSeenMs: number,
 *   lastSeenMs: number,
 *   gpuDisjointDropped: number,
 *   gpuMissingPool: number,
 *   gpuSlotBlocked: number,
 * }} EffectAggregate
 */

/**
 * @returns {EffectAggregate}
 */
function makeEffectAggregate() {
  const phase = () => ({
    cpuMs: makeStat(),
    gpuMs: makeStat(),
    draws: makeStat(),
    triangles: makeStat(),
    lines: makeStat(),
    points: makeStat(),
  });
  return {
    update: phase(),
    render: phase(),
    firstSeenMs: 0,
    lastSeenMs: 0,
    gpuDisjointDropped: 0,
    gpuMissingPool: 0,
    gpuSlotBlocked: 0,
  };
}

/**
 * Performance recorder singleton-style class. Instantiated once during
 * `createThreeCanvas` and exposed on `window.MapShine.performanceRecorder`.
 *
 * The recorder is *armed* but inactive at construction time; `start()` opens
 * a recording session and `stop()` finalizes it. All hot-path calls
 * (`beginEffectCall`, `endEffectCall`, `beginFrame`, `endFrame`) become
 * effective no-ops when `enabled` is false.
 */
export class PerformanceRecorder {
  /**
   * @param {import('three').WebGLRenderer} renderer
   * @param {object} [options]
   * @param {number} [options.maxFrames]
   * @param {number} [options.queryPoolSize]
   */
  constructor(renderer, options = {}) {
    /** @type {import('three').WebGLRenderer|null} */
    this.renderer = renderer ?? null;

    /** @type {boolean} */
    this.enabled = false;

    /** @type {boolean} If true, GPU timer queries are issued when supported. */
    this.gpuTimingEnabled = true;

    /** @type {boolean} GPU timing capability detection result. */
    this.gpuTimingSupported = false;

    /** @type {number} */
    this.maxFrames = Math.max(60, Number(options.maxFrames) || DEFAULT_MAX_FRAMES);

    /** @type {number} */
    this.queryPoolSize = Math.max(16, Number(options.queryPoolSize) || DEFAULT_QUERY_POOL_SIZE);

    /** @type {Map<string, EffectAggregate>} */
    this._aggregates = new Map();

    /** @type {Map<string, number>} `updatable name → total ms` (EffectComposer updatables). */
    this._updatables = new Map();
    /** @type {Map<string, number>} Updatable call counters. */
    this._updatableCounts = new Map();

    /** @type {Map<string, Stat>} Sequencer subsystem CPU phases (e.g. tickBefore.total). */
    this._sequencerPhases = new Map();
    /** @type {Map<string, Stat>} Per-mirror syncFromPixi CPU (combined postPixi + pre-bus). */
    this._sequencerMirrorSync = new Map();
    /** @type {Array<FrameRecord>} */
    this._frames = [];
    /** @type {number} */
    this._frameWriteIndex = 0;

    /** @type {Map<string, number>} Continuous-render reason histogram. */
    this._continuousReasons = new Map();
    /** @type {number} */
    this._decimationFrames = 0;
    /** @type {number} */
    this._totalRecordedFrames = 0;

    /** @type {Array<TickRecord>} rAF tick ring (includes skipped + presented). */
    this._tickRecords = [];
    /** @type {number} */
    this._tickWriteIndex = 0;
    /** @type {number} */
    this._totalTickRecords = 0;
    /** @type {number} */
    this._presentedTickCount = 0;
    /** @type {number} */
    this._skippedTickCount = 0;
    /** @type {number} */
    this._judderTransitions = 0;
    /** @type {boolean} */
    this._lastTickPresented = false;
    /** @type {Map<string, number>} */
    this._skipReasonHistogram = new Map();

    /** @type {Map<string, { effect: string, phase: string, cpuMs: number }>} Per-frame effect CPU scratch. */
    this._currentFrameEffects = new Map();

    /** @type {Array<{ seq: number, tMs: number, frameTimeMs: number, topEffects: object[] }>} */
    this._spikeFrameDetails = [];
    /** @type {number} */
    this._spikeWriteIndex = 0;

    /** @type {Array<{ startMs: number, endMs: number, durationMs: number, name: string|null }>} */
    this._longTasks = [];
    /** @type {PerformanceObserver|null} */
    this._longTaskObserver = null;
    /** @type {boolean} */
    this._longTaskObserverWarned = false;

    /** @type {number} Performance-now ms at session start. */
    this._startedAtMs = 0;
    /** @type {number} Date.now() at session start, for export metadata. */
    this._startedAtWallClockMs = 0;
    /** @type {number} */
    this._stoppedAtMs = 0;

    /** @type {object|null} Initial renderer.info snapshot at start. */
    this._infoStart = null;
    /** @type {object|null} Renderer.info snapshot at stop. */
    this._infoEnd = null;
    /** @type {number} */
    this._drawCallsAccumLast = 0;
    /** @type {number} */
    this._trianglesAccumLast = 0;
    /** @type {number} */
    this._linesAccumLast = 0;
    /** @type {number} */
    this._pointsAccumLast = 0;

    // ── GPU timer-query state ──────────────────────────────────────────────
    /** @type {WebGL2RenderingContext|null} */
    this._gl = null;
    /** @type {any} EXT_disjoint_timer_query_webgl2 extension object. */
    this._gpuExt = null;
    /** @type {WebGLQuery[]} Free GPU query pool. */
    this._queryPool = [];
    /** @type {WebGLQuery[]} All queries created (for cleanup). */
    this._queriesOwned = [];
    /** @type {Array<PendingQuery>} */
    this._pendingQueries = [];
    /** @type {WebGLQuery|null} Currently active TIME_ELAPSED_EXT query (only one allowed per spec). */
    this._activeQuery = null;
    /** @type {number} Frame counter used for GPU query age. */
    this._frameSeq = 0;
    /** @type {number} Total disjoint events observed during the session. */
    this._gpuDisjointEvents = 0;
    /** @type {number} Total GPU samples discarded because pool was exhausted. */
    this._gpuPoolStarvations = 0;

    // ── In-frame scratch state for beginEffectCall / endEffectCall ─────────
    /** @type {number} */
    this._tokenSeq = 0;
    /** @type {EffectCallToken|null} */
    this._frameFirstToken = null;

    // ── Per-frame begin/end CPU/info snapshots ─────────────────────────────
    this._frameBeginMs = 0;
    this._frameBeginCalls = 0;
    this._frameBeginTriangles = 0;
    this._frameBeginLines = 0;
    this._frameBeginPoints = 0;

    /** Per-frame draw stats summed from render-phase effect spans (Three autoReset-safe). */
    this._frameDrawAccum = 0;
    this._frameTriAccum = 0;
    this._frameLinesAccum = 0;
    this._framePointsAccum = 0;

    /** @type {string|null} Cached module version for export context. */
    this._moduleVersion = null;
    try {
      this._moduleVersion = game?.modules?.get?.('map-shine-advanced')?.version ?? null;
    } catch (_) {}

    this._detectGpuCapability();
  }

  /**
   * Detect WebGL2 timer-query extension and cache the GL handle.
   * @private
   */
  _detectGpuCapability() {
    try {
      const gl = this.renderer?.getContext?.() ?? null;
      if (!gl) {
        this.gpuTimingSupported = false;
        return;
      }
      // We need WebGL2 for `EXT_disjoint_timer_query_webgl2`.
      const isWebGL2 = typeof WebGL2RenderingContext !== 'undefined'
        && gl instanceof WebGL2RenderingContext;
      if (!isWebGL2) {
        this.gpuTimingSupported = false;
        return;
      }
      this._gl = gl;
      const ext = gl.getExtension('EXT_disjoint_timer_query_webgl2');
      if (ext) {
        this._gpuExt = ext;
        this.gpuTimingSupported = true;
        log.info('GPU timer queries available (EXT_disjoint_timer_query_webgl2)');
      } else {
        this.gpuTimingSupported = false;
        log.info('GPU timer queries not supported by this renderer/driver');
      }
    } catch (err) {
      this.gpuTimingSupported = false;
      log.warn('GPU capability detection failed:', err);
    }
  }

  /**
   * @returns {{ supported: boolean, enabled: boolean }}
   */
  getGpuTimingState() {
    return {
      supported: this.gpuTimingSupported,
      enabled: this.gpuTimingSupported && this.gpuTimingEnabled,
    };
  }

  /**
   * Toggle GPU timer queries during a session. Pending queries are drained on
   * disable to avoid leaking into the next batch.
   * @param {boolean} enabled
   */
  setGpuTimingEnabled(enabled) {
    const newVal = enabled === true;
    if (this.gpuTimingEnabled === newVal) return;
    this.gpuTimingEnabled = newVal;
    if (!newVal) {
      this._abortAllPendingQueries('gpuTimingDisabled');
    }
  }

  /**
   * Begin a new recording session. Safe to call again to restart.
   * @param {object} [options]
   * @param {boolean} [options.gpuTiming]
   */
  start(options = {}) {
    if (options && typeof options.gpuTiming === 'boolean') {
      this.gpuTimingEnabled = options.gpuTiming;
    }

    this.reset({ keepEnabled: true });

    this._startedAtMs = performance.now();
    this._startedAtWallClockMs = Date.now();
    this._stoppedAtMs = 0;

    // Snapshot baseline renderer.info so per-frame deltas are correct from
    // the first frame onwards. We never reset renderer.info ourselves
    // (Three.js owns it and many other systems read it).
    this._infoStart = this._snapshotRendererInfo();
    this._drawCallsAccumLast = this._infoStart?.render?.calls ?? 0;
    this._trianglesAccumLast = this._infoStart?.render?.triangles ?? 0;
    this._linesAccumLast = this._infoStart?.render?.lines ?? 0;
    this._pointsAccumLast = this._infoStart?.render?.points ?? 0;

    this._ensureQueryPool();

    this.enabled = true;

    this._startLongTaskObserver();

    // Mirror the existing pass profiler flag so __v2PassTimings is populated
    // for cross-reference in the export.
    try {
      if (window.MapShine) window.MapShine.__v2PassProfiler = true;
    } catch (_) {}

    try {
      resolveLightingEffect()?.resetPerformanceRecorderSession?.();
    } catch (_) {}

    log.info('Recording started');
  }

  /**
   * Finalize a session. Pending GPU queries are drained for up to
   * `MAX_PENDING_QUERY_AGE` frames; any that remain are recorded as missing.
   */
  stop() {
    if (!this.enabled) return;

    this._stoppedAtMs = performance.now();

    // Best-effort: try to read whatever queries are already resolvable.
    this._pumpPendingQueries({ drain: true });

    // Discard any survivors so they don't leak into the next session.
    this._abortAllPendingQueries('sessionStopped');

    this._infoEnd = this._snapshotRendererInfo();

    this._stopLongTaskObserver();

    this.enabled = false;

    // Leave __v2PassProfiler on if other tooling expects it; we did not own
    // its prior value when start() flipped it, so flipping it back off here
    // could regress other workflows. Conservative: leave as-is.

    log.info(`Recording stopped (${this._totalRecordedFrames} frames captured)`);
  }

  /**
   * Clear aggregates without ending the armed state.
   * @param {object} [options]
   * @param {boolean} [options.keepEnabled]
   */
  reset(options = {}) {
    const keepEnabled = options?.keepEnabled === true;

    this._aggregates.clear();
    this._updatables.clear();
    this._updatableCounts.clear();
    this._sequencerPhases.clear();
    this._sequencerMirrorSync.clear();
    this._frames.length = 0;
    this._frameWriteIndex = 0;
    this._continuousReasons.clear();
    this._decimationFrames = 0;
    this._totalRecordedFrames = 0;
    this._tickRecords.length = 0;
    this._tickWriteIndex = 0;
    this._totalTickRecords = 0;
    this._presentedTickCount = 0;
    this._skippedTickCount = 0;
    this._judderTransitions = 0;
    this._lastTickPresented = false;
    this._skipReasonHistogram.clear();

    this._currentFrameEffects.clear();
    this._spikeFrameDetails.length = 0;
    this._spikeWriteIndex = 0;
    this._longTasks.length = 0;

    this._abortAllPendingQueries('reset');

    this._infoStart = null;
    this._infoEnd = null;

    this._gpuDisjointEvents = 0;
    this._gpuPoolStarvations = 0;

    if (!keepEnabled) {
      this.enabled = false;
    }
  }

  // ────────────────────────────────────────────────────────────────────────
  // rAF tick hooks (called from RenderLoop every animation frame)
  // ────────────────────────────────────────────────────────────────────────

  /**
   * Begin an rAF tick record (runs even when compositor is skipped).
   * @param {number} [nowMs]
   * @returns {number|null} tick token
   */
  beginTick(nowMs = performance.now()) {
    if (!this.enabled) return null;
    return nowMs;
  }

  /**
   * End an rAF tick record.
   * @param {number|null} token - Value from {@link beginTick}
   * @param {object} [meta]
   */
  endTick(token, meta = {}) {
    if (!this.enabled || token == null) return;

    const now = performance.now();
    const presented = meta.presented === true;
    const skipReason = typeof meta.skipReason === 'string' ? meta.skipReason : (presented ? 'none' : 'unknown');
    const targetFps = Number(meta.targetFps) || 0;
    const tier = typeof meta.tier === 'string' ? meta.tier : null;
    const sinceLastPresentMs = Number(meta.sinceLastPresentMs) || 0;
    const tickMs = now - token;
    const compositorMs = Number(meta.compositorMs) || 0;
    const handlerOverheadMs = compositorMs > 0 ? Math.max(0, tickMs - compositorMs) : 0;

    if (presented) this._presentedTickCount++;
    else this._skippedTickCount++;
    this._skipReasonHistogram.set(skipReason, (this._skipReasonHistogram.get(skipReason) || 0) + 1);

    if (this._lastTickPresented !== presented) {
      this._judderTransitions++;
    }
    this._lastTickPresented = presented;

    /** @type {TickRecord} */
    const record = {
      tMs: now - this._startedAtMs,
      tickMs,
      presented,
      skipReason,
      targetFps,
      tier,
      sinceLastPresentMs,
      renderPath: meta.renderPath ?? null,
      continuousReason: meta.continuousReason ?? null,
      compositorMs: compositorMs > 0 ? compositorMs : undefined,
      handlerOverheadMs: compositorMs > 0 ? handlerOverheadMs : undefined,
    };
    this._pushTickRecord(record);
    this._totalTickRecords++;
  }

  /**
   * @param {TickRecord} record
   * @private
   */
  _pushTickRecord(record) {
    if (this._tickRecords.length < this.maxFrames) {
      this._tickRecords.push(record);
    } else {
      this._tickRecords[this._tickWriteIndex] = record;
    }
    this._tickWriteIndex = (this._tickWriteIndex + 1) % this.maxFrames;
  }

  // ────────────────────────────────────────────────────────────────────────
  // Frame hooks (called from EffectComposer.render)
  // ────────────────────────────────────────────────────────────────────────

  /**
   * Record the start of a frame.
   * @param {object} timeInfo - From TimeManager (used for frame counter).
   */
  beginFrame(timeInfo) {
    if (!this.enabled) return;

    this._frameSeq += 1;
    this._frameBeginMs = performance.now();
    this._frameDrawAccum = 0;
    this._frameTriAccum = 0;
    this._frameLinesAccum = 0;
    this._framePointsAccum = 0;

    const info = this.renderer?.info;
    this._frameBeginCalls = info?.render?.calls ?? 0;
    this._frameBeginTriangles = info?.render?.triangles ?? 0;
    this._frameBeginLines = info?.render?.lines ?? 0;
    this._frameBeginPoints = info?.render?.points ?? 0;

    this._currentFrameEffects.clear();
  }

  /**
   * Record the end of a frame and append to the timeline ring buffer.
   *
   * @param {object} [rendererInfo] - `renderer.info` reference (optional;
   *   recorder reads from its own renderer if omitted).
   * @param {string|null} [continuousReason]
   * @param {boolean} [decimationActive]
   */
  endFrame(rendererInfo, continuousReason, decimationActive) {
    if (!this.enabled) return;

    const now = performance.now();
    const deltaMs = now - this._frameBeginMs;

    const info = rendererInfo ?? this.renderer?.info ?? null;
    const calls = info?.render?.calls ?? this._frameBeginCalls;
    const tris = info?.render?.triangles ?? this._frameBeginTriangles;
    const lines = info?.render?.lines ?? this._frameBeginLines;
    const points = info?.render?.points ?? this._frameBeginPoints;

    // Prefer per-effect span sums — Three.js autoReset zeros renderer.info between
    // internal render() calls, so a whole-frame delta is usually 0.
    const drawCallsFrame = this._frameDrawAccum > 0
      ? this._frameDrawAccum
      : Math.max(0, calls - this._frameBeginCalls);
    const trianglesFrame = this._frameTriAccum > 0
      ? this._frameTriAccum
      : Math.max(0, tris - this._frameBeginTriangles);
    const linesFrame = this._frameLinesAccum > 0
      ? this._frameLinesAccum
      : Math.max(0, lines - this._frameBeginLines);
    const pointsFrame = this._framePointsAccum > 0
      ? this._framePointsAccum
      : Math.max(0, points - this._frameBeginPoints);

    this._drawCallsAccumLast = calls;
    this._trianglesAccumLast = tris;
    this._linesAccumLast = lines;
    this._pointsAccumLast = points;

    // Append to ring buffer
    const reasonKey = typeof continuousReason === 'string' && continuousReason.length > 0
      ? continuousReason
      : 'none';
    this._continuousReasons.set(reasonKey, (this._continuousReasons.get(reasonKey) || 0) + 1);
    if (decimationActive === true) this._decimationFrames += 1;
    this._totalRecordedFrames += 1;

    /** @type {FrameRecord} */
    const record = {
      seq: this._frameSeq,
      tMs: now - this._startedAtMs,
      frameTimeMs: deltaMs,
      drawCalls: drawCallsFrame,
      triangles: trianglesFrame,
      lines: linesFrame,
      points: pointsFrame,
      continuousReason: reasonKey,
      decimationActive: decimationActive === true,
    };
    this._pushFrameRecord(record);
    this._pushSpikeFrameDetailIfNeeded(record);

    // Pump GPU query results for samples completed since last frame.
    this._pumpPendingQueries();
  }

  /**
   * Push a frame record into the ring buffer.
   * @param {FrameRecord} record
   * @private
   */
  _pushFrameRecord(record) {
    if (this._frames.length < this.maxFrames) {
      this._frames.push(record);
    } else {
      this._frames[this._frameWriteIndex] = record;
    }
    this._frameWriteIndex = (this._frameWriteIndex + 1) % this.maxFrames;
  }

  /**
   * When a compositor frame exceeds the spike threshold, retain top effect spans.
   * @param {FrameRecord} record
   * @private
   */
  _pushSpikeFrameDetailIfNeeded(record) {
    const frameTimes = [];
    for (const f of this._frames) {
      if (f) frameTimes.push(f.frameTimeMs);
    }
    const p95 = percentile(frameTimes.slice(), 0.95);
    const threshold = Math.max(20, p95 * 1.5);
    if (record.frameTimeMs < threshold) return;

    const topEffects = [...this._currentFrameEffects.values()]
      .sort((a, b) => b.cpuMs - a.cpuMs)
      .slice(0, 5)
      .map(({ effect, phase, cpuMs }) => ({ effect, phase, cpuMs }));

    /** @type {{ seq: number, tMs: number, frameTimeMs: number, topEffects: object[] }} */
    const detail = {
      seq: record.seq,
      tMs: record.tMs,
      frameTimeMs: record.frameTimeMs,
      topEffects,
    };

    if (this._spikeFrameDetails.length < MAX_SPIKE_DETAILS) {
      this._spikeFrameDetails.push(detail);
    } else {
      this._spikeFrameDetails[this._spikeWriteIndex] = detail;
    }
    this._spikeWriteIndex = (this._spikeWriteIndex + 1) % MAX_SPIKE_DETAILS;
  }

  /**
   * @returns {{ stutterSummary: object, stutterEvents: object[], longTasks: object[], spikeFrameDetails: object[] }}
   * @private
   */
  _buildStutterPayload() {
    const frames = this._frames.slice();
    const ticks = this._tickRecords.slice();
    /** @type {Map<number, object>} */
    const spikeDetailsBySeq = new Map();
    for (const row of this._spikeFrameDetails) {
      if (row && Number.isFinite(row.seq)) spikeDetailsBySeq.set(row.seq, row);
    }
    const analysis = analyzeStutters(frames, ticks, {
      longTasks: this._longTasks,
      spikeDetailsBySeq,
    });
    return {
      stutterSummary: analysis.summary,
      stutterEvents: analysis.events,
      longTasks: this._longTasks.slice(),
      spikeFrameDetails: this._spikeFrameDetails.filter(Boolean),
    };
  }

  /** @private */
  _startLongTaskObserver() {
    if (this._longTaskObserver || typeof PerformanceObserver === 'undefined') return;
    try {
      this._longTaskObserver = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          const startMs = entry.startTime;
          const durationMs = entry.duration;
          let name = entry.name ?? null;
          try {
            const attr = entry.attribution?.[0];
            if (attr?.name) name = attr.name;
          } catch (_) {}
          const row = {
            startMs,
            endMs: startMs + durationMs,
            durationMs,
            name,
            tMs: performance.now() - this._startedAtMs,
          };
          if (this._longTasks.length < MAX_LONG_TASKS) {
            this._longTasks.push(row);
          } else {
            this._longTasks.shift();
            this._longTasks.push(row);
          }
        }
      });
      this._longTaskObserver.observe({ entryTypes: ['longtask'] });
    } catch (err) {
      if (!this._longTaskObserverWarned) {
        this._longTaskObserverWarned = true;
        log.info('Long-task observer unavailable:', err);
      }
    }
  }

  /** @private */
  _stopLongTaskObserver() {
    if (!this._longTaskObserver) return;
    try { this._longTaskObserver.disconnect(); } catch (_) {}
    this._longTaskObserver = null;
  }

  // ────────────────────────────────────────────────────────────────────────
  // Per-effect hot path
  // ────────────────────────────────────────────────────────────────────────

  /**
   * Begin an instrumentation span around a single effect call.
   *
   * @param {string} effectKey - Stable identifier (e.g. `'lighting'`).
   * @param {'update'|'render'} phase
   * @param {{ cpuOnly?: boolean, gpuSlot?: { index: number, count: number } }} [options]
   *   - `cpuOnly`: never acquire a GPU timer query (allows nested child spans
   *     to use the single active-query slot during this span).
   *   - `gpuSlot`: when set, only probe GPU on frames where
   *     `frameSeq % count === index` (round-robin for multi-pass effects).
   * @returns {EffectCallToken|null}
   */
  beginEffectCall(effectKey, phase, options = {}) {
    if (!this.enabled) return null;

    const info = this.renderer?.info;
    /** @type {EffectCallToken} */
    const token = {
      id: ++this._tokenSeq,
      key: effectKey || 'unknown',
      phase: phase === 'render' ? 'render' : 'update',
      frameSeq: this._frameSeq,
      cpuStart: performance.now(),
      drawsBefore: info?.render?.calls ?? 0,
      trianglesBefore: info?.render?.triangles ?? 0,
      linesBefore: info?.render?.lines ?? 0,
      pointsBefore: info?.render?.points ?? 0,
      gpuQuery: null,
      gpuWanted: false,
      gpuSlotBlocked: false,
    };

    const cpuOnly = options?.cpuOnly === true;
    const gpuSlot = options?.gpuSlot;
    const slotCount = Math.max(1, Number(gpuSlot?.count) || 0);
    const slotIndex = Math.max(0, Number(gpuSlot?.index) || 0);
    const slotOpen = !gpuSlot || ((this._frameSeq % slotCount) === slotIndex);
    token.gpuWanted = !cpuOnly && slotOpen
      && this.gpuTimingSupported
      && this.gpuTimingEnabled
      && !!this._gl
      && !!this._gpuExt;

    // WebGL2 spec: only one TIME_ELAPSED_EXT query may be active at a time.
    if (token.gpuWanted && this._activeQuery === null) {
      const q = this._acquireQuery();
      if (q) {
        try {
          this._gl.beginQuery(this._gpuExt.TIME_ELAPSED_EXT, q);
          this._activeQuery = q;
          token.gpuQuery = q;
        } catch (err) {
          // Recycle the query and continue with CPU-only timing.
          this._queryPool.push(q);
          token.gpuQuery = null;
          if (!this._gpuBeginErrorLogged) {
            this._gpuBeginErrorLogged = true;
            log.warn('beginQuery failed; falling back to CPU-only timing:', err);
          }
        }
      } else {
        this._gpuPoolStarvations += 1;
      }
    } else if (token.gpuWanted && this._activeQuery !== null) {
      token.gpuSlotBlocked = true;
    }

    return token;
  }

  /**
   * Finish an instrumentation span started with `beginEffectCall`.
   * @param {EffectCallToken|null} token
   */
  endEffectCall(token) {
    if (!this.enabled || !token) return;

    const cpuMs = performance.now() - token.cpuStart;
    const info = this.renderer?.info;
    const drawsDelta = Math.max(0, (info?.render?.calls ?? token.drawsBefore) - token.drawsBefore);
    const trianglesDelta = Math.max(0, (info?.render?.triangles ?? token.trianglesBefore) - token.trianglesBefore);
    const linesDelta = Math.max(0, (info?.render?.lines ?? token.linesBefore) - token.linesBefore);
    const pointsDelta = Math.max(0, (info?.render?.points ?? token.pointsBefore) - token.pointsBefore);

    const agg = this._getOrCreateAggregate(token.key);
    const slot = agg[token.phase];
    addSample(slot.cpuMs, cpuMs);
    addSample(slot.draws, drawsDelta);
    addSample(slot.triangles, trianglesDelta);
    addSample(slot.lines, linesDelta);
    addSample(slot.points, pointsDelta);
    if (agg.firstSeenMs === 0) agg.firstSeenMs = performance.now() - this._startedAtMs;
    agg.lastSeenMs = performance.now() - this._startedAtMs;
    if (token.gpuSlotBlocked) agg.gpuSlotBlocked += 1;

    if (token.phase === 'render' && token.frameSeq === this._frameSeq) {
      this._frameDrawAccum += drawsDelta;
      this._frameTriAccum += trianglesDelta;
      this._frameLinesAccum += linesDelta;
      this._framePointsAccum += pointsDelta;
    }

    if (token.frameSeq === this._frameSeq) {
      const effectId = `${token.key}|${token.phase}`;
      let frameRow = this._currentFrameEffects.get(effectId);
      if (!frameRow) {
        frameRow = { effect: token.key, phase: token.phase, cpuMs: 0 };
        this._currentFrameEffects.set(effectId, frameRow);
      }
      frameRow.cpuMs += cpuMs;
    }

    // Close the GPU query and queue it for deferred read. GPU result attribution
    // is deferred until `gl.getQueryParameter(QUERY_RESULT_AVAILABLE)` flips.
    if (token.gpuQuery) {
      try {
        this._gl.endQuery(this._gpuExt.TIME_ELAPSED_EXT);
        this._pendingQueries.push({
          query: token.gpuQuery,
          effectKey: token.key,
          phase: token.phase,
          frameSeq: this._frameSeq,
        });
      } catch (err) {
        // Recycle the query; sample is lost.
        this._queryPool.push(token.gpuQuery);
        if (!this._gpuEndErrorLogged) {
          this._gpuEndErrorLogged = true;
          log.warn('endQuery failed; sample dropped:', err);
        }
      } finally {
        this._activeQuery = null;
      }
    }
  }

  /**
   * Convenience wrapper used by FloorCompositor: measures a function call
   * with begin/end tokens and matches the existing try/catch pattern.
   *
   * @param {string} effectKey
   * @param {'update'|'render'} phase
   * @param {Function} fn
   * @param {string} [errorLabel] - Used only by the caller for logging on throw.
   */
  measure(effectKey, phase, fn, errorLabel) {
    if (!this.enabled) {
      try { fn(); } catch (err) {
        // Caller is responsible for its own logging; we just rethrow.
        throw err;
      }
      return;
    }
    const token = this.beginEffectCall(effectKey, phase);
    try {
      fn();
    } finally {
      this.endEffectCall(token);
    }
  }

  /**
   * Record an updatable measurement (e.g. TokenManager.update timing from
   * EffectComposer's updatables loop).
   * @param {string} name
   * @param {number} ms
   */
  recordUpdatable(name, ms) {
    if (!this.enabled || !name || !Number.isFinite(ms)) return;
    this._updatables.set(name, (this._updatables.get(name) || 0) + ms);
    this._updatableCounts.set(name, (this._updatableCounts.get(name) || 0) + 1);
  }

  /**
   * Accumulate CPU time for a Sequencer subsystem phase (`tickBefore.*`, `postPixi.*`).
   * @param {string} phase
   * @param {number} ms
   */
  recordSequencerPhase(phase, ms) {
    if (!this.enabled || !phase || !Number.isFinite(ms)) return;
    let st = this._sequencerPhases.get(phase);
    if (!st) {
      st = makeStat();
      this._sequencerPhases.set(phase, st);
    }
    addSample(st, ms);
  }

  /**
   * Record one `syncFromPixi()` invocation for a Sequencer mirror (there are
   * typically two passes per mirror per rendered frame: post-PIXI + pre-bus).
   * @param {string} adapterKey
   * @param {string|null} textureKind
   * @param {number} ms
   */
  recordSequencerMirrorSync(adapterKey, textureKind, ms) {
    if (!this.enabled || !adapterKey || !Number.isFinite(ms)) return;
    const kind = (textureKind != null && String(textureKind).length > 0)
      ? String(textureKind)
      : 'unknown';
    const compound = `${kind}|${adapterKey}`;
    let st = this._sequencerMirrorSync.get(compound);
    if (!st) {
      st = makeStat();
      this._sequencerMirrorSync.set(compound, st);
    }
    addSample(st, ms);
  }

  /**
   * Gather live Sequencer diagnostics (mirror list, EffectManager sizing) via
   * {@link globalThis.window.MapShine.externalEffects}.
   * @returns {object|null}
   */
  snapshotSequencerLive() {
    try {
      const fn = window?.MapShine?.externalEffects?.sequencer?.getPerformanceRecorderDiagnostics?.bind?.(
        window.MapShine.externalEffects.sequencer,
      );
      return typeof fn === 'function' ? fn() : null;
    } catch (_) {
      return null;
    }
  }

  // ────────────────────────────────────────────────────────────────────────
  // GPU query pool / pump
  // ────────────────────────────────────────────────────────────────────────

  /** @private */
  _ensureQueryPool() {
    if (!this.gpuTimingSupported || !this._gl) return;
    while (this._queriesOwned.length < this.queryPoolSize) {
      let q = null;
      try { q = this._gl.createQuery(); } catch (_) { q = null; }
      if (!q) break;
      this._queriesOwned.push(q);
      this._queryPool.push(q);
    }
  }

  /** @private */
  _acquireQuery() {
    if (this._queryPool.length > 0) return this._queryPool.pop();
    return null;
  }

  /** @private */
  _recycleQuery(q) {
    if (!q) return;
    this._queryPool.push(q);
  }

  /**
   * Poll pending GPU queries, attribute completed samples, and recycle.
   * Discards in-flight queries when a `GPU_DISJOINT_EXT` event is observed.
   *
   * @param {object} [options]
   * @param {boolean} [options.drain] - If true, poll until all expected
   *   queries are either resolved or aged out.
   * @private
   */
  _pumpPendingQueries(options = {}) {
    if (!this.gpuTimingSupported || !this._gl || !this._gpuExt || this._pendingQueries.length === 0) return;

    const gl = this._gl;
    const ext = this._gpuExt;

    // Disjoint events invalidate every in-flight query.
    let disjoint = false;
    try { disjoint = gl.getParameter(ext.GPU_DISJOINT_EXT) === true; } catch (_) { disjoint = false; }
    if (disjoint) {
      this._gpuDisjointEvents += 1;
      for (const pending of this._pendingQueries) {
        const agg = this._getOrCreateAggregate(pending.effectKey);
        agg.gpuDisjointDropped += 1;
        this._recycleQuery(pending.query);
      }
      this._pendingQueries.length = 0;
      return;
    }

    const drain = options?.drain === true;
    const maxPasses = drain ? MAX_PENDING_QUERY_AGE + 2 : 1;

    for (let pass = 0; pass < maxPasses; pass++) {
      const survivors = [];
      for (const pending of this._pendingQueries) {
        let available = false;
        try { available = gl.getQueryParameter(pending.query, gl.QUERY_RESULT_AVAILABLE) === true; } catch (_) {}

        if (available) {
          let resultNs = 0;
          try { resultNs = gl.getQueryParameter(pending.query, gl.QUERY_RESULT); } catch (_) { resultNs = 0; }
          const gpuMs = Number(resultNs) / 1e6;
          const agg = this._getOrCreateAggregate(pending.effectKey);
          addSample(agg[pending.phase].gpuMs, gpuMs);
          this._recycleQuery(pending.query);
          continue;
        }

        const age = this._frameSeq - pending.frameSeq;
        if (age > MAX_PENDING_QUERY_AGE) {
          const agg = this._getOrCreateAggregate(pending.effectKey);
          agg.gpuMissingPool += 1;
          this._recycleQuery(pending.query);
          continue;
        }

        survivors.push(pending);
      }
      this._pendingQueries = survivors;
      if (!drain || survivors.length === 0) break;
    }
  }

  /**
   * @param {string} reason
   * @private
   */
  _abortAllPendingQueries(reason) {
    if (this._pendingQueries.length === 0 && this._activeQuery === null) return;
    for (const pending of this._pendingQueries) {
      this._recycleQuery(pending.query);
    }
    this._pendingQueries.length = 0;
    if (this._activeQuery && this._gl && this._gpuExt) {
      try { this._gl.endQuery(this._gpuExt.TIME_ELAPSED_EXT); } catch (_) {}
      this._recycleQuery(this._activeQuery);
      this._activeQuery = null;
    }
    log.debug(`Aborted pending GPU queries (${reason})`);
  }

  // ────────────────────────────────────────────────────────────────────────
  // Snapshot / export
  // ────────────────────────────────────────────────────────────────────────

  /**
   * @returns {EffectAggregate}
   * @private
   */
  _getOrCreateAggregate(key) {
    let agg = this._aggregates.get(key);
    if (!agg) {
      agg = makeEffectAggregate();
      this._aggregates.set(key, agg);
    }
    return agg;
  }

  /**
   * Take a snapshot of renderer.info as plain JSON.
   * @returns {object|null}
   * @private
   */
  _snapshotRendererInfo() {
    try {
      const info = this.renderer?.info;
      if (!info) return null;
      return {
        render: info.render
          ? {
              calls: info.render.calls,
              triangles: info.render.triangles,
              lines: info.render.lines,
              points: info.render.points,
              frame: info.render.frame,
            }
          : null,
        memory: info.memory
          ? {
              geometries: info.memory.geometries,
              textures: info.memory.textures,
            }
          : null,
        programs: Array.isArray(info.programs) ? info.programs.length : null,
      };
    } catch (_) {
      return null;
    }
  }

  /**
   * Build the live snapshot consumed by the dialog. Computed on-demand so the
   * dialog can poll at any rate without the hot path doing extra work.
   *
   * @returns {PerformanceSnapshot}
   */
  getSnapshot() {
    const now = performance.now();
    const durationMs = this.enabled
      ? Math.max(0, now - this._startedAtMs)
      : (this._stoppedAtMs > 0 ? this._stoppedAtMs - this._startedAtMs : 0);

    /** @type {EffectSnapshotRow[]} */
    const effects = [];
    for (const [key, agg] of this._aggregates.entries()) {
      for (const phase of /** @type {const} */ (['update', 'render'])) {
        const slot = agg[phase];
        if (slot.cpuMs.count === 0 && slot.gpuMs.count === 0) continue;
        effects.push({
          effect: key,
          phase,
          cpuLast: slot.cpuMs.last,
          cpuAvg: statAvg(slot.cpuMs),
          cpuMax: slot.cpuMs.max,
          cpuTotal: slot.cpuMs.total,
          cpuCount: slot.cpuMs.count,
          gpuLast: slot.gpuMs.last,
          gpuAvg: statAvg(slot.gpuMs),
          gpuMax: slot.gpuMs.max,
          gpuTotal: slot.gpuMs.total,
          gpuCount: slot.gpuMs.count,
          drawCallsAvg: statAvg(slot.draws),
          trianglesAvg: statAvg(slot.triangles),
          linesAvg: statAvg(slot.lines),
          pointsAvg: statAvg(slot.points),
          gpuDisjointDropped: agg.gpuDisjointDropped,
          gpuMissing: agg.gpuMissingPool,
          gpuBlocked: agg.gpuSlotBlocked,
        });
      }
    }

    const sequencerZeroGpuExtras = () => ({
      gpuLast: 0,
      gpuAvg: 0,
      gpuMax: 0,
      gpuTotal: 0,
      gpuCount: 0,
      drawCallsAvg: 0,
      trianglesAvg: 0,
      linesAvg: 0,
      pointsAvg: 0,
      gpuDisjointDropped: 0,
      gpuMissing: 0,
      gpuBlocked: 0,
    });

    /** @type {{ phase: string, lastMs: number, avgMs: number, maxMs: number, totalMs: number, count: number }[]} */
    const sequencerPhasesDetailed = [];
    for (const [phase, st] of this._sequencerPhases.entries()) {
      if (st.count === 0) continue;
      effects.push({
        effect: `sequencer › ${phase}`,
        phase: 'cpu',
        cpuLast: st.last,
        cpuAvg: statAvg(st),
        cpuMax: st.max,
        cpuTotal: st.total,
        cpuCount: st.count,
        ...sequencerZeroGpuExtras(),
      });
      sequencerPhasesDetailed.push({
        phase,
        lastMs: st.last,
        avgMs: statAvg(st),
        maxMs: st.max,
        totalMs: st.total,
        count: st.count,
      });
    }
    sequencerPhasesDetailed.sort((a, b) => b.totalMs - a.totalMs);

    /** @type {{ textureKind: string, adapterKey: string, lastMs: number, avgMs: number, maxMs: number, totalMs: number, count: number }[]} */
    const sequencerMirrorsDetailed = [];
    for (const [compound, st] of this._sequencerMirrorSync.entries()) {
      if (st.count === 0) continue;
      const pipeIdx = compound.indexOf('|');
      const textureKind = pipeIdx >= 0 ? compound.slice(0, pipeIdx) : 'unknown';
      const adapterKey = pipeIdx >= 0 ? compound.slice(pipeIdx + 1) : compound;
      effects.push({
        effect: `seqMirror › ${textureKind} › ${adapterKey}`,
        phase: 'sync',
        cpuLast: st.last,
        cpuAvg: statAvg(st),
        cpuMax: st.max,
        cpuTotal: st.total,
        cpuCount: st.count,
        ...sequencerZeroGpuExtras(),
      });
      sequencerMirrorsDetailed.push({
        textureKind,
        adapterKey,
        lastMs: st.last,
        avgMs: statAvg(st),
        maxMs: st.max,
        totalMs: st.total,
        count: st.count,
      });
    }
    sequencerMirrorsDetailed.sort((a, b) => b.totalMs - a.totalMs);

    const sequencer = {
      note:
        'Sequencer mirrors call syncFromPixi once immediately before FloorRenderBus '
        + 'renders (`tickBeforeBus`), so profiling counts scale roughly with compositor FPS × mirror '
        + 'count. Legacy post-PIX `syncFromPixi` repeats work every PIXI tick when '
        + '`MapShine.__sequencerMirrorLegacyPostPixiSync` is set (profiles as postPixi.syncFromPixi.loop). ',
      phases: sequencerPhasesDetailed,
      mirrors: sequencerMirrorsDetailed,
      live: this.snapshotSequencerLive(),
    };

    // Frame-time / FPS percentiles (1-second buckets).
    const frameTimes = [];
    const fpsBuckets = new Map();
    const startedAt = this._startedAtMs;
    for (const f of this._frames) {
      if (!f) continue;
      frameTimes.push(f.frameTimeMs);
      const secBucket = Math.floor(((startedAt + f.tMs) - startedAt) / 1000);
      fpsBuckets.set(secBucket, (fpsBuckets.get(secBucket) || 0) + 1);
    }
    const fpsValues = Array.from(fpsBuckets.values());

    const updatables = [];
    for (const [name, total] of this._updatables.entries()) {
      const count = this._updatableCounts.get(name) || 0;
      updatables.push({
        name,
        totalMs: total,
        count,
        avgMs: count > 0 ? total / count : 0,
      });
    }
    updatables.sort((a, b) => b.totalMs - a.totalMs);

    const continuousReasons = {};
    for (const [reason, n] of this._continuousReasons.entries()) {
      continuousReasons[reason] = n;
    }

    const skipReasons = {};
    for (const [reason, n] of this._skipReasonHistogram.entries()) {
      skipReasons[reason] = n;
    }
    const tickTotal = Math.max(1, this._totalTickRecords);
    const overBudgetTicks = this._tickRecords.filter((t) => t && t.presented && t.tickMs > 34).length;
    const durationSec = Math.max(0.001, durationMs / 1000);
    const judderPerSec = this._judderTransitions / durationSec;

    let v2PassTimings = null;
    try {
      v2PassTimings = window?.MapShine?.__v2PassTimings ?? null;
    } catch (_) {}

    let vramBudget = null;
    try {
      const tracker = window?.MapShine?.textureBudgetTracker;
      if (tracker && typeof tracker.getBudgetState === 'function') {
        vramBudget = tracker.getBudgetState();
      }
    } catch (_) {}

    let cloudShadowCache = null;
    try {
      const cloud = window?.MapShine?.effectComposer?._floorCompositorV2?._cloudEffect
        ?? window?.MapShine?.floorCompositorV2?._cloudEffect
        ?? window?.MapShine?.cloudEffectV2;
      if (cloud && typeof cloud.getShadowCacheStats === 'function') {
        cloudShadowCache = cloud.getShadowCacheStats();
      }
    } catch (_) {}

    const infoCurrent = this._snapshotRendererInfo();
    const avgDrawCallsPerFrame = this._totalRecordedFrames > 0
      ? frameTimes.length > 0
        ? this._frames.reduce((sum, f) => sum + (f?.drawCalls ?? 0), 0) / this._frames.length
        : 0
      : 0;
    const avgTrianglesPerFrame = this._totalRecordedFrames > 0 && this._frames.length > 0
      ? this._frames.reduce((sum, f) => sum + (f?.triangles ?? 0), 0) / this._frames.length
      : 0;

    const stutterPayload = this._buildStutterPayload();

    let lighting = null;
    try {
      lighting = buildLightingPerfSection({
        effects,
        v2PassTimings,
        session: {
          frameTime: {
            avg: frameTimes.length > 0 ? frameTimes.reduce((s, v) => s + v, 0) / frameTimes.length : 0,
          },
        },
      });
    } catch (_) {}

    let worldOverlays = null;
    try {
      worldOverlays = buildWorldOverlaysPerfSection({
        effects,
        v2PassTimings,
        session: {
          frameTime: {
            avg: frameTimes.length > 0 ? frameTimes.reduce((s, v) => s + v, 0) / frameTimes.length : 0,
          },
        },
      });
    } catch (_) {}

    const sessionFrameTime = {
      p50: percentile(frameTimes.slice(), 0.5),
      p95: percentile(frameTimes.slice(), 0.95),
      p99: percentile(frameTimes.slice(), 0.99),
      max: frameTimes.reduce((m, v) => Math.max(m, v), 0),
      avg: frameTimes.length > 0 ? frameTimes.reduce((s, v) => s + v, 0) / frameTimes.length : 0,
    };
    const sessionFps = {
      p05: percentile(fpsValues.slice(), 0.05),
      p50: percentile(fpsValues.slice(), 0.5),
      p95: percentile(fpsValues.slice(), 0.95),
      min: fpsValues.length > 0 ? Math.min.apply(null, fpsValues) : 0,
      max: fpsValues.length > 0 ? Math.max.apply(null, fpsValues) : 0,
      avg: fpsValues.length > 0 ? fpsValues.reduce((s, v) => s + v, 0) / fpsValues.length : 0,
    };

    let frameBudget = null;
    try {
      frameBudget = buildFrameBudgetSection({
        effects,
        session: { frameTime: sessionFrameTime, fps: sessionFps },
        stutterSummary: stutterPayload.stutterSummary,
        meta: { context: this._collectContext() },
      });
    } catch (_) {}

    return {
      meta: {
        enabled: this.enabled,
        durationMs,
        framesRecorded: this._totalRecordedFrames,
        framesBuffered: this._frames.length,
        gpuTiming: this.getGpuTimingState(),
        gpuDisjointEvents: this._gpuDisjointEvents,
        gpuPoolStarvations: this._gpuPoolStarvations,
        startedAtWallClockMs: this._startedAtWallClockMs,
        context: this._collectContext(),
      },
      session: {
        frameTime: sessionFrameTime,
        fps: sessionFps,
        continuousReasons,
        decimationActivePct: this._totalRecordedFrames > 0
          ? (this._decimationFrames / this._totalRecordedFrames) * 100
          : 0,
        avgDrawCallsPerFrame,
        avgTrianglesPerFrame,
        pacing: {
          ticksRecorded: this._totalTickRecords,
          presentedPct: (this._presentedTickCount / tickTotal) * 100,
          skippedPct: (this._skippedTickCount / tickTotal) * 100,
          judderTransitions: this._judderTransitions,
          judderPerSec,
          overBudgetPresentPct: this._presentedTickCount > 0
            ? (overBudgetTicks / this._presentedTickCount) * 100
            : 0,
          skipReasons,
        },
      },
      effects,
      updatables,
      sequencer,
      v2PassTimings,
      vramBudget,
      cloudShadowCache,
      lighting,
      worldOverlays,
      frameBudget,
      rendererInfo: {
        start: this._infoStart,
        current: infoCurrent,
      },
      ...stutterPayload,
    };
  }

  /**
   * Build a JSON export blob and trigger a browser download.
   * @param {{ mode?: 'summary'|'full' }} [options] - Default `summary` (grouped effects, no timelines).
   * @returns {{ blob: Blob, filename: string }}
   */
  exportJson(options = {}) {
    const mode = resolveExportMode(options);
    const payload = mode === 'full'
      ? buildFullPayload(this)
      : buildSummaryPayload(this);
    const json = JSON.stringify(payload, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const filename = buildExportFilename(this, mode);
    this._triggerDownload(blob, filename);
    return { blob, filename };
  }

  /**
   * Build a CSV export. The file contains a "per-effect" section followed by
   * a "frame timeline" section so it can be loaded into a spreadsheet either
   * by skipping rows or by splitting on the marker line.
   *
   * @returns {{ blob: Blob, filename: string }}
   */
  exportCsv() {
    const snapshot = this.getSnapshot();
    const lines = [];

    lines.push('# Map Shine Advanced Performance Recorder Export');
    lines.push(`# generatedAt,${new Date().toISOString()}`);
    lines.push(`# durationMs,${snapshot.meta.durationMs.toFixed(2)}`);
    lines.push(`# framesRecorded,${snapshot.meta.framesRecorded}`);
    lines.push(`# gpuTimingSupported,${snapshot.meta.gpuTiming.supported}`);
    lines.push(`# gpuTimingEnabled,${snapshot.meta.gpuTiming.enabled}`);
    lines.push(`# gpuDisjointEvents,${snapshot.meta.gpuDisjointEvents}`);
    lines.push(`# gpuPoolStarvations,${snapshot.meta.gpuPoolStarvations}`);
    lines.push('');

    lines.push('## section,per-effect');
    lines.push([
      'effect', 'phase',
      'cpu_avg_ms', 'cpu_max_ms', 'cpu_last_ms', 'cpu_total_ms', 'cpu_count',
      'gpu_avg_ms', 'gpu_max_ms', 'gpu_last_ms', 'gpu_total_ms', 'gpu_count',
      'draws_avg', 'triangles_avg', 'lines_avg', 'points_avg',
      'gpu_disjoint_dropped', 'gpu_missing',
    ].join(','));
    const sortedEffects = snapshot.effects.slice().sort((a, b) =>
      (b.cpuAvg + b.gpuAvg) - (a.cpuAvg + a.gpuAvg)
    );
    for (const row of sortedEffects) {
      lines.push([
        csvEscape(row.effect), row.phase,
        row.cpuAvg.toFixed(4), row.cpuMax.toFixed(4), row.cpuLast.toFixed(4), row.cpuTotal.toFixed(4), row.cpuCount,
        row.gpuAvg.toFixed(4), row.gpuMax.toFixed(4), row.gpuLast.toFixed(4), row.gpuTotal.toFixed(4), row.gpuCount,
        row.drawCallsAvg.toFixed(2), row.trianglesAvg.toFixed(0), row.linesAvg.toFixed(0), row.pointsAvg.toFixed(0),
        row.gpuDisjointDropped, row.gpuMissing,
      ].join(','));
    }
    lines.push('');

    lines.push('## section,updatables');
    lines.push(['updatable', 'count', 'avg_ms', 'total_ms'].join(','));
    for (const u of snapshot.updatables) {
      lines.push([csvEscape(u.name), u.count, u.avgMs.toFixed(4), u.totalMs.toFixed(4)].join(','));
    }
    lines.push('');

    const lighting = snapshot.lighting;
    if (lighting?.spans?.length) {
      lines.push('## section,lighting-spans');
      lines.push([
        'span', 'phase', 'cpu_avg_ms', 'cpu_max_ms', 'cpu_total_ms', 'cpu_count',
        'gpu_avg_ms', 'gpu_max_ms', 'gpu_total_ms', 'gpu_count',
        'draws_avg', 'triangles_avg', 'gpu_blocked',
      ].join(','));
      for (const row of lighting.spans) {
        lines.push([
          csvEscape(row.span), csvEscape(row.phase),
          Number(row.cpuAvg ?? 0).toFixed(4), Number(row.cpuMax ?? 0).toFixed(4),
          Number(row.cpuTotal ?? 0).toFixed(4), Number(row.cpuCount ?? 0),
          Number(row.gpuAvg ?? 0).toFixed(4), Number(row.gpuMax ?? 0).toFixed(4),
          Number(row.gpuTotal ?? 0).toFixed(4), Number(row.gpuCount ?? 0),
          Number(row.drawCallsAvg ?? 0).toFixed(2), Number(row.trianglesAvg ?? 0).toFixed(0),
          Number(row.gpuBlocked ?? 0),
        ].join(','));
      }
      lines.push('');
    }

    const seq = snapshot.sequencer ?? {
      phases: [],
      mirrors: [],
      note: '',
    };

    lines.push('## section,sequencer-phases');
    lines.push(['phase', 'avg_ms', 'max_ms', 'last_ms', 'total_ms', 'call_count'].join(','));
    for (const row of seq.phases ?? []) {
      lines.push([
        csvEscape(row.phase),
        Number(row.avgMs ?? 0).toFixed(4),
        Number(row.maxMs ?? 0).toFixed(4),
        Number(row.lastMs ?? 0).toFixed(4),
        Number(row.totalMs ?? 0).toFixed(4),
        Number(row.count ?? 0),
      ].join(','));
    }
    lines.push('');

    lines.push('## section,sequencer-mirrors');
    lines.push(['texture_kind', 'adapter_key', 'avg_ms', 'max_ms', 'last_ms', 'total_ms', 'invoke_count'].join(','));
    for (const row of seq.mirrors ?? []) {
      lines.push([
        csvEscape(row.textureKind),
        csvEscape(row.adapterKey),
        Number(row.avgMs ?? 0).toFixed(4),
        Number(row.maxMs ?? 0).toFixed(4),
        Number(row.lastMs ?? 0).toFixed(4),
        Number(row.totalMs ?? 0).toFixed(4),
        Number(row.count ?? 0),
      ].join(','));
    }
    lines.push('');

    lines.push('## section,continuous-reasons');
    lines.push(['reason', 'frame_count'].join(','));
    for (const [reason, count] of Object.entries(snapshot.session.continuousReasons)) {
      lines.push([csvEscape(reason), count].join(','));
    }
    lines.push('');

    lines.push('## section,v2-pass-timings');
    lines.push(['pass', 'avg_ms', 'last_ms', 'count', 'total_ms'].join(','));
    const passTimings = snapshot.v2PassTimings ?? {};
    for (const [name, data] of Object.entries(passTimings)) {
      lines.push([
        csvEscape(name),
        Number(data?.avg ?? 0).toFixed(4),
        Number(data?.last ?? 0).toFixed(4),
        Number(data?.count ?? 0),
        Number(data?.total ?? 0).toFixed(4),
      ].join(','));
    }
    lines.push('');

    lines.push('## section,tick-timeline');
    lines.push([
      't_ms', 'tick_ms', 'presented', 'skip_reason', 'target_fps', 'since_last_present_ms',
      'compositor_ms', 'handler_overhead_ms', 'render_path', 'continuous_reason',
    ].join(','));
    for (const t of this._tickRecords) {
      if (!t) continue;
      lines.push([
        t.tMs.toFixed(2),
        t.tickMs.toFixed(3),
        t.presented ? 1 : 0,
        csvEscape(t.skipReason),
        t.targetFps,
        t.sinceLastPresentMs.toFixed(2),
        t.compositorMs != null ? t.compositorMs.toFixed(3) : '',
        t.handlerOverheadMs != null ? t.handlerOverheadMs.toFixed(3) : '',
        csvEscape(t.renderPath ?? ''),
        csvEscape(t.continuousReason ?? ''),
      ].join(','));
    }
    lines.push('');

    lines.push('## section,stutter-events');
    lines.push([
      'kind', 'severity', 't_ms', 'seq', 'gap_ms', 'tick_ms', 'frame_time_ms',
      'since_last_present_ms', 'continuous_reason',
    ].join(','));
    for (const ev of snapshot.stutterEvents ?? []) {
      lines.push([
        csvEscape(ev.kind),
        csvEscape(ev.severity),
        Number(ev.tMs ?? 0).toFixed(2),
        ev.seq ?? '',
        ev.gapMs != null ? Number(ev.gapMs).toFixed(2) : '',
        ev.tickMs != null ? Number(ev.tickMs).toFixed(3) : '',
        ev.frameTimeMs != null ? Number(ev.frameTimeMs).toFixed(3) : '',
        ev.sinceLastPresentMs != null ? Number(ev.sinceLastPresentMs).toFixed(2) : '',
        csvEscape(ev.continuousReason ?? ''),
      ].join(','));
    }
    lines.push('');

    lines.push('## section,long-tasks');
    lines.push(['start_ms', 'duration_ms', 'name', 't_ms'].join(','));
    for (const lt of snapshot.longTasks ?? []) {
      lines.push([
        Number(lt.startMs ?? 0).toFixed(2),
        Number(lt.durationMs ?? 0).toFixed(2),
        csvEscape(lt.name ?? ''),
        Number(lt.tMs ?? 0).toFixed(2),
      ].join(','));
    }
    lines.push('');

    lines.push('## section,spike-frame-details');
    lines.push(['seq', 't_ms', 'frame_time_ms', 'top_effects_json'].join(','));
    for (const row of snapshot.spikeFrameDetails ?? []) {
      lines.push([
        row.seq,
        Number(row.tMs ?? 0).toFixed(2),
        Number(row.frameTimeMs ?? 0).toFixed(3),
        csvEscape(JSON.stringify(row.topEffects ?? [])),
      ].join(','));
    }
    lines.push('');

    lines.push('## section,frame-timeline');
    lines.push([
      'seq', 't_ms', 'frame_time_ms', 'draw_calls', 'triangles', 'lines', 'points',
      'continuous_reason', 'decimation_active',
    ].join(','));
    for (const f of this._frames) {
      if (!f) continue;
      lines.push([
        f.seq,
        f.tMs.toFixed(2),
        f.frameTimeMs.toFixed(3),
        f.drawCalls,
        f.triangles,
        f.lines,
        f.points,
        csvEscape(f.continuousReason),
        f.decimationActive ? 1 : 0,
      ].join(','));
    }

    const blob = new Blob([lines.join('\n')], { type: 'text/csv' });
    const filename = this._buildFilename('csv');
    this._triggerDownload(blob, filename);
    return { blob, filename };
  }

  /**
   * Build actionable insights for the current session.
   * @returns {import('./performance-recorder-insights.js').PerformanceInsight[]}
   */
  getInsights() {
    return buildPerformanceInsights(
      this.getSnapshot(),
      this._frames.slice(),
      this._tickRecords.slice(),
    );
  }

  /**
   * Build a human-readable markdown report (also used by Copy report).
   * @returns {string}
   */
  buildMarkdownReport() {
    const snapshot = this.getSnapshot();
    const frames = this._frames.slice();
    const ticks = this._tickRecords.slice();
    const insights = buildPerformanceInsights(snapshot, frames, ticks);
    const ctx = snapshot.meta?.context ?? {};
    const session = snapshot.session ?? {};
    const ft = session.frameTime ?? {};
    const fps = session.fps ?? {};

    const lines = [];
    lines.push('# Map Shine Performance Report');
    lines.push('');
    lines.push(`**Generated:** ${new Date().toISOString()}`);
    lines.push(`**Duration:** ${(snapshot.meta.durationMs / 1000).toFixed(2)}s · **Frames:** ${snapshot.meta.framesRecorded}`);
    if (ctx.sceneName || ctx.sceneId) {
      lines.push(`**Scene:** ${ctx.sceneName ?? '?'} (${ctx.sceneId ?? '?'})`);
    }
    if (ctx.presetId) lines.push(`**Preset:** ${ctx.presetId}`);
    if (ctx.viewport) {
      lines.push(`**Viewport:** ${ctx.viewport.w}×${ctx.viewport.h} @ ${ctx.viewport.dpr}x DPR`);
    }
    if (ctx.targetFps) lines.push(`**Target FPS:** ${ctx.targetFps} (${ctx.tier ?? 'tier unknown'})`);
    lines.push('');
    lines.push('## Summary');
    lines.push(`- FPS avg **${(fps.avg ?? 0).toFixed(1)}** (p05 ${(fps.p05 ?? 0).toFixed(0)}, p50 ${(fps.p50 ?? 0).toFixed(0)})`);
    lines.push(`- Frame time avg **${(ft.avg ?? 0).toFixed(2)} ms** (p95 ${(ft.p95 ?? 0).toFixed(2)}, max ${(ft.max ?? 0).toFixed(2)})`);
    lines.push(`- Draws/frame **${Math.round(session.avgDrawCallsPerFrame ?? 0)}** · Tris/frame **${Math.round(session.avgTrianglesPerFrame ?? 0)}**`);
    const reasons = session.continuousReasons ?? {};
    const topReason = Object.entries(reasons).sort((a, b) => b[1] - a[1])[0];
    if (topReason) lines.push(`- Top continuous reason: **${topReason[0]}** (${topReason[1]} frames)`);
    const pacing = session.pacing ?? {};
    if (pacing.overBudgetPresentPct > 0) {
      lines.push(`- Over-budget rAF ticks: **${pacing.overBudgetPresentPct.toFixed(1)}%** (>34 ms)`);
    }
    lines.push('');
    lines.push('## Key findings');
    lines.push(formatInsightsMarkdown(insights));
    const stutterSummary = snapshot.stutterSummary ?? {};
    const stutterCounts = stutterSummary.countsByKind ?? {};
    const stutterEvents = snapshot.stutterEvents ?? [];
    if (Object.keys(stutterCounts).length > 0) {
      lines.push('## Stutter summary');
      const countParts = Object.entries(stutterCounts)
        .map(([k, v]) => `${k}: ${v}`)
        .join(', ');
      lines.push(`- Events by kind: ${countParts}`);
      const rafGap = stutterSummary.rafGapMs ?? {};
      const presentGap = stutterSummary.sinceLastPresentMs ?? {};
      if (rafGap.count > 0) lines.push(`- rAF gap p95 **${(rafGap.p95 ?? 0).toFixed(2)} ms** (max ${(rafGap.max ?? 0).toFixed(2)} ms)`);
      if (presentGap.count > 0) lines.push(`- Present spacing p95 **${(presentGap.p95 ?? 0).toFixed(2)} ms**`);
      if (stutterEvents.length > 0) {
        lines.push('');
        lines.push('### Worst stutter events');
        for (const ev of stutterEvents.slice(0, 10)) {
          const ms = ev.gapMs ?? ev.frameTimeMs ?? ev.tickMs ?? ev.sinceLastPresentMs ?? 0;
          lines.push(`- **${ev.kind}** @ ${(ev.tMs / 1000).toFixed(2)}s (${ms.toFixed(2)} ms)${ev.seq != null ? ` frame #${ev.seq}` : ''}`);
          if (ev.topEffects?.length) {
            const tops = ev.topEffects.slice(0, 3).map((e) => `${e.effect}/${e.phase} ${e.cpuMs.toFixed(2)}ms`).join(', ');
            lines.push(`  - top effects: ${tops}`);
          }
          if (ev.longTasks?.length) {
            const lt = ev.longTasks[0];
            lines.push(`  - long task: ${lt.durationMs.toFixed(1)} ms${lt.name ? ` (${lt.name})` : ''}`);
          }
        }
      }
      lines.push('');
    }
    lines.push('## Top effects (by CPU total)');
    lines.push('| Effect | Phase | CPU total ms | GPU total ms | Cost/call ms |');
    lines.push('| --- | --- | ---: | ---: | ---: |');
    const sorted = (snapshot.effects ?? []).slice().sort((a, b) => b.cpuTotal - a.cpuTotal).slice(0, 10);
    for (const row of sorted) {
      const cost = (row.cpuAvg + row.gpuAvg).toFixed(3);
      lines.push(`| ${row.effect} | ${row.phase} | ${row.cpuTotal.toFixed(1)} | ${row.gpuTotal.toFixed(2)} | ${cost} |`);
    }
    lines.push('');
    lines.push('## V2 pass timings (top 5 by avg)');
    const passes = Object.entries(snapshot.v2PassTimings ?? {})
      .map(([name, data]) => ({ name, avg: data?.avg ?? 0, total: data?.total ?? 0 }))
      .sort((a, b) => b.avg - a.avg)
      .slice(0, 5);
    if (passes.length) {
      for (const p of passes) {
        lines.push(`- **${p.name}:** ${p.avg.toFixed(2)} ms avg (${p.total.toFixed(1)} ms total)`);
      }
    } else {
      lines.push('_No pass timing data._');
    }
    lines.push('');
    const cache = snapshot.cloudShadowCache;
    if (cache) {
      lines.push('## Cloud shadow cache');
      lines.push(`- Raw hit **${(cache.rawHitPct ?? 0).toFixed(1)}%** · mask hit **${(cache.maskHitPct ?? 0).toFixed(1)}%** · last miss: ${cache.lastMissReason ?? 'n/a'}`);
      lines.push('');
    }
    const lighting = snapshot.lighting;
    if (lighting) {
      lines.push('## Lighting (performance)');
      const live = lighting.live ?? {};
      const counts = live.sourceCounts ?? {};
      lines.push(`- Sources: **${counts.foundryLights ?? '?'}** lights (**${counts.visibleLights ?? '?'}** visible), **${counts.foundryDarkness ?? '?'}** darkness (**${counts.visibleDarkness ?? '?'}** visible)`);
      if (live.estimatedRtVramMb != null) {
        lines.push(`- Estimated lighting RT VRAM: **${live.estimatedRtVramMb.toFixed(1)} MB**`);
      }
      const scales = live.resolutionScales ?? {};
      if (scales.internalLightResolutionScale != null) {
        lines.push(`- RT scales: light **${scales.internalLightResolutionScale}** · window **${scales.internalWindowResolutionScale}** · darkness **${scales.internalDarknessResolutionScale}**`);
      }
      const topSpans = (lighting.spans ?? []).slice(0, 5);
      if (topSpans.length) {
        const spanList = topSpans.map((s) => `${s.span} cpu ${(s.cpuTotal ?? 0).toFixed(1)} gpu ${(s.gpuTotal ?? 0).toFixed(1)}`).join('; ');
        lines.push(`- Heaviest spans: ${spanList}`);
      }
      const passes = lighting.passes ?? [];
      if (passes.length) {
        lines.push(`- Compositor passes: ${passes.map((p) => `${p.pass} ${(p.avg ?? 0).toFixed(2)} ms avg`).join('; ')}`);
      }
      lines.push('');
    }
    const vram = snapshot.vramBudget;
    if (vram) {
      const usedMb = (vram.usedBytes ?? 0) / 1024 / 1024;
      const budgetMb = (vram.budgetBytes ?? 0) / 1024 / 1024;
      lines.push('## VRAM budget');
      lines.push(`- ${usedMb.toFixed(1)} / ${budgetMb.toFixed(0)} MB (${((vram.usedFraction ?? 0) * 100).toFixed(1)}%)`);
      lines.push('');
    }
    const gpu = snapshot.meta.gpuTiming;
    lines.push('---');
    lines.push(`GPU timing: ${gpu?.supported ? (gpu.enabled ? 'enabled' : 'disabled') : 'unsupported'} · disjoints ${snapshot.meta.gpuDisjointEvents} · pool starvations ${snapshot.meta.gpuPoolStarvations}`);
    if (ctx.moduleVersion) lines.push(`Map Shine Advanced v${ctx.moduleVersion}`);
    return lines.join('\n');
  }

  /**
   * Export markdown report and trigger download.
   * @returns {{ blob: Blob, filename: string, text: string }}
   */
  exportMarkdown() {
    const text = this.buildMarkdownReport();
    const blob = new Blob([text], { type: 'text/markdown;charset=utf-8' });
    const filename = this._buildFilename('md');
    this._triggerDownload(blob, filename);
    return { blob, filename, text };
  }

  /**
   * Read-only scene / viewport context for export metadata.
   * @returns {object}
   * @private
   */
  _collectContext() {
    /** @type {Record<string, unknown>} */
    const ctx = {
      moduleVersion: this._moduleVersion,
    };
    try {
      const scene = globalThis.canvas?.scene ?? game?.scenes?.active ?? null;
      if (scene) {
        ctx.sceneId = scene.id ?? null;
        ctx.sceneName = scene.name ?? null;
        try {
          const preset = scene.getFlag?.('map-shine-advanced', 'activePresetId');
          if (typeof preset === 'string' && preset.trim()) ctx.presetId = preset.trim();
        } catch (_) {}
      }
    } catch (_) {}
    try {
      const ps = window?.MapShine?.__presentationState;
      if (ps) {
        ctx.targetFps = ps.targetFps ?? null;
        ctx.tier = ps.tier ?? null;
        ctx.continuousReason = ps.continuousReason ?? null;
      }
    } catch (_) {}
    try {
      const ms = window?.MapShine;
      if (ms) {
        ctx.fpsSettings = {
          idleFps: ms.renderIdleFps ?? null,
          activeFps: ms.renderActiveFps ?? null,
          presentationFps: ms.renderPresentationFps ?? null,
          continuousFps: ms.renderContinuousFps ?? null,
        };
      }
    } catch (_) {}
    try {
      const el = document.getElementById('board') ?? document.querySelector('#board canvas');
      const w = el?.clientWidth ?? window.innerWidth;
      const h = el?.clientHeight ?? window.innerHeight;
      ctx.viewport = {
        w: Math.round(w),
        h: Math.round(h),
        dpr: window.devicePixelRatio ?? 1,
      };
    } catch (_) {}
    try {
      const floors = window?.MapShine?.floorStack?.getFloors?.();
      ctx.activeFloorCount = Array.isArray(floors) ? floors.length : null;
    } catch (_) {}
    return ctx;
  }

  /**
   * @param {string} ext
   * @returns {string}
   * @private
   */
  _buildFilename(ext) {
    const wall = this._startedAtWallClockMs || Date.now();
    const d = new Date(wall);
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    const hh = String(d.getHours()).padStart(2, '0');
    const mi = String(d.getMinutes()).padStart(2, '0');
    const ss = String(d.getSeconds()).padStart(2, '0');
    return `map-shine-perf-${yyyy}${mm}${dd}-${hh}${mi}${ss}.${ext}`;
  }

  /**
   * @param {Blob} blob
   * @param {string} filename
   * @private
   */
  _triggerDownload(blob, filename) {
    try {
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      a.style.display = 'none';
      document.body.appendChild(a);
      a.click();
      setTimeout(() => {
        try { a.remove(); } catch (_) {}
        try { URL.revokeObjectURL(url); } catch (_) {}
      }, 1000);
    } catch (err) {
      log.warn('Download trigger failed:', err);
    }
  }

  /**
   * Free GPU resources. Called only on full teardown (canvas destroy).
   */
  dispose() {
    this._stopLongTaskObserver();
    this._abortAllPendingQueries('dispose');
    if (this._gl) {
      for (const q of this._queriesOwned) {
        try { this._gl.deleteQuery(q); } catch (_) {}
      }
    }
    this._queriesOwned.length = 0;
    this._queryPool.length = 0;
    this._aggregates.clear();
    this._sequencerPhases.clear();
    this._sequencerMirrorSync.clear();
    this._frames.length = 0;
  }
}

/**
 * @param {string} value
 * @returns {string}
 */
function csvEscape(value) {
  const s = String(value ?? '');
  if (/[",\n]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

/**
 * @typedef {Object} EffectCallToken
 * @property {number} id
 * @property {string} key
 * @property {'update'|'render'} phase
 * @property {number} cpuStart
 * @property {number} frameSeq
 * @property {number} drawsBefore
 * @property {number} trianglesBefore
 * @property {number} linesBefore
 * @property {number} pointsBefore
 * @property {WebGLQuery|null} gpuQuery
 */

/**
 * @typedef {Object} PendingQuery
 * @property {WebGLQuery} query
 * @property {string} effectKey
 * @property {'update'|'render'} phase
 * @property {number} frameSeq
 */

/**
 * @typedef {Object} FrameRecord
 * @property {number} seq
 * @property {number} tMs
 * @property {number} frameTimeMs
 * @property {number} drawCalls
 * @property {number} triangles
 * @property {number} lines
 * @property {number} points
 * @property {string} continuousReason
 * @property {boolean} decimationActive
 */

/**
 * @typedef {Object} TickRecord
 * @property {number} tMs
 * @property {number} tickMs
 * @property {boolean} presented
 * @property {string} skipReason
 * @property {number} targetFps
 * @property {number} sinceLastPresentMs
 * @property {string|null} renderPath
 * @property {string|null} continuousReason
 * @property {number} [compositorMs]
 * @property {number} [handlerOverheadMs]
 */

/**
 * @typedef {Object} EffectSnapshotRow
 * @property {string} effect
 * @property {'update'|'render'} phase
 * @property {number} cpuLast
 * @property {number} cpuAvg
 * @property {number} cpuMax
 * @property {number} cpuTotal
 * @property {number} cpuCount
 * @property {number} gpuLast
 * @property {number} gpuAvg
 * @property {number} gpuMax
 * @property {number} gpuTotal
 * @property {number} gpuCount
 * @property {number} drawCallsAvg
 * @property {number} trianglesAvg
 * @property {number} linesAvg
 * @property {number} pointsAvg
 * @property {number} gpuDisjointDropped
 * @property {number} gpuMissing
 */

/**
 * @typedef {Object} PerformanceSnapshot
 * @property {object} meta
 * @property {object} session
 * @property {EffectSnapshotRow[]} effects
 * @property {Array<{name:string, totalMs:number, count:number, avgMs:number}>} updatables
 * @property {object} sequencer — phases / per-mirror sync / live diagnostics
 * @property {object|null} v2PassTimings
 * @property {object|null} vramBudget
 * @property {object|null} cloudShadowCache
 * @property {object|null} lighting — unrolled spans, live RT inventory, compositor pass timings
 * @property {{ start: object|null, current: object|null }} rendererInfo
 */
