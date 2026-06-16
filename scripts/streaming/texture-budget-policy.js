/**
 * @fileoverview Derive streaming tile size, LOD cap, and VRAM budget from GPU + scene size.
 * @module streaming/texture-budget-policy
 */

import { resolveCellSize } from './streaming-grid.js';
import { getTextureBudgetTracker } from '../assets/TextureBudgetTracker.js';
import { clearPyramidMemoryCaches } from './texture-pyramid-builder.js';

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
  const deviceMem = Number(navigator?.deviceMemory) || 4;

  let budgetMB = 512;
  if (tier === 'low') budgetMB = 256;
  else if (deviceMem >= 16) budgetMB = 1024;
  else if (deviceMem >= 8) budgetMB = 768;
  else if (deviceMem >= 4) budgetMB = 512;
  else budgetMB = 384;

  // Boundaries use >= so an exactly-144 MP scene (12000×12000) hits the huge tier.
  const isLargeScene = sceneMp >= 90;
  const isHugeScene = sceneMp >= 130;

  if (isLargeScene) budgetMB = Math.min(budgetMB, 768);
  if (isHugeScene) budgetMB = Math.min(budgetMB, 384);

  const fd = window.MapShine?.sceneComposer?.foundrySceneData ?? {};
  const sr = globalThis.canvas?.dimensions?.sceneRect ?? {};
  const sceneW = Number(sr.width ?? fd.sceneWidth ?? 4096);
  const sceneH = Number(sr.height ?? fd.sceneHeight ?? 4096);

  let cellSize = resolveCellSize(maxTextureSize, sceneW, sceneH);
  if (isHugeScene) cellSize = Math.min(cellSize, 2048);

  let maxLod = 4;
  if (tier === 'low' || budgetMB <= 384) maxLod = 3;

  let maskResolutionScale = 1.0;
  if (sceneMp > 25) maskResolutionScale = 0.85;
  if (sceneMp > 36) maskResolutionScale = 0.75;
  if (sceneMp > 64) maskResolutionScale = 0.65;
  if (isLargeScene) maskResolutionScale = Math.min(maskResolutionScale, 0.55);
  if (isHugeScene) maskResolutionScale = Math.min(maskResolutionScale, 0.3);
  if (budgetMB <= 384) maskResolutionScale = Math.min(maskResolutionScale, 0.5);

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
  // mask caches so they rebuild at the smaller size next compose.
  const newMaskScale = Number(policy?.maskResolutionScale) || 1.0;
  if (newMaskScale < prevMaskScale - 0.01) {
    const compositor = window.MapShine?.gpuSceneMaskCompositor
      ?? window.MapShine?.sceneComposer?._sceneMaskCompositor
      ?? null;
    try { compositor?.purgeAllFloorCaches?.(); } catch (_) {}
  }
  return policy;
}
