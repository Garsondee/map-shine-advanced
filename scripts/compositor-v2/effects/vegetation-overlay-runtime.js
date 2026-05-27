/**
 * @fileoverview Shared CPU helpers for BushEffectV2 / TreeEffectV2 (view culling, bounds).
 * @module compositor-v2/effects/vegetation-overlay-runtime
 */

import { VEGETATION_ABOVE_WATER_LAYER } from '../../core/render-layers.js';

/**
 * Route an overlay mesh to the post-water compositor pass (not the bus albedo draw).
 * Tree canopies may keep WEATHER_ROOF_LAYER (21) for overhead/weather roof capture.
 *
 * @param {import('three').Object3D|null|undefined} object3d
 * @param {{ retainWeatherRoofLayer?: boolean }} [options]
 */
export function applyVegetationAboveWaterLayer(object3d, options = {}) {
  if (!object3d) return;
  object3d.userData = object3d.userData || {};
  object3d.userData.mapShineVegetationOverlay = true;
  if (!object3d.layers) return;
  if (typeof object3d.layers.disable === 'function') object3d.layers.disable(0);
  if (typeof object3d.layers.enable === 'function') {
    object3d.layers.enable(VEGETATION_ABOVE_WATER_LAYER);
    if (options.retainWeatherRoofLayer === true) object3d.layers.enable(21);
  }
}

/**
 * @param {string} tileId
 * @returns {boolean}
 */
export function isVegetationOverlayBusKey(tileId) {
  const id = String(tileId || '');
  return id.endsWith('_bush')
    || id.endsWith('_tree')
    || id.endsWith('_bush_shadow')
    || id.endsWith('_tree_shadow');
}

/**
 * Mark splash batches so FloorCompositor can exclude them from the bus albedo pass.
 * Splashes are drawn via a visibility-gated bus render after water (layer 0), not
 * isolated Three.js layer 33 — quarks BatchedRenderer does not honor that reliably.
 *
 * @param {import('three').Object3D|null|undefined} object3d
 */
export function applyWaterSplashAboveWaterLayer(object3d) {
  if (!object3d) return;
  object3d.userData = object3d.userData || {};
  object3d.userData.mapShineWaterSplashOverlay = true;
  if (object3d.layers?.enable) {
    object3d.layers.enable(0);
  }
}

/**
 * World-space AABB for a tile-aligned overlay plane.
 * @param {number} centerX
 * @param {number} centerY
 * @param {number} tileW
 * @param {number} tileH
 * @returns {{ minX: number, minY: number, maxX: number, maxY: number }}
 */
export function overlayWorldBounds(centerX, centerY, tileW, tileH) {
  const hw = Math.max(0, Number(tileW) || 0) * 0.5;
  const hh = Math.max(0, Number(tileH) || 0) * 0.5;
  const cx = Number(centerX) || 0;
  const cy = Number(centerY) || 0;
  return { minX: cx - hw, minY: cy - hh, maxX: cx + hw, maxY: cy + hh };
}

/**
 * Visible world XY rect from the Map Shine scene camera (Three space, Y-up).
 * @param {import('three').Camera|null|undefined} cam
 * @param {{ groundZ?: number, baseViewportWidth?: number, baseViewportHeight?: number }} [sceneComposer]
 * @param {number} [padding=0]
 * @returns {{ minX: number, minY: number, maxX: number, maxY: number }|null}
 */
export function resolveWorldViewBounds(cam, sceneComposer = null, padding = 0) {
  if (!cam) return null;

  const pad = Math.max(0, Number(padding) || 0);
  let vMinX = 0;
  let vMinY = 0;
  let vMaxX = 1;
  let vMaxY = 1;

  if (cam.isOrthographicCamera) {
    const camPos = cam.position;
    const zoom = Math.max(1e-6, Number(cam.zoom) || 1);
    vMinX = camPos.x + cam.left / zoom;
    vMinY = camPos.y + cam.bottom / zoom;
    vMaxX = camPos.x + cam.right / zoom;
    vMaxY = camPos.y + cam.top / zoom;
  } else {
    const groundZ = Number(sceneComposer?.groundZ ?? 0);
    const dist = Math.max(1e-3, Math.abs((cam.position?.z ?? 0) - groundZ));
    const fovRad = ((Number(cam.fov) || 60) * Math.PI) / 180;
    const halfH = dist * Math.tan(fovRad * 0.5);
    const aspect = Number(cam.aspect)
      || ((Number(sceneComposer?.baseViewportWidth) || 1) / Math.max(1, Number(sceneComposer?.baseViewportHeight) || 1));
    const halfW = halfH * aspect;
    vMinX = cam.position.x - halfW;
    vMaxX = cam.position.x + halfW;
    vMinY = cam.position.y - halfH;
    vMaxY = cam.position.y + halfH;
  }

  return {
    minX: vMinX - pad,
    minY: vMinY - pad,
    maxX: vMaxX + pad,
    maxY: vMaxY + pad,
  };
}

