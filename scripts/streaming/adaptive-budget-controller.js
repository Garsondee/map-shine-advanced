/**
 * @fileoverview Self-calibrating memory/streaming controller.
 *
 * Treats the software texture budget as advisory and drives streaming
 * aggressiveness from real signals: the renderer's live texture count, growth
 * versus the session floor, and crash history. It:
 *  - raises extra budget headroom on stable high-VRAM GPUs so the software cap
 *    stops forcing downscale churn,
 *  - tightens (drops the bonus, throttles the GPU work governor, forbids LOD-0)
 *    on crashes or unexpected texture growth,
 *  - relaxes the degradation level gradually once the session is stable again.
 *
 * @module streaming/adaptive-budget-controller
 */

import { createLogger } from '../core/log.js';
import { getTextureBudgetTracker } from '../assets/TextureBudgetTracker.js';
import { getGpuWorkScheduler } from './gpu-work-scheduler.js';
import { resolveEffectiveGpuVramGB } from './memory-settings.js';

const log = createLogger('AdaptiveBudgetController');

/** Real-signal sampling cadence. */
const SAMPLE_INTERVAL_MS = 1000;
/** How often the adaptive headroom bonus may step up while stable. */
const STABLE_RAISE_INTERVAL_MS = 5000;
/** Headroom granted per ramp step. */
const BONUS_STEP_MB = 128;
/** Live texture count this far above the session floor signals a leak/churn. */
const GROWTH_ALERT_DELTA = 220;
/** Sustained growth samples before proactive degradation (sample interval = 1s). */
const GROWTH_DEGRADE_STREAK = 12;
/** Delta above session floor required before proactive degradation. */
const GROWTH_DEGRADE_DELTA = 200;
/** Stable time required since the last crash before relaxing one degradation level. */
const CRASH_RELAX_MS = 30000;
/** Only grow headroom once usage is at least this fraction (no point otherwise). */
const RAISE_MIN_USED_FRACTION = 0.7;
/** LOD-0 cooldown applied per degradation level (ms). */
const LEVEL_LOD0_COOLDOWN_MS = Object.freeze([0, 4000, 8000, 15000]);

export class AdaptiveBudgetController {
  constructor() {
    this._lastSampleMs = 0;
    this._lastRaiseMs = 0;
    this._textureCount = 0;
    this._minTextureCount = Infinity;
    this._peakTextureCount = 0;
    this._growthAlert = false;
    /** @type {number} Consecutive growth-alert samples. */
    this._growthAlertStreak = 0;
    /** @type {number} 0 none .. 3 severe */
    this._degradationLevel = 0;
    this._lastCrashMs = 0;
    this._crashCount = 0;
    this._bonusMB = 0;
  }

  /**
   * Per-frame entry point (internally throttled to SAMPLE_INTERVAL_MS).
   */
  sample() {
    const now = performance.now();
    if (now - this._lastSampleMs < SAMPLE_INTERVAL_MS) return;
    this._lastSampleMs = now;

    const renderer = window.MapShine?.renderer ?? null;
    const texCount = Number(renderer?.info?.memory?.textures) || 0;
    this._textureCount = texCount;
    if (texCount > 0) {
      this._minTextureCount = Math.min(this._minTextureCount, texCount);
      this._peakTextureCount = Math.max(this._peakTextureCount, texCount);
    }

    const floor = Number.isFinite(this._minTextureCount) ? this._minTextureCount : texCount;
    this._growthAlert = texCount > 0 && (texCount - floor) >= GROWTH_ALERT_DELTA;
    if (this._growthAlert) {
      this._growthAlertStreak += 1;
    } else {
      this._growthAlertStreak = 0;
    }

    // Proactive degradation before the next context-loss: sustained climb with
    // hundreds of untracked textures means the governor alone is not enough.
    if (
      this._growthAlertStreak >= GROWTH_DEGRADE_STREAK
      && (texCount - floor) >= GROWTH_DEGRADE_DELTA
      && this._degradationLevel < 2
    ) {
      this._setDegradation(Math.min(2, this._degradationLevel + 1));
      this._growthAlertStreak = 0;
      log.warn(
        `Sustained texture growth (+${texCount - floor} above floor ${floor}) — `
        + `proactive degradation level ${this._degradationLevel}`,
      );
    }

    // Relax one degradation level after a stable window since the last crash.
    if (this._degradationLevel > 0 && (now - this._lastCrashMs) >= CRASH_RELAX_MS) {
      this._setDegradation(this._degradationLevel - 1);
      // Require a fresh stable window before relaxing further.
      this._lastCrashMs = now;
      log.info(`Stable — relaxed degradation to level ${this._degradationLevel}`);
    }

    this._updateBudgetBonus(now);
  }

  /**
   * Record a GPU context-loss crash: escalate degradation immediately.
   */
  noteCrash() {
    this._lastCrashMs = performance.now();
    this._crashCount += 1;
    this._setDegradation(Math.min(3, this._degradationLevel + 1));
    log.warn(`Crash noted (#${this._crashCount}) — degradation level ${this._degradationLevel}`);
  }

