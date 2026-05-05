/**
 * @fileoverview V3 shader warmup coordinator — stages, progress events, and
 * yielded execution so that first-use shader program compilation does not
 * lock the main thread while the canvas is coming online.
 *
 * ## Why
 *
 * V3 builds several large GLSL3 `RawShaderMaterial`s (see
 * {@link V3IlluminationPipeline}, {@link V3FloorLightBufferPass},
 * {@link V3BuildingShadowsPass}, {@link V3ThreeSandwichCompositor}) plus
 * optional post-processing materials (bloom kernels, halftone, dot-screen,
 * invert). Three.js compiles a program the first time each material is
 * rendered, which inside the composite loop converts into a long main-thread
 * stall on the first frame that touches a new material — visible as a hang
 * when the player opens a scene or toggles an effect.
 *
 * The coordinator expresses the "compile this material now" work as a flat
 * list of named stages grouped into two tiers:
 *
 *   - `core`     — required to render a stable, interactive V3 frame.
 *   - `optional` — effects and variants that do not block interaction.
 *
 * Stages run sequentially, with a browser yield (`requestAnimationFrame` or
 * `setTimeout(0)` fallback) between each stage, so that Foundry's canvas
 * transition / PIXI ticker and any loading UI keep a heartbeat while
 * compiles happen. Each stage records start / end / duration so the debug
 * surface can expose per-stage timing, and the coordinator persists the
 * most recent core duration to {@link localStorage} so the next session can
 * decide whether to use a "gated" overlay or a "fast-first-pixel" flow.
 *
 * The coordinator is transport-agnostic: stages are plain async callbacks
 * supplied by {@link V3ThreeSceneHost}, listeners subscribe via
 * {@link V3ShaderWarmupCoordinator#onUpdate}, and snapshots are serialisable
 * so `V3Shine.diag()` and the status overlay share the same contract.
 *
 * @module v3/V3ShaderWarmupCoordinator
 */

import {
  resolveWarmupMode,
  DEFAULT_GATE_THRESHOLD_MS,
  RECENT_SAMPLE_WINDOW,
} from "./V3WarmupPolicy.js";

/**
 * @typedef {"core" | "optional"} V3WarmupTier
 * @typedef {"pending" | "running" | "done" | "skipped" | "error"} V3WarmupStageStatus
 *
 * @typedef {
 *   | "idle"
 *   | "loading-resources"
 *   | "core"
 *   | "interactive-ready"
 *   | "optional"
 *   | "fully-warm"
 *   | "cancelled"
 * } V3WarmupState
 *
 * @typedef {Object} V3WarmupStageRec
 * @property {string} id
 * @property {string} label
 * @property {V3WarmupTier} tier
 * @property {() => (void | Promise<void>)} run
 * @property {(() => boolean) | null} skipIf
 * @property {V3WarmupStageStatus} status
 * @property {number} startMs
 * @property {number} endMs
 * @property {number} durationMs
 * @property {string | null} error
 *
 * @typedef {Object} V3WarmupStageSnapshot
 * @property {string} id
 * @property {string} label
 * @property {V3WarmupTier} tier
 * @property {V3WarmupStageStatus} status
 * @property {number} startMs
 * @property {number} endMs
 * @property {number} durationMs
 * @property {string | null} error
 *
 * @typedef {Object} V3WarmupTierProgress
 * @property {number} done
 * @property {number} total
 * @property {number} fraction `0..1`; `1` when the tier is empty.
 *
 * @typedef {Object} V3WarmupSnapshot
 * @property {V3WarmupState} state
 * @property {"fast" | "gated" | "auto"} mode
 * @property {"fast" | "gated"} resolvedMode
 * @property {V3WarmupStageSnapshot | null} currentStage
 * @property {number | null} startedAtMs
 * @property {number | null} coreCompletedAtMs
 * @property {number | null} allCompletedAtMs
 * @property {number | null} coreDurationMs
 * @property {number | null} fullyWarmDurationMs
 * @property {{ core: V3WarmupTierProgress, optional: V3WarmupTierProgress, coreDone: boolean, optionalDone: boolean }} progress
 * @property {{ core: V3WarmupStageSnapshot[], optional: V3WarmupStageSnapshot[] }} tiers
 * @property {V3WarmupPersistedMetrics | null} persistedMetrics
 * @property {import("./V3WarmupPolicy.js").V3WarmupHardwareInfo | null} hardware
 *   Live hardware snapshot supplied via {@link V3ShaderWarmupCoordinator#setHardware}.
 * @property {import("./V3WarmupPolicy.js").V3WarmupPolicyDecision | null} adaptiveDecision
 *   Rationale for the current `"auto"` resolution. `null` when the mode is
 *   explicitly fast/gated.
 */

