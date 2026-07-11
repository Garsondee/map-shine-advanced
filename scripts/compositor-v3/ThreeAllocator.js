/**
 * @fileoverview ThreeAllocator — a {@link FrameGraph} allocator backed by
 * `THREE.WebGLRenderTarget`.
 *
 * Translates the graph's THREE-free {@link ResolvedDescriptor} objects into real
 * GPU render targets, including the **multi-render-target** case used by the
 * floor-attribute buffer (B0-1): three r170 does MRT via the `count` option on a
 * single `WebGLRenderTarget` (the old `WebGLMultipleRenderTargets` class is gone
 * in r170). Per-attachment params (e.g. the attribute attachment wants
 * `NearestFilter` + `NoColorSpace` while the color attachment wants `LinearFilter`)
 * are applied to `rt.textures[i]` after construction.
 *
 * The pure descriptor→params mapping ({@link ThreeAllocator.describe}) is a
 * static, THREE-free function so it can be unit-tested; `create/resize/dispose`
 * are the thin THREE-touching wrappers the graph calls.
 *
 * @module compositor-v3/ThreeAllocator
 */

import { createLogger } from '../core/log.js';

const log = createLogger('V3ThreeAllocator');

/**
 * Resolve a THREE enum from either a THREE namespace value or a passthrough
 * number. Descriptors may carry symbolic strings (`'nearest'`) or raw THREE
 * constants; this keeps the descriptor authorable without importing three.
 * @param {any} THREE
 * @param {string} filter - 'nearest' | 'linear'
 * @returns {number}
 */
function resolveFilter(THREE, filter) {
  return filter === 'nearest' ? THREE.NearestFilter : THREE.LinearFilter;
}

export class ThreeAllocator {
  /**
   * @param {object} [options]
   * @param {any} [options.THREE] - THREE namespace (defaults to `window.THREE`,
   *   matching the codebase convention of a global rather than an ESM import).
   * @param {(handle: any) => void} [options.onCreate] - Optional hook for
   *   diagnostics/budget accounting when a target is allocated.
   */
  constructor(options = {}) {
    this._THREE = options.THREE ?? (typeof window !== 'undefined' ? window.THREE : null);
    this._onCreate = typeof options.onCreate === 'function' ? options.onCreate : null;
  }

  /** @param {any} THREE */
  setTHREE(THREE) { this._THREE = THREE; }

  /**
   * Pure mapping: resolved descriptor → the option object + per-attachment plan.
   * No THREE calls beyond enum lookups; separated so it is testable.
   *
   * @param {any} THREE
   * @param {import('./FrameGraph.js').ResolvedDescriptor} desc
   * @returns {{ width: number, height: number, options: object, attachments: Array<object> }}
   */
  static describe(THREE, desc) {
    const width = Math.max(1, desc.resolvedW | 0);
    const height = Math.max(1, desc.resolvedH | 0);
    const count = Math.max(1, Number(desc.mrtCount) || 1);

    const baseFilter = resolveFilter(THREE, desc.filter ?? 'linear');
    const options = {
      minFilter: baseFilter,
      magFilter: baseFilter,
      format: desc.format ?? THREE.RGBAFormat,
      type: desc.type ?? THREE.UnsignedByteType,
      depthBuffer: desc.depth === true,
      stencilBuffer: false,
    };
    if (count > 1) options.count = count;
    if (desc.colorSpace != null) options.colorSpace = desc.colorSpace;

    // Per-attachment overrides (index 0 is the primary color attachment).
    // `desc.attachments[i]` may set { filter, type, colorSpace } for texture i.
    const attachments = [];
    const src = Array.isArray(desc.attachments) ? desc.attachments : [];
    for (let i = 0; i < count; i++) {
      const a = src[i] ?? null;
      if (!a) { attachments.push(null); continue; }
      const plan = {};
      if (a.filter != null) {
        plan.minFilter = resolveFilter(THREE, a.filter);
        plan.magFilter = plan.minFilter;
      }
      if (a.type != null) plan.type = a.type;
      if (a.colorSpace != null) plan.colorSpace = a.colorSpace;
      attachments.push(Object.keys(plan).length ? plan : null);
    }
    return { width, height, options, attachments };
  }

  /**
   * @param {string} name
   * @param {import('./FrameGraph.js').ResolvedDescriptor} desc
   * @returns {THREE.WebGLRenderTarget}
   */
  create(name, desc) {
    const THREE = this._THREE;
    if (!THREE || typeof THREE.WebGLRenderTarget !== 'function') {
      throw new Error(`ThreeAllocator.create("${name}"): window.THREE unavailable`);
    }
    const { width, height, options, attachments } = ThreeAllocator.describe(THREE, desc);
    const rt = new THREE.WebGLRenderTarget(width, height, options);
    rt.name = `v3:${name}`;

    // Apply per-attachment overrides. `rt.textures` exists for count>1; for a
    // single attachment fall back to `rt.texture`.
    const textures = Array.isArray(rt.textures) && rt.textures.length ? rt.textures : [rt.texture];
    for (let i = 0; i < attachments.length && i < textures.length; i++) {
      const plan = attachments[i];
      const tex = textures[i];
      if (!plan || !tex) continue;
      if (plan.minFilter != null) tex.minFilter = plan.minFilter;
      if (plan.magFilter != null) tex.magFilter = plan.magFilter;
      if (plan.type != null) tex.type = plan.type;
      if (plan.colorSpace != null) tex.colorSpace = plan.colorSpace;
      tex.name = `v3:${name}:${i}`;
    }

    if (this._onCreate) {
      try { this._onCreate(rt); } catch (_) {}
    }
    log.debug(`allocated ${rt.name} ${width}x${height}${options.count ? ` mrt=${options.count}` : ''}`);
    return rt;
  }

  /**
   * @param {THREE.WebGLRenderTarget} handle
   * @param {number} w
   * @param {number} h
   */
  resize(handle, w, h) {
    if (!handle || typeof handle.setSize !== 'function') return;
    handle.setSize(Math.max(1, w | 0), Math.max(1, h | 0));
  }

  /** @param {THREE.WebGLRenderTarget} handle */
  dispose(handle) {
    try { handle?.dispose?.(); } catch (_) {}
  }
}
