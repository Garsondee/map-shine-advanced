/**
 * @fileoverview Derive streaming tile size, LOD cap, and VRAM budget from GPU + scene size.
 * @module streaming/texture-budget-policy
 */

import { resolveCellSize } from './streaming-grid.js';
import { getTextureBudgetTracker } from '../assets/TextureBudgetTracker.js';
import { clearPyramidMemoryCaches } from './texture-pyramid-builder.js';
import {
  isGpuVramUserOverride,
  resolveEffectiveGpuVramGB,
  resolveEffectiveSystemRamGB,
  resolveGpuVramBaseBudgetMB,
  resolveHugeSceneCapMB,
  resolveLargeSceneCapMB,
} from './memory-settings.js';

/**
 * @typedef {object} TextureBudgetPolicy
 * @property {number} budgetMB
 * @property {number} cellSize
 * @property {number} maxLod
 * @property {number} maxTextureSize
 * @property {number} maskResolutionScale
 * @property {number} backgroundMaxSize
 * @property {number} tileAlbedoMaxSize
 * @property {number} sceneMegapixels
 * @property {string} budgetReason
 */

/**
 * Estimate scene megapixels from canvas dimensions.
 * @returns {number}
 */
export function estimateSceneMegapixels() {
  const fd = window.MapShine?.sceneComposer?.foundrySceneData;
  const sr = globalThis.canvas?.dimensions?.sceneRect ?? globalThis.canvas?.dimensions ?? {};
  const w = Number(sr.width ?? fd?.sceneWidth ?? 0);
  const h = Number(sr.height ?? fd?.sceneHeight ?? 0);
  if (!(w > 0 && h > 0)) return 0;
  return (w * h) / 1_000_000;
}

/**
 * Estimate the compositor drawing-buffer size in megapixels. Effect
 * render-target stacks scale with this (not with scene size), so a small scene
 * at native 4K on an 8 GB card can be just as heavy as a large scene at 1080p.
 * @returns {number}
 */
export function estimateDrawingBufferMP() {
  let w = 0;
  let h = 0;
  try {
    // Prefer the GL context's reported drawing-buffer size — it reflects the
    // actual backing-store resolution. When the context is lost this returns
    // 0×0, so fall through to the canvas element dimensions which persist.
    const gl = window.MapShine?.renderer?.getContext?.() ?? null;
    w = Number(gl?.drawingBufferWidth) || 0;
    h = Number(gl?.drawingBufferHeight) || 0;
  } catch (_) {}
  if (!(w > 0 && h > 0)) {
    try {
      // Three.js canvas .width/.height are the backing-store pixel dimensions
      // (canvas.width = floor(cssWidth * pixelRatio)). This is more accurate
      // than innerWidth × devicePixelRatio which always gives the full native
      // resolution even when the render preset is lower.
      const canvas = window.MapShine?.renderer?.domElement;
      w = Number(canvas?.width) || 0;
      h = Number(canvas?.height) || 0;
    } catch (_) {}
  }
  if (!(w > 0 && h > 0)) {
    // Last resort — full-native fallback. Only used when neither the GL context
    // nor the canvas element is reachable (e.g. very early in bootstrap).
    const vw = Number(globalThis.innerWidth) || 0;
    const vh = Number(globalThis.innerHeight) || 0;
    const pr = Number(globalThis.devicePixelRatio) || 1;
    w = vw * pr;
    h = vh * pr;
  }
  if (!(w > 0 && h > 0)) return 0;
  return (w * h) / 1_000_000;
}

/**
 * Best-effort visible/defined floor count for the current scene.
 * @returns {number}
 */
export function resolveVisibleFloorCount() {
  try {
    const fs = window.MapShine?.floorStack?.getFloors?.() ?? [];
    if (fs.length > 1) return fs.length;
    return Number(globalThis.canvas?.scene?.levels?.size ?? 0) || 0;
  } catch (_) {
    return 0;
  }
}

/**
 * @typedef {object} GpuLoadPressure
 * @property {number} vram Effective GPU VRAM (GB) — from the corrected auto probe or user override.
 * @property {number} sceneMp Scene size in megapixels.
 * @property {number} drawingBufferMp Compositor drawing-buffer size in megapixels.
 * @property {number} floors Visible/defined floor count.
 * @property {boolean} highLoad True when this scene + viewport is heavy for this card.
 */

/**
 * Effective GPU load pressure for the current scene, viewport and card.
 *
 * The historical crash guardrails engaged only on scene megapixels (>=90/130),
 * which misses the exact failure case in the field: a modest scene rendered at
 * native 4K on an 8 GB GPU. This blends scene size, floor count AND drawing
 * buffer size, scaled by the card's real VRAM tier.
 *
 * @returns {GpuLoadPressure}
 */
