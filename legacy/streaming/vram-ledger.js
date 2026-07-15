/**
 * @fileoverview VRAM ledger — one residency accountant for the whole card.
 *
 * The crash this exists to prevent is aggregate, not per-consumer. MSA historically
 * ran THREE independent budgets that never summed against one ceiling:
 *   1. TextureBudgetTracker (masks + streaming tiles)  — its own ~768 MB budget.
 *   2. The compositor render-target stack               — a FIXED ~1200 MB budget
 *      (`resolveCompositorRtBudgetMB`), estimate-only.
 *   3. Foundry's PIXI-side textures                     — measured only at crash,
 *      enforced by nobody (often ~500 MB on a heavy scene).
 * Each budget can pass its own exam while the SUM sails past what the card actually
 * gives browser WebGL through ANGLE/D3D11 (~1.8 GB on an 8 GB laptop). That is a
 * `webglcontextlost` with `overBudget:false` on every individual meter — exactly the
 * shape of the field crashes (see docs/planning/Forward+.md §16, "one residency ledger").
 *
 * This module is that single ledger. It sums the three consumers into one resident
 * total against one calibrated usable ceiling, and — the load-bearing part — makes
 * the render-resolution budget DYNAMIC: the RTs may use `ceiling − masks − pixi`,
 * not a fixed 1200. When masks + PIXI are heavy, internal render resolution caps
 * tighter (FSR upscales to display), so the aggregate never crosses the ceiling.
 *
 * Design guarantees:
 *  - **Monotonic safety.** {@link resolveMaxInternalMpDynamic} returns
 *    `min(staticPolicyMax, dynamicMax)` — it can only ever TIGHTEN vs. today's
 *    behaviour, never loosen. Scenes that render fine today are unaffected (their
 *    masks + PIXI are small, so the dynamic budget exceeds the static one and the
 *    static wins); only scenes that are genuinely over the aggregate get pulled down.
 *  - **Fails soft.** Every probe guards to 0 / Infinity so the live budgeting path
 *    never throws during bootstrap, teardown, or a lost context.
 *  - **Acyclic.** Imports low-level estimators from texture-budget-policy and reads
 *    the live internal render size off the MapShine global — nothing here is imported
 *    back by those modules.
 *
 * @module streaming/vram-ledger
 */

import { getTextureBudgetTracker } from '../assets/TextureBudgetTracker.js';
import {
  estimateCompositorRtVramMB,
  estimateRtMbPerDrawingBufferMp,
  estimateDrawingBufferMP,
  resolveMaxDrawingBufferMp,
} from './texture-budget-policy.js';
import { resolveEffectiveGpuVramGB } from './memory-settings.js';
import { samplePixiTextureMB } from './pixi-vram-probe.js';

/**
 * MSA-controllable usable-VRAM ceiling in MB, by GPU VRAM tier. This is the budget
 * the three MSA-visible consumers (tracked masks/tiles + compositor RTs + PIXI
 * textures) must collectively fit under — NOT nominal card VRAM. Chrome's GPU
 * process, ANGLE/D3D11 driver overhead, and transient source-decode memory are
 * already reserved out of it.
 *
 * Calibration (RTX 3070 Laptop, 8 GB, ANGLE/D3D11 in Chrome): field context-loss
 * observed at ~1.6–1.8 GB total browser-WebGL residency; reserving ~250 MB for
 * Chrome/ANGLE overhead leaves ~1550–1600 MB for the three consumers. We set 1600
 * and rely on the monotonic `min(static, dynamic)` clamp downstream to prevent any
 * regression if this proves slightly generous.
 *
 * @param {number} vramGB
 * @returns {number} Usable ceiling in MB (Infinity = no aggregate cap on 16 GB+).
 */
export function resolveUsableVramCeilingMB(vramGB) {
  const v = Number(vramGB) || 0;
  if (v <= 4) return 800;
  if (v <= 6) return 1200;
  if (v <= 8) return 1600;
  if (v <= 12) return 2900;
  return Infinity;
}

/**
 * Live internal (DRS-capped) drawing-buffer size in megapixels. The compositor and
 * effect RTs are allocated at the INTERNAL render size, not the display backing
 * store, so the RT VRAM estimate must use internal MP to be accurate. Prefers the
 * resolution snapshot, then the live compositor, then the raw drawing buffer.
 * @returns {number} Megapixels.
 * @private
 */
