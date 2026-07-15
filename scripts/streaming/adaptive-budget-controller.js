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
import {
  collectLiveTextureAudit,
  describeTextureSituation,
  diagnoseTextures,
  exposeTextureDiagnosticsApi,
  formatTextureGrowthAlert,
} from '../core/texture-diagnostics.js';
import { exposeTextureOverhaulFlagsApi } from '../core/texture-overhaul-flags.js';
import { getGpuWorkScheduler } from './gpu-work-scheduler.js';
import { resolveEffectiveGpuVramGB } from './memory-settings.js';
import { exposeVramLedgerApi, sampleVramLedger, resolveMaxInternalMpDynamic } from './vram-ledger.js';
import { disposeLargePixiFileTexturesUnderPressure } from '../foundry/pixi-texture-demotion.js';

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

/**
 * Aggregate VRAM pressure (resident / usable ceiling, across masks + PIXI +
 * compositor RTs) at which to re-apply the render-resolution cap. Residency climbs
 * AFTER the resolution was last set — masks/PIXI that weren't resident at initial
 * set now are — so the ledger's now-tighter dynamic RT budget must be re-applied to
 * pull internal resolution down before the context is lost. The count-based growth
 * signal above is blind to PIXI and compositor RTs; this byte-based one is not.
 */