/**
 * @typedef {Object} V3WarmupPersistedMetrics
 * @property {number} lastCoreDurationMs
 * @property {number} lastFullyWarmDurationMs
 * @property {number} lastObservedAtMs Epoch ms when the metrics were written.
 * @property {number} sampleCount Rolling count (capped) of completed warmups.
 * @property {number[]} recentCoreDurationsMs Bounded rolling buffer of
 *   recent core durations used by {@link V3WarmupPolicy} (youngest last).
 * @property {string|null} hardwareSignature Signature when samples were
 *   recorded; mismatches invalidate the samples adaptively.
 */

const STORAGE_KEY = "mapShineV3.warmup.metrics.v1";

/**
 * Above this core-compile duration, the adaptive (`"auto"`) mode resolves to
 * `"gated"` next session so the user sees a dedicated loading state instead
 * of a transient stall after mount. Value is deliberately generous: the V3
 * shader stack should generally compile in well under this budget. The
 * policy module owns the canonical default; this local constant is kept for
 * the public export below.
 */
const ADAPTIVE_GATE_THRESHOLD_MS = DEFAULT_GATE_THRESHOLD_MS;

const STATE_IDLE = "idle";
const STATE_LOADING_RESOURCES = "loading-resources";
const STATE_CORE = "core";
const STATE_INTERACTIVE_READY = "interactive-ready";
const STATE_OPTIONAL = "optional";
const STATE_FULLY_WARM = "fully-warm";
const STATE_CANCELLED = "cancelled";

const TIER_CORE = "core";
const TIER_OPTIONAL = "optional";

/**
 * Coordinates shader warmup stages for the V3 pipeline.
 *
 * Typical lifecycle:
 *
 *   1. {@link V3ShaderWarmupCoordinator#setState} `"loading-resources"` while
 *      textures and masks load (host-managed).
 *   2. {@link V3ShaderWarmupCoordinator#addStage} for every core compile.
 *   3. `await` {@link V3ShaderWarmupCoordinator#runTier} `"core"` — state goes
 *      `core` then `interactive-ready` when all core stages finish.
 *   4. Queue optional stages for enabled effects, `await runTier("optional")`
 *      — state goes `optional` then `fully-warm`.
 *
 * Stages within a tier run sequentially, with a browser yield between
 * stages, so other main-thread work (Foundry canvas, PIXI ticker, user input
 * if re-entrant) keeps flowing. A stage's `run` may itself invoke multiple
 * `renderer.compile` calls; the coordinator treats it as one unit for
 * progress reporting.
 */
export class V3ShaderWarmupCoordinator {
  /**
   * @param {{
   *   logger?: { log?: (...args: any[]) => void, warn?: (...args: any[]) => void },
   *   nowMs?: () => number,
   *   storage?: Storage | null,
   * }} [options]
   */
  constructor(options = {}) {
    const { logger, nowMs, storage } = options;
    /** @type {(...args: any[]) => void} */
    this.log = typeof logger?.log === "function" ? logger.log : () => {};
    /** @type {(...args: any[]) => void} */
    this.warn = typeof logger?.warn === "function" ? logger.warn : () => {};
    /** @type {() => number} */
    this._nowMs = typeof nowMs === "function"
      ? nowMs
      : () => {
          try {
            return globalThis.performance?.now?.() ?? Date.now();
          } catch (_) {
            return Date.now();
          }
        };
    /**
     * The persistence surface the coordinator uses for adaptive mode. Provided
     * as an argument (and defaulted to `localStorage`) so tests / non-browser
     * contexts can inject a mock or `null` to disable persistence entirely.
     * @type {Storage | null}
     */
    this._storage = storage === undefined ? getDefaultStorage() : storage;

    /** @type {V3WarmupStageRec[]} */
    this._stages = [];
    /** @type {V3WarmupState} */
    this._state = STATE_IDLE;
    /** @type {"fast" | "gated" | "auto"} */
    this._mode = "auto";
    /** @type {Set<(snap: V3WarmupSnapshot) => void>} */
    this._listeners = new Set();

    /**
     * Incremented by {@link #clear} and {@link #cancel}. Pending stage loops
     * check the captured token after every yield and bail without running
     * further stages if the token changed, so mount/unmount races cannot leave
     * half-run warmups writing into a disposed renderer.
     */
    this._runToken = 0;

    /** @type {number | null} */
    this._startedAt = null;
    /** @type {number | null} */
    this._coreCompletedAt = null;
    /** @type {number | null} */
    this._allCompletedAt = null;

    /**
     * Most recent hardware snapshot supplied by the host (see
     * {@link V3ShaderWarmupCoordinator#setHardware}). Fed into the adaptive
     * policy together with persisted sample buffers so the `"auto"` mode
     * can pick fast vs gated without relying solely on a single prior run.
     *
     * @type {import("./V3WarmupPolicy.js").V3WarmupHardwareInfo | null}
     */
    this._hardware = null;

    /**
     * Memoised last adaptive decision; cleared whenever inputs change.
     * Allows {@link #snapshot} to surface a stable rationale without
     * repeating the policy computation per listener.
     *
     * @type {import("./V3WarmupPolicy.js").V3WarmupPolicyDecision | null}
     */
    this._cachedDecision = null;
  }

