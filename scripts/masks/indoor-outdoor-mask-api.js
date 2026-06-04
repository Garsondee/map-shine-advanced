/**
 * Public API for indoors vs outdoors masks — single source of truth.
 *
 * **Per band (scene-space):** {@link getBandOutdoorsMask}
 * **Effective stack (all visible floors):** {@link getEffectiveOutdoorsStack}
 * **Active / viewed band (legacy name):** {@link resolveViewedBandOutdoorsMask}
 *
 * Do not sample raw `compositor.getFloorTexture(key, 'outdoors')` or bundle
 * `_floorMeta` textures in scene-UV consumers — use this module.
 *
 * @module masks/indoor-outdoor-mask-api
 */

import {
  getIndoorOutdoorMaskService,
} from './IndoorOutdoorMaskService.js';
import {
  resolveSceneSpaceOutdoorsForFloorKey,
  resolveCompositorOutdoorsTexture,
  collectCompositorFloorCandidateKeys,
} from './resolve-compositor-outdoors.js';

export { getIndoorOutdoorMaskService } from './IndoorOutdoorMaskService.js';
export {
  resolveSceneSpaceOutdoorsForFloorKey,
  resolveAuthoredOutdoorsForFloorKey,
  collectCompositorFloorCandidateKeys,
} from './resolve-compositor-outdoors.js';
export {
  getIndoorOutdoorDefringeParams,
  syncIndoorOutdoorDefringeConsumers,
} from './indoor-outdoor-defringe.js';

/**
 * @param {object|null} [compositor]
 * @returns {import('./IndoorOutdoorMaskService.js').IndoorOutdoorMaskService|null}
 */
export function getMaskService(compositor = null) {
  const comp = compositor ?? window.MapShine?.sceneComposer?._sceneMaskCompositor ?? null;
  if (!comp) return null;
  try {
    return getIndoorOutdoorMaskService(comp);
  } catch (_) {
    return null;
  }
}

/**
 * Scene-space `_Outdoors` for one floor band (GPU compose or background bake).
 *
 * @param {string} floorKey
 * @param {object|null} [scene=null]
 * @param {object|null} [compositor=null]
 * @returns {import('three').Texture|null}
 */
export function getBandOutdoorsMask(floorKey, scene = null, compositor = null) {
  const comp = compositor ?? window.MapShine?.sceneComposer?._sceneMaskCompositor ?? null;
  if (!comp || !floorKey) return null;
  const sc = scene ?? (typeof canvas !== 'undefined' ? canvas?.scene : null);
  const service = getMaskService(comp);
  if (service) {
    return service.getBandMaskForLevel(String(floorKey), sc);
  }
  return resolveSceneSpaceOutdoorsForFloorKey(comp, String(floorKey), sc);
}

/**
 * Visible-floor stacked effective mask (Camera Grade, bloom, screen-space gating).
 *
 * @param {THREE.WebGLRenderer} renderer
 * @param {object|null} [scene=null]
 * @param {string[]|null} [floorKeysBottomToTop=null] defaults to FloorStack visible keys
 * @param {object|null} [compositor=null]
 * @returns {ReturnType<import('./IndoorOutdoorMaskService.js').IndoorOutdoorMaskService['buildVisibleFloorStack']>}
 */
export function getEffectiveOutdoorsStack(renderer, scene = null, floorKeysBottomToTop = null, compositor = null) {
  const empty = { outdoors: null, skyReach: null, diag: null, cacheHit: false };
  const comp = compositor ?? window.MapShine?.sceneComposer?._sceneMaskCompositor ?? null;
  if (!comp || !renderer) return empty;

  const service = getMaskService(comp);
  if (!service) return empty;

  const sc = scene ?? (typeof canvas !== 'undefined' ? canvas?.scene : null);
  let keys = floorKeysBottomToTop;
  if (!Array.isArray(keys) || keys.length === 0) {
    keys = [];
    try {
      const floors = window.MapShine?.floorStack?.getVisibleFloors?.() ?? [];
      for (const floor of floors) {
        const ck = floor?.compositorKey;
        if (ck != null && String(ck).length > 0) keys.push(String(ck));
      }
    } catch (_) {}
  }
  if (!keys.length) {
    return service.buildStackForVisibleFloors(renderer, sc);
  }
  return service.buildVisibleFloorStack(renderer, keys, sc);
}

