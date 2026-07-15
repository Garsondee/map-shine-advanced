/**
 * @fileoverview GPU capability detection for Map Shine Advanced
 * @module core/capabilities
 */

import { createLogger } from './log.js';

const log = createLogger('Capabilities');

/** @param {number} ms @returns {Promise<void>} */
function _sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Probe once for a WebGL2 (then WebGL1) context on a throwaway 1×1 canvas.
 *
 * IMPORTANT: Use a minimal 1x1 canvas and explicitly release the context after
 * probing. Leaked WebGL contexts exhaust the browser's context limit (typically
 * 8-16), causing other contexts (e.g. PIXI's) to be evicted with a "WebGL
 * context was lost" error that freezes the loading screen.
 *
 * @returns {{ webgl2: boolean, webgl: boolean }}
 */
function _probeOnce() {
  const result = { webgl2: false, webgl: false };
  let probeCanvas = null;
  try {
    probeCanvas = document.createElement('canvas');
    probeCanvas.width = 1;
    probeCanvas.height = 1;

    const gl2 = probeCanvas.getContext('webgl2');
    result.webgl2 = !!gl2;
    if (gl2) {
      log.debug('WebGL2 context created successfully');
      const loseCtx = gl2.getExtension('WEBGL_lose_context');
      if (loseCtx) loseCtx.loseContext();
    }

    // Check WebGL 1.0 availability (only if WebGL2 failed)
    if (!result.webgl2) {
      const gl = probeCanvas.getContext('webgl') || probeCanvas.getContext('experimental-webgl');
      result.webgl = !!gl;
      if (gl) {
        log.debug('WebGL 1.0 context created successfully');
        const loseCtx = gl.getExtension('WEBGL_lose_context');
        if (loseCtx) loseCtx.loseContext();
      }
    }
  } catch (err) {
    // getContext can throw in hardened/soft-blocklisted configs; treat as "no
    // context this attempt" and let the retry loop decide.
    log.debug('WebGL probe attempt threw', err);
  } finally {
    try { probeCanvas?.remove(); } catch (_) {}
  }
  return result;
}

/**
 * Detect GPU capabilities and determine rendering tier.
 *
 * **Retries the context probe before concluding tier `'none'`.** A single
 * failed probe is NOT proof the GPU can't render: right after a driver watchdog
 * reset (TDR) — the exact moment the crash-recovery path calls this to rebuild —
 * the driver is still settling and/or the lost context's slot has not been
 * freed, so `getContext('webgl2')` transiently returns null. The old one-shot
 * probe treated that as "no compatible GPU," aborted the rebuild, and told the
 * user to refresh (F5) on a perfectly capable card. Retrying with a short
 * backoff recovers automatically; on a genuinely GPU-less machine every attempt
 * fails and the added delay (~2s) before the compatibility error is negligible.
 *
 * The success path is unchanged: if the first probe succeeds there is no delay.
 *
 * @param {{ retries?: number, retryDelayMs?: number }} [options] - `retries` =
 *   extra attempts after the first (default 4); `retryDelayMs` = base backoff,
 *   grown linearly per attempt (default 250 → 250/500/750/1000 ms).
 * @returns {Promise<GPUCapabilities>} Detected capabilities and computed tier
 * @public
 */
export async function detect(options = {}) {
  const retries = Number.isFinite(options.retries) ? Math.max(0, options.retries) : 4;
  const retryDelayMs = Number.isFinite(options.retryDelayMs) ? Math.max(0, options.retryDelayMs) : 250;

  /** @type {GPUCapabilities} */
  const capabilities = { webgl2: false, webgl: false, tier: 'none' };

  for (let attempt = 0; attempt <= retries; attempt++) {
    const probe = _probeOnce();
    if (probe.webgl2 || probe.webgl) {
      capabilities.webgl2 = probe.webgl2;
      capabilities.webgl = probe.webgl;
      if (attempt > 0) {
        log.info(`WebGL context probe succeeded on retry ${attempt} (transient failure, likely post-TDR settling)`);
      }
      break;
    }
    if (attempt < retries) {
      const delay = retryDelayMs * (attempt + 1);
      log.warn(`WebGL context probe failed (attempt ${attempt + 1}/${retries + 1}); retrying in ${delay}ms — a GPU driver reset can leave the context briefly unavailable`);
      await _sleep(delay);
    }
  }

  // Determine rendering tier based on capabilities (WebGL-only)
  if (capabilities.webgl2) {
    capabilities.tier = 'high';
  } else if (capabilities.webgl) {
    capabilities.tier = 'low';
  }

  log.info('GPU Capabilities:', capabilities);

  return capabilities;
}

/**
 * Get human-readable tier description
 * @param {'high'|'medium'|'low'|'none'} tier - Rendering tier
 * @returns {string} Description of what this tier supports
 * @public
 */
export function getTierDescription(tier) {
  const descriptions = {
    high: 'Full effects enabled with WebGL 2.0 (PBR, post-processing, advanced effects)',
    medium: 'Standard effects enabled with WebGL 2.0 (core effects)',
    low: 'Basic effects enabled with WebGL 1.0 (limited features, upgrade recommended)',
    none: 'No GPU acceleration available'
  };
  
  return descriptions[tier] || 'Unknown tier';
}

/**
 * Check if a specific feature tier is supported
 * @param {GPUCapabilities} capabilities - Detected capabilities
 * @param {'high'|'medium'|'low'} minimumTier - Minimum required tier
 * @returns {boolean} Whether the minimum tier is met
 * @public
 */
export function supportsMinimumTier(capabilities, minimumTier) {
  const tierRanking = { high: 3, medium: 2, low: 1, none: 0 };
  return tierRanking[capabilities.tier] >= tierRanking[minimumTier];
}