  /**
   * Queue a warmup stage. Stages for the same tier run in the order they are
   * added. `skipIf` is evaluated lazily when the stage is about to run, so
   * toggles made between `addStage` and `runTier` are honoured.
   *
   * @param {{
   *   id: string,
   *   label?: string,
   *   tier?: V3WarmupTier,
   *   run: () => (void | Promise<void>),
   *   skipIf?: () => boolean,
   * }} stage
   * @returns {string} The registered stage id.
   */
  addStage(stage) {
    if (!stage || typeof stage.run !== "function") {
      throw new TypeError("V3ShaderWarmupCoordinator.addStage: stage.run must be a function");
    }
    const tier = stage.tier === TIER_OPTIONAL ? TIER_OPTIONAL : TIER_CORE;
    const id = String(stage.id ?? stage.label ?? `stage-${this._stages.length + 1}`);
    /** @type {V3WarmupStageRec} */
    const rec = {
      id,
      label: String(stage.label ?? id),
      tier,
      run: stage.run,
      skipIf: typeof stage.skipIf === "function" ? stage.skipIf : null,
      status: "pending",
      startMs: 0,
      endMs: 0,
      durationMs: 0,
      error: null,
    };
    this._stages.push(rec);
    this._emit();
    return id;
  }

  /**
   * Remove every stage and reset counters. Any in-flight run is cancelled at
   * the next yield via the run token; stages that have already started will
   * complete (we cannot abort a GPU compile call) but no further stages run.
   */
  clear() {
    this._stages.length = 0;
    this._state = STATE_IDLE;
    this._startedAt = null;
    this._coreCompletedAt = null;
    this._allCompletedAt = null;
    this._runToken += 1;
    this._cachedDecision = null;
    this._emit();
  }

  /**
   * Cancel any in-flight run without clearing stages. Useful when the host
   * wants to re-run warmup after a setting change.
   */
  cancel() {
    this._runToken += 1;
    if (this._state === STATE_CORE || this._state === STATE_OPTIONAL) {
      this._setState(STATE_CANCELLED);
    }
  }

  /**
   * @param {"fast" | "gated" | "auto"} mode
   */
  setMode(mode) {
    if (mode === "fast" || mode === "gated" || mode === "auto") {
      if (this._mode !== mode) {
        this._mode = mode;
        this._cachedDecision = null;
        this._emit();
      }
    }
  }

  getMode() {
    return this._mode;
  }

  /**
   * Register live hardware information used by the adaptive policy. The
   * host calls this once per mount, right after the renderer exists, so
   * that {@link #resolvedMode} can consult both persisted timing samples
   * and runtime hardware hints. Passing `null` clears the stored hint.
   *
   * @param {import("./V3WarmupPolicy.js").V3WarmupHardwareInfo | null} hw
   */
  setHardware(hw) {
    this._hardware = hw ?? null;
    this._cachedDecision = null;
    this._emit();
  }