/**
 * @param {{ minX: number, minY: number, maxX: number, maxY: number }} tile
 * @param {{ minX: number, minY: number, maxX: number, maxY: number }} view
 * @returns {boolean}
 */
export function tileBoundsIntersectView(tile, view) {
  if (!tile || !view) return true;
  return !(tile.maxX < view.minX || tile.minX > view.maxX
    || tile.maxY < view.minY || tile.minY > view.maxY);
}

/**
 * Compact camera signature for caching view bounds between frames.
 * @param {import('three').Camera|null|undefined} cam
 * @returns {string}
 */
export function cameraViewBoundsSignature(cam) {
  if (!cam) return '';
  const p = cam.position;
  if (cam.isOrthographicCamera) {
    return [
      'o', p.x, p.y, p.z, cam.zoom, cam.left, cam.right, cam.top, cam.bottom,
    ].join('|');
  }
  return [
    'p', p.x, p.y, p.z, cam.zoom, cam.fov, cam.aspect, cam.near, cam.far,
  ].join('|');
}

/**
 * Scene rect for bush/tree edge-safety shaders (Foundry Y-down → Three Y-up).
 * During populate, pass `{ preferSnapshot: true }` so a stale `canvas.sceneRect`
 * from the previous scene cannot override the new `foundrySceneData` snapshot.
 * On per-frame sync, live `canvas.sceneRect` wins when present.
 *
 * @param {object|null|undefined} foundrySceneData
 * @param {{ preferSnapshot?: boolean }} [options]
 * @returns {{ minX: number, minY: number, maxX: number, maxY: number }|null}
 */
export function resolveVegetationEdgeSafetyBounds(foundrySceneData = null, options = {}) {
  const preferSnapshot = options.preferSnapshot === true;
  const fd = foundrySceneData && typeof foundrySceneData === 'object' ? foundrySceneData : {};
  const dims = typeof canvas !== 'undefined' ? canvas?.dimensions : null;
  const sceneRect = dims?.sceneRect ?? null;
  const canvasHeight = Number(dims?.height) || Number(fd.height) || 0;

  const fdSceneW = Number(fd.sceneWidth) || Number(fd.width) || 0;
  const fdSceneH = Number(fd.sceneHeight) || Number(fd.height) || 0;
  const hasSnapshotRect = fdSceneW > 0 && fdSceneH > 0;

  let sceneX = Number(fd.sceneX ?? 0) || 0;
  let sceneY = Number(fd.sceneY ?? 0) || 0;
  let sceneW = fdSceneW;
  let sceneH = fdSceneH;

  if (preferSnapshot && hasSnapshotRect) {
    // Keep populate snapshot values (see module doc).
  } else if (sceneRect) {
    const rx = Number(sceneRect.x ?? 0);
    const ry = Number(sceneRect.y ?? 0);
    const rw = Number(sceneRect.width ?? 0);
    const rh = Number(sceneRect.height ?? 0);
    if (rw > 0 && rh > 0) {
      sceneX = rx;
      sceneY = ry;
      sceneW = rw;
      sceneH = rh;
    }
  }

  if (!(sceneW > 0) || !(sceneH > 0)) {
    const cw = Number(dims?.width) || 0;
    const ch = Number(dims?.height) || 0;
    if (!(sceneW > 0) && cw > 0) sceneW = cw;
    if (!(sceneH > 0) && ch > 0) sceneH = ch;
  }

  if (!(canvasHeight > 0) || !(sceneW > 0) || !(sceneH > 0)) return null;

  const minY = canvasHeight - (sceneY + sceneH);
  const maxY = canvasHeight - sceneY;
  return {
    minX: sceneX,
    minY,
    maxX: sceneX + sceneW,
    maxY,
  };
}

/**
 * @param {{ minX: number, minY: number, maxX: number, maxY: number }|null|undefined} bounds
 * @returns {string}
 */
export function vegetationEdgeSafetyBoundsSignature(bounds) {
  if (!bounds) return '';
  return `${bounds.minX}|${bounds.minY}|${bounds.maxX}|${bounds.maxY}`;
}