  /** @returns {number} */
  getDegradationLevel() {
    return this._degradationLevel;
  }

  /** @param {number} gpuVramGB @returns {number} @private */
  _bonusCapMB(gpuVramGB) {
    if (gpuVramGB >= 24) return 1024;
    if (gpuVramGB >= 16) return 768;
    if (gpuVramGB >= 12) return 384;
    return 0;
  }

  /** @param {number} now @private */
  _updateBudgetBonus(now) {
    const tracker = getTextureBudgetTracker();

    // Any trouble: surrender the bonus immediately.
    if (this._degradationLevel > 0 || this._growthAlert) {
      if (this._bonusMB !== 0) {
        this._bonusMB = 0;
        tracker.setAdaptiveBonusMB(0);
        log.info('Dropped adaptive budget bonus (degradation / growth alert)');
      }
      return;
    }

    const cap = this._bonusCapMB(resolveEffectiveGpuVramGB());
    if (cap <= 0) return;
    // Only grow headroom when we are actually under pressure and stable.
    if (tracker.getUsedFraction() < RAISE_MIN_USED_FRACTION) return;
    if (now - this._lastRaiseMs < STABLE_RAISE_INTERVAL_MS) return;
    this._lastRaiseMs = now;
    if (this._bonusMB < cap) {
      this._bonusMB = Math.min(cap, this._bonusMB + BONUS_STEP_MB);
      tracker.setAdaptiveBonusMB(this._bonusMB);
      log.info(`Raised adaptive budget bonus -> +${this._bonusMB} MB (stable high-VRAM)`);
    }
  }

  /** @param {number} level @private */
  _setDegradation(level) {
    const lvl = Math.max(0, Math.min(3, Math.floor(level) || 0));
    this._degradationLevel = lvl;
    const gov = getGpuWorkScheduler();
    gov.setThrottleLevel(lvl);
    const cooldown = LEVEL_LOD0_COOLDOWN_MS[lvl] ?? 0;
    if (cooldown > 0) gov.noteCrashCooldown(cooldown);
    if (lvl > 0 && this._bonusMB !== 0) {
      this._bonusMB = 0;
      getTextureBudgetTracker().setAdaptiveBonusMB(0);
    }
  }

  /** @returns {object} Telemetry snapshot for crash report / UI. */
  getState() {
    return {
      degradationLevel: this._degradationLevel,
      crashCount: this._crashCount,
      liveTextureCount: this._textureCount,
      minTextureCount: Number.isFinite(this._minTextureCount) ? this._minTextureCount : 0,
      peakTextureCount: this._peakTextureCount,
      growthAlert: this._growthAlert,
      adaptiveBonusMB: this._bonusMB,
    };
  }
}

/**
 * Stable runtime tuning + telemetry surface (console / macros / diagnostics UI).
 * Lives on `window.MapShine.streamingTuning`.
 * @returns {object}
 */
export function getStreamingTuningApi() {
  return {
    /** Base GPU upload budget per frame in MB (0 = engine default). */
    get uploadMbPerFrame() { return getGpuWorkScheduler().getBaseFrameCreditMb(); },
    set uploadMbPerFrame(v) { getGpuWorkScheduler().setBaseFrameCreditMb(Number(v) || 0); },

    /** Allow focal cells to sharpen one level finer than zoom-native LOD. */
    get focalLod0Sharpen() { return getGpuWorkScheduler().focalSharpenEnabled !== false; },
    set focalLod0Sharpen(v) { getGpuWorkScheduler().focalSharpenEnabled = !!v; },

    /** Read-only: current adaptive budget bonus (MB) granted on stable high-VRAM GPUs. */
    get adaptiveBonusMB() { return getTextureBudgetTracker().getAdaptiveBonusMB?.() ?? 0; },
    /** Read-only: policy base budget (MB). */
    get policyBudgetMB() { return getTextureBudgetTracker().getPolicyBudgetMB?.() ?? 0; },
    /** Read-only: 0 (none) .. 3 (severe). */
    get degradationLevel() { return getAdaptiveBudgetController().getDegradationLevel(); },

    /** Telemetry snapshot (controller + governor). */
    getState() {
      return {
        adaptive: getAdaptiveBudgetController().getState(),
        governor: getGpuWorkScheduler().getStats(),
      };
    },
  };
}

/** @type {AdaptiveBudgetController|null} */
let _instance = null;

/** @returns {AdaptiveBudgetController} */
export function getAdaptiveBudgetController() {
  if (!_instance) {
    _instance = new AdaptiveBudgetController();
    try {
      if (window.MapShine) {
        window.MapShine.adaptiveBudgetController = _instance;
        window.MapShine.streamingTuning = getStreamingTuningApi();
      }
    } catch (_) {}
  }
  return _instance;
}

/** Reset singleton (teardown). */
export function disposeAdaptiveBudgetController() {
  _instance = null;
}