  /**
   * Resolve `"auto"` against persisted samples + live hardware hints via
   * {@link V3WarmupPolicy#resolveWarmupMode}. Explicit `"fast"` / `"gated"`
   * modes pass through unchanged. The policy considers a rolling window of
   * recent core durations (not just the single latest) and weighs hardware
   * tier in the ambiguous band so a capable device does not get gated on
   * one cold-load outlier.
   *
   * @returns {"fast" | "gated"}
   */
  resolvedMode() {
    if (this._mode === "fast") return "fast";
    if (this._mode === "gated") return "gated";
    return this._resolveAdaptive().mode;
  }

  /**
   * Full adaptive decision (mode + rationale). Used by diagnostics to
   * explain *why* the "Auto" overlay resolved one way or the other.
   *
   * @returns {import("./V3WarmupPolicy.js").V3WarmupPolicyDecision}
   */
  _resolveAdaptive() {
    if (this._cachedDecision) return this._cachedDecision;
    const persisted = this.readPersistedMetrics();
    const decision = resolveWarmupMode({
      persisted: persisted
        ? {
            lastCoreDurationMs: persisted.lastCoreDurationMs,
            recentCoreDurationsMs: persisted.recentCoreDurationsMs ?? [],
            hardwareSignature: persisted.hardwareSignature ?? null,
            sampleCount: persisted.sampleCount,
          }
        : null,
      hardware: this._hardware,
    });
    this._cachedDecision = decision;
    return decision;
  }

  /**
   * @returns {import("./V3WarmupPolicy.js").V3WarmupPolicyDecision}
   */
  adaptiveDecision() {
    return this._resolveAdaptive();
  }

  /**
   * Explicit state setter for non-stage phases (e.g. "loading textures").
   * Stage-driven states (`core`, `interactive-ready`, `optional`,
   * `fully-warm`) are written automatically by {@link #runTier} and should
   * not be set from outside.
   *
   * @param {"idle" | "loading-resources"} state
   */
  setState(state) {
    if (state === STATE_IDLE || state === STATE_LOADING_RESOURCES) {
      this._setState(state);
    }
  }

  /**
   * Subscribe to snapshot updates. Fires on every stage status change, state
   * transition, mode change, and stage addition. Returns an unsubscribe fn.
   *
   * @param {(snap: V3WarmupSnapshot) => void} fn
   * @returns {() => void}
   */
  onUpdate(fn) {
    if (typeof fn !== "function") return () => {};
    this._listeners.add(fn);
    try {
      fn(this.snapshot());
    } catch (err) {
      this.warn("V3ShaderWarmupCoordinator listener threw during subscribe", err);
    }
    return () => {
      this._listeners.delete(fn);
    };
  }

  /**
   * Run all pending stages of the given tier sequentially, yielding to the
   * browser between stages. Safe to call more than once: only `pending`
   * stages are processed.
   *
   * @param {V3WarmupTier} tier
   * @returns {Promise<void>}
   */
  async runTier(tier) {
    const normalized = tier === TIER_OPTIONAL ? TIER_OPTIONAL : TIER_CORE;
    const myToken = this._runToken;

    if (normalized === TIER_CORE) {
      if (this._startedAt == null) this._startedAt = this._nowMs();
      this._setState(STATE_CORE);
    } else {
      this._setState(STATE_OPTIONAL);
    }

    for (const stage of this._stages) {
      if (stage.tier !== normalized || stage.status !== "pending") continue;
      if (myToken !== this._runToken) return;

      if (stage.skipIf) {
        let shouldSkip = false;
        try {
          shouldSkip = !!stage.skipIf();
        } catch (err) {
          this.warn(`warmup skipIf("${stage.id}") threw`, err);
        }
        if (shouldSkip) {
          stage.status = "skipped";
          this._emit();
          continue;
        }
      }

      stage.status = "running";
      stage.startMs = this._nowMs();
      this._emit();

      try {
        await stage.run();
        stage.status = "done";
      } catch (err) {
        stage.status = "error";
        stage.error = err instanceof Error ? err.message : String(err);
        this.warn(`V3 warmup stage "${stage.id}" failed`, err);
      }

      stage.endMs = this._nowMs();
      stage.durationMs = Math.max(0, stage.endMs - stage.startMs);
      this._emit();

      await yieldToBrowser();
      if (myToken !== this._runToken) return;
    }

    if (normalized === TIER_CORE) {
      this._coreCompletedAt = this._nowMs();
      this._setState(STATE_INTERACTIVE_READY);
      this._persistCoreMetrics();
    } else {
      this._allCompletedAt = this._nowMs();
      this._setState(STATE_FULLY_WARM);
      this._persistFullyWarmMetrics();
    }
  }

