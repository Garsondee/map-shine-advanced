/**
 * @fileoverview LevelRenderTargetPool — per-level RT allocation for V2 compositor.
 *
 * Provides a set of render targets (sceneRT, postA, postB) per visible level.
 * RTs are lazily allocated on first access and reused across frames. Levels that
 * are no longer visible can be released to free GPU memory.
 *
 * Per-level targets use `LinearSRGBColorSpace` (constructor option), matching
 * {@link FloorCompositor} and the same “linear working RT” idea as V3 bloom inputs.
 *
 * @module compositor-v2/LevelRenderTargetPool
 */

import { createLogger } from '../core/log.js';

const log = createLogger('LevelRenderTargetPool');

export class LevelRenderTargetPool {
  constructor() {
    /** @type {Map<number, {sceneRT: THREE.WebGLRenderTarget, postA: THREE.WebGLRenderTarget, postB: THREE.WebGLRenderTarget}>} */
    this._pools = new Map();
    this._width = 1;
    this._height = 1;
    /** @type {number|null} THREE texture type (HalfFloatType or UnsignedByteType) */
    this._rtType = null;
    this._initialized = false;
  }

  /**
   * @param {number} width
   * @param {number} height
   * @param {number} rtType - THREE.HalfFloatType or THREE.UnsignedByteType
   */
  initialize(width, height, rtType) {
    this._width = Math.max(1, width);
    this._height = Math.max(1, height);
    this._rtType = rtType;
    this._initialized = true;
  }

  /**
   * Acquire (or reuse) an RT set for the given level index.
   *
   * When a renderer is supplied and a *new* entry is allocated, each RT
   * receives a one-time unscissored full clear to opaque black. This is
   * required for the SceneRectScissor pipeline: subsequent passes write
   * only inside the inner sceneRect, leaving the outer area untouched.
   * Bloom's mip downsample samples the input RT at full UV, so the outer
   * area must contain a known value (not driver-uninitialized memory).
   *
   * @param {number} levelIndex
   * @param {THREE.WebGLRenderer} [renderer]
   * @returns {{sceneRT: THREE.WebGLRenderTarget, postA: THREE.WebGLRenderTarget, postB: THREE.WebGLRenderTarget}|null}
   */
  acquire(levelIndex, renderer = null) {
    const THREE = window.THREE;
    if (!THREE || !this._initialized) return null;

    let entry = this._pools.get(levelIndex);
    if (entry) return entry;

    const makeOpts = (depthBuffer) => ({
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      format: THREE.RGBAFormat,
      type: this._rtType,
      depthBuffer: !!depthBuffer,
      stencilBuffer: false,
      // Same contract as FloorCompositor main RTs / V3 linear working buffers (e.g. bloom input).
      colorSpace: THREE.LinearSRGBColorSpace,
    });

    const sceneRT = new THREE.WebGLRenderTarget(this._width, this._height, makeOpts(true));

    const postA = new THREE.WebGLRenderTarget(this._width, this._height, makeOpts(false));

    const postB = new THREE.WebGLRenderTarget(this._width, this._height, makeOpts(false));

    entry = { sceneRT, postA, postB };
    this._pools.set(levelIndex, entry);
    log.debug(`LevelRenderTargetPool: allocated RTs for level ${levelIndex} (${this._width}x${this._height})`);
    if (renderer) this._clearTargetsToBlack(renderer, entry);
    return entry;
  }

