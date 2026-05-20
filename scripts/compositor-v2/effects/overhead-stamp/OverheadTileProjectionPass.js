/**
 * @fileoverview Tile shadow projection capture (alpha + sort) without scene traversals.
 */

import { SceneCaptureScope } from './SceneCaptureScope.js';

/**
 * @param {import('three').Object3D} object
 * @param {number} sortMin
 * @param {number} sortRange
 * @returns {number}
 */
function encodeTileSort(object, sortMin, sortRange) {
  const raw = Number(
    object?.userData?._msSortKey
    ?? object?.userData?.tileDoc?.sort
    ?? object?.userData?.tileDoc?.z
    ?? 0
  );
  const key = Number.isFinite(raw) ? raw : 0;
  const min = Number.isFinite(sortMin) ? sortMin : 0;
  const range = Number.isFinite(sortRange) && sortRange > 0.00001 ? sortRange : 1.0;
  return Math.max(0, Math.min(1, (key - min) / range));
}

export class OverheadTileProjectionPass {
  constructor() {
    this._sortCaptureScene = null;
    this._sortCaptureCamera = null;
    this._sortCaptureMaterial = null;
    this._sortCaptureMesh = null;
    /** @type {WeakMap<import('three').Material, import('three').Material>} */
    this._sortMaterialBackup = new WeakMap();
  }

