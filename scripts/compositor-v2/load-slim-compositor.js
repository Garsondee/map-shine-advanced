/**
 * @fileoverview Load-slim compositor init for huge scenes on constrained GPUs.
 * Defers heavy effect RT allocation until after the scene load completes.
 * @module compositor-v2/load-slim-compositor
 */

import { estimateSceneMegapixels, getGpuLoadPressure } from '../streaming/texture-budget-policy.js';
import { resolveEffectiveGpuVramGB } from '../streaming/memory-settings.js';

/** Effect init labels that allocate large screen-space RT stacks — safe to defer during load. */
export const LOAD_SLIM_DEFER_HEAVY_RT_EFFECTS = new Set([
  'ShadowManagerV2',
  'VegetationBillboardShadowPasses',
  'UpperFloorAlphaCompositor',
  'SkyOcclusionPrimitive',
  'LightingEffectV2',
  'BloomEffectV2',
  'OverheadShadowsEffectV2',
  'BuildingShadowsEffectV2',
  'SkyReachShadowsEffectV2',
  'PaintedShadowEffectV2',
  'AtmosphericFogEffectV2',
  'FogOfWarEffectV2',
  'DistortionManagerV2',
]);

/**
 * True when compositor init should defer heavy GPU RT allocation until load finishes.
 * @returns {boolean}
 */
function _resolveSceneMegapixels() {
  const mp = estimateSceneMegapixels();
  if (mp > 0) return mp;
  try {
    const scene = globalThis.canvas?.scene;
    const w = Number(scene?.width ?? 0);
    const h = Number(scene?.height ?? 0);
    if (w > 0 && h > 0) return (w * h) / 1_000_000;
  } catch (_) {}
  return 0;
}

function _resolveMultifloorFloorCount() {
  try {
    const fs = window.MapShine?.floorStack?.getFloors?.() ?? [];
    if (fs.length > 1) return fs.length;
    return Number(globalThis.canvas?.scene?.levels?.size ?? 0) || 0;
  } catch (_) {
    return 0;
  }
}

export function shouldUseLoadSlimCompositorInit() {
  if (window.MapShine?.__msaSceneLoading !== true) return false;
  try {
    // Effective load pressure accounts for the real GPU VRAM, scene size, floor
    // count AND drawing-buffer size (native 4K on an 8 GB card is heavy even for
    // a modest scene — the exact case that kept losing the WebGL context).
    const pressure = getGpuLoadPressure();
    if (pressure.highLoad) return true;

    // Legacy fall-throughs kept as a safety net if the pressure model returns
    // an unexpected shape (e.g. renderer not ready yet).
    const mp = _resolveSceneMegapixels();
    const vram = resolveEffectiveGpuVramGB();
    const floors = _resolveMultifloorFloorCount();
    if (mp >= 130) return true;
    if (vram <= 8 && mp >= 90) return true;
    if (floors >= 2 && mp >= 90 && vram <= 12) return true;
    return false;
  } catch (_) {
    return false;
  }
}

/**
 * True when mask GPU warmup during load should be skipped (upload lazily instead).
 * @returns {boolean}
 */
export function shouldSkipGpuTextureWarmupForLoad() {
  return shouldUseLoadSlimCompositorInit();
}

/**
 * True while load-slim has deferred effect GPU resources that must not receive onResize yet.
 * @returns {boolean}
 */
export function isLoadSlimEffectWorkDeferred() {
  const fc = window.MapShine?.floorCompositorV2
    ?? window.MapShine?.effectComposer?._floorCompositorV2
    ?? null;
  return (fc?._loadSlimPendingEffects?.size ?? 0) > 0;
}
