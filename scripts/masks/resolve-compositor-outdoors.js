/**
 * Unified GpuSceneMaskCompositor _Outdoors resolution for FloorCompositor,
 * BuildingShadowsEffectV2, and diagnostics.
 *
 * Scene-UV consumers: prefer {@link module:masks/indoor-outdoor-mask-api} instead of
 * calling `getFloorTexture(key, 'outdoors')` directly.
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
 * `collectCompositorFloorCandidateKeys` is shared by `resolveCompositorFloorMaskTexture`
 * (_Shadow / painted shadow) so per-floor masks use the **same ordered band guesses**
 * during navigation drift.
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
 * Canonical ordered floor keys to try against GpuSceneMaskCompositor for the viewed band,
 * aligned with `_Outdoors` resolution (stack → context gate → `_activeFloorKey`).
 *
 * @param {object|null} compositor
 * @param {{ bottom?: number, top?: number }|null|undefined} [levelContext=null]
 * @returns {{
 *   uniqueKeys: string[],
 *   activeFloor: object|null,
 *   ctx: { bottom?: unknown, top?: unknown }|null,
 *   ctxBandKey: string|null,
 *   multiFloor: boolean,
 *   cb: number
 * }}
 */
export function collectCompositorFloorCandidateKeys(compositor = null, levelContext = null) {
  const ctx = levelContext ?? window.MapShine?.activeLevelContext ?? null;
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

  const cak = compositor?._activeFloorKey ?? null;
  if (cak) {
    const activeCk = activeFloor ? String(activeFloor.compositorKey) : '';
    if (!multiFloor || !activeFloor || String(cak) === activeCk) {
      candidateKeys.push(String(cak));
    }
  }

  const uniqueKeys = [...new Set(candidateKeys.filter(Boolean))];
  return { uniqueKeys, activeFloor, ctx, ctxBandKey, multiFloor, cb };
}

/**
 * Collect sibling / alternate GpuSceneMaskCompositor keys that share `siblingBottom` (same
 * band bottom as FloorStack/context, different string suffix). Used after primary candidate
 * keys miss.
 *
 * @param {object} compositor
 * @param {number} siblingBottom
 * @param {readonly string[]} [exclude=[]]
 * @returns {string[]}
 */
export function siblingFloorKeysMatchingBottom(compositor, siblingBottom, exclude = []) {
  if (!compositor || !Number.isFinite(siblingBottom)) return [];
  const ex = new Set(exclude.map(String));
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
  return [...keySet]
    .filter((key) => Number(String(key).split(':')[0]) === siblingBottom && !ex.has(key))
    .sort();
}

/**
 * Resolve any per-floor GpuSceneMaskCompositor RT by mask id (`handPaintedShadow`, …) using the
 * same band-candidate ordering as `_Outdoors`. Never uses cross-floor downward fallbacks
 * (nearest lower-band) — those are intentional for `_Outdoors` sampling only.
 *
 * @param {object} compositor
 * @param {string[]} maskTypeIds
 * @param {{ bottom?: number, top?: number }|null|undefined} [levelContext=null]
 * @returns {{
 *   texture: import('three').Texture|null,
 *   resolvedKey: string|null,
 *   maskType: string|null,
 *   route: string|null,
 *   candidateKeysAttempted: string[]
 * }}
 */
export function resolveCompositorFloorMaskTexture(compositor, maskTypeIds, levelContext = null) {
  const empty = {
    texture: null,
    resolvedKey: null,
    maskType: null,
    route: null,
    candidateKeysAttempted: [],
  };
  if (!compositor || typeof compositor.getFloorTexture !== 'function') return empty;
  if (!Array.isArray(maskTypeIds) || maskTypeIds.length === 0) return empty;

  const { uniqueKeys, activeFloor, ctxBandKey, multiFloor, cb } = collectCompositorFloorCandidateKeys(
    compositor,
    levelContext,
  );

  /** @type {string[]} */
  const candidateKeysAttempted = [];

  const recordTry = (k) => {
    const s = String(k ?? '');
    if (s === '') return;
    if (!candidateKeysAttempted.includes(s)) candidateKeysAttempted.push(s);
  };

  const sc = typeof canvas !== 'undefined' ? canvas?.scene : null;

  const tryFloorMask = (floorKey) => {
    for (const type of maskTypeIds) {
      let t = null;
      if (type === 'outdoors') {
        t = resolveSceneSpaceOutdoorsForFloorKey(compositor, String(floorKey), sc) ?? null;
      } else {
        t = compositor.getFloorTexture(String(floorKey), type) ?? null;
      }
      if (t) return { texture: t, maskType: type };
    }
    return null;
  };

  for (const key of uniqueKeys) {
    recordTry(key);
    const hit = tryFloorMask(key);
    if (hit?.texture) {
      return {
        texture: hit.texture,
        resolvedKey: key,
        maskType: hit.maskType ?? null,
        route: 'direct',
        candidateKeysAttempted,
      };
    }
  }

  // Same gapfill rationale as `_Outdoors`: stack/context desync mid-navigation.
  try {
    if (
      ctxBandKey != null
      && multiFloor
      && activeFloor
      && String(ctxBandKey) !== String(activeFloor.compositorKey ?? '')
    ) {
      recordTry(ctxBandKey);
      const hit = tryFloorMask(ctxBandKey);
      if (hit?.texture) {
        return {
          texture: hit.texture,
          resolvedKey: ctxBandKey,
          maskType: hit.maskType ?? null,
          route: 'level-context-gapfill',
          candidateKeysAttempted,
        };
      }
    }
  } catch (_) {}

  const siblingBottom = Number.isFinite(Number(activeFloor?.elevationMin))
    ? Number(activeFloor.elevationMin)
    : (Number.isFinite(cb) ? cb : Number.NaN);
  if (Number.isFinite(siblingBottom)) {
    const siblingKeys = siblingFloorKeysMatchingBottom(compositor, siblingBottom, uniqueKeys);
    for (const key of siblingKeys) {
      recordTry(key);
      const hit = tryFloorMask(key);
      if (hit?.texture) {
        return {
          texture: hit.texture,
          resolvedKey: key,
          maskType: hit.maskType ?? null,
          route: 'sibling',
          candidateKeysAttempted,
        };
      }
    }
  }

  return { ...empty, candidateKeysAttempted };
}

