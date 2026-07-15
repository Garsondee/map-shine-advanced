/**
 * @fileoverview Foundry/PIXI-side GPU texture demotion (Stage A9, Forward+ §13.2).
 *
 * Foundry's own PIXI renderer holds full-resolution source images (scene
 * background, tiles) in the same GPU memory as MSA's Three.js renderer. On a
 * 12000×12000 scene that is ~1.46 GB for two textures — resident while MSA
 * (which caps its own copies at 2048px) does all visible rendering. Verified
 * by the crash-report `pixiTextures` section: 1733–1981 MB on the Mansion,
 * growing across context-restore retries, while MSA-side allocations were
 * near-zero at crash time.
 *
 * `BaseTexture.dispose()` frees the GL texture but keeps the CPU-side
 * resource, so:
 *  - MSA's `_tryLoadFromFoundryPixi` (which reads `resource.source` CPU-side,
 *    never binds) keeps working;
 *  - if anything DOES render the sprite again, PIXI transparently re-uploads —
 *    worst case is the pre-demotion status quo, never breakage.
 *
 * Only file-backed textures (`resource.src` is a string) above a size
 * threshold are demoted; render textures (Foundry's vision/occlusion
 * machinery, `src == null`) are never touched. A per-URL dispose counter
 * stops the sweep from churning if something keeps re-binding a texture.
 *
 * Verification: the demoted entries disappear from `pixiTextures` in the
 * crash/diagnostics report; `estTotalMB` should drop by ~1.4 GB on the
 * Mansion.
 *
 * @module foundry/pixi-texture-demotion
 */

import { createLogger } from '../core/log.js';

const log = createLogger('PixiTextureDemotion');

/** Minimum texture dimension (px) to demote. Catches 12000² scene images. */
const DEFAULT_MIN_DIM = 8192;
/** Sweep cadence while a scene load is in progress. */
const SWEEP_INTERVAL_MS = 2000;
/** Per-URL dispose limit — if something keeps re-binding, stop churning it. */
const MAX_DISPOSES_PER_TEXTURE = 3;

let _sweepId = null;
/** @type {number|null} floor-change sweep timer */
let _floorSweepId = null;
/** @type {Map<string, number>} dispose count per resource URL — load-time + floor-change sweeps share this budget. */
const _disposeCounts = new Map();
/**
 * @type {Map<string, number>} SEPARATE dispose-count budget for pressure-triggered
 * (crash-prevention) demotion calls — see the long comment on
 * {@link disposeLargePixiFileTexturesUnderPressure} for why this must not share
 * `_disposeCounts` with the load/floor-change sweeps.
 */
const _pressureDisposeCounts = new Map();

/**
 * Dispose the GL side of large file-backed PIXI BaseTextures.
 * Safe to call at any time; returns what it freed.
 *
 * @param {number} [minDim=DEFAULT_MIN_DIM]
 * @param {Map<string, number>} [disposeCounts] Anti-churn budget to read/write.
 *   Defaults to the shared load/floor-change budget for the two original call
 *   sites' behavior. Pass a private Map to give a caller its own independent
 *   budget — see {@link disposeLargePixiFileTexturesUnderPressure}.
 * @returns {{ count: number, freedMB: number }}
 */
export function disposeLargePixiFileTextures(minDim = DEFAULT_MIN_DIM, disposeCounts = _disposeCounts) {
  let freedMB = 0;
  let count = 0;
  try {
    const managed = globalThis.canvas?.app?.renderer?.texture?.managedTextures;
    if (!Array.isArray(managed)) return { count: 0, freedMB: 0 };
    // slice(): dispose() mutates managedTextures during iteration.
    for (const bt of managed.slice()) {
      try {
        const w = Number(bt?.realWidth ?? bt?.width) || 0;
        const h = Number(bt?.realHeight ?? bt?.height) || 0;
        const src = bt?.resource?.src;
        if (typeof src !== 'string' || Math.max(w, h) < minDim) continue;
        const n = disposeCounts.get(src) ?? 0;
        if (n >= MAX_DISPOSES_PER_TEXTURE) continue;
        disposeCounts.set(src, n + 1);
        bt.dispose();
        freedMB += Math.round((w * h * 4) / 1048576);
        count++;
        if (n + 1 === MAX_DISPOSES_PER_TEXTURE) {
          log.warn(
            `PIXI texture re-bound ${MAX_DISPOSES_PER_TEXTURE}x — leaving it resident to avoid upload churn: ${src.slice(-96)}`,
          );
        }
      } catch (_) {}
    }
  } catch (_) {}
  if (count) {
    log.info(`Demoted ${count} large PIXI texture(s), ~${freedMB} MB GPU freed`);
  }
  return { count, freedMB };
}

