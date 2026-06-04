/**
 * Single source of truth for scene-space `_Outdoors` masks and the visible-floor stack
 * used by Camera Grade, bloom, and debug views.
 *
 * @module masks/IndoorOutdoorMaskService
 */

import { createLogger } from '../core/log.js';
import { resolveSceneSpaceOutdoorsForFloorKey } from './resolve-compositor-outdoors.js';
import { defringeParamsSignature, getIndoorOutdoorDefringeParams } from './indoor-outdoor-defringe.js';

const log = createLogger('IndoorOutdoorMaskService');

/**
 * @param {object|null} compositor - GpuSceneMaskCompositor
 * @returns {IndoorOutdoorMaskService}
 */
export function getIndoorOutdoorMaskService(compositor) {
  if (!compositor) {
    throw new Error('IndoorOutdoorMaskService requires GpuSceneMaskCompositor');
  }
  if (!compositor._indoorOutdoorMaskService) {
    compositor._indoorOutdoorMaskService = new IndoorOutdoorMaskService(compositor);
  }
  return compositor._indoorOutdoorMaskService;
}

export class IndoorOutdoorMaskService {
  /**
   * @param {object} compositor
   */
  constructor(compositor) {
    this._compositor = compositor;
    /** @type {string} */
    this._stackCacheKey = '';
    /** @type {import('three').Texture|null} */
    this._stackTexture = null;
    /** @type {import('three').Texture|null} */
    this._stackSkyReachTexture = null;
    /** @type {object|null} */
    this._lastBuildDiag = null;
  }

  /**
   * Scene-space `_Outdoors` for one band (never raw tile-space meta).
   *
   * @param {string} floorKey
   * @param {object|null} [scene=null]
   * @returns {import('three').Texture|null}
   */
  ensureBandSceneMask(floorKey, scene = null) {
    if (!floorKey) return null;
    const sc = scene ?? (typeof canvas !== 'undefined' ? canvas?.scene : null);
    return resolveSceneSpaceOutdoorsForFloorKey(this._compositor, String(floorKey), sc);
  }

  /**
   * Per-band mask for per-level passes (Light Physics, window-light clip).
   *
   * @param {string} floorKey
   * @param {object|null} [scene=null]
   * @returns {import('three').Texture|null}
   */
  getBandMaskForLevel(floorKey, scene = null) {
    return this.ensureBandSceneMask(floorKey, scene);
  }

  /**
   * Last stacked build diagnostics.
   * @returns {object|null}
   */
  getLastBuildDiag() {
    return this._lastBuildDiag;
  }

  /**
   * Cached stack texture from the last build (may be null).
   * @returns {import('three').Texture|null}
   */
  getCachedStackTexture() {
    return this._stackTexture ?? null;
  }

