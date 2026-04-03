/**
 * Unified GpuSceneMaskCompositor _Outdoors resolution for FloorCompositor,
 * BuildingShadowsEffectV2, and diagnostics.
 *
 * Order: **FloorStack active floor** (compositorKey + elevation band) → active level band key
 * → compositor._activeFloorKey, then sibling keys (same band bottom in _floorMeta / _floorCache),
 * then ground band.
 *
 * Rationale: GpuSceneMaskCompositor keys masks by rendered floor bands. `activeLevelContext`
 * (CameraFollower) can briefly disagree with `floorStack` (e.g. scene-background vs upper
 * tile floor). Trying level context first caused wrong-band _Outdoors (e.g. all-indoor
 * underground) to win over the viewed floor's mask for BuildingShadowsEffectV2 and sync.
 *
 * @module masks/resolve-compositor-outdoors
 */

/**
 * @param {object} compositor - GpuSceneMaskCompositor instance
 * @param {{ bottom?: number, top?: number }|null} [levelContext]
 * @param {{ skipGroundFallback?: boolean, allowBundleFallback?: boolean }} [options]
 * @returns {{ texture: import('three').Texture|null, resolvedKey: string|null, route: string|null }}
 */
export function resolveCompositorOutdoorsTexture(compositor, levelContext = null, options = {}) {
  const { skipGroundFallback = false, allowBundleFallback = true } = options;
  const empty = { texture: null, resolvedKey: null, route: null };
  if (!compositor || typeof compositor.getFloorTexture !== 'function') return empty;

  const ctx = levelContext ?? window.MapShine?.activeLevelContext ?? null;
  /** @type {import('three').Texture|null} */
  let tex = null;

  const tryKey = (k) => {
    if (k == null || k === '') return null;
    return compositor.getFloorTexture(String(k), 'outdoors') ?? null;
  };

  const candidateKeys = [];

  let activeFloor = null;
  try {
    activeFloor = window.MapShine?.floorStack?.getActiveFloor?.() ?? null;
    const ck = activeFloor?.compositorKey;
    if (ck) candidateKeys.push(String(ck));
    const eb = Number(activeFloor?.elevationMin);
    const et = Number(activeFloor?.elevationMax);
    if (Number.isFinite(eb) && Number.isFinite(et)) candidateKeys.push(`${eb}:${et}`);
  } catch (_) {}

  const cb = Number(ctx?.bottom);
  const ct = Number(ctx?.top);
  if (Number.isFinite(cb) && Number.isFinite(ct)) candidateKeys.push(`${cb}:${ct}`);

  const cak = compositor._activeFloorKey ?? null;
  if (cak) candidateKeys.push(String(cak));

  const uniqueKeys = [...new Set(candidateKeys.filter(Boolean))];
  for (const key of uniqueKeys) {
    tex = tryKey(key);
    if (tex) return { texture: tex, resolvedKey: key, route: 'direct' };
  }

  // Prefer rendered floor band bottom (floor stack) so sibling scan matches the viewed band.
  const siblingBottom = Number.isFinite(Number(activeFloor?.elevationMin))
    ? Number(activeFloor.elevationMin)
    : (Number.isFinite(cb) ? cb : Number.NaN);
  if (Number.isFinite(siblingBottom)) {
    /** @type {Set<string>} */
    const keySet = new Set();
    try {
      if (compositor._floorMeta && typeof compositor._floorMeta.keys === 'function') {
        for (const k of compositor._floorMeta.keys()) keySet.add(String(k));
      }
    } catch (_) {}
    try {
      if (compositor._floorCache && typeof compositor._floorCache.keys === 'function') {
        for (const k of compositor._floorCache.keys()) keySet.add(String(k));
      }
    } catch (_) {}
    const matching = [...keySet].filter((key) => Number(String(key).split(':')[0]) === siblingBottom).sort();
    for (const key of matching) {
      if (uniqueKeys.includes(key)) continue;
      tex = tryKey(key);
      if (tex) return { texture: tex, resolvedKey: key, route: 'sibling' };
    }
  }

  if (!skipGroundFallback) {
    tex = compositor.getGroundFloorMaskTexture?.('outdoors') ?? null;
    if (tex) {
      let gk = null;
      let gb = Infinity;
      try {
        for (const [key] of compositor._floorMeta) {
          const kb = Number(String(key).split(':')[0]);
          if (Number.isFinite(kb) && kb < gb) {
            gb = kb;
            gk = key;
          }
        }
      } catch (_) {}
      return { texture: tex, resolvedKey: gk || 'ground', route: 'ground' };
    }
  }

  // BUNDLE FALLBACK: if GPU compositor has no outdoors texture for this level,
  // try to load directly from the scene's asset bundle (for single-floor scenes
  // or levels where _Outdoors comes from bundle, not per-tile composition).
  if (allowBundleFallback && !tex) {
    const sc = window.MapShine?.sceneComposer;
    const bundleMask = sc?.currentBundle?.masks?.find?.(m => (m?.id === 'outdoors' || m?.type === 'outdoors'))?.texture ?? null;
    if (bundleMask) {
      return { texture: bundleMask, resolvedKey: 'bundle', route: 'bundle' };
    }
  }

  return empty;
}