  /**
   * Serialisable snapshot. Shared by the status overlay and
   * `V3Shine.diag().shaderWarmup`.
   *
   * @returns {V3WarmupSnapshot}
   */
  snapshot() {
    const core = this._stages
      .filter((s) => s.tier === TIER_CORE)
      .map(stageToSnapshot);
    const optional = this._stages
      .filter((s) => s.tier === TIER_OPTIONAL)
      .map(stageToSnapshot);

    const current = this._stages.find((s) => s.status === "running") ?? null;
    const persisted = this.readPersistedMetrics();

    return {
      state: this._state,
      mode: this._mode,
      resolvedMode: this.resolvedMode(),
      currentStage: current ? stageToSnapshot(current) : null,
      startedAtMs: this._startedAt,
      coreCompletedAtMs: this._coreCompletedAt,
      allCompletedAtMs: this._allCompletedAt,
      coreDurationMs:
        this._coreCompletedAt != null && this._startedAt != null
          ? this._coreCompletedAt - this._startedAt
          : null,
      fullyWarmDurationMs:
        this._allCompletedAt != null && this._startedAt != null
          ? this._allCompletedAt - this._startedAt
          : null,
      progress: {
        core: tierProgress(core),
        optional: tierProgress(optional),
        coreDone: core.length === 0 || core.every(isTerminal),
        optionalDone: optional.length === 0 || optional.every(isTerminal),
      },
      tiers: { core, optional },
      persistedMetrics: persisted,
      hardware: this._hardware,
      adaptiveDecision: this._mode === "auto" ? this._resolveAdaptive() : null,
    };
  }

  /**
   * Read persisted adaptive metrics. Tolerant of missing / corrupt values.
   *
   * @returns {V3WarmupPersistedMetrics | null}
   */
  readPersistedMetrics() {
    const raw = safeStorageGet(this._storage, STORAGE_KEY);
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object") return null;
      const last = Number(parsed.lastCoreDurationMs);
      if (!Number.isFinite(last) || last < 0) return null;
      const recentRaw = Array.isArray(parsed.recentCoreDurationsMs)
        ? parsed.recentCoreDurationsMs
        : [last];
      const recent = recentRaw
        .map((n) => Number(n))
        .filter((n) => Number.isFinite(n) && n >= 0)
        .slice(-RECENT_SAMPLE_WINDOW);
      return {
        lastCoreDurationMs: last,
        lastFullyWarmDurationMs: Number.isFinite(Number(parsed.lastFullyWarmDurationMs))
          ? Number(parsed.lastFullyWarmDurationMs)
          : 0,
        lastObservedAtMs: Number.isFinite(Number(parsed.lastObservedAtMs))
          ? Number(parsed.lastObservedAtMs)
          : 0,
        sampleCount: Number.isFinite(Number(parsed.sampleCount))
          ? Math.max(0, Math.floor(Number(parsed.sampleCount)))
          : 0,
        recentCoreDurationsMs: recent,
        hardwareSignature:
          typeof parsed.hardwareSignature === "string" && parsed.hardwareSignature.length
            ? parsed.hardwareSignature
            : null,
      };
    } catch (_) {
      return null;
    }
  }

  _persistCoreMetrics() {
    if (!this._storage) return;
    if (this._coreCompletedAt == null || this._startedAt == null) return;
    const duration = Math.max(0, this._coreCompletedAt - this._startedAt);
    const rounded = Math.round(duration);
    const prior = this.readPersistedMetrics();
    const currentSignature = this._hardware?.signature ?? null;
    // If hardware changed between sessions, treat the previous buffer as
    // stale: retaining samples from another GPU/driver combo would skew
    // the adaptive policy in both directions.
    const priorRecent = prior?.recentCoreDurationsMs ?? [];
    const keepPrior = prior && prior.hardwareSignature && currentSignature
      ? prior.hardwareSignature === currentSignature
      : true;
    const nextRecent = [
      ...(keepPrior ? priorRecent : []),
      rounded,
    ].slice(-RECENT_SAMPLE_WINDOW);
    const next = {
      lastCoreDurationMs: rounded,
      lastFullyWarmDurationMs: keepPrior ? (prior?.lastFullyWarmDurationMs ?? 0) : 0,
      lastObservedAtMs: Date.now(),
      sampleCount: keepPrior
        ? Math.min(10000, Number(prior?.sampleCount ?? 0) + 1)
        : 1,
      recentCoreDurationsMs: nextRecent,
      hardwareSignature: currentSignature ?? prior?.hardwareSignature ?? null,
    };
    safeStorageSet(this._storage, STORAGE_KEY, JSON.stringify(next));
    this._cachedDecision = null;
  }

  _persistFullyWarmMetrics() {
    if (!this._storage) return;
    if (this._allCompletedAt == null || this._startedAt == null) return;
    const duration = Math.max(0, this._allCompletedAt - this._startedAt);
    const prior = this.readPersistedMetrics();
    if (!prior) return;
    const next = {
      ...prior,
      lastFullyWarmDurationMs: Math.round(duration),
      lastObservedAtMs: Date.now(),
    };
    safeStorageSet(this._storage, STORAGE_KEY, JSON.stringify(next));
    this._cachedDecision = null;
  }

  /**
   * @param {V3WarmupState} next
   */
  _setState(next) {
    if (this._state === next) return;
    this._state = next;
    this._emit();
  }

  _emit() {
    if (!this._listeners.size) return;
    let snap = null;
    for (const fn of this._listeners) {
      try {
        if (snap == null) snap = this.snapshot();
        fn(snap);
      } catch (err) {
        this.warn("V3ShaderWarmupCoordinator listener threw", err);
      }
    }
  }
}