  /**
   * Build or reuse the visible-floor stacked outdoors mask (bottom→top).
   *
   * @param {THREE.WebGLRenderer} renderer
   * @param {string[]} visibleFloorKeysBottomToTop
   * @param {object|null} [scene=null]
   * @returns {{
   *   outdoors: import('three').Texture|null,
   *   skyReach: import('three').Texture|null,
   *   diag: object|null,
   *   cacheHit: boolean,
   * }}
   */
  buildVisibleFloorStack(renderer, visibleFloorKeysBottomToTop, scene = null) {
    const empty = {
      outdoors: null,
      skyReach: null,
      diag: null,
      cacheHit: false,
    };
    const compositor = this._compositor;
    if (!compositor || !renderer || !Array.isArray(visibleFloorKeysBottomToTop)) {
      return empty;
    }

    const sc = scene ?? (typeof canvas !== 'undefined' ? canvas?.scene : null);
    const keys = visibleFloorKeysBottomToTop
      .map((k) => (k != null ? String(k) : ''))
      .filter((k) => k.length > 0);
    if (!keys.length) return empty;

    const sceneId = String(sc?.id ?? sc?._id ?? '');
    let cacheVersion = 0;
    try {
      cacheVersion = Number(compositor.getFloorCacheVersion?.() ?? 0);
    } catch (_) {}

    const maskSig = keys.map((key) => {
      const o = compositor.getFloorTexture?.(key, 'outdoors')?.uuid ?? 'no-od';
      const a = compositor.getFloorTexture?.(key, 'floorAlpha')?.uuid ?? 'no-fa';
      const s = compositor.getFloorTexture?.(key, 'skyReach')?.uuid ?? 'no-sr';
      return `${key}:${o}:${a}:${s}`;
    }).join('|');
    const defringeSig = defringeParamsSignature(getIndoorOutdoorDefringeParams());
    const cacheKey = `${sceneId}|${keys.join(',')}|${maskSig}|v${cacheVersion}|${defringeSig}`;

    if (this._stackCacheKey === cacheKey && this._stackTexture) {
      const diag = {
        mode: 'stack-cache-hit',
        stackKeys: keys.slice(),
        visibleFloorKeys: keys.slice(),
        cacheHit: true,
        prep: this._lastBuildDiag?.prep ?? null,
        outdoors: compositor.getLastStackedOutdoorsDiag?.() ?? null,
        skyReach: compositor.getLastStackedSkyReachDiag?.() ?? null,
      };
      this._lastBuildDiag = diag;
      this._publishGlobalDiag(diag, this._stackTexture);
      return {
        outdoors: this._stackTexture,
        skyReach: this._stackSkyReachTexture ?? null,
        diag,
        cacheHit: true,
      };
    }

    for (const key of keys) {
      try {
        if (
          compositor._floorBandUsesBackgroundAuthoredOutdoors?.(key, sc)
          && !compositor._authoredOutdoorsFileByFloor?.has(key)
        ) {
          compositor._evictGpuMaskRtForFloor?.(key, 'outdoors');
        }
      } catch (_) {}
    }

    const prep = compositor.prepareVisibleFloorsForOutdoorsStack?.(
      renderer,
      keys,
      sc,
    ) ?? { preparedKeys: [], skippedKeys: [], reasons: {} };

    try {
      compositor.rebuildFloorIdFromVisibleFloorKeys?.(keys);
    } catch (_) {}

    for (const key of keys) {
      try {
        this.ensureBandSceneMask(key, sc);
      } catch (e) {
        log.debug('buildVisibleFloorStack: ensureBandSceneMask failed', { key, err: e });
      }
    }

    let outdoorsTex = null;
    let skyReachTex = null;
    try {
      outdoorsTex = compositor.composeStackedOutdoorsMask?.(renderer, keys, sc) ?? null;
      skyReachTex = compositor.composeStackedSkyReachMask?.(renderer, keys) ?? null;
    } catch (e) {
      log.debug('buildVisibleFloorStack: stack compose failed', e);
    }

    if (!outdoorsTex && keys.length === 1) {
      outdoorsTex = this.ensureBandSceneMask(keys[0], sc);
      skyReachTex = compositor.getFloorTexture?.(keys[0], 'skyReach') ?? null;
    }

    if (outdoorsTex) {
      this._stackCacheKey = cacheKey;
      this._stackTexture = outdoorsTex;
      this._stackSkyReachTexture = skyReachTex;
    }

    const diag = {
      mode: keys.length > 1 ? 'stack-visible-floors' : 'single-visible-floor',
      stackKeys: keys.slice(),
      visibleFloorKeys: keys.slice(),
      cacheHit: false,
      prep,
      outdoors: compositor.getLastStackedOutdoorsDiag?.() ?? null,
      skyReach: compositor.getLastStackedSkyReachDiag?.() ?? null,
      skippedKeys: prep.skippedKeys ?? [],
    };
    this._lastBuildDiag = diag;
    this._publishGlobalDiag(diag, outdoorsTex);

    if (prep.skippedKeys?.length || diag.outdoors?.skippedKeys?.length) {
      log.debug('buildVisibleFloorStack: incomplete stack', diag);
    }

    return {
      outdoors: outdoorsTex,
      skyReach: skyReachTex,
      diag,
      cacheHit: false,
    };
  }

  /**
   * Convenience for post-merge consumers — uses current visible floors from FloorStack.
   *
   * @param {THREE.WebGLRenderer} renderer
   * @param {object|null} [scene=null]
   * @returns {ReturnType<IndoorOutdoorMaskService['buildVisibleFloorStack']>}
   */
  buildStackForVisibleFloors(renderer, scene = null) {
    const keys = [];
    try {
      const floors = window.MapShine?.floorStack?.getVisibleFloors?.() ?? [];
      for (const floor of floors) {
        const ck = floor?.compositorKey;
        if (ck != null && String(ck).length > 0) keys.push(String(ck));
      }
    } catch (_) {}
    return this.buildVisibleFloorStack(renderer, keys, scene);
  }

  /** Invalidate frame cache (floor/scene change). */
  invalidateCache() {
    this._stackCacheKey = '';
    this._stackTexture = null;
    this._stackSkyReachTexture = null;
    this._lastBuildDiag = null;
  }

  /**
   * @param {object} diag
   * @param {import('three').Texture|null} texture
   * @private
   */
  _publishGlobalDiag(diag, texture) {
    try {
      const ms = window.MapShine;
      if (!ms) return;
      ms.__effectiveOutdoorsStack = {
        diag,
        textureUuid: texture?.uuid ?? null,
        capturedAt: Date.now(),
      };
    } catch (_) {}
  }
}
