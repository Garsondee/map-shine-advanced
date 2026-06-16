/**
 * Shelter / localized-effect outdoors CPU cache — used by FloorCompositor to pre-warm
 * mask snapshots before draws. Candles and fire sample via water-splash-behaviors.
 *
 * @module compositor-v2/outdoors-mask-sample
 */

import {
  clearSharedOutdoorsMaskCache,
  syncSharedOutdoorsMaskForFloor,
} from './effects/water-splash-behaviors.js';

/** Monotonic token — only bumped when explicitly clearing shelter cache. */
let _shelterRefreshToken = 0;

/** Drop shared outdoors CPU mirrors (splashes + shelter refresh). */
export function clearShelterOutdoorsMaskCache() {
  clearSharedOutdoorsMaskCache();
  _shelterRefreshToken += 1;
}

/**
 * Pre-warm the active floor's _Outdoors CPU snapshot for candle/fire glow sampling.
 * Called from FloorCompositor when the resolved outdoors mask changes (before draws).
 *
 * @param {import('three').Texture|null} [_outdoorsTex=null] - Resolved mask (hint only)
 */
export function refreshShelterOutdoorsMaskForActiveFloor(_outdoorsTex = null) {
  void _outdoorsTex;

  const renderer = window.MapShine?.renderer;
  if (renderer?.getRenderTarget?.()) return;

  let floorIndex = 0;
  try {
    const af = window.MapShine?.floorStack?.getActiveFloor?.();
    if (af && Number.isFinite(Number(af.index))) {
      floorIndex = Math.max(0, Math.floor(Number(af.index)));
    }
  } catch (_) {}

  const levelContext = window.MapShine?.activeLevelContext ?? null;
  const compositorGen = Number(
    window.MapShine?.sceneComposer?._sceneMaskCompositor?.getFloorCacheVersion?.() ?? 0,
  );

  try {
    // Use compositor generation as the sync token — pixel data only invalidates when
    // mask RTs rebuild, not every call (CandleFlames used to force getImageData every frame).
    syncSharedOutdoorsMaskForFloor(floorIndex, compositorGen, levelContext);
  } catch (_) {}
}

export {
  buildEffectSceneBoundsFromCanvas,
  classifyOutdoorsMaskTexel8,
  decodeOutdoorsMaskSample8,
  sampleAuthoredOutdoorsAtWorld,
  sampleOutdoorsFromSnapshot,
} from './effects/water-splash-behaviors.js';