/**
 * Authored file/bundle `_Outdoors` for one floor band — prefers `_floorMeta` over the
 * GPU compose RT so consumers (window-light clip, compose outdoor block) do not treat
 * stale/cleared GPU texels as fully outdoor.
 *
 * @param {object|null} compositor - GpuSceneMaskCompositor instance
 * @param {string|null|undefined} floorKey
 * @returns {import('three').Texture|null}
 */
export function resolveAuthoredOutdoorsForFloorKey(compositor, floorKey) {
  if (!compositor || floorKey == null || floorKey === '') return null;
  const key = String(floorKey);
  try {
    const metaTex = compositor._floorMeta?.get?.(key)?.masks
      ?.find((m) => (m.id ?? m.type) === 'outdoors')?.texture ?? null;
    if (Number(metaTex?.image?.width) > 0) return metaTex;
  } catch (_) {}
  try {
    return compositor.getFloorTexture?.(key, 'outdoors') ?? null;
  } catch (_) {
    return null;
  }
}

/**
 * Scene-space `_Outdoors` for a single floor band — GPU compose RT first, then
 * bundle bake into scene UV. Do **not** return raw tile-space `_floorMeta` textures
 * (wrong UV mapping in lighting / Camera Grade scene-UV passes).
 *
 * @param {object|null} compositor
 * @param {string|null|undefined} floorKey
 * @param {object|null} [scene=null]
 * @returns {import('three').Texture|null}
 */
export function resolveSceneSpaceOutdoorsForFloorKey(compositor, floorKey, scene = null) {
  if (!compositor || floorKey == null || floorKey === '') return null;
  const key = String(floorKey);
  const sc = scene ?? (typeof canvas !== 'undefined' ? canvas?.scene : null);

  let needsTileGpu = false;
  try {
    needsTileGpu = typeof compositor._floorBandNeedsTileGpuOutdoors === 'function'
      ? compositor._floorBandNeedsTileGpuOutdoors(key, sc)
      : false;
  } catch (_) {}

  try {
    if (typeof compositor.ensureSceneSpaceOutdoorsForFloor === 'function') {
      compositor.ensureSceneSpaceOutdoorsForFloor(key, sc);
    }
  } catch (_) {}

  try {
    const gpuTex = compositor._floorCache?.get?.(key)?.get?.('outdoors')?.texture ?? null;
    if (!gpuTex) return null;
    if (needsTileGpu && gpuTex.userData?.msaBundleBake) return null;
    return gpuTex;
  } catch (_) {}

  return null;
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

  const { uniqueKeys, activeFloor, ctxBandKey, multiFloor, cb } = collectCompositorFloorCandidateKeys(
    compositor,
    levelContext,
  );

  /** @type {import('three').Texture|null} */
  let tex = null;

  const sc = typeof canvas !== 'undefined' ? canvas?.scene : null;

  const tryKey = (k) => {
    if (k == null || k === '') return null;
    return resolveSceneSpaceOutdoorsForFloorKey(compositor, String(k), sc) ?? null;
  };

  for (const key of uniqueKeys) {
    tex = tryKey(key);
    if (tex) return { texture: tex, resolvedKey: key, route: 'direct' };
  }

  try {
    if (
      tex == null
      && ctxBandKey != null
      && multiFloor
      && activeFloor
      && String(ctxBandKey) !== String(activeFloor.compositorKey ?? '')
    ) {
      tex = tryKey(ctxBandKey);
      if (tex) return { texture: tex, resolvedKey: ctxBandKey, route: 'level-context-gapfill' };
    }
  } catch (_) {}

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

  const siblingBottom = Number.isFinite(Number(activeFloor?.elevationMin))
    ? Number(activeFloor.elevationMin)
    : (Number.isFinite(cb) ? cb : Number.NaN);
  if (Number.isFinite(siblingBottom)) {
    const matching = siblingFloorKeysMatchingBottom(compositor, siblingBottom, uniqueKeys);
    for (const key of matching) {
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

  if (allowBundleFallback && !tex) {
    const sc = window.MapShine?.sceneComposer;
    const bundleMask = sc?.currentBundle?.masks?.find?.(m => (m?.id === 'outdoors' || m?.type === 'outdoors'))?.texture ?? null;
    if (bundleMask) {
      return { texture: bundleMask, resolvedKey: 'bundle', route: 'bundle' };
    }
  }

  return empty;
}