  _initSortCaptureMaterial() {
    const THREE = window.THREE;
    if (!THREE || this._sortCaptureMaterial) return;
    this._sortCaptureScene = new THREE.Scene();
    this._sortCaptureCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this._sortCaptureMaterial = new THREE.ShaderMaterial({
      uniforms: {
        tMap: { value: null },
        uSortNorm: { value: 0 },
        uOpacity: { value: 1 },
      },
      vertexShader: /* glsl */`
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: /* glsl */`
        uniform sampler2D tMap;
        uniform float uSortNorm;
        uniform float uOpacity;
        varying vec2 vUv;
        void main() {
          float a = clamp(texture2D(tMap, vUv).a * uOpacity, 0.0, 1.0);
          gl_FragColor = vec4(uSortNorm, 0.0, 0.0, a);
        }
      `,
      transparent: true,
      depthWrite: false,
      depthTest: false,
      blending: THREE.NoBlending,
    });
    this._sortCaptureMaterial.toneMapped = false;
  }

  /**
   * @param {import('../OverheadStampEffectV2.js').OverheadStampEffectV2} host
   * @param {import('three').WebGLRenderer} renderer
   * @param {object} ctx
   * @returns {{ hasProjection: boolean, hasProjectionSort: boolean, hasReceiverSort: boolean }}
   */
  render(host, renderer, ctx) {
    const {
      size,
      tileProjectionIds,
      frameCasters,
      baseProjectionPx,
      beginPerfSpan,
      endPerfSpan,
    } = ctx;

    const result = { hasProjection: false, hasProjectionSort: false, hasReceiverSort: false };
    if (!tileProjectionIds?.length
      || !host.tileProjectionTarget
      || !host.tileProjectionSortTarget
      || !host.tileReceiverAlphaTarget
      || !host.tileReceiverSortTarget) {
      return result;
    }

    const scope = new SceneCaptureScope();
    const tileReceiverVisibilityOverrides = [];
    const tileReceiverOpacityOverrides = [];
    const tileProjectionVisibilityOverrides = [];
    const tileProjectionOpacityOverrides = [];
    const sortMaterialSwaps = [];

    let sortMin = Infinity;
    let sortMax = -Infinity;
    const tileEntries = [];
    for (let i = 0, n = frameCasters.list.length; i < n; i++) {
      const entry = frameCasters.list[i];
      if (!entry.isFoundryTile) continue;
      if (!(entry.isSprite || entry.isMesh)) continue;
      tileEntries.push(entry);
      const sk = entry.sortKey ?? 0;
      if (sk < sortMin) sortMin = sk;
      if (sk > sortMax) sortMax = sk;
    }
    if (!Number.isFinite(sortMin) || !Number.isFinite(sortMax)) {
      sortMin = 0;
      sortMax = 1;
    }
    const sortDelta = sortMax - sortMin;
    // V2 bus tiles do not guarantee stable, receiver-comparable sort keys across
    // all render paths. Fail open (no sort gate) so projection is not fully
    // suppressed when sort encoding is inconsistent.
    const canUseSortOcclusion = false;
    const sortRange = canUseSortOcclusion ? sortDelta : 1;
    const idSet = ctx.tileProjectionIdSet;

    const prevMask = host.mainCamera.layers.mask;
    host.mainCamera.layers.enableAll();

    if (canUseSortOcclusion) {
      let perfToken = beginPerfSpan?.('tileProjectionPrep');
      for (const entry of tileEntries) {
        const object = entry.object;
        if (typeof object.visible !== 'boolean') continue;
        tileReceiverVisibilityOverrides.push({ object, visible: object.visible });
        const tileId = entry.tileId;
        const keepVisible = !!(object.visible && tileId && entry.mat);
        scope.pushVisibility(object, keepVisible);
        if (keepVisible && typeof entry.mat.opacity === 'number') {
          tileReceiverOpacityOverrides.push({ object, opacity: entry.mat.opacity });
        }
      }
      endPerfSpan?.(perfToken);

      perfToken = beginPerfSpan?.('tileReceiverAlpha');
      renderer.setRenderTarget(host.tileReceiverAlphaTarget);
      renderer.setClearColor(0x000000, 0);
      renderer.clear();
      renderer.render(host.mainScene, host.mainCamera);
      endPerfSpan?.(perfToken);

      this._initSortCaptureMaterial();
      const THREE = window.THREE;
      for (const entry of tileReceiverOpacityOverrides) {
        const object = entry.object;
        const mat = object?.material;
        if (!mat?.map) continue;
        const sortNorm = encodeTileSort(object, sortMin, sortRange);
        const cap = this._sortCaptureMaterial.clone();
        cap.uniforms.tMap.value = mat.map;
        cap.uniforms.uSortNorm.value = sortNorm;
        cap.uniforms.uOpacity.value = entry.opacity;
        cap.side = mat.side ?? THREE.DoubleSide;
        sortMaterialSwaps.push({ object, mat, cap });
        object.material = cap;
      }
      renderer.setRenderTarget(host.tileReceiverSortTarget);
      renderer.setClearColor(0x000000, 0);
      renderer.clear();
      renderer.render(host.mainScene, host.mainCamera);
      for (const swap of sortMaterialSwaps) {
        swap.object.material = swap.mat;
        swap.cap.dispose();
      }
      sortMaterialSwaps.length = 0;
      result.hasReceiverSort = true;

      for (const entry of tileReceiverOpacityOverrides) {
        if (entry.object?.material && typeof entry.opacity === 'number') {
          entry.object.material.opacity = entry.opacity;
        }
      }
    }

    let perfToken = beginPerfSpan?.('tileContributorPrep');
    for (const entry of tileEntries) {
      const object = entry.object;
      if (typeof object.visible !== 'boolean') continue;
      tileProjectionVisibilityOverrides.push({ object, visible: object.visible });
      const tileId = entry.tileId;
      const keepVisible = !!(entry.isSprite || entry.isMesh) && tileId && idSet.has(String(tileId));
      scope.pushVisibility(object, keepVisible);
      if (keepVisible && typeof entry.mat?.opacity === 'number') {
        scope.pushOpacity(object, 1.0);
        tileProjectionOpacityOverrides.push({ object, opacity: entry.mat.opacity });
      }
    }
    endPerfSpan?.(perfToken);

    const tileProjectionPx = baseProjectionPx * Math.max(Number(host.params.tileProjectionLengthScale) || 0, 0);
    const tileProjectionBlurPx = Math.max(Number(host.params.tileProjectionSoftness) || 0, 0) * 2.0;
    const tileGuardPx = Math.max(24.0, tileProjectionPx + tileProjectionBlurPx + 2.0);
    const tileGuardScaleX = 1.0 + (2.0 * tileGuardPx / Math.max(size.x, 1));
    const tileGuardScaleY = 1.0 + (2.0 * tileGuardPx / Math.max(size.y, 1));
    const tileCaptureScale = Math.max(tileGuardScaleX, tileGuardScaleY);
    const restoreTileCaptureCamera = host._applyRoofCaptureGuardScale(tileCaptureScale);
    if (host.material?.uniforms?.uTileProjectionUvScale) {
      host.material.uniforms.uTileProjectionUvScale.value = 1.0 / Math.max(tileCaptureScale, 1.0);
    }

    try {
      perfToken = beginPerfSpan?.('tileProjectionCapture');
      renderer.setRenderTarget(host.tileProjectionTarget);
      renderer.setClearColor(0x000000, 0);
      renderer.clear();
      renderer.render(host.mainScene, host.mainCamera);
      endPerfSpan?.(perfToken);

      if (canUseSortOcclusion) {
        const THREE = window.THREE;
        for (const entry of tileProjectionOpacityOverrides) {
          const object = entry.object;
          const mat = object?.material;
          if (!mat?.map) continue;
          const sortNorm = encodeTileSort(object, sortMin, sortRange);
          const cap = this._sortCaptureMaterial.clone();
          cap.uniforms.tMap.value = mat.map;
          cap.uniforms.uSortNorm.value = sortNorm;
          cap.uniforms.uOpacity.value = 1.0;
          cap.side = mat.side ?? THREE.DoubleSide;
          sortMaterialSwaps.push({ object, mat, cap });
          object.material = cap;
        }
        renderer.setRenderTarget(host.tileProjectionSortTarget);
        renderer.setClearColor(0x000000, 0);
        renderer.clear();
        renderer.render(host.mainScene, host.mainCamera);
        for (const swap of sortMaterialSwaps) {
          swap.object.material = swap.mat;
          swap.cap.dispose();
        }
        result.hasProjectionSort = true;
      }
    } finally {
      restoreTileCaptureCamera();
      scope.restore();
      host.mainCamera.layers.mask = prevMask;
    }

    result.hasProjection = true;
    return result;
  }

  dispose() {
    try { this._sortCaptureMaterial?.dispose?.(); } catch (_) { /* dispose */ }
    this._sortCaptureMaterial = null;
    this._sortCaptureScene = null;
    this._sortCaptureCamera = null;
  }
}
