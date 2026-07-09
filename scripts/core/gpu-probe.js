/**
 * @fileoverview Best-effort GPU identification and VRAM estimation from the
 * WebGL renderer string (`WEBGL_debug_renderer_info` -> `UNMASKED_RENDERER_WEBGL`).
 *
 * The "auto" GPU VRAM budget historically inferred VRAM from *system RAM*
 * (`navigator.deviceMemory`). That is wrong for the common case of a laptop
 * with 16 GB RAM and an 8 GB discrete GPU: the module assumes 16 GB VRAM and
 * every crash guardrail (load-slim, streaming burst caps, budget caps) stays
 * disarmed, so a scene loads the full effect stack and spikes the card until
 * the WebGL context is lost.
 *
 * This probe reads the actual GPU name once, maps it to an estimated VRAM tier,
 * and lets {@link module:streaming/memory-settings} cap the auto budget to what
 * the card can actually hold. When the GPU cannot be identified we deliberately
 * refuse to assume more than 8 GB.
 *
 * @module core/gpu-probe
 */

import { createLogger } from './log.js';

const log = createLogger('GpuProbe');

/**
 * @typedef {object} GpuProbeResult
 * @property {string|null} renderer Unmasked renderer string (or masked fallback).
 * @property {string|null} vendor Unmasked vendor string (or masked fallback).
 * @property {number|null} estimatedVramGB Estimated dedicated VRAM in GB, or null when unknown.
 * @property {boolean} confident True when the GPU name matched a known model.
 * @property {'unmasked'|'masked'|'none'} source How the renderer string was obtained.
 */

/** @type {GpuProbeResult|null} */
let _result = null;
let _probed = false;

/**
 * Read the GPU renderer/vendor strings. Prefers the provided live WebGL context;
 * otherwise creates a short-lived throwaway context.
 * @param {WebGLRenderingContext|WebGL2RenderingContext|null} [gl]
 * @returns {{ renderer: string|null, vendor: string|null, source: 'unmasked'|'masked'|'none' }}
 * @private
 */
function _readRendererStrings(gl = null) {
  let context = gl;
  let throwaway = null;
  try {
    if (!context && typeof document !== 'undefined') {
      throwaway = document.createElement('canvas');
      context = throwaway.getContext('webgl2') || throwaway.getContext('webgl');
    }
    if (!context) return { renderer: null, vendor: null, source: 'none' };

    let renderer = null;
    let vendor = null;
    let source = 'masked';
    try {
      const dbg = context.getExtension('WEBGL_debug_renderer_info');
      if (dbg) {
        renderer = context.getParameter(dbg.UNMASKED_RENDERER_WEBGL) || null;
        vendor = context.getParameter(dbg.UNMASKED_VENDOR_WEBGL) || null;
        if (renderer) source = 'unmasked';
      }
    } catch (_) {}
    if (!renderer) {
      try { renderer = context.getParameter(context.RENDERER) || null; } catch (_) {}
    }
    if (!vendor) {
      try { vendor = context.getParameter(context.VENDOR) || null; } catch (_) {}
    }
    return { renderer, vendor, source: renderer ? source : 'none' };
  } catch (_) {
    return { renderer: null, vendor: null, source: 'none' };
  } finally {
    if (throwaway && context) {
      try { context.getExtension('WEBGL_lose_context')?.loseContext?.(); } catch (_) {}
    }
  }
}

/**
 * Estimate dedicated VRAM (GB) from a renderer string. Conservative: returns
 * `{ gb: null }` for anything not confidently recognised so callers can fall
 * back to a safe default rather than over-committing VRAM.
 * @param {string|null} rendererRaw
 * @returns {{ gb: number|null, confident: boolean }}
 * @private
 */
