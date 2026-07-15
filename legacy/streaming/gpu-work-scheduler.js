/**
 * @fileoverview Single frame-paced GPU work governor.
 *
 * All subsystems that commit heavy GPU work (streaming texture uploads, scene
 * mask recompose/rebuild, effect (re)builds) enqueue a `commit` callback with an
 * estimated cost. The governor runs as many commits as fit inside the current
 * frame's credit budget and defers the rest to later frames, so the systems do
 * not all spike in the same frame and trip a GPU driver reset (webglcontextlost).
 *
 * @module streaming/gpu-work-scheduler
 */

import { createLogger } from '../core/log.js';

const log = createLogger('GpuWorkScheduler');

/**
 * Commit priorities (lower number = runs first).
 * @enum {number}
 */
export const GPU_WORK_PRIORITY = Object.freeze({
  /** Visible cell with no texture yet — fill coverage ASAP. */
  COVERAGE: 0,
  /** Sharpen an already-textured resident cell. */
  UPGRADE: 1,
  /** Scene mask recompose / purge-rebuild. */
  MASK: 2,
  /** Effect (re)build (fire/candle/etc.). */
  EFFECT: 3,
  /** Off-screen / idle prefetch warm. */
  PREFETCH: 4,
});

/** Full per-frame upload credit (MB) at throttle level 0. */
const BASE_FRAME_CREDIT_MB = 32;
/** Full per-frame discrete commit slot count at throttle level 0. */
const BASE_FRAME_OPS = 6;
/** Floor for the per-frame credit when heavily throttled. */
const MIN_FRAME_CREDIT_MB = 6;
/** Floor for the per-frame op count when heavily throttled. */
const MIN_FRAME_OPS = 1;

/** Throttle multipliers indexed by level (0 = none, 3 = severe). */
const THROTTLE_SCALE = Object.freeze([1.0, 0.6, 0.35, 0.2]);

/**
 * Extra credit scale applied while the user is actively panning/zooming. Large
 * single-frame uploads are the most common pan stutter source, so we spread the
 * same work over more frames (coverage still flows, just in smaller bites) to
 * keep frame pacing even. Full-detail uploads resume the moment motion stops.
 */
const NAVIGATION_CREDIT_SCALE = 0.5;

/**
 * @typedef {object} GpuWorkItem
 * @property {string} id Stable id used to dedupe queued work (e.g. a cell key).
 * @property {number} priority One of GPU_WORK_PRIORITY.
 * @property {number} costMb Estimated GPU upload cost in megabytes.
 * @property {() => void} commit Performs the actual GPU work (upload / recompose).
 * @property {() => void} [onDrop] Called if this item is superseded or cleared
 *   without committing — use it to release resources the commit would have owned
 *   (e.g. dispose a decoded-but-never-uploaded texture) to avoid leaks.
 * @property {string} [category] Telemetry bucket (defaults from priority).
 */

const PRIORITY_CATEGORY = Object.freeze({
  0: 'coverage',
  1: 'upgrade',
  2: 'mask',
  3: 'effect',
  4: 'prefetch',
});

export class GpuWorkScheduler {
  constructor() {
    /** @type {Map<string, GpuWorkItem>} */
    this._queue = new Map();
    /** @type {number} 0..3 */
    this._throttleLevel = 0;
    /** @type {number} */
    this._lastTickMs = 0;
    /** @type {number} Smoothed inter-tick interval (ms). */
    this._avgFrameMs = 16.7;
    /** @type {boolean} When true the next tick commits everything (curtain up). */
    this._flushOnce = false;
    /** @type {number} performance.now() until which LOD-0 uploads are forbidden. */
    this._lod0CooldownUntil = 0;
    /** @type {number} User/tuning override for the base per-frame upload credit (0 = default). */
    this._baseCreditOverrideMb = 0;
    /** @type {boolean} Tunable: allow focal cells to sharpen finer than zoom-native LOD. */
    this.focalSharpenEnabled = true;
    /** @type {object} */
    this._stats = this._emptyStats();
  }

  /**
   * Override the base per-frame upload credit (MB). Pass 0 to restore the default.
   * @param {number} mb
   */
  setBaseFrameCreditMb(mb) {
    this._baseCreditOverrideMb = Math.max(0, Number(mb) || 0);
  }

  /** @returns {number} The active base per-frame upload credit (MB), before throttle. */
  getBaseFrameCreditMb() {
    return this._baseCreditOverrideMb > 0 ? this._baseCreditOverrideMb : BASE_FRAME_CREDIT_MB;
  }

  /**
   * Forbid LOD-0 (finest, largest) streaming uploads for `ms` milliseconds.
   * Used by the crash-adaptive ladder so recovery does not immediately re-upload
   * the heaviest tiles that may have triggered the context loss.
   * @param {number} ms
   */
  noteCrashCooldown(ms) {
    const dur = Math.max(0, Number(ms) || 0);
    this._lod0CooldownUntil = Math.max(this._lod0CooldownUntil, performance.now() + dur);
  }

