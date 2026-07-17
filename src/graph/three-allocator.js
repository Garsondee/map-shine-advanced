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
 * THE LAW (Keyhole.md §0, §4.6): nothing is ever allocated at world resolution.
 * Not a budget we police — an architectural impossibility, enforced here. Any
 * FrameGraph-declared RT wider or taller than this throws at the call site,
 * with a stack, in dev — not a context loss in the field three weeks later.
 *
 * The virtual-texture page atlas itself never goes through this allocator (it's
 * a THREE.DataArrayTexture allocated once, directly, by vt/atlas.js — not a
 * per-frame graph resource), so it needs no exemption. The only legitimate
 * exceptions are named in the plan: fog exploration (capped ≤ 2048² anyway) and
 * the present chain's native-resolution upscale target. Both must opt in
 * explicitly per-descriptor — there is no name-string whitelist to silently
 * extend.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS FILE WAS AUDITED 2026-07-17 — the law was NOT installed
 *
 * This module had **zero callers**. Keyhole is *named* for the law it enforces,
 * and the law was a unit-tested function nobody called. That alone is only
 * "the rooms aren't built yet" — no pass allocates a target, so there was
 * genuinely nothing to route. The real defect was worse, and it is the reason
 * this comment exists:
 *
 *   **The law was BROKEN AT FIRST TOUCH.** `new ThreeAllocator()` defaulted its
 *   THREE namespace to `window.THREE` — a global this codebase never sets (boot
 *   imports THREE as an ES module from src/vendor/). So the first session ever
 *   to reach for the law would get `"window.THREE unavailable"`, an error about
 *   a global that does not exist and was never supposed to, on a module whose
 *   tests were all green — because the tests inject a MOCK THREE and never
 *   exercised the default.
 *
 * That is exactly how `EffectComposer` lost (memory:
 * v2-postmortem-the-failure-modes). Not by being wrong — by being *harder than
 * the alternative on the afternoon someone needed it*. A session under pressure
 * hits a broken wall, writes `new THREE.RenderTarget(...)` instead, and the law
 * is optional forever after. Skeleton.md §0 law 2: **the wall must be
 * frictionless, or it loses.** A wall that is broken when you reach it is not a
 * wall, it is a dare.
 *
 * Fixed by ENFORCEMENT BY ABSENCE (Skeleton.md §1, L0): there is no global
 * fallback to be stale. THREE is a required constructor argument. You cannot
 * build an allocator that cannot allocate.
 *
 * The wall that makes calling this NON-OPTIONAL is `gpu/allocator-only` in
 * tools/verify-structure.mjs — `new *RenderTarget(` outside this file fails the
 * build. It was designed in Skeleton.md §2.3 and never built; it sits at ZERO
 * today, which is the cheapest moment to build a wall and does not come twice.
 */
export const LAW_MAX_WORLD_RES_DIM = 2048;

/**
 * An absolute sanity ceiling for a `screenSized` target. No real drawing buffer
 * is this large (an 8K display is 7680 wide); a `screenSized` request above it
 * means a WORLD dimension reached this call by mistake — which is the exact
 * thing the law exists to catch, so it still throws.
 */
export const LAW_MAX_SCREEN_DIM = 8192;

/**
 * @param {string} name
 * @param {number} width
 * @param {number} height
 * @param {import('./frame-graph.js').ResolvedDescriptor} desc
 */
