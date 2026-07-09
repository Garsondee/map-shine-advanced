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
/** @type {Map<string, number>} dispose count per resource URL (this load) */
const _disposeCounts = new Map();

/**
 * Dispose the GL side of large file-backed PIXI BaseTextures.
 * Safe to call at any time; returns what it freed.
 *
 * @param {number} [minDim=DEFAULT_MIN_DIM]
 * @returns {{ count: number, freedMB: number }}
 */
export function disposeLargePixiFileTextures(minDim = DEFAULT_MIN_DIM) {
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
        const n = _disposeCounts.get(src) ?? 0;
        if (n >= MAX_DISPOSES_PER_TEXTURE) continue;
        _disposeCounts.set(src, n + 1);
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

// Console/manual access for testing: MapShine.pixiTextureDemotion.dispose()
try {
  if (typeof window !== 'undefined') {
    window.MapShine = window.MapShine || {};
    window.MapShine.pixiTextureDemotion = {
      dispose: disposeLargePixiFileTextures,
      startSweep: startLoadDemotionSweep,
      stopSweep: stopLoadDemotionSweep,
    };
  }
} catch (_) {}