  /** @returns {boolean} True when LOD-0 uploads are currently permitted. */
  isLod0Allowed() {
    return performance.now() >= this._lod0CooldownUntil;
  }

  /** @returns {number} Remaining LOD-0 cooldown in ms (0 when none). */
  lod0CooldownRemainingMs() {
    return Math.max(0, this._lod0CooldownUntil - performance.now());
  }

  /** @returns {object} @private */
  _emptyStats() {
    return {
      queued: 0,
      committedLastFrame: 0,
      deferredLastFrame: 0,
      committedMbLastFrame: 0,
      frameCreditMb: BASE_FRAME_CREDIT_MB,
      frameOps: BASE_FRAME_OPS,
      throttleLevel: 0,
      autoThrottleLevel: 0,
      avgFrameMs: 16.7,
      byCategory: { coverage: 0, upgrade: 0, mask: 0, effect: 0, prefetch: 0 },
      totalCommitted: 0,
      totalDeferredPeak: 0,
    };
  }

  /**
   * Queue (or replace) a unit of GPU work. Re-enqueuing the same id keeps the
   * higher priority and the latest commit callback.
   * @param {GpuWorkItem} item
   */
  enqueue(item) {
    if (!item || typeof item.commit !== 'function') return;
    const id = String(item.id ?? `anon:${this._queue.size}:${performance.now()}`);
    const priority = Number.isFinite(item.priority) ? Number(item.priority) : GPU_WORK_PRIORITY.PREFETCH;
    const costMb = Math.max(0, Number(item.costMb) || 0);
    const category = item.category ?? PRIORITY_CATEGORY[priority] ?? 'prefetch';

    const existing = this._queue.get(id);
    if (existing) {
      // The superseded commit owned resources (e.g. a decoded texture) that will
      // never be uploaded — release them so they don't leak.
      if (existing.commit !== item.commit) {
        try { existing.onDrop?.(); } catch (e) { log.warn(`onDrop failed for "${id}"`, e); }
      }
      existing.priority = Math.min(existing.priority, priority);
      existing.costMb = costMb;
      existing.commit = item.commit;
      existing.onDrop = item.onDrop;
      existing.category = category;
      existing.enqueuedAt = existing.enqueuedAt ?? performance.now();
      return;
    }
    this._queue.set(id, {
      id,
      priority,
      costMb,
      commit: item.commit,
      onDrop: item.onDrop,
      category,
      enqueuedAt: performance.now(),
    });
  }

  /** @param {string} id @returns {boolean} */
  has(id) {
    return this._queue.has(String(id));
  }

  /** @param {string} id */
  cancel(id) {
    const item = this._queue.get(String(id));
    if (!item) return;
    this._queue.delete(String(id));
    try { item.onDrop?.(); } catch (e) { log.warn(`onDrop failed for "${id}"`, e); }
  }

  /**
   * Cancel all queued items whose id starts with `prefix` (running their onDrop).
   * @param {string} prefix
   */
  cancelByPrefix(prefix) {
    const p = String(prefix ?? '');
    if (!p) return;
    for (const id of [...this._queue.keys()]) {
      if (id.startsWith(p)) this.cancel(id);
    }
  }

  /** @returns {number} */
  pendingCount() {
    return this._queue.size;
  }

  /**
   * Set throttle level (0 none .. 3 severe). Used by the crash-adaptive ladder.
   * @param {number} level
   */
  setThrottleLevel(level) {
    const lvl = Math.max(0, Math.min(THROTTLE_SCALE.length - 1, Math.floor(Number(level) || 0)));
    if (lvl !== this._throttleLevel) {
      log.info(`Throttle level ${this._throttleLevel} -> ${lvl}`);
    }
    this._throttleLevel = lvl;
  }

  /** @returns {number} */
  getThrottleLevel() {
    return this._throttleLevel;
  }

  /** Commit the entire queue on the next tick (e.g. while a transition curtain hides the canvas). */
  requestFlush() {
    this._flushOnce = true;
  }

  /**
   * @returns {number} Soft credit scale while the camera is panning/zooming.
   * Reads the authoritative per-frame navigation flag published by the render
   * loop / FloorCompositor (no extra dependency / import cycle).
   * @private
   */
  _navigationScale() {
    try {
      if (window.MapShine?.__v2NavigationLiteUpdates === true) return NAVIGATION_CREDIT_SCALE;
    } catch (_) {}
    return 1.0;
  }

  /**
   * Backpressure derived from measured frame time. When frames get long the GPU
   * is under pressure (heavy uploads / driver stalls), so we shrink the upload
   * credit *before* a spike trips a context loss. This self-tunes to any GPU and
   * complements the crash-adaptive ladder ({@link setThrottleLevel}); the higher
   * of the two wins.
   * @returns {number} 0..3
   * @private
   */
  _autoThrottleLevel() {
    const ms = this._avgFrameMs;
    if (!(ms > 0)) return 0;
    if (ms > 120) return 3;
    if (ms > 80) return 2;
    if (ms > 50) return 1;
    return 0;
  }