/**
 * Tier progress helper.
 *
 * @param {V3WarmupStageSnapshot[]} items
 * @returns {V3WarmupTierProgress}
 */
function tierProgress(items) {
  if (!items.length) return { done: 0, total: 0, fraction: 1 };
  let done = 0;
  for (const s of items) if (isTerminal(s)) done += 1;
  return { done, total: items.length, fraction: done / items.length };
}

/**
 * @param {{ status: V3WarmupStageStatus }} s
 */
function isTerminal(s) {
  return s.status === "done" || s.status === "skipped" || s.status === "error";
}

/**
 * @param {V3WarmupStageRec} s
 * @returns {V3WarmupStageSnapshot}
 */
function stageToSnapshot(s) {
  return {
    id: s.id,
    label: s.label,
    tier: s.tier,
    status: s.status,
    startMs: s.startMs,
    endMs: s.endMs,
    durationMs: s.durationMs,
    error: s.error,
  };
}

/**
 * Yield back to the browser event loop. Uses `requestAnimationFrame` when
 * available so the yield is naturally aligned with a paint boundary; falls
 * back to `setTimeout(0)` in headless / test environments.
 *
 * @returns {Promise<void>}
 */
function yieldToBrowser() {
  return new Promise((resolve) => {
    try {
      if (typeof requestAnimationFrame === "function") {
        requestAnimationFrame(() => resolve());
        return;
      }
    } catch (_) {}
    setTimeout(resolve, 0);
  });
}

/**
 * @returns {Storage | null}
 */
function getDefaultStorage() {
  try {
    const s = globalThis.localStorage;
    if (s && typeof s.getItem === "function" && typeof s.setItem === "function") {
      return s;
    }
  } catch (_) {}
  return null;
}

/**
 * @param {Storage | null} storage
 * @param {string} key
 * @returns {string | null}
 */
function safeStorageGet(storage, key) {
  if (!storage) return null;
  try {
    return storage.getItem(key);
  } catch (_) {
    return null;
  }
}

/**
 * @param {Storage | null} storage
 * @param {string} key
 * @param {string} value
 */
function safeStorageSet(storage, key, value) {
  if (!storage) return;
  try {
    storage.setItem(key, value);
  } catch (_) {}
}

/**
 * Constants re-exported for callers that want stable comparisons without
 * importing string literals.
 */
export const V3_WARMUP_STATE = Object.freeze({
  IDLE: STATE_IDLE,
  LOADING_RESOURCES: STATE_LOADING_RESOURCES,
  CORE: STATE_CORE,
  INTERACTIVE_READY: STATE_INTERACTIVE_READY,
  OPTIONAL: STATE_OPTIONAL,
  FULLY_WARM: STATE_FULLY_WARM,
  CANCELLED: STATE_CANCELLED,
});

export const V3_WARMUP_TIER = Object.freeze({
  CORE: TIER_CORE,
  OPTIONAL: TIER_OPTIONAL,
});

export const V3_WARMUP_ADAPTIVE_GATE_THRESHOLD_MS = ADAPTIVE_GATE_THRESHOLD_MS;