function _estimateVramGB(rendererRaw) {
  const s = String(rendererRaw || '').toLowerCase();
  if (!s) return { gb: null, confident: false };

  // Integrated / shared-memory GPUs: no dedicated VRAM, treat as a low tier.
  if (/intel/.test(s) && /(uhd|hd graphics|iris|\bxe\b|integrated)/.test(s)) {
    return { gb: 4, confident: true };
  }
  if (/(vega \d\b|radeon\(tm\) graphics|amd radeon graphics)/.test(s) && !/rx /.test(s)) {
    return { gb: 4, confident: true };
  }
  if (/apple m\d/.test(s)) {
    // Unified memory — the GPU-visible share is large but not all of it is safe
    // to treat as VRAM. Stay conservative and unconfident.
    return { gb: 8, confident: false };
  }

  // NVIDIA GeForce RTX 40-series
  if (/rtx 40?90/.test(s)) return { gb: 24, confident: true };
  if (/rtx 40?80/.test(s)) return { gb: 16, confident: true };
  if (/rtx 40?70/.test(s)) return { gb: 12, confident: true };
  if (/rtx 40?60/.test(s)) return { gb: 8, confident: true };
  if (/rtx 40?50/.test(s)) return { gb: 6, confident: true };
  // NVIDIA GeForce RTX 30-series
  if (/rtx 30?90/.test(s)) return { gb: 24, confident: true };
  if (/rtx 30?80 ti/.test(s)) return { gb: 12, confident: true };
  if (/rtx 30?80/.test(s)) return { gb: 10, confident: true };
  if (/rtx 30?70/.test(s)) return { gb: 8, confident: true };
  if (/rtx 30?60 ti/.test(s)) return { gb: 8, confident: true };
  if (/rtx 30?60/.test(s)) return { gb: 12, confident: true };
  if (/rtx 30?50/.test(s)) return { gb: 8, confident: true };
  // NVIDIA GeForce RTX 20-series
  if (/rtx 20?80 ti/.test(s)) return { gb: 11, confident: true };
  if (/rtx 20?80/.test(s)) return { gb: 8, confident: true };
  if (/rtx 20?70/.test(s)) return { gb: 8, confident: true };
  if (/rtx 20?60/.test(s)) return { gb: 6, confident: true };
  // NVIDIA GTX 16-series
  if (/gtx 16?60/.test(s)) return { gb: 6, confident: true };
  if (/gtx 16?50/.test(s)) return { gb: 4, confident: true };
  // NVIDIA GTX 10-series
  if (/gtx 10?80 ti/.test(s)) return { gb: 11, confident: true };
  if (/gtx 10?80/.test(s)) return { gb: 8, confident: true };
  if (/gtx 10?70/.test(s)) return { gb: 8, confident: true };
  if (/gtx 10?60/.test(s)) return { gb: 6, confident: true };
  if (/gtx 10?50 ti/.test(s)) return { gb: 4, confident: true };
  if (/gtx 10?50/.test(s)) return { gb: 2, confident: true };

  // AMD Radeon RX 7000
  if (/rx 79\d\d/.test(s)) return { gb: 20, confident: true };
  if (/rx 78\d\d/.test(s)) return { gb: 16, confident: true };
  if (/rx 77\d\d/.test(s)) return { gb: 12, confident: true };
  if (/rx 76\d\d/.test(s)) return { gb: 8, confident: true };
  // AMD Radeon RX 6000
  if (/rx 69\d\d|rx 68\d\d/.test(s)) return { gb: 16, confident: true };
  if (/rx 67\d\d/.test(s)) return { gb: 12, confident: true };
  if (/rx 66\d\d/.test(s)) return { gb: 8, confident: true };
  if (/rx 65\d\d/.test(s)) return { gb: 4, confident: true };
  // AMD Radeon RX 5000
  if (/rx 57\d\d/.test(s)) return { gb: 8, confident: true };
  if (/rx 56\d\d/.test(s)) return { gb: 6, confident: true };
  if (/rx 55\d\d/.test(s)) return { gb: 4, confident: true };
  // AMD Radeon RX 400/500
  if (/rx 5[78]0/.test(s)) return { gb: 8, confident: true };
  if (/rx 5[56]0/.test(s)) return { gb: 4, confident: true };

  return { gb: null, confident: false };
}

/**
 * Probe the GPU once (cached). Safe to call repeatedly.
 * @param {WebGLRenderingContext|WebGL2RenderingContext|null} [gl] Live context (optional).
 * @returns {GpuProbeResult}
 */
export function probeGpu(gl = null) {
  // If a previous probe only had a masked/none result and we now have a live
  // context, re-probe once to try for the unmasked string.
  if (_probed && _result && (_result.source === 'unmasked' || !gl)) {
    return _result;
  }

  const { renderer, vendor, source } = _readRendererStrings(gl);
  const est = _estimateVramGB(renderer);
  _result = {
    renderer,
    vendor,
    estimatedVramGB: est.gb,
    confident: est.confident,
    source,
  };
  _probed = true;

  try {
    if (typeof window !== 'undefined') {
      window.MapShine = window.MapShine || {};
      window.MapShine.gpuProbe = _result;
    }
  } catch (_) {}

  if (renderer) {
    log.info(
      `GPU probe: "${renderer}" -> estimated `
      + `${est.gb != null ? `${est.gb} GB` : 'unknown'} VRAM`
      + `${est.confident ? '' : ' (low confidence; auto budget capped at 8 GB)'}`,
    );
  } else {
    log.warn('GPU probe: renderer string unavailable — auto VRAM budget capped at 8 GB');
  }
  return _result;
}

/**
 * @returns {GpuProbeResult|null} The cached probe result (probes lazily if needed).
 */
export function getProbedGpuInfo() {
  if (!_probed) {
    try { return probeGpu(); } catch (_) { return null; }
  }
  return _result;
}

/**
 * @returns {number|null} Estimated dedicated VRAM (GB), or null when unknown.
 */
export function getEstimatedGpuVramGB() {
  const r = getProbedGpuInfo();
  return r?.estimatedVramGB ?? null;
}