export function getGpuLoadPressure() {
  const vram = resolveEffectiveGpuVramGB();
  const sceneMp = estimateSceneMegapixels();
  const drawingBufferMp = estimateDrawingBufferMP();
  const floors = resolveVisibleFloorCount();

  let highLoad = false;
  if (sceneMp >= 130) {
    highLoad = true;
  } else if (vram <= 8) {
    highLoad = sceneMp >= 40 || drawingBufferMp >= 8 || (floors >= 2 && sceneMp >= 24);
  } else if (vram <= 12) {
    highLoad = sceneMp >= 90 || drawingBufferMp >= 12 || (floors >= 2 && sceneMp >= 60);
  } else {
    highLoad = sceneMp >= 90;
  }

  return { vram, sceneMp, drawingBufferMp, floors, highLoad };
}

/**
 * Estimated compositor render-target VRAM cost, in MB, per megapixel of drawing
 * buffer, for a single visible floor. This is the sum of every full-screen (or
 * scene-resolution) WebGLRenderTarget the compositor + effects hold alive:
 * the bus scene/post RTs (HalfFloat), the lighting stack + per-floor snapshots,
 * bloom, the overhead-stamp mask stack (~19 RGBA8 targets), shadow passes,
 * distortion, replica/vegetation occlusion passes and the optional depth blur,
 * PLUS their depth-buffer textures (each RT with depth=true contributes an
 * additional RGBA8/depth texture that is also uploaded to GPU).
 *
 * Calibrated from field data: on an RTX 3070 Laptop GPU (8 GB) running through
 * ANGLE/D3D11 in Chrome, a crash was observed at 2.12 MP drawing buffer. Back-
 * calculating: RTs ≈ 1600 MB total − 285 MB masks − 150 MB source cache − 200 MB
 * Chrome/ANGLE overhead = ~965 MB of RTs at 2.12 MP → ~455 MB/MP. The initial
 * estimate of 370 MB/MP was too low because it omitted depth textures.
 * These render targets are NOT counted by TextureBudgetTracker (which only tracks
 * masks and streaming tiles), so they are the dominant *uncounted* VRAM consumer.
 * @type {number}
 */
export const RT_MB_PER_DRAWING_BUFFER_MP_BASE = 470;

/** Additional RT cost per MP for each visible floor beyond the first (per-level bus pool + lit snapshots + light snapshots). */
export const RT_MB_PER_DRAWING_BUFFER_MP_PER_EXTRA_FLOOR = 55;

/**
 * RT VRAM cost per drawing-buffer megapixel for the current scene (scales with
 * visible floor count).
 * @returns {number} MB per drawing-buffer megapixel
 */
export function estimateRtMbPerDrawingBufferMp() {
  const floors = Math.max(1, resolveVisibleFloorCount() || 1);
  return RT_MB_PER_DRAWING_BUFFER_MP_BASE
    + Math.max(0, floors - 1) * RT_MB_PER_DRAWING_BUFFER_MP_PER_EXTRA_FLOOR;
}

/**
 * Estimated compositor render-target VRAM in MB at the current (or a supplied)
 * drawing-buffer megapixel count. Used both for the drawing-buffer cap and for
 * crash-report accounting so total GPU memory is finally visible.
 * @param {number} [drawingBufferMp] Defaults to the live drawing buffer.
 * @returns {number} Estimated RT VRAM in MB.
 */
export function estimateCompositorRtVramMB(drawingBufferMp) {
  const mp = Number.isFinite(drawingBufferMp) ? drawingBufferMp : estimateDrawingBufferMP();
  if (!(mp > 0)) return 0;
  return mp * estimateRtMbPerDrawingBufferMp();
}

/**
 * VRAM budget (MB) allotted to the *uncounted* compositor render-target stack for
 * a given GPU VRAM tier. This is deliberately conservative: browser WebGL through
 * ANGLE/D3D11 on a shared or laptop GPU has far less usable VRAM than the nominal
 * spec (Chrome's GPU process, PIXI, the Foundry canvas and driver overhead all
 * compete), and a single oversized allocation triggers context loss. The tracked
 * mask/tile budget is separate and lives alongside this.
 * @param {number} vramGB
 * @returns {number} RT budget in MB (Infinity = uncapped).
 */
