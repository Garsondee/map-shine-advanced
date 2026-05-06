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
 * tile floor). Including a stale level band in the candidate list after floor-stack keys
 * caused wrong-band _Outdoors (e.g. all-black underground) to win whenever the viewed
 * floor's texture was not found yet (async compose): tryKey(underground) succeeded before
 * the correct floor's RT existed.
 *
 * @module masks/resolve-compositor-outdoors
 */

/**
 * String key for a Levels band — must match FloorStack `compositorKey`
 * (`${bottom}:${top}`, including `Infinity` for open-top bands).
 * @param {{ bottom?: unknown, top?: unknown }|null|undefined} ctx
 * @returns {string|null}
 */
function levelsBandKeyFromContext(ctx) {
  if (!ctx) return null;
  const b = ctx.bottom;
  if (b == null && b !== 0) return null;
  const t = ctx.top;
  return `${b}:${t ?? ''}`;
}

/**
 * @param {object} compositor - GpuSceneMaskCompositor instance
 * @param {{ bottom?: number, top?: number }|null} [levelContext]
 * @param {{ skipGroundFallback?: boolean, allowBundleFallback?: boolean, strictViewedFloorOnly?: boolean }} [options]
 * @returns {{ texture: import('three').Texture|null, resolvedKey: string|null, route: string|null }}
 */
export function resolveCompositorOutdoorsTexture(compositor, levelContext = null, options = {}) {
  const { skipGroundFallback = false, allowBundleFallback = true, strictViewedFloorOnly = false } = options;
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

  let multiFloor = false;
  try {
    multiFloor = (window.MapShine?.floorStack?.getFloors?.() ?? []).length > 1;
  } catch (_) {
    multiFloor = false;
  }

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
  const ctxBandKey = levelsBandKeyFromContext(ctx);
  if (ctxBandKey != null) {
    const activeCk = activeFloor ? String(activeFloor.compositorKey) : '';
    if (!multiFloor || !activeFloor || ctxBandKey === activeCk) {
      candidateKeys.push(ctxBandKey);
    }
  }

  const cak = compositor._activeFloorKey ?? null;
  if (cak) {
    const activeCk = activeFloor ? String(activeFloor.compositorKey) : '';
    if (!multiFloor || !activeFloor || String(cak) === activeCk) {
      candidateKeys.push(String(cak));
    }
  }

  const uniqueKeys = [...new Set(candidateKeys.filter(Boolean))];
  for (const key of uniqueKeys) {
    tex = tryKey(key);
    if (tex) return { texture: tex, resolvedKey: key, route: 'direct' };
  }

  if (strictViewedFloorOnly) {
    if (allowBundleFallback && !tex) {
      const sc = window.MapShine?.sceneComposer;
      const bundleMask = sc?.currentBundle?.masks?.find?.(
        (m) => m?.id === 'outdoors' || m?.type === 'outdoors'
      )?.texture ?? null;
      if (bundleMask) {
        let mf = false;
        try {
          mf = (window.MapShine?.floorStack?.getFloors?.() ?? []).length > 1;
        } catch (_) {
          mf = false;
        }
        const af = window.MapShine?.floorStack?.getActiveFloor?.() ?? null;
        const aidx = Number(af?.index);
        if (!mf || !Number.isFinite(aidx) || aidx <= 0) {
          return { texture: bundleMask, resolvedKey: 'bundle', route: 'bundle' };
        }
      }
    }
    return empty;
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

  // Multi-floor fallback: if the active/view floor has no direct outdoors
  // texture, prefer the nearest lower floor band that does have one.
  // This supports "look down" rendering where upper floors are view layers but
  // authored outdoors masks only exist on lower map floors.
  const activeBottom = Number(activeFloor?.elevationMin);
  if (Number.isFinite(activeBottom)) {
    /** @type {Array<{key:string,bottom:number}>} */
    const keyed = [];
    try {
      if (compositor._floorMeta && typeof compositor._floorMeta.keys === 'function') {
        for (const k of compositor._floorMeta.keys()) {
          const key = String(k);
          const kb = Number(key.split(':')[0]);
          if (Number.isFinite(kb)) keyed.push({ key, bottom: kb });
        }
      }
    } catch (_) {}
    try {
      if (compositor._floorCache && typeof compositor._floorCache.keys === 'function') {
        for (const k of compositor._floorCache.keys()) {
          const key = String(k);
          const kb = Number(key.split(':')[0]);
          if (Number.isFinite(kb)) keyed.push({ key, bottom: kb });
        }
      }
    } catch (_) {}
    const uniqueSorted = [...new Map(keyed.map((r) => [r.key, r])).values()]
      .filter((r) => r.bottom <= activeBottom)
      .sort((a, b) => b.bottom - a.bottom);
    for (const row of uniqueSorted) {
      if (uniqueKeys.includes(row.key)) continue;
      tex = tryKey(row.key);
      if (tex) return { texture: tex, resolvedKey: row.key, route: 'lower-floor' };
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