  /** @returns {number} Effective throttle = max(crash-adaptive, frame-time backpressure). @private */
  _effectiveThrottleLevel() {
    return Math.max(this._throttleLevel, this._autoThrottleLevel());
  }

  /** @returns {number} @private */
  _frameCreditMb() {
    const scale = (THROTTLE_SCALE[this._effectiveThrottleLevel()] ?? 1.0) * this._navigationScale();
    return Math.max(MIN_FRAME_CREDIT_MB, Math.round(this.getBaseFrameCreditMb() * scale));
  }

  /** @returns {number} @private */
  _frameOps() {
    const scale = (THROTTLE_SCALE[this._effectiveThrottleLevel()] ?? 1.0) * this._navigationScale();
    return Math.max(MIN_FRAME_OPS, Math.round(BASE_FRAME_OPS * scale));
  }

  /**
   * Run queued commits within this frame's budget. Call once per rendered frame.
   */
  tick() {
    const now = performance.now();
    if (this._lastTickMs > 0) {
      const dt = now - this._lastTickMs;
      // Exponential moving average of frame interval — proxy for GPU pressure.
      this._avgFrameMs = this._avgFrameMs * 0.85 + Math.min(200, dt) * 0.15;
    }
    this._lastTickMs = now;

    const flush = this._flushOnce;
    this._flushOnce = false;

    const stats = this._stats;
    stats.queued = this._queue.size;
    stats.byCategory = { coverage: 0, upgrade: 0, mask: 0, effect: 0, prefetch: 0 };
    stats.committedLastFrame = 0;
    stats.committedMbLastFrame = 0;
    stats.throttleLevel = this._effectiveThrottleLevel();
    stats.autoThrottleLevel = this._autoThrottleLevel();
    stats.avgFrameMs = Math.round(this._avgFrameMs * 10) / 10;

    if (this._queue.size === 0) {
      stats.deferredLastFrame = 0;
      stats.frameCreditMb = this._frameCreditMb();
      stats.frameOps = this._frameOps();
      return;
    }

    let creditMb = flush ? Infinity : this._frameCreditMb();
    let opsLeft = flush ? Infinity : this._frameOps();
    stats.frameCreditMb = flush ? -1 : creditMb;
    stats.frameOps = flush ? -1 : opsLeft;

    const items = [...this._queue.values()].sort((a, b) => {
      if (a.priority !== b.priority) return a.priority - b.priority;
      return a.enqueuedAt - b.enqueuedAt;
    });

    let committedAny = false;
    for (const item of items) {
      if (opsLeft <= 0) break;
      // Starvation guard: always allow the first item even if it exceeds credit,
      // so a single oversized upload still drains over successive frames.
      if (!committedAny || item.costMb <= creditMb) {
        this._queue.delete(item.id);
        try {
          item.commit();
        } catch (e) {
          log.warn(`commit failed for "${item.id}"`, e);
        }
        committedAny = true;
        opsLeft -= 1;
        creditMb -= item.costMb;
        stats.committedLastFrame += 1;
        stats.committedMbLastFrame += item.costMb;
        stats.totalCommitted += 1;
        stats.byCategory[item.category] = (stats.byCategory[item.category] || 0) + 1;
        if (creditMb <= 0 && !flush) break;
      }
    }

    stats.deferredLastFrame = this._queue.size;
    stats.totalDeferredPeak = Math.max(stats.totalDeferredPeak, this._queue.size);
    stats.committedMbLastFrame = Math.round(stats.committedMbLastFrame * 10) / 10;
  }

  /**
   * Drop all queued work without committing (teardown / epoch change).
   * Each item's onDrop hook runs so owned resources are released.
   */
  clear() {
    for (const item of this._queue.values()) {
      try { item.onDrop?.(); } catch (e) { log.warn(`onDrop failed for "${item.id}"`, e); }
    }
    this._queue.clear();
  }

  /** @returns {object} Telemetry snapshot for crash report / UI. */
  getStats() {
    return {
      ...this._stats,
      queued: this._queue.size,
      throttleLevel: this._effectiveThrottleLevel(),
      autoThrottleLevel: this._autoThrottleLevel(),
      baseThrottleLevel: this._throttleLevel,
    };
  }
}

/** @type {GpuWorkScheduler|null} */
let _instance = null;

/** @returns {GpuWorkScheduler} */
export function getGpuWorkScheduler() {
  if (!_instance) {
    _instance = new GpuWorkScheduler();
    try {
      if (window.MapShine) window.MapShine.gpuWorkScheduler = _instance;
    } catch (_) {}
  }
  return _instance;
}

/** Reset singleton (teardown). */
export function disposeGpuWorkScheduler() {
  if (_instance) {
    _instance.clear();
    _instance = null;
  }
}
