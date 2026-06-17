/**
 * @fileoverview Unified camera view-projection service for tile streaming and culling.
 * Single CPU source of truth wrapping scene-view-projection raycast cache.
 * @module streaming/view-projection-service
 */

import {
  createSceneViewProjectionCache,
  updateSceneViewProjectionFromCamera,
} from '../compositor-v2/scene-view-projection.js';
import { intersectRects } from './streaming-grid.js';

/** @type {import('../compositor-v2/scene-view-projection.js').SceneViewProjectionCache} */
let _cache = createSceneViewProjectionCache();

/** Reusable Three.js temps for perspective raycast (lazy-init). */
let _temps = null;

/**
 * @returns {{ ndc: import('three').Vector3, world: import('three').Vector3, dir: import('three').Vector3 }}
 */
function _ensureTemps() {
  const THREE = window.THREE;
  if (!_temps && THREE) {
    _temps = {
      ndc: new THREE.Vector3(),
      world: new THREE.Vector3(),
      dir: new THREE.Vector3(),
    };
  }
  return _temps;
}

/**
 * Resolve ground Z from SceneComposer (defaults to 1000).
 * @returns {number}
 */
export function resolveGroundZ() {
  const gz = Number(window.MapShine?.sceneComposer?.groundZ);
  return Number.isFinite(gz) ? gz : 1000;
}

/**
 * Update the global view projection cache from the live camera.
 * Call once per frame after CameraFollower sync (EffectComposer camera phase).
 *
 * @param {import('three').Camera|null} [camera]
 * @param {number} [groundZ]
 * @returns {boolean}
 */
export function tickViewProjection(camera = null, groundZ = resolveGroundZ()) {
  const cam = camera ?? window.MapShine?.sceneComposer?.camera ?? null;
  if (!cam) {
    _cache.isValid = false;
    return false;
  }
  return updateSceneViewProjectionFromCamera(cam, groundZ, _cache, _ensureTemps());
}

/**
 * @returns {import('../compositor-v2/scene-view-projection.js').SceneViewProjectionCache}
 */
export function getViewProjectionCache() {
  return _cache;
}

/**
 * Visible world-space rectangle (Three.js Y-up) at the ground plane.
 *
 * @param {number} [padding=0] World-unit padding on each side
 * @returns {{ minX: number, minY: number, maxX: number, maxY: number }|null}
 */
export function getVisibleWorldRect(padding = 0) {
  if (!_cache?.isValid) return null;
  const pad = Math.max(0, Number(padding) || 0);
  return {
    minX: _cache.vMinX - pad,
    minY: _cache.vMinY - pad,
    maxX: _cache.vMaxX + pad,
    maxY: _cache.vMaxY + pad,
  };
}

/**
 * Stable ground-plane view rect for debug overlays (minimap).
 * Uses the live Three camera after PIXI sync — avoids stale raycast cache
 * when called outside the EffectComposer camera phase.
 *
 * @returns {{ minX: number, minY: number, maxX: number, maxY: number }|null}
 */
export function getStableViewRectForMinimap() {
  const camera = window.MapShine?.sceneComposer?.camera
    ?? window.MapShine?.floorCompositorV2?.camera
    ?? null;
  const pos = camera?.position;
  if (!camera || !pos) return getVisibleWorldRect(0);

  const px = Number(pos.x);
  const py = Number(pos.y);
  if (!Number.isFinite(px) || !Number.isFinite(py)) return getVisibleWorldRect(0);

  if (camera.isOrthographicCamera) {
    const zoom = Math.max(1e-6, Number(camera.zoom) || 1);
    return {
      minX: px + (Number(camera.left) || 0) / zoom,
      minY: py + (Number(camera.bottom) || 0) / zoom,
      maxX: px + (Number(camera.right) || 0) / zoom,
      maxY: py + (Number(camera.top) || 0) / zoom,
    };
  }

  if (camera.isPerspectiveCamera) {
    const gz = resolveGroundZ();
    const pz = Number(pos.z);
    const dist = Number.isFinite(pz) ? Math.max(1e-3, Math.abs(pz - gz)) : 1;
    const fovRad = ((Number(camera.fov) || 60) * Math.PI) / 180;
    const halfH = dist * Math.tan(fovRad * 0.5);
    const aspect = Math.max(1e-6, Number(camera.aspect) || 1);
    const halfW = halfH * aspect;
    return {
      minX: px - halfW,
      minY: py - halfH,
      maxX: px + halfW,
      maxY: py + halfH,
    };
  }

  return getVisibleWorldRect(0);
}