/**
 * Whether a scene-space outdoors RT exists for a band (readiness probe).
 *
 * @param {string} floorKey
 * @param {object|null} [scene=null]
 * @param {object|null} [compositor=null]
 * @returns {boolean}
 */
export function hasBandOutdoorsMask(floorKey, scene = null, compositor = null) {
  return !!getBandOutdoorsMask(floorKey, scene, compositor);
}

/**
 * Resolve outdoors for the viewed / active band (scene-space), with optional
 * effective-stack preference on multi-floor scenes.
 *
 * @param {object|null} compositor
 * @param {{ bottom?: number, top?: number }|null} [levelContext=null]
 * @param {{
 *   skipGroundFallback?: boolean,
 *   allowBundleFallback?: boolean,
 *   strictViewedFloorOnly?: boolean,
 *   preferEffectiveStack?: boolean,
 *   renderer?: import('three').WebGLRenderer|null,
 *   scene?: object|null,
 * }} [options]
 * @returns {{ texture: import('three').Texture|null, floorKey: string|null, route?: string|null }}
 */
export function resolveViewedBandOutdoorsMask(compositor, levelContext = null, options = {}) {
  const {
    skipGroundFallback = false,
    allowBundleFallback = true,
    strictViewedFloorOnly = false,
    preferEffectiveStack = true,
    renderer = null,
    scene = null,
  } = options;

  if (!compositor) {
    return { texture: null, floorKey: null, route: null };
  }

  let multiFloor = false;
  try {
    multiFloor = (window.MapShine?.floorStack?.getFloors?.() ?? []).length > 1;
  } catch (_) {
    multiFloor = false;
  }

  const sc = scene ?? (typeof canvas !== 'undefined' ? canvas?.scene : null);
  const r = renderer
    ?? window.MapShine?.floorCompositorV2?.renderer
    ?? window.MapShine?.renderer
    ?? null;

  if (preferEffectiveStack && multiFloor && !strictViewedFloorOnly && r) {
    try {
      const built = getEffectiveOutdoorsStack(r, sc, null, compositor);
      if (built.outdoors) {
        return {
          texture: built.outdoors,
          floorKey: 'effective-stack',
          route: built.cacheHit ? 'stack-cache' : 'stack',
        };
      }
    } catch (_) {}
  }

  const gpu = resolveCompositorOutdoorsTexture(compositor, levelContext, {
    skipGroundFallback,
    allowBundleFallback,
    strictViewedFloorOnly,
  });
  return {
    texture: gpu.texture,
    floorKey: gpu.resolvedKey,
    route: gpu.route ?? gpu.resolvedKey,
  };
}

/**
 * Per-floor `_Outdoors` indexed by FloorStack index (0..maxSlots-1), scene-space only.
 *
 * @param {object|null} compositor
 * @param {number} [maxSlots=4]
 * @param {object|null} [scene=null]
 * @returns {{ textures: (import('three').Texture|null)[], floorIdTex: import('three').Texture|null }}
 */
export function collectBandOutdoorsByFloorIndex(compositor, maxSlots = 4, scene = null) {
  const textures = Array.from({ length: maxSlots }, () => null);
  if (!compositor) {
    return { textures, floorIdTex: null };
  }
  const sc = scene ?? (typeof canvas !== 'undefined' ? canvas?.scene : null);
  try {
    const floors = window.MapShine?.floorStack?.getFloors?.() ?? [];
    for (const floor of floors) {
      const idx = Number(floor?.index);
      if (!Number.isFinite(idx) || idx < 0 || idx >= maxSlots) continue;
      let key = floor?.compositorKey != null ? String(floor.compositorKey) : '';
      if (!key) {
        const b = Number(floor?.elevationMin);
        const t = Number(floor?.elevationMax);
        if (Number.isFinite(b) && Number.isFinite(t)) key = `${b}:${t}`;
      }
      if (!key) continue;
      textures[idx] = getBandOutdoorsMask(key, sc, compositor);
    }
    const floorIdTex = compositor.floorIdTarget?.texture ?? null;
    return { textures, floorIdTex };
  } catch (_) {
    return { textures, floorIdTex: null };
  }
}