export function resolveCompositorRtBudgetMB(vramGB) {
  const v = Number(vramGB) || 0;
  // The model's MB/MP figure (RT_MB_PER_DRAWING_BUFFER_MP_BASE = 470) reflects
  // the un-optimised stack. LightingEffectV2 and OverheadStampEffectV2 now run
  // their targets at 0.5× on ≤8 GB GPUs, saving ~165 MB/MP → effective actual
  // cost is ~305 MB/MP. We keep the pessimistic per-MP figure and instead raise
  // the budget: the gap between model and reality is a built-in safety margin.
  //
  // Calibration for 8 GB (RTX 3070 Laptop, ANGLE/D3D11 in Chrome):
  //   Budget 1200 MB → max 2.55 MP (~2105×1213 at 2207×1271 CSS viewport)
  //   Actual RT cost at 2.55 MP with reductions ≈ 305×2.55 = 778 MB
  //   Total w/masks+source+Chrome ≈ 778+285+150+200 = 1413 MB → well within
  //   observed ~1.8 GB browser WebGL limit (field crash at 1.6 GB without
  //   reductions → 200 MB safety margin; now ~400 MB margin with reductions).
  if (v <= 4) return 500;
  if (v <= 6) return 800;
  if (v <= 8) return 1200;
  if (v <= 12) return 2400;
  return Infinity;
}

/**
 * Maximum safe drawing-buffer size, in megapixels, so the compositor RT stack
 * stays within {@link resolveCompositorRtBudgetMB}. Returns Infinity when the
 * card is large enough that no cap is needed (16 GB+). This is the principled
 * "set a budget and stick to it" ceiling that bounds the entire full-screen RT
 * stack with a single lever (render resolution), because every RT scales with it.
 * @returns {number} Max drawing-buffer megapixels (Infinity = uncapped).
 */
export function resolveMaxDrawingBufferMp() {
  const vram = resolveEffectiveGpuVramGB();
  const budgetMB = resolveCompositorRtBudgetMB(vram);
  if (!Number.isFinite(budgetMB)) return Infinity;
  const perMp = estimateRtMbPerDrawingBufferMp();
  if (!(perMp > 0)) return Infinity;
  return budgetMB / perMp;
}

/**
 * Compute streaming policy from renderer capabilities and scene size.
 *
 * @param {import('three').WebGLRenderer|null} renderer
 * @param {{ tier?: string }} [capabilities]
 * @param {object} [options]
 * @returns {TextureBudgetPolicy}
 */