  /**
   * Unscissored full clear of one or more RTs to opaque black. Used to
   * pre-fill outer-rect (padded zone + outer black region) pixels with a
   * known value before the SceneRectScissor pipeline starts writing only
   * inside the inner sceneRect.
   *
   * @param {THREE.WebGLRenderer} renderer
   * @param {{sceneRT: THREE.WebGLRenderTarget, postA: THREE.WebGLRenderTarget, postB: THREE.WebGLRenderTarget}} entry
   * @private
   */
  _clearTargetsToBlack(renderer, entry) {
    if (!renderer || !entry) return;
    const THREE = window.THREE;
    const prevTarget = renderer.getRenderTarget?.();
    const prevAutoClear = renderer.autoClear;
    const prevScissor = (typeof renderer.getScissorTest === 'function')
      ? renderer.getScissorTest()
      : null;
    const prevColor = (THREE && typeof renderer.getClearColor === 'function')
      ? renderer.getClearColor(new THREE.Color())
      : null;
    const prevAlpha = (typeof renderer.getClearAlpha === 'function')
      ? renderer.getClearAlpha()
      : null;

    try {
      if (typeof renderer.setScissorTest === 'function') renderer.setScissorTest(false);
      if (typeof renderer.setClearColor === 'function') renderer.setClearColor(0x000000, 1);
      if (typeof renderer.setClearAlpha === 'function') renderer.setClearAlpha(1);
      renderer.autoClear = true;
      for (const rt of [entry.sceneRT, entry.postA, entry.postB]) {
        if (!rt) continue;
        renderer.setRenderTarget(rt);
        if (typeof renderer.clear === 'function') {
          renderer.clear(true, true, true);
        }
      }
    } catch (err) {
      log.warn('LevelRenderTargetPool: pre-clear failed:', err);
    } finally {
      renderer.autoClear = prevAutoClear;
      try {
        if (prevColor && typeof renderer.setClearColor === 'function') {
          renderer.setClearColor(prevColor, prevAlpha != null ? prevAlpha : 1);
        }
      } catch (_) {}
      try {
        if (prevAlpha != null && typeof renderer.setClearAlpha === 'function') {
          renderer.setClearAlpha(prevAlpha);
        }
      } catch (_) {}
      try {
        if (prevScissor != null && typeof renderer.setScissorTest === 'function') {
          renderer.setScissorTest(prevScissor);
        }
      } catch (_) {}
      try {
        if (typeof renderer.setRenderTarget === 'function') {
          renderer.setRenderTarget(prevTarget ?? null);
        }
      } catch (_) {}
    }
  }

  /**
   * Release RTs for levels not in the active set, freeing GPU memory.
   * @param {Set<number>} activeLevels - set of level indices to keep
   */
  releaseStale(activeLevels) {
    for (const [idx, entry] of this._pools) {
      if (!activeLevels.has(idx)) {
        try { entry.sceneRT?.dispose(); } catch (_) {}
        try { entry.postA?.dispose(); } catch (_) {}
        try { entry.postB?.dispose(); } catch (_) {}
        this._pools.delete(idx);
        log.debug(`LevelRenderTargetPool: released RTs for level ${idx}`);
      }
    }
  }

  /** @returns {number} current number of allocated level RT sets */
  get allocatedCount() {
    return this._pools.size;
  }

  /**
   * Resize all allocated RTs. Optionally re-clears each entry to opaque
   * black so the SceneRectScissor pipeline doesn't read driver-
   * uninitialized memory in the outer-rect area after a reallocation.
   *
   * @param {number} width
   * @param {number} height
   * @param {THREE.WebGLRenderer} [renderer]
   */
  onResize(width, height, renderer = null) {
    this._width = Math.max(1, width);
    this._height = Math.max(1, height);
    for (const [, entry] of this._pools) {
      try { entry.sceneRT?.setSize(this._width, this._height); } catch (_) {}
      try { entry.postA?.setSize(this._width, this._height); } catch (_) {}
      try { entry.postB?.setSize(this._width, this._height); } catch (_) {}
      if (renderer) this._clearTargetsToBlack(renderer, entry);
    }
  }

  dispose() {
    for (const [, entry] of this._pools) {
      try { entry.sceneRT?.dispose(); } catch (_) {}
      try { entry.postA?.dispose(); } catch (_) {}
      try { entry.postB?.dispose(); } catch (_) {}
    }
    this._pools.clear();
    this._initialized = false;
    log.debug('LevelRenderTargetPool: disposed');
  }
}
