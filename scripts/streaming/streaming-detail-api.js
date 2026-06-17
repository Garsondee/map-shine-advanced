/**
 * @fileoverview Streaming detail tier + cell visibility API for effect culling.
 * @module streaming/streaming-detail-api
 */

import { getTileStreamingManager } from './tile-streaming-manager.js';
import { getVisibleStreamingCellKeys } from './vegetation-streaming-bridge.js';
import { selectLodFromZoom } from './streaming-grid.js';
import { getTextureBudgetTracker } from '../assets/TextureBudgetTracker.js';
import { estimateSceneMegapixels } from './texture-budget-policy.js';
import { resolveStreamingViewRect } from './view-projection-service.js';

/**
 * @typedef {'full'|'medium'|'coarse'|'minimal'} StreamingDetailTier
 */

/**
 * Map zoom-native LOD to an effect detail tier.
 *
 * @param {number} lod
 * @param {number} [maxLod=4]
 * @returns {StreamingDetailTier}
 */
export function lodToDetailTier(lod, maxLod = 4) {
  const l = Math.max(0, Math.min(maxLod, Math.floor(Number(lod) || 0)));
  if (l <= 0) return 'full';
  if (l === 1) return 'medium';
  if (l === 2) return 'coarse';
  return 'minimal';
}

/**
 * Whether expensive per-cell / screen-space effects should run at this tier.
 *
 * @param {StreamingDetailTier} tier
 * @returns {boolean}
 */
export function shouldRunExpensiveEffects(tier) {
  return tier === 'full' || tier === 'medium';
}

/**
 * Particle density scale for weather at each detail tier (1 = full rate).
 *
 * @param {StreamingDetailTier} tier
 * @returns {number}
 */
export function detailTierParticleScale(tier) {
  switch (tier) {
    case 'full': return 1;
    case 'medium': return 0.75;
    case 'coarse': return 0.45;
    default: return 0.25;
  }
}

/**
 * Current focal streaming LOD from the tile manager.
 *
 * @returns {number}
 */
export function getFocalLod() {
  try {
    return getTileStreamingManager().getFocalLod?.() ?? 2;
  } catch (_) {
    return 2;
  }
}

/**
 * Current streaming detail tier derived from zoom LOD.
 *
 * @returns {StreamingDetailTier}
 */
export function getStreamingDetailTier() {
  try {
    return getTileStreamingManager().getDetailTier?.() ?? 'medium';
  } catch (_) {
    return 'medium';
  }
}

/**
 * Visible resident cell keys for a streaming grid.
 *
 * @param {string} gridKey
 * @returns {Set<string>}
 */
export function getStreamingVisibleCellKeys(gridKey) {
  return getVisibleStreamingCellKeys(gridKey);
}

/**
 * True when a cell has a visible resident streamed texture.
 *
 * @param {string} gridKey
 * @param {string} cellKey
 * @returns {boolean}
 */
export function isStreamingCellResident(gridKey, cellKey) {
  if (!gridKey || !cellKey) return true;
  return getVisibleStreamingCellKeys(gridKey).has(cellKey);
}

/**
 * Resolve focal LOD from current zoom without the manager.
 *
 * @returns {number}
 */
export function resolveFocalLodFromZoom() {
  const zoom = Number(window.MapShine?.sceneComposer?.currentZoom) || 1;
  const budget = getTextureBudgetTracker();
  const mp = estimateSceneMegapixels();
  return selectLodFromZoom(zoom, budget.getMaxLodLevel(), mp);
}

/**
 * @returns {{ minX: number, minY: number, maxX: number, maxY: number }|null}
 */
export function getStreamingViewRect() {
  try {
    const manager = getTileStreamingManager();
    return resolveStreamingViewRect(manager.getViewPaddingOptions?.() ?? { uniform: 512 });
  } catch (_) {
    return resolveStreamingViewRect({ uniform: 512 });
  }
}

/**
 * Whether weather/particle systems should throttle for the current streaming state.
 *
 * @returns {{ tier: StreamingDetailTier, particleScale: number, expensiveEffects: boolean, isPanning: boolean }}
 */
export function getStreamingEffectGateState() {
  const tier = getStreamingDetailTier();
  const manager = getTileStreamingManager();
  return {
    tier,
    particleScale: detailTierParticleScale(tier),
    expensiveEffects: shouldRunExpensiveEffects(tier),
    isPanning: manager?.isPanning?.() === true,
  };
}