function enforceKeyholeLaw(name, width, height, desc) {
  if (desc && desc.allowWorldScale === true) return; // explicit, rare, opt-in only

  // SCREEN-SIZED IS NOT A VIOLATION — it is the GOAL (added 2026-07-17, the
  // first time the law met its first real caller).
  //
  // §0's law is "nothing is ever allocated at WORLD resolution": the cost model
  // must be O(screen), never O(world × floors × masks). A flat 2048 cap is a
  // PROXY for that, and the proxy is wrong in one direction — it reads "big" as
  // "world-res". A 2239×1271 scene buffer on an ordinary monitor is O(screen).
  // It is not a violation of the law; it is the law being obeyed.
  //
  // Left unfixed, the very first honest caller (`scene.color`, so effects have
  // somewhere to draw) would have been rejected by the law it satisfies — and
  // the only escape hatch on offer was `allowWorldScale: true`, which would have
  // been a LIE about what a screen buffer is, and would have taught every later
  // session that world-scale allocations are a formality to wave through. §4.6's
  // own text already names "the present chain's native-resolution upscale
  // target" as legitimate; this makes that sanctioned path say what it means.
  //
  // The distinction the two flags draw, and it is the whole point:
  //   screenSized     — sized FROM THE DRAWING BUFFER. Cost scales with the
  //                     player's monitor, never with the map. Always allowed
  //                     (up to LAW_MAX_SCREEN_DIM, which catches a typo'd world
  //                     dimension). This is the normal case for frame-graph RTs.
  //   allowWorldScale — sized from the WORLD, and knowingly so. Rare, and each
  //                     one is a named exception in the plan (fog exploration,
  //                     capped ≤2048² anyway). Adding one is a design decision,
  //                     not a build fix.
  // A descriptor that is neither may not exceed 2048px in any dimension.
  if (desc && desc.screenSized === true) {
    if (width > LAW_MAX_SCREEN_DIM || height > LAW_MAX_SCREEN_DIM) {
      throw new Error(
        `[Keyhole law] ThreeAllocator.create("${name}"): ${width}x${height} is declared ` +
          `{ screenSized: true } but exceeds ${LAW_MAX_SCREEN_DIM}px — no real drawing buffer is ` +
          `that large, so this is a WORLD dimension that reached a screen-sized allocation by ` +
          `mistake. That is exactly what the law is for (Keyhole.md §0, §4.6).`
      );
    }
    return;
  }

  if (width > LAW_MAX_WORLD_RES_DIM || height > LAW_MAX_WORLD_RES_DIM) {
    throw new Error(
      `[Keyhole law] ThreeAllocator.create("${name}"): ${width}x${height} exceeds the ` +
        `${LAW_MAX_WORLD_RES_DIM}px world-resolution cap (Keyhole.md §4.6). Nothing is ever ` +
        `allocated at world resolution.\n` +
        `  • Is this sized from the DRAWING BUFFER (a frame-graph RT, the present chain)? ` +
        `Pass { screenSized: true } — that is O(screen) and always allowed.\n` +
        `  • Is it genuinely sized from the WORLD (fog exploration)? Pass ` +
        `{ allowWorldScale: true } — rare, named in the plan, a design decision.\n` +
        `  • Neither? Then this is the crash class Keyhole exists to end: 470–580 MB per ` +
        `drawing-buffer megapixel against a ~1.6 GB ceiling (§1). Never widen the cap globally.`
    );
  }
}

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
   * @param {object} options
   * @param {any} options.THREE - **REQUIRED.** The THREE namespace, handed in.
   *   There is deliberately NO `window.THREE` fallback: this used to default to
   *   a global the codebase never sets, so the law's first-ever caller would
   *   have hit `"window.THREE unavailable"` and routed around it. A wall that is
   *   broken when you reach it is a dare, not a wall (see the header). Handing
   *   it in is one argument at the one construction site; a stale global is a
   *   silent failure at every call site forever.
   * @param {(handle: any) => void} [options.onCreate] - Optional hook for
   *   diagnostics/budget accounting when a target is allocated.
   */
  constructor(options = {}) {
    if (!options.THREE) {
      throw new Error(
        'ThreeAllocator: options.THREE is required. Hand in the THREE namespace ' +
          "(`import * as THREE from '../vendor/three/three.webgpu.js'`). There is no " +
          'window.THREE in this codebase and no fallback to one — a global that can go ' +
          'stale is how the law would silently stop being enforced (Keyhole.md §4.6).'
      );
    }
    this._THREE = options.THREE;
    this._onCreate = typeof options.onCreate === 'function' ? options.onCreate : null;
  }

  /**
   * Pure mapping: resolved descriptor → the option object + per-attachment plan.
   * No THREE calls beyond enum lookups; separated so it is testable.
   *
   * @param {any} THREE
   * @param {import('./frame-graph.js').ResolvedDescriptor} desc
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
      if (!a) {
        attachments.push(null);
        continue;
      }
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
   * @param {import('./frame-graph.js').ResolvedDescriptor} desc
   * @returns {THREE.WebGLRenderTarget}
   */
  create(name, desc) {
    const THREE = this._THREE;
    if (typeof THREE.WebGLRenderTarget !== 'function') {
      throw new Error(
        `ThreeAllocator.create("${name}"): the THREE namespace handed to this allocator has no ` +
          'WebGLRenderTarget. (Under the WebGPU build it is still there and still correct — ' +
          '`WebGLRenderTarget extends RenderTarget`, adding only an `isWebGLRenderTarget` flag; ' +
          'verified against src/vendor/three/three.webgpu.js:5003 before this was wired.)'
      );
    }
    const { width, height, options, attachments } = ThreeAllocator.describe(THREE, desc);
    enforceKeyholeLaw(name, width, height, desc);
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
      // Reported, never swallowed: a broken accounting hook must not take down a
      // real allocation, but it must not be invisible either. V2 had 2,670 empty
      // catches — one silent swallow per ~140 lines — which is how the rot stayed
      // invisible until it crashed (memory: feedback_instruments_must_not_lie).
      try {
        this._onCreate(rt);
      } catch (err) {
        log.error(`onCreate hook threw for ${rt.name} — allocation kept, accounting lost`, err);
      }
    }
    log.debug(`allocated ${rt.name} ${width}x${height}${options.count ? ` mrt=${options.count}` : ''}`);
    return rt;
  }

  /**
   * @param {THREE.WebGLRenderTarget} handle
   * @param {number} w
   * @param {number} h
   * @param {import('./frame-graph.js').ResolvedDescriptor} [desc] - pass the
   *   owning descriptor so a resize storm can't smuggle a world-res target
   *   past the law that `create()` already enforced.
   */
  resize(handle, w, h, desc) {
    if (!handle || typeof handle.setSize !== 'function') return;
    const width = Math.max(1, w | 0);
    const height = Math.max(1, h | 0);
    enforceKeyholeLaw(handle.name || '(resize)', width, height, desc);
    handle.setSize(width, height);
  }

  /** @param {THREE.WebGLRenderTarget} handle */
  dispose(handle) {
    try {
      handle?.dispose?.();
    } catch (err) {
      // A dispose that throws is a VRAM leak, which is this project's entire
      // crash class (§1: ~1.6GB ceiling). Never silent.
      log.error(`dispose threw for ${handle?.name ?? '(unnamed)'} — GPU memory may be leaked`, err);
    }
  }
}
