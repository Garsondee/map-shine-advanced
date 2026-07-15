import { collectBandOutdoorsByFloorIndex } from '../../masks/indoor-outdoor-mask-api.js';

/**
 * Collect per-floor _Outdoors textures indexed by FloorStack index (0..3) for
 * floor-id-aware receiver sampling (matches PaintedShadowEffectV2 wiring).
 *
 * @param {object|null} compositor GpuSceneMaskCompositor
 * @param {number} [maxSlots=4]
 * @returns {{ textures: (import('three').Texture|null)[], floorIdTex: import('three').Texture|null }}
 */
export function collectOutdoorsTexturesByFloorIndex(compositor, maxSlots = 4) {
  return collectBandOutdoorsByFloorIndex(compositor, maxSlots);
}