const LEDGER_PRESSURE_REAPPLY = 0.9;
/** At/over the ceiling: also escalate degradation (throttle GPU uploads). */
const LEDGER_PRESSURE_DEGRADE = 1.0;
/** Minimum spacing between ledger-driven re-applies — let one take effect first (ms). */
const LEDGER_REAPPLY_COOLDOWN_MS = 3000;

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
    /** @type {object|null} Last classified growth diagnosis for UI / console. */
    this._lastGrowthDiagnosis = null;
    /** Throttle repeated growth-alert info logs. */
    this._lastGrowthInfoLogMs = 0;
    /** @type {number} performance.now() of the last ledger-driven resolution re-apply. */
    this._lastLedgerReapplyMs = 0;
    /** @type {number} Last sampled aggregate VRAM pressure (resident / ceiling). */
    this._lastLedgerPressure = 0;
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
      const nextLevel = Math.min(2, this._degradationLevel + 1);
      this._setDegradation(nextLevel);
      this._growthAlertStreak = 0;
      this._logTextureGrowthEscalation(texCount, floor, nextLevel);
    } else if (
      this._growthAlert
      && this._growthAlertStreak === 3
      && now - this._lastGrowthInfoLogMs >= 15000
    ) {
      this._lastGrowthInfoLogMs = now;
      log.info(
        `GPU texture count rising (+${texCount - floor} above session floor ${floor}, `
        + `${this._growthAlertStreak}s) — run MapShine.diagnoseTextures() if this continues`,
      );
    }

    // Relax one degradation level after a stable window since the last crash.
    if (this._degradationLevel > 0 && (now - this._lastCrashMs) >= CRASH_RELAX_MS) {
      this._setDegradation(this._degradationLevel - 1);
      // Require a fresh stable window before relaxing further.
      this._lastCrashMs = now;
      log.info(`Stable — relaxed degradation to level ${this._degradationLevel}`);
    }

    this._sampleVramLedgerPressure(now);
    this._updateBudgetBonus(now);
  }

  /**
   * Byte-based aggregate pressure check (VRAM ledger). Where the count-based growth
   * signal above is blind to PIXI and compositor RTs, this sees the whole card. When
   * residency crosses into the danger zone, pull TWO independent levers:
   *
   *  1. Re-apply the render-resolution cap — shrinks the RT slice. Self-limiting
   *     (lower res → lower RT cost → lower pressure → converges).
   *  2. Demote large file-backed PIXI textures
   *     (`disposeLargePixiFileTexturesUnderPressure`) — shrinks the PIXI slice,
   *     which resolution CANNOT touch (Foundry holds full-res source images
   *     independent of MSA's render resolution). Field data (2026-07-15, Church of
   *     the Light) showed masks+PIXI alone at 1193 MB of a 1600 MB ceiling — 75%
   *     consumed before a single RT existed — so lever 1 alone shrank internal
   *     resolution to its floor (~0.7 MP) and STILL crashed ~35 MB over. Demotion
   *     is safe to call anytime (the module's own doc: "worst case is the
   *     pre-demotion status quo, never breakage" — PIXI just re-uploads
   *     transparently if the sprite renders again) and was previously only wired
   *     to load-time and floor-change sweeps, never steady-state pressure. Uses its
   *     OWN anti-churn budget (not the load/floor-change sweeps' shared one) — see
   *     the long comment on `disposeLargePixiFileTexturesUnderPressure` for why
   *     sharing it let a floor-change sweep silently exhaust this lever's budget.
   *
   * @param {number} now
   * @private
   */
  _sampleVramLedgerPressure(now) {
    let led = null;
    try {
      led = sampleVramLedger();
    } catch (_) {
      return;
    }
    if (!led || !Number.isFinite(led.ceilingMB)) return;
    this._lastLedgerPressure = led.pressure;
    if (led.pressure < LEDGER_PRESSURE_REAPPLY) return;

    // Do NOT respond during a floor-switch / scene-load transient. Those are heavy,
    // self-resolving windows, and a render-resolution re-apply during one is an
    // own-goal: it reallocates the ENTIRE compositor RT stack (a multi-second
    // main-thread stall AND a transient VRAM spike as the old + new RTs briefly
    // coexist), and because the switch's own mask bake is still growing residency
    // it chases a moving target and RE-FIRES every cooldown. Field data
    // (2026-07-15, Church of the Light) showed exactly this — a `graphicsSettings.
    // resize` storm across a cold floor switch, ending in a TDR context loss.
    // Return WITHOUT consuming the cooldown so ONE clean re-apply fires promptly
    // once the transient clears and residency is stable. The floor-change path has
    // its own PIXI demotion sweep (`startFloorChangeDemotionSweep`), so skipping the
    // pressure-demotion here during the transient leaves no coverage gap.
    if (window.MapShine?.__msaSceneLoading === true
        || window.MapShine?.__v3ViewOnlyFloorSwitchInFlight === true) {
      return;
    }

    if (now - this._lastLedgerReapplyMs < LEDGER_REAPPLY_COOLDOWN_MS) return;

    // A render-resolution re-apply only helps if it will MEANINGFULLY shrink the RT
    // stack. If the current internal resolution already fits the dynamic budget (or
    // is within ~5% of it), a resize pays the full RT-realloc cost — the exact stall
    // above — for no VRAM gain. In that case the overage is masks/PIXI, not RTs, so
    // demote PIXI (cheap: dispose only, no realloc) and skip the resize.
    let targetMaxMp = Infinity;
    try { targetMaxMp = resolveMaxInternalMpDynamic(); } catch (_) {}
    const currentMp = Number(led.internalMp) || 0;
    const resizeWouldHelp = !(Number.isFinite(targetMaxMp) && currentMp > 0 && currentMp <= targetMaxMp * 1.05);

    this._lastLedgerReapplyMs = now;

    if (resizeWouldHelp) {
      try {
        window.MapShine?.graphicsSettings?.reapplyRenderResolution?.();
      } catch (_) {}
    }

    let demoted = { count: 0, freedMB: 0 };
    try {
      demoted = disposeLargePixiFileTexturesUnderPressure() ?? demoted;
    } catch (_) {}

    // At/over the ceiling, also throttle GPU uploads so a floor-switch mask rebuild
    // or a cloud-atlas upload spike can't push it further over the edge.
    if (led.pressure >= LEDGER_PRESSURE_DEGRADE && this._degradationLevel < 2) {
      this._setDegradation(Math.min(2, this._degradationLevel + 1));
    }

    log.warn(
      `VRAM aggregate ${Math.round(led.residentMB)}/${Math.round(led.ceilingMB)} MB `
      + `(${Math.round(led.pressure * 100)}%: masks ${Math.round(led.masksMB)} + pixi ${Math.round(led.pixiMB)} `
      + `+ rt ${Math.round(led.compositorRtMB)}) — `
      + (resizeWouldHelp ? 're-applied render-resolution cap' : 'internal res already at budget, no resize')
      + (demoted.count ? ` + demoted ${demoted.count} PIXI texture(s) (~${demoted.freedMB} MB)` : ''),
    );
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

  /**
   * Classify sustained texture inflation and log a readable escalation message.
   * @param {number} texCount
   * @param {number} floor
   * @param {number} degradationLevel
   * @private
   */
  _logTextureGrowthEscalation(texCount, floor, degradationLevel) {
    const growthDelta = texCount - floor;
    const growthStreakSec = GROWTH_DEGRADE_STREAK;
    try {
      const audit = collectLiveTextureAudit({ maxCellsPerGrid: 12, probeLimit: 8 });
      const diagnosis = describeTextureSituation(audit, {
        growthDelta,
        sessionFloor: floor,
        growthStreakSec,
        degradationLevel,
        action: `Raising proactive degradation to level ${degradationLevel} `
          + '(throttle GPU uploads, LOD-0 cooldown). Run MapShine.diagnoseTextures() for full audit.',
      });
      this._lastGrowthDiagnosis = diagnosis;
      log.warn(formatTextureGrowthAlert(audit, {
        growthDelta,
        sessionFloor: floor,
        growthStreakSec,
        degradationLevel,
      }));
    } catch (err) {
      this._lastGrowthDiagnosis = {
        leakId: 'none',
        label: 'Texture inflation',
        headline: `Texture inflation: ${texCount} GPU textures (+${growthDelta} above floor ${floor})`,
        summary: `Sustained growth ~${growthStreakSec}s — proactive degradation level ${degradationLevel}`,
        detail: String(err?.message ?? err),
        metrics: '',
      };
      log.warn(this._lastGrowthDiagnosis.summary);
    }
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
      growthAlertStreak: this._growthAlertStreak,
      growthDiagnosis: this._lastGrowthDiagnosis,
      adaptiveBonusMB: this._bonusMB,
      ledgerPressure: Number(this._lastLedgerPressure.toFixed(3)),
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

    /** Classify live GPU texture inflation (console tables + lastTextureAudit global). */
    diagnoseTextures: (opts) => diagnoseTextures(opts),
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
        exposeTextureDiagnosticsApi();
        exposeTextureOverhaulFlagsApi();
        exposeVramLedgerApi();
      }
    } catch (_) {}
  }
  return _instance;
}

/** Reset singleton (teardown). */
export function disposeAdaptiveBudgetController() {
  _instance = null;
}