export function computeTextureBudgetPolicy(renderer = null, capabilities = {}, options = {}) {
  const maxTextureSize = Number(renderer?.capabilities?.maxTextureSize) || 8192;
  const tier = String(capabilities?.tier ?? 'high');
  const sceneMp = Number(options.sceneMegapixels) || estimateSceneMegapixels();
  const deviceMem = resolveEffectiveSystemRamGB();
  const gpuVramGB = resolveEffectiveGpuVramGB();
  const userVramOverride = isGpuVramUserOverride();

  const tierHigh = tier === 'high';
  let budgetMB = resolveGpuVramBaseBudgetMB(gpuVramGB, tier, userVramOverride, deviceMem);
  let budgetReason = userVramOverride
    ? `user GPU VRAM (${gpuVramGB} GB)`
    : 'default';

  // Boundaries use >= so an exactly-144 MP scene (12000×12000) hits the huge tier.
  const isLargeScene = sceneMp >= 90;
  const isHugeScene = sceneMp >= 130;

  const largeCap = resolveLargeSceneCapMB(gpuVramGB, userVramOverride);
  if (isLargeScene && budgetMB > largeCap) {
    budgetMB = largeCap;
    budgetReason = `large scene (≥90 MP, ${largeCap} MB cap)`;
  }
  if (isHugeScene) {
    // Software budget for Map Shine textures — not total GPU VRAM. Huge scenes still
    // need a conservative cap, but high-end desktops can use more headroom than 384 MB.
    const hugeCap = resolveHugeSceneCapMB(gpuVramGB, userVramOverride, tierHigh, deviceMem);
    if (budgetMB > hugeCap) {
      budgetMB = hugeCap;
      budgetReason = `huge scene (≥130 MP, ${hugeCap} MB cap)`;
    }
  }

  const fd = window.MapShine?.sceneComposer?.foundrySceneData ?? {};
  const sr = globalThis.canvas?.dimensions?.sceneRect ?? {};
  const sceneW = Number(sr.width ?? fd.sceneWidth ?? 4096);
  const sceneH = Number(sr.height ?? fd.sceneHeight ?? 4096);

  const cellSize = resolveCellSize(maxTextureSize, sceneW, sceneH);

  let maxLod = 4;
  if (tier === 'low' || budgetMB <= 384) maxLod = 3;

  let maskResolutionScale = 1.0;
  if (sceneMp > 25) maskResolutionScale = 0.85;
  if (sceneMp > 36) maskResolutionScale = 0.75;
  if (sceneMp > 64) maskResolutionScale = 0.65;
  if (isLargeScene) maskResolutionScale = Math.min(maskResolutionScale, 0.55);
  if (isHugeScene) maskResolutionScale = Math.min(maskResolutionScale, 0.3);
  if (budgetMB <= 384) maskResolutionScale = Math.min(maskResolutionScale, 0.5);

  // VRAM-aware clamp — the dominant crash cause on constrained GPUs.
  // Scene-space masks (outdoors / floorAlpha / skyReach / floorId, plus per-effect
  // masks) are near-full-scene textures. A single 6750x7200 scene at mask scale
  // 0.75 is ~110 MB *per mask*; with ~7 resident masks that is ~770 MB — the whole
  // software budget — before a single effect RT or tile. Bound each mask to a
  // per-mask MB target derived from the card's VRAM tier. Because mask bytes scale
  // with scale^2, scale = sqrt(targetMB / (sceneMp * 4bpp)).
  const perMaskTargetMB = gpuVramGB <= 4 ? 10 : gpuVramGB <= 8 ? 22 : gpuVramGB <= 12 ? 48 : 96;
  if (sceneMp > 0 && !userVramOverride) {
    const scaleForTarget = Math.sqrt(perMaskTargetMB / Math.max(1, sceneMp * 4));
    maskResolutionScale = Math.min(maskResolutionScale, Math.max(0.15, scaleForTarget));
  } else if (sceneMp > 0 && gpuVramGB <= 8) {
    // Even with a user override, never let masks alone blow an 8 GB card.
    const scaleForTarget = Math.sqrt((perMaskTargetMB * 1.5) / Math.max(1, sceneMp * 4));
    maskResolutionScale = Math.min(maskResolutionScale, Math.max(0.18, scaleForTarget));
  }

  const backgroundMaxSize = Math.min(
    maxTextureSize,
    isHugeScene ? 2048 : sceneMp > 25 ? 4096 : 8192,
  );

  const tileAlbedoMaxSize = Math.min(
    backgroundMaxSize,
    isLargeScene ? 2048 : sceneMp > 25 ? 3072 : 4096,
  );

  return {
    budgetMB,
    cellSize,
    maxLod,
    maxTextureSize,
    maskResolutionScale,
    backgroundMaxSize,
    tileAlbedoMaxSize,
    sceneMegapixels: sceneMp,
    budgetReason,
  };
}

/**
 * Re-apply texture budget policy after scene dimensions are known.
 * @param {import('three').WebGLRenderer|null} [renderer]
 * @returns {TextureBudgetPolicy|null}
 */
export function reconfigureTextureBudgetForScene(renderer = null) {
  const budget = getTextureBudgetTracker();
  const prevMaskScale = Number(budget.maskResolutionScale) || 1.0;
  const prevCellSize = Number(budget.cellSize) || 0;
  const r = renderer ?? window.MapShine?.renderer ?? null;
  const policy = computeTextureBudgetPolicy(r, window.MapShine?.capabilities ?? {}, {});
  budget.configureFromPolicy(policy);

  if (Number(policy.cellSize) !== prevCellSize && prevCellSize > 0) {
    try {
      clearPyramidMemoryCaches();
      window.MapShine?.tileStreamingManager?.reloadAllCells?.();
    } catch (_) {}
  }

  // Masks composed before the scene-sized policy was known stay cached at their
  // original (often full-res) size. When the mask resolution tightens, purge the
  // mask caches so they rebuild at the smaller size next compose. Route the purge
  // (and the implicit rebuild on the next compose) through the GPU work governor
  // so it is serialized against streaming uploads rather than spiking in the same
  // frame and tripping a context loss.
  const newMaskScale = Number(policy?.maskResolutionScale) || 1.0;
  if (newMaskScale < prevMaskScale - 0.01) {
    const purge = () => {
      const compositor = window.MapShine?.gpuSceneMaskCompositor
        ?? window.MapShine?.sceneComposer?._sceneMaskCompositor
        ?? null;
      try { compositor?.purgeAllFloorCaches?.(); } catch (_) {}
    };
    void import('./gpu-work-scheduler.js')
      .then(({ getGpuWorkScheduler, GPU_WORK_PRIORITY }) => {
        getGpuWorkScheduler().enqueue({
          id: 'mask:purgeAllFloorCaches',
          priority: GPU_WORK_PRIORITY.MASK,
          costMb: 0,
          commit: purge,
        });
      })
      .catch(() => { purge(); });
  }
  return policy;
}