/**
 * @typedef {{ minX?: number, minY?: number, maxX?: number, maxY?: number, uniform?: number }} StreamingViewPadding
 */

/**
 * Normalize padding to per-edge world units.
 * @param {number|StreamingViewPadding} [padding=0]
 * @returns {{ minX: number, minY: number, maxX: number, maxY: number }}
 */
export function normalizeStreamingViewPadding(padding = 0) {
  if (typeof padding === 'number') {
    const pad = Math.max(0, Number(padding) || 0);
    return { minX: pad, minY: pad, maxX: pad, maxY: pad };
  }
  const uniform = Math.max(0, Number(padding?.uniform) || 0);
  return {
    minX: Math.max(0, Number(padding?.minX) || uniform),
    minY: Math.max(0, Number(padding?.minY) || uniform),
    maxX: Math.max(0, Number(padding?.maxX) || uniform),
    maxY: Math.max(0, Number(padding?.maxY) || uniform),
  };
}

/**
 * View rect for tile streaming — always ticks projection first, then picks the
 * larger of raycast vs stable FOV box so zoom-out never keeps a stale small frustum.
 *
 * @param {number|StreamingViewPadding} [padding=0]
 * @returns {{ minX: number, minY: number, maxX: number, maxY: number }|null}
 */
export function resolveStreamingViewRect(padding = 0) {
  tickViewProjection(
    window.MapShine?.sceneComposer?.camera ?? null,
    resolveGroundZ(),
  );
  const pad = normalizeStreamingViewPadding(padding);
  const expand = (r) => ({
    minX: r.minX - pad.minX,
    minY: r.minY - pad.minY,
    maxX: r.maxX + pad.maxX,
    maxY: r.maxY + pad.maxY,
  });
  const raycast = getVisibleWorldRect(0);
  const stable = getStableViewRectForMinimap();
  const stablePad = stable ? expand(stable) : null;
  if (!raycast && !stablePad) return null;
  if (!raycast) return stablePad;
  if (!stablePad) return raycast;
  const area = (r) => Math.max(1, r.maxX - r.minX) * Math.max(1, r.maxY - r.minY);
  return area(stablePad) > area(raycast) * 1.02 ? stablePad : raycast;
}

/**
 * True when a streaming view rect plausibly overlaps scene content.
 * Rejects stale projection during floor transitions (camera not yet synced).
 *
 * @param {{ minX: number, minY: number, maxX: number, maxY: number }|null} viewRect
 * @param {number} [margin=1.25] Expand scene bounds by this factor for padding tolerance.
 * @returns {boolean}
 */
export function viewRectIntersectsScene(viewRect, margin = 1.25) {
  if (!viewRect) return false;
  const scene = getSceneWorldRect();
  const sw = Math.max(1, scene.maxX - scene.minX);
  const sh = Math.max(1, scene.maxY - scene.minY);
  const m = Math.max(1, Number(margin) || 1);
  const padX = sw * (m - 1) * 0.5;
  const padY = sh * (m - 1) * 0.5;
  const expanded = {
    minX: scene.minX - padX,
    minY: scene.minY - padY,
    maxX: scene.maxX + padX,
    maxY: scene.maxY + padY,
  };
  return !!intersectRects(viewRect, expanded);
}

/**
 * Foundry scene rect metadata from canvas dimensions.
 * @returns {{ x: number, y: number, width: number, height: number, canvasWidth: number, canvasHeight: number }}
 */