function _internalDrawingBufferMp() {
  try {
    const mp = Number(window.MapShine?.compositorResolution?.internal?.mp);
    if (mp > 0) return mp;
  } catch (_) {}
  try {
    const fc = window.MapShine?.floorCompositorV2;
    const w = Number(fc?._internalW) || 0;
    const h = Number(fc?._internalH) || 0;
    if (w > 0 && h > 0) return (w * h) / 1_000_000;
  } catch (_) {}
  return estimateDrawingBufferMP();
}

/**
 * Tracked non-render-target VRAM (masks + streaming tiles) in MB. Deliberately
 * EXCLUDES any 'renderTarget'-source entries so the compositor-RT estimate owns
 * the RT slice and nothing is double-counted — even if effect RTs get registered
 * with the tracker in future.
 * @returns {number} MB.
 * @private
 */
function _trackedNonRtMB() {
  try {
    const tracker = getTextureBudgetTracker();
    const breakdown = tracker?.getSourceBreakdown?.();
    if (breakdown && typeof breakdown === 'object') {
      let bytes = 0;
      for (const [src, b] of Object.entries(breakdown)) {
        if (src === 'renderTarget') continue;
        bytes += Number(b) || 0;
      }
      return bytes / 1048576;
    }
    return (Number(tracker?._usedBytes) || 0) / 1048576;
  } catch (_) {
    return 0;
  }
}

/**
 * @typedef {object} VramLedgerSample
 * @property {number} vramGB         Effective GPU VRAM (GB).
 * @property {number} ceilingMB      Usable aggregate ceiling (Infinity on 16 GB+).
 * @property {number} masksMB        Tracked masks + streaming tiles.
 * @property {number} pixiMB         Foundry/PIXI-side textures.
 * @property {number} compositorRtMB Estimated compositor/effect RT stack (at internal MP).
 * @property {number} internalMp     Internal render size in megapixels.
 * @property {number} residentMB     masks + pixi + compositorRt.
 * @property {number} pressure       residentMB / ceilingMB (0 when uncapped).
 */

/**
 * Sample the whole ledger once. Cheap enough for ~1 Hz polling (walks ~tens of
 * PIXI textures + ~tens of tracker entries).
 * @returns {VramLedgerSample}
 */
export function sampleVramLedger() {
  const vramGB = resolveEffectiveGpuVramGB();
  const ceilingMB = resolveUsableVramCeilingMB(vramGB);
  const masksMB = _trackedNonRtMB();
  const pixiMB = samplePixiTextureMB();
  const internalMp = _internalDrawingBufferMp();
  const compositorRtMB = estimateCompositorRtVramMB(internalMp);
  const residentMB = masksMB + pixiMB + compositorRtMB;
  const pressure = (Number.isFinite(ceilingMB) && ceilingMB > 0) ? residentMB / ceilingMB : 0;
  return { vramGB, ceilingMB, masksMB, pixiMB, compositorRtMB, internalMp, residentMB, pressure };
}

/** RTs are never starved below this so the image stays usable (upscaled) rather than black. */
export const RT_BUDGET_FLOOR_MB = 300;

/**
 * The unification: how much VRAM the compositor RT stack may use RIGHT NOW, given
 * what masks and PIXI already hold. This replaces the fixed per-tier RT budget with
 * `ceiling − masks − pixi`, so render resolution automatically yields to whichever
 * consumer is heavy on this scene.
 * @returns {number} RT budget in MB (Infinity = uncapped on 16 GB+).
 */
export function resolveDynamicCompositorRtBudgetMB() {
  const vramGB = resolveEffectiveGpuVramGB();
  const ceilingMB = resolveUsableVramCeilingMB(vramGB);
  if (!Number.isFinite(ceilingMB)) return Infinity;
  const masksMB = _trackedNonRtMB();
  const pixiMB = samplePixiTextureMB();
  const avail = ceilingMB - masksMB - pixiMB;
  return Math.max(RT_BUDGET_FLOOR_MB, avail);
}

/**
 * Maximum safe INTERNAL drawing-buffer megapixels, aggregate-aware. The dynamic
 * answer is clamped to the static policy ceiling ({@link resolveMaxDrawingBufferMp})
 * so this can only ever tighten resolution vs. today, never loosen it — no regression
 * on scenes that already render fine.
 * @returns {number} Max internal megapixels (Infinity = uncapped).
 */