/**
 * Pressure-triggered demotion entry point (VRAM ledger — `AdaptiveBudgetController`,
 * called whenever aggregate residency crosses the danger threshold).
 *
 * Uses its OWN anti-churn budget (`_pressureDisposeCounts`), independent of the
 * load-time and floor-change sweeps' shared `_disposeCounts`. Field data (2026-07-15,
 * Church of the Light, floor-change crash): `startFloorChangeDemotionSweep` fires on
 * every floor change and shares `_disposeCounts` with the ORIGINAL
 * `disposeLargePixiFileTextures()` call — if that sweep burns through the shared
 * 3-dispose budget on a texture Foundry keeps re-binding (plausible for a floor's own
 * light-cover/background asset touched every redraw), a pressure-triggered call
 * arriving moments later would see the cap already hit and silently no-op for the
 * REST OF THE SESSION, with no way to distinguish "already handled" from "gave up."
 * The two purposes have different tolerances anyway: the load/floor sweeps are
 * optimizing for "don't waste bandwidth re-uploading during a known transient
 * window" (a reasonable throttle); pressure-triggered demotion exists purely to
 * avert a context-loss crash, where repeated wasted disposal is a fully acceptable
 * cost next to the alternative. Giving it an independent budget means an unrelated
 * sweep can never disable emergency demotion for the rest of the session.
 *
 * @param {number} [minDim=DEFAULT_MIN_DIM]
 * @returns {{ count: number, freedMB: number }}
 */
export function disposeLargePixiFileTexturesUnderPressure(minDim = DEFAULT_MIN_DIM) {
  return disposeLargePixiFileTextures(minDim, _pressureDisposeCounts);
}

/**
 * Start the load-time sweep: demote every SWEEP_INTERVAL_MS while
 * `window.MapShine.__msaSceneLoading` is true, then run one final pass and
 * self-terminate. Call at the start of scene canvas creation.
 */
export function startLoadDemotionSweep() {
  stopLoadDemotionSweep();
  _disposeCounts.clear();
  disposeLargePixiFileTextures();
  _sweepId = setInterval(() => {
    try {
      disposeLargePixiFileTextures();
      if (window.MapShine?.__msaSceneLoading !== true) {
        stopLoadDemotionSweep();
        log.debug('Load demotion sweep complete (scene load finished)');
      }
    } catch (_) {
      stopLoadDemotionSweep();
    }
  }, SWEEP_INTERVAL_MS);
}

/** Stop the load-time sweep (idempotent). */
export function stopLoadDemotionSweep() {
  if (_sweepId != null) {
    clearInterval(_sweepId);
    _sweepId = null;
  }
}

/**
 * Demote after a FLOOR CHANGE. A multi-floor view makes Foundry's PIXI renderer
 * load and hold the newly-viewed floor's full-resolution background (via
 * `canvas.scene.view({ level })`) — e.g. on the Mansion, three 12000² textures
 * (~731 MB each) resident at once, which exhausted the 8 GB card and lost the
 * context at fadeIn (a floor-change crash the load-time sweep never covered
 * because it self-terminates once `__msaSceneLoading` clears). V3 renders from
 * the bus/streaming copies, not Foundry's full-res source, so these are pure
 * waste.
 *
 * Foundry uploads the texture asynchronously during its redraw, so this runs a
 * few spaced passes to catch it once it lands, then stops. The per-URL dispose
 * counter (reset here for a fresh floor-change budget) still bounds churn if
 * something keeps re-binding.
 *
 * @param {{ passes?: number, intervalMs?: number }} [opts]
 */
export function startFloorChangeDemotionSweep({ passes = 5, intervalMs = 1200 } = {}) {
  stopFloorChangeDemotionSweep();
  // Fresh anti-churn budget: we WANT to dispose the just-loaded floor texture,
  // even if a previous load/floor-change already spent its budget on that URL.
  _disposeCounts.clear();
  let remaining = Math.max(1, passes | 0);
  const tick = () => {
    _floorSweepId = null;
    try {
      const { count, freedMB } = disposeLargePixiFileTextures();
      if (count) log.info(`Floor-change demotion freed ~${freedMB} MB (${count} texture(s))`);
    } catch (_) {}
    remaining -= 1;
    if (remaining <= 0) return;
    _floorSweepId = setTimeout(tick, Math.max(200, intervalMs | 0));
  };
  tick();
}

/** Stop the floor-change sweep (idempotent). */
export function stopFloorChangeDemotionSweep() {
  if (_floorSweepId != null) {
    clearTimeout(_floorSweepId);
    _floorSweepId = null;
  }
}

// Console/manual access for testing: MapShine.pixiTextureDemotion.dispose()
try {
  if (typeof window !== 'undefined') {
    window.MapShine = window.MapShine || {};
    window.MapShine.pixiTextureDemotion = {
      dispose: disposeLargePixiFileTextures,
      disposeUnderPressure: disposeLargePixiFileTexturesUnderPressure,
      startSweep: startLoadDemotionSweep,
      stopSweep: stopLoadDemotionSweep,
      startFloorChangeSweep: startFloorChangeDemotionSweep,
      stopFloorChangeSweep: stopFloorChangeDemotionSweep,
    };
  }
} catch (_) {}
