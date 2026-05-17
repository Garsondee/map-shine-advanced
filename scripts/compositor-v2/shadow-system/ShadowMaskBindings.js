/**
 * @fileoverview Shared mask lookup facade for the unified shadow system.
 */

import { resolveCompositorOutdoorsTexture } from '../../masks/resolve-compositor-outdoors.js';

/**
 * Read-only facade over GpuSceneMaskCompositor / FloorStack mask state.
 */
export class ShadowMaskBindings {
  constructor() {
    /** @type {Map<string, {outdoorsMask:any}>} */
    this._floorStates = new Map();
  }

  syncFloorMask(bundle, floorKey) {
    const key = String(floorKey ?? '');
    if (!key) return;
    const outdoorsEntry = bundle?.masks?.find?.((m) => m?.id === 'outdoors' || m?.type === 'outdoors');
    const outdoorsMask = outdoorsEntry?.texture ?? null;
    const existing = this._floorStates.get(key);
    if (existing) existing.outdoorsMask = outdoorsMask;
    else this._floorStates.set(key, { outdoorsMask });
  }

  get compositor() {
    return window.MapShine?.sceneComposer?._sceneMaskCompositor ?? null;
  }

  get floorStack() {
    return window.MapShine?.floorStack ?? null;
  }

  get activeFloor() {
    return this.floorStack?.getActiveFloor?.() ?? null;
  }

  get floorIdTexture() {
    return this.compositor?.floorIdTarget?.texture ?? null;
  }

  getActiveOutdoors({ purpose = 'shadow-receiver', levelContext = null } = {}) {
    const compositor = this.compositor;
    if (!compositor) return null;
    const activeFloor = this.activeFloor;
    const floors = this.floorStack?.getFloors?.() ?? [];
    const activeIdx = Number(activeFloor?.index);
    const multiFloor = Array.isArray(floors) && floors.length > 1;
    const strictUpper = multiFloor && Number.isFinite(activeIdx) && activeIdx > 0;
    const strictViewedFloorOnly = purpose === 'shadow-receiver' || purpose === 'sky-mask';
    const allowBundleFallback = !strictUpper || purpose === 'sky-mask';
    const resolved = resolveCompositorOutdoorsTexture(
      compositor,
      levelContext ?? window.MapShine?.activeLevelContext ?? null,
      {
        skipGroundFallback: strictUpper,
        allowBundleFallback,
        strictViewedFloorOnly,
      },
    );
    if (resolved.texture) return resolved.texture;
    const activeKey = activeFloor?.compositorKey != null ? String(activeFloor.compositorKey) : '';
    if (activeKey && this._floorStates.has(activeKey)) {
      return this._floorStates.get(activeKey).outdoorsMask ?? null;
    }
    return null;
  }

  getActiveSkyReach() {
    const compositor = this.compositor;
    if (!compositor?.getFloorTexture) return null;
    const activeFloor = this.activeFloor;
    const ck = activeFloor?.compositorKey != null ? String(activeFloor.compositorKey) : '';
    if (ck) {
      const tex = compositor.getFloorTexture(ck, 'skyReach') ?? null;
      if (tex) return tex;
    }
    const b = Number(activeFloor?.elevationMin);
    const t = Number(activeFloor?.elevationMax);
    if (Number.isFinite(b) && Number.isFinite(t)) {
      return compositor.getFloorTexture(`${b}:${t}`, 'skyReach') ?? null;
    }
    return null;
  }

  getActiveFloorAlpha() {
    return this._getFloorTexture(this.activeFloor, 'floorAlpha');
  }

  getUpperFloorAlphaStack({ receiverBaseIndex = null } = {}) {
    const textures = [];
    const keys = [];
    const floors = this.floorStack?.getFloors?.() ?? [];
    const activeIdx = Number.isFinite(Number(receiverBaseIndex))
      ? Number(receiverBaseIndex)
      : Number(this.activeFloor?.index);
    if (!Array.isArray(floors) || !Number.isFinite(activeIdx)) return { textures, keys };
    const seen = new Set();
    for (const floor of floors) {
      const idx = Number(floor?.index);
      if (!Number.isFinite(idx) || idx <= activeIdx) continue;
      const tex = this._getFloorTexture(floor, 'floorAlpha');
      const key = floor?.compositorKey != null ? String(floor.compositorKey) : `${floor?.elevationMin}:${floor?.elevationMax}`;
      const sig = tex?.uuid ?? tex;
      if (!tex || seen.has(sig)) continue;
      seen.add(sig);
      textures.push(tex);
      keys.push(key);
    }
    return { textures, keys };
  }

  _getFloorTexture(floor, maskType) {
    const compositor = this.compositor;
    if (!compositor?.getFloorTexture || !floor) return null;
    const ck = floor?.compositorKey != null ? String(floor.compositorKey) : '';
    if (ck) {
      const tex = compositor.getFloorTexture(ck, maskType) ?? null;
      if (tex) return tex;
    }
    const b = Number(floor?.elevationMin);
    const t = Number(floor?.elevationMax);
    if (Number.isFinite(b) && Number.isFinite(t)) {
      return compositor.getFloorTexture(`${b}:${t}`, maskType) ?? null;
    }
    return null;
  }
}