export function resolveMaxInternalMpDynamic() {
  const staticMax = resolveMaxDrawingBufferMp();
  const budgetMB = resolveDynamicCompositorRtBudgetMB();
  if (!Number.isFinite(budgetMB)) return staticMax;
  const perMp = estimateRtMbPerDrawingBufferMp();
  if (!(perMp > 0)) return staticMax;
  const dynamicMax = budgetMB / perMp;
  return Number.isFinite(staticMax) ? Math.min(staticMax, dynamicMax) : dynamicMax;
}

/**
 * True when a fresh large GPU allocation (a cloud-atlas upload, a per-floor mask
 * rebuild) should be paced/deferred because it risks tipping the card. Trips during
 * exactly the windows the field crashes landed in: mid-load, mid-floor-switch, or
 * whenever the aggregate is already near the ceiling.
 * @param {{ pressureThreshold?: number }} [opts]
 * @returns {boolean}
 */
export function shouldDeferHeavyAlloc(opts = {}) {
  try {
    if (window.MapShine?.__msaSceneLoading === true) return true;
    if (window.MapShine?.__v3ViewOnlyFloorSwitchInFlight === true) return true;
    const threshold = Number(opts.pressureThreshold) || 0.85;
    const { pressure } = sampleVramLedger();
    if (pressure >= threshold) return true;
  } catch (_) {}
  return false;
}

/**
 * Compact, rounded ledger snapshot for the crash report and the `MapShine.vram()`
 * console diagnostic.
 * @returns {object|null}
 */
export function getVramLedgerReport() {
  try {
    const s = sampleVramLedger();
    const dynBudget = resolveDynamicCompositorRtBudgetMB();
    const maxMp = resolveMaxInternalMpDynamic();
    const capped = Number.isFinite(s.ceilingMB);
    return {
      vramGB: s.vramGB,
      ceilingMB: capped ? Math.round(s.ceilingMB) : null,
      residentMB: Math.round(s.residentMB),
      pressurePct: capped ? Math.round(s.pressure * 100) : null,
      overCeiling: capped ? s.residentMB > s.ceilingMB : false,
      breakdown: {
        masksMB: Math.round(s.masksMB),
        pixiMB: Math.round(s.pixiMB),
        compositorRtMB: Math.round(s.compositorRtMB),
      },
      internalMp: Number(s.internalMp.toFixed(2)),
      dynamicRtBudgetMB: Number.isFinite(dynBudget) ? Math.round(dynBudget) : null,
      maxInternalMp: Number.isFinite(maxMp) ? Number(maxMp.toFixed(2)) : null,
      deferHeavyAlloc: shouldDeferHeavyAlloc(),
    };
  } catch (_) {
    return null;
  }
}

/**
 * Expose `MapShine.vram()` — a live console readout of the aggregate breakdown vs
 * the ceiling and the dynamic render-resolution budget. Idempotent.
 */
export function exposeVramLedgerApi() {
  try {
    if (!window.MapShine || typeof window.MapShine.vram === 'function') return;
    window.MapShine.vram = () => {
      const r = getVramLedgerReport();
      if (!r) {
        console.log('[vram] ledger unavailable (renderer not ready)');
        return null;
      }
      const color = r.overCeiling ? '#ff6b6b' : (r.pressurePct ?? 0) > 85 ? '#ffd166' : '#8ac926';
      console.log(
        `%c[vram] resident ${r.residentMB} MB / ceiling ${r.ceilingMB ?? '∞'} MB `
        + `(${r.pressurePct ?? '?'}%)${r.overCeiling ? '  ⚠ OVER CEILING' : ''}`,
        `color:${color};font-weight:bold`,
      );
      try {
        console.table({
          masks: { MB: r.breakdown.masksMB },
          pixi: { MB: r.breakdown.pixiMB },
          compositorRT: { MB: r.breakdown.compositorRtMB },
        });
      } catch (_) {}
      console.log(
        `[vram] internal ${r.internalMp} MP · dynamic RT budget `
        + `${r.dynamicRtBudgetMB ?? '∞'} MB → max internal ${r.maxInternalMp ?? '∞'} MP · `
        + `deferHeavyAlloc=${r.deferHeavyAlloc}`,
      );
      return r;
    };
  } catch (_) {}
}
