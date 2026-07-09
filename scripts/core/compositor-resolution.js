/**
 * @fileoverview Compositor display vs internal render resolution (DRS).
 *
 * Display resolution drives the canvas backing store and late overlays.
 * Internal resolution drives the compositor RT stack (VRAM-budgeted).
 * When internal < display, PresentationUpscalePass (FSR-1 EASU) presents to screen.
 *
 * @module core/compositor-resolution
 */

import { resolveMaxDrawingBufferMp } from '../streaming/texture-budget-policy.js';

/**
 * @typedef {object} CompositorSizeInfo
 * @property {number} w
 * @property {number} h
 * @property {number} mp
 * @property {number} pixelRatio
 */

/**
 * @typedef {object} CompositorResolutionSnapshot
 * @property {CompositorSizeInfo} display
 * @property {CompositorSizeInfo} internal
 * @property {number} internalScale Ratio of internal pixels to display pixels (<= 1).
 * @property {'fsr1'|'off'} upscale
 */

/** @type {CompositorResolutionSnapshot|null} */
let _lastSnapshot = null;

/**
 * Pixel ratio from a render-resolution preset (no VRAM cap).
 * @param {number} viewportWidthCss
 * @param {number} viewportHeightCss
 * @param {number} basePixelRatio
 * @param {string|null|undefined} preset
 * @returns {number}
 */
export function resolveDisplayPixelRatioFromPreset(
  viewportWidthCss,
  viewportHeightCss,
  basePixelRatio,
  preset,
) {
  const base = Math.max(0.1, Number(basePixelRatio) || 1);
  if (!viewportWidthCss || !viewportHeightCss) return base;
  if (!preset || preset === 'native') return base;

  const match = String(preset).match(/^(\d+)x(\d+)$/i);
  if (!match) return base;

  const targetW = Math.max(1, Number(match[1]) || 1);
  const targetH = Math.max(1, Number(match[2]) || 1);
  const prFromW = targetW / viewportWidthCss;
  const prFromH = targetH / viewportHeightCss;
  const desired = Math.min(prFromW, prFromH);
  return Math.max(0.1, Math.min(base, desired));
}

/**
 * Apply load-time and VRAM caps to derive internal pixel ratio.
 * @param {number} displayPixelRatio
 * @param {number} viewportWidthCss
 * @param {number} viewportHeightCss
 * @param {{ applyLoadCap?: (pr: number) => number, applyVramCap?: (pr: number, w: number, h: number) => number }} [caps]
 * @returns {number}
 */
export function resolveInternalPixelRatio(
  displayPixelRatio,
  viewportWidthCss,
  viewportHeightCss,
  caps = {},
) {
  let pr = Math.max(0.1, Number(displayPixelRatio) || 1);
  if (typeof caps.applyLoadCap === 'function') {
    pr = caps.applyLoadCap(pr);
  }
  if (typeof caps.applyVramCap === 'function') {
    pr = caps.applyVramCap(pr, viewportWidthCss, viewportHeightCss);
  }
  return pr;
}

/**
 * Build pixel dimensions from CSS viewport and pixel ratio.
 * @param {number} cssW
 * @param {number} cssH
 * @param {number} pixelRatio
 * @returns {{ w: number, h: number, mp: number, pixelRatio: number }}
 */
export function buildCompositorSize(cssW, cssH, pixelRatio) {
  const pr = Math.max(0.1, Number(pixelRatio) || 1);
  const w = Math.max(1, Math.floor(cssW * pr));
  const h = Math.max(1, Math.floor(cssH * pr));
  return {
    w,
    h,
    mp: (w * h) / 1_000_000,
    pixelRatio: pr,
  };
}

/**
 * Resolve display + internal sizes and cache on MapShine.
 * @param {number} cssW
 * @param {number} cssH
 * @param {number} displayPixelRatio
 * @param {number} internalPixelRatio
 * @returns {CompositorResolutionSnapshot}
 */
export function buildCompositorResolutionSnapshot(
  cssW,
  cssH,
  displayPixelRatio,
  internalPixelRatio,
) {
  const display = buildCompositorSize(cssW, cssH, displayPixelRatio);
  const internal = buildCompositorSize(cssW, cssH, internalPixelRatio);
  const displayMax = Math.max(display.w, display.h);
  const internalMax = Math.max(internal.w, internal.h);
  const internalScale = displayMax > 0 ? internalMax / displayMax : 1;
  const needsUpscale = internal.w < display.w || internal.h < display.h;
  const snapshot = {
    display,
    internal,
    internalScale,
    upscale: needsUpscale && internalScale < 0.95 ? 'fsr1' : 'off',
  };
  _lastSnapshot = snapshot;
  try {
    if (window.MapShine) window.MapShine.compositorResolution = snapshot;
  } catch (_) {}
  return snapshot;
}

/**
 * @returns {CompositorResolutionSnapshot|null}
 */
export function getCompositorResolutionSnapshot() {
  return _lastSnapshot;
}

/**
 * Internal compositor render size in pixels (for RT allocation).
 * Falls back to renderer drawing-buffer size during early bootstrap.
 * @param {THREE.WebGLRenderer} [renderer]
 * @returns {{ w: number, h: number }}
 */
export function getCompositorInternalSize(renderer = null) {
  const cached = _lastSnapshot?.internal;
  if (cached?.w > 0 && cached?.h > 0) {
    return { w: cached.w, h: cached.h };
  }
  try {
    const fc = window.MapShine?.floorCompositorV2;
    if (fc?._internalW > 0 && fc?._internalH > 0) {
      return { w: fc._internalW, h: fc._internalH };
    }
  } catch (_) {}
  try {
    const THREE = window.THREE;
    if (renderer?.getDrawingBufferSize && THREE) {
      const v = new THREE.Vector2();
      renderer.getDrawingBufferSize(v);
      const w = Math.max(1, Math.floor(v.x || v.width || 1));
      const h = Math.max(1, Math.floor(v.y || v.height || 1));
      return { w, h };
    }
  } catch (_) {}
  return { w: 1, h: 1 };
}

/**
 * Write internal dimensions into a Three.js Vector2 (or compatible).
 * @param {THREE.WebGLRenderer} renderer
 * @param {{ set?: (x: number, y: number) => void, x?: number, y?: number }} target
 * @returns {{ w: number, h: number }}
 */
export function writeCompositorInternalSize(renderer, target) {
  const { w, h } = getCompositorInternalSize(renderer);
  if (target && typeof target.set === 'function') {
    target.set(w, h);
  } else if (target) {
    target.x = w;
    target.y = h;
  }
  return { w, h };
}

/**
 * Max drawing-buffer megapixels allowed for internal compositor RTs.
 * @returns {number}
 */
export function getInternalRenderBudgetMp() {
  return resolveMaxDrawingBufferMp();
}
