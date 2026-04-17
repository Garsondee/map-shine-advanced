/**
 * @fileoverview LevelRenderTargetPool — per-level RT allocation for V2 compositor.
 *
 * Provides a set of render targets (sceneRT, postA, postB) per visible level.
 * RTs are lazily allocated on first access and reused across frames. Levels that
 * are no longer visible can be released to free GPU memory.
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
   * @param {number} levelIndex
   * @returns {{sceneRT: THREE.WebGLRenderTarget, postA: THREE.WebGLRenderTarget, postB: THREE.WebGLRenderTarget}|null}
   */
  acquire(levelIndex) {
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
    });

    const sceneRT = new THREE.WebGLRenderTarget(this._width, this._height, makeOpts(true));
    sceneRT.texture.colorSpace = THREE.LinearSRGBColorSpace;

    const postA = new THREE.WebGLRenderTarget(this._width, this._height, makeOpts(false));
    postA.texture.colorSpace = THREE.LinearSRGBColorSpace;

    const postB = new THREE.WebGLRenderTarget(this._width, this._height, makeOpts(false));
    postB.texture.colorSpace = THREE.LinearSRGBColorSpace;

    entry = { sceneRT, postA, postB };
    this._pools.set(levelIndex, entry);
    log.debug(`LevelRenderTargetPool: allocated RTs for level ${levelIndex} (${this._width}x${this._height})`);
    return entry;
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
   * Resize all allocated RTs.
   * @param {number} width
   * @param {number} height
   */
  onResize(width, height) {
    this._width = Math.max(1, width);
    this._height = Math.max(1, height);
    for (const [, entry] of this._pools) {
      try { entry.sceneRT?.setSize(this._width, this._height); } catch (_) {}
      try { entry.postA?.setSize(this._width, this._height); } catch (_) {}
      try { entry.postB?.setSize(this._width, this._height); } catch (_) {}
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
