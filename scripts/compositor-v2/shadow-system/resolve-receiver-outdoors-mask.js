/**
 * Receiver-floor `_Outdoors` resolution shared by directional shadow passes.
 *
 * BuildingShadowsEffectV2 historically carried the most defensive path (bundle +
 * multi-floor + _floorMeta band matching). SkyReachShadowsEffectV2 used a narrower
 * `getFloorTexture(activeFloor)` fallback for `collectOutdoorsTexturesByFloorIndex`
 * slot holes; that mismatch can make `msa_readFloorIdOutdoors` sample the wrong
 * mask (often ~0 outdoors) and zero the whole sky-reach strength buffer.
 *
 * @module compositor-v2/shadow-system/resolve-receiver-outdoors-mask
 */

import { resolveCompositorOutdoorsTexture } from '../../masks/resolve-compositor-outdoors.js';

/**
 * @param {object|null} compositor GpuSceneMaskCompositor
 * @param {import('three').Texture|null} [legacyOutdoorsMask] Building-only bundle cache
 * @returns {import('three').Texture|null}
 */
export function resolveReceiverOutdoorsMaskTexture(compositor, legacyOutdoorsMask = null) {
  if (!compositor) return legacyOutdoorsMask ?? null;

  const floorStackFloors = window.MapShine?.floorStack?.getFloors?.() ?? [];
  const activeFloorForMask = window.MapShine?.floorStack?.getActiveFloor?.() ?? null;
  const activeIdxForMask = Number(activeFloorForMask?.index);
  const skipGroundGlobalFallback = floorStackFloors.length > 1
    && Number.isFinite(activeIdxForMask)
    && activeIdxForMask > 0;

  const r = resolveCompositorOutdoorsTexture(
    compositor,
    window.MapShine?.activeLevelContext ?? null,
    { skipGroundFallback: skipGroundGlobalFallback, allowBundleFallback: false },
  );
  if (r.texture) return r.texture;

  const ctx = window.MapShine?.activeLevelContext ?? null;
  const b = Number.isFinite(Number(activeFloorForMask?.elevationMin))
    ? Number(activeFloorForMask.elevationMin)
    : Number(ctx?.bottom);
  const t = Number.isFinite(Number(activeFloorForMask?.elevationMax))
    ? Number(activeFloorForMask.elevationMax)
    : Number(ctx?.top);
  if (Number.isFinite(b) && Number.isFinite(t)) {
    const mid = (b + t) * 0.5;
    const keySet = new Set([
      ...Array.from(compositor._floorCache?.keys?.() ?? []),
      ...Array.from(compositor._floorMeta?.keys?.() ?? []),
    ]);
    let bestKey = null;
    let bestDelta = Infinity;
    for (const key of keySet) {
      const parts = String(key).split(':');
      if (parts.length !== 2) continue;
      const kb = Number(parts[0]);
      const kt = Number(parts[1]);
      if (!Number.isFinite(kb) || !Number.isFinite(kt)) continue;
      if (mid < kb || mid > kt) continue;
      const delta = Math.abs(kb - b) + Math.abs(kt - t);
      if (delta < bestDelta) {
        bestDelta = delta;
        bestKey = key;
      }
    }
    if (bestKey) {
      const tex = compositor.getFloorTexture(bestKey, 'outdoors');
      if (tex) return tex;
    }
  }

  return legacyOutdoorsMask ?? null;
}