export function getSceneRectMeta() {
  const canvas = globalThis.canvas;
  const fd = window.MapShine?.sceneComposer?.foundrySceneData;
  const sr = canvas?.dimensions?.sceneRect ?? canvas?.dimensions ?? {};
  return {
    x: Number(sr.x ?? fd?.sceneX ?? 0),
    y: Number(sr.y ?? fd?.sceneY ?? 0),
    width: Number(sr.width ?? fd?.sceneWidth ?? 1000),
    height: Number(sr.height ?? fd?.sceneHeight ?? 1000),
    canvasWidth: Number(canvas?.dimensions?.width ?? fd?.width ?? 1000),
    canvasHeight: Number(canvas?.dimensions?.height ?? fd?.height ?? 1000),
  };
}

/**
 * Scene content bounds in Three.js world XY (matches FloorRenderBus / view projection).
 *
 * @returns {{ minX: number, minY: number, maxX: number, maxY: number }}
 */
export function getSceneWorldRect() {
  const meta = getSceneRectMeta();
  const worldH = meta.canvasHeight;
  return {
    minX: meta.x,
    minY: worldH - (meta.y + meta.height),
    maxX: meta.x + meta.width,
    maxY: worldH - meta.y,
  };
}

/**
 * Scene content bounds from FloorRenderBus foundry scene data (fd).
 *
 * @param {object|null|undefined} fd
 * @returns {{ minX: number, minY: number, maxX: number, maxY: number }|null}
 */
export function getSceneRegionFromFoundryData(fd) {
  if (!fd) return null;
  const sceneW = Number(fd.sceneWidth ?? fd.width ?? 0);
  const sceneH = Number(fd.sceneHeight ?? fd.height ?? 0);
  const sceneX = Number(fd.sceneX ?? 0);
  const sceneY = Number(fd.sceneY ?? 0);
  const worldH = Number(fd.height ?? sceneH);
  if (!(sceneW > 0 && sceneH > 0)) return null;
  return {
    minX: sceneX,
    minY: worldH - (sceneY + sceneH),
    maxX: sceneX + sceneW,
    maxY: worldH - sceneY,
  };
}

/**
 * Convert Three world XY to Foundry scene UV [0..1] within the scene rect.
 *
 * @param {number} worldX
 * @param {number} worldY
 * @returns {{ u: number, v: number }}
 */
export function worldToSceneUv(worldX, worldY) {
  const meta = getSceneRectMeta();
  const foundryY = meta.canvasHeight - worldY;
  const u = (worldX - meta.x) / Math.max(1, meta.width);
  const v = (foundryY - meta.y) / Math.max(1, meta.height);
  return { u, v };
}

/**
 * Visible region in scene UV space [0..1].
 *
 * @param {number} [padding=0] World-unit padding (converted via view span)
 * @returns {{ uMin: number, vMin: number, uMax: number, vMax: number }|null}
 */
export function getVisibleSceneUvRect(padding = 0) {
  const world = getVisibleWorldRect(padding);
  if (!world) return null;
  const tl = worldToSceneUv(world.minX, world.maxY);
  const br = worldToSceneUv(world.maxX, world.minY);
  return {
    uMin: Math.min(tl.u, br.u),
    vMin: Math.min(tl.v, br.v),
    uMax: Math.max(tl.u, br.u),
    vMax: Math.max(tl.v, br.v),
  };
}

/**
 * Camera ground-plane center in Three.js world XY (tile under crosshair).
 * Ticks projection when the cache is stale.
 *
 * @returns {{ x: number, y: number }|null}
 */
export function getCameraGroundCenter() {
  if (!_cache?.isValid) {
    tickViewProjection(
      window.MapShine?.sceneComposer?.camera ?? null,
      resolveGroundZ(),
    );
  }
  if (!_cache?.isValid) return null;
  return { x: _cache.px, y: _cache.py };
}

/**
 * Reset cache (scene teardown / tests).
 */
export function resetViewProjectionService() {
  _cache = createSceneViewProjectionCache();
}
