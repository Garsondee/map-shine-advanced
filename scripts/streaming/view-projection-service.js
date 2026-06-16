/**
 * @fileoverview Unified camera view-projection service for tile streaming and culling.
 * Single CPU source of truth wrapping scene-view-projection raycast cache.
 * @module streaming/view-projection-service
 */

import {
  createSceneViewProjectionCache,
  updateSceneViewProjectionFromCamera,
} from '../compositor-v2/scene-view-projection.js';

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
 * Reset cache (scene teardown / tests).
 */
export function resetViewProjectionService() {
  _cache = createSceneViewProjectionCache();
}
