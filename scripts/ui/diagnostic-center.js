/**
 * @fileoverview Diagnostic Center Manager
 *
 * Owns the Diagnostic Center dialog lifecycle and provides a small stable API.
 *
 * @module ui/diagnostic-center
 */

import { createLogger } from '../core/log.js';
import { DiagnosticCenterDialog } from './diagnostic-center-dialog.js';

const log = createLogger('DiagnosticCenter');

export class DiagnosticCenterManager {
  /**
   * @param {any} [options]
   */
  constructor(options = null) {
    this.options = options || {};

    /** @type {DiagnosticCenterDialog} */
    this.dialog = new DiagnosticCenterDialog(this);

    /** @type {boolean} */
    this._initialized = false;

    /** @type {boolean} */
    this._jankProbeWrapped = false;
    this._jankProbeCounters = {
      compositorComposeFloorCalls: 0,
      compositorComposeCalls: 0,
      compositorEvictOutdoorsRtCalls: 0,
      compositorPromoteMetaToRtCalls: 0,
      floorSyncOutdoorsCalls: 0,
      floorResolveOutdoorsCalls: 0,
    };
  }

  async initialize() {
    if (this._initialized) return;
    await this.dialog.initialize();
    this._initialized = true;
    log.info('Diagnostic Center initialized');
  }

  toggle() {
    this.dialog.toggle();
  }

  show() {
    this.dialog.show();
  }

  hide() {
    this.dialog.hide();
  }

  /**
   * Ensure low-overhead method instrumentation is installed for churn probing.
   * Wraps once per manager lifetime.
   * @private
   */
  _ensureJankProbeInstrumentation() {
    if (this._jankProbeWrapped) return;
    const ms = window.MapShine ?? null;
    const fc = ms?.effectComposer?._floorCompositorV2 ?? ms?.floorCompositorV2 ?? null;
    const comp = ms?.sceneComposer?._sceneMaskCompositor ?? null;
    const counters = this._jankProbeCounters;

    const wrap = (obj, fnName, counterKey) => {
      if (!obj || typeof obj[fnName] !== 'function') return;
      if (obj[fnName]?.__diagJankWrapped) return;
      const original = obj[fnName];
      const wrapped = function diagJankWrappedFn(...args) {
        counters[counterKey] = Number(counters[counterKey] || 0) + 1;
        return original.apply(this, args);
      };
      try {
        Object.defineProperty(wrapped, '__diagJankWrapped', { value: true });
      } catch (_) {}
      obj[fnName] = wrapped;
    };

    wrap(comp, 'composeFloor', 'compositorComposeFloorCalls');
    wrap(comp, 'compose', 'compositorComposeCalls');
    wrap(comp, '_evictGpuMaskRtForFloor', 'compositorEvictOutdoorsRtCalls');
    wrap(comp, '_promoteMetaMaskToGpuRt', 'compositorPromoteMetaToRtCalls');
    wrap(fc, '_syncOutdoorsMaskConsumers', 'floorSyncOutdoorsCalls');
    wrap(fc, '_resolveOutdoorsMask', 'floorResolveOutdoorsCalls');

    this._jankProbeWrapped = true;
  }

  /**
   * Multi-second runtime churn probe to help correlate jank with cache/sync churn.
   * @param {{durationMs?: number, sampleEveryMs?: number}} [options]
   * @returns {Promise<object>}
   */
  async collectJankChurnProbe(options = {}) {
    const durationMs = Math.max(400, Number(options?.durationMs ?? 1800));
    const sampleEveryMs = Math.max(50, Number(options?.sampleEveryMs ?? 120));
    this._ensureJankProbeInstrumentation();

    const ms = window.MapShine ?? null;
    const fc = ms?.effectComposer?._floorCompositorV2 ?? ms?.floorCompositorV2 ?? null;
    const comp = ms?.sceneComposer?._sceneMaskCompositor ?? null;
    const renderLoop = ms?.renderLoop ?? null;
    const counters = this._jankProbeCounters;
    const counterKeys = Object.keys(counters);
    const startCounters = {};
    for (const k of counterKeys) startCounters[k] = Number(counters[k] || 0);

    const startFrame = Number(renderLoop?.frameCount ?? 0);
    const startedAt = Date.now();
    const sampleRows = [];
    let prevFloorKey = String(comp?._activeFloorKey ?? '');
    let prevOutdoorsKey = String(fc?._lastOutdoorsFloorKey ?? '');
    let floorKeyFlips = 0;
    let outdoorsKeyFlips = 0;

    while ((Date.now() - startedAt) < durationMs) {
      await new Promise((resolve) => setTimeout(resolve, sampleEveryMs));
      const currentFloorKey = String(comp?._activeFloorKey ?? '');
      const currentOutdoorsKey = String(fc?._lastOutdoorsFloorKey ?? '');
      if (currentFloorKey !== prevFloorKey) {
        floorKeyFlips++;
        prevFloorKey = currentFloorKey;
      }
      if (currentOutdoorsKey !== prevOutdoorsKey) {
        outdoorsKeyFlips++;
        prevOutdoorsKey = currentOutdoorsKey;
      }
      sampleRows.push({
        tMs: Date.now() - startedAt,
        activeFloorKey: currentFloorKey || null,
        lastOutdoorsFloorKey: currentOutdoorsKey || null,
        floorMetaSize: Number(comp?._floorMeta?.size ?? 0),
        floorCacheSize: Number(comp?._floorCache?.size ?? 0),
        lruSize: Array.isArray(comp?._lruOrder) ? comp._lruOrder.length : null,
      });
    }

    const elapsedMs = Math.max(1, Date.now() - startedAt);
    const elapsedSec = elapsedMs / 1000;
    const endFrame = Number(renderLoop?.frameCount ?? startFrame);
    const frameDelta = Math.max(0, endFrame - startFrame);

    const deltaCounters = {};
    for (const k of counterKeys) {
      deltaCounters[k] = Math.max(0, Number(counters[k] || 0) - Number(startCounters[k] || 0));
    }
    const perSecond = {};
    for (const k of counterKeys) {
      perSecond[k] = Number((deltaCounters[k] / elapsedSec).toFixed(2));
    }

    const floorMetaSizes = sampleRows.map((r) => Number(r.floorMetaSize ?? 0));
    const floorCacheSizes = sampleRows.map((r) => Number(r.floorCacheSize ?? 0));
    const minMeta = floorMetaSizes.length ? Math.min(...floorMetaSizes) : null;
    const maxMeta = floorMetaSizes.length ? Math.max(...floorMetaSizes) : null;
    const minCache = floorCacheSizes.length ? Math.min(...floorCacheSizes) : null;
    const maxCache = floorCacheSizes.length ? Math.max(...floorCacheSizes) : null;

    return {
      durationMs: elapsedMs,
      sampleEveryMs,
      samples: sampleRows.length,
      frameDelta,
      approxFps: Number((frameDelta / elapsedSec).toFixed(2)),
      counterDelta: deltaCounters,
      counterPerSec: perSecond,
      keyFlips: {
        compositorActiveFloorKeyFlips: floorKeyFlips,
        floorCompositorOutdoorsFloorKeyFlips: outdoorsKeyFlips,
      },
      cacheSizeRange: {
        floorMeta: { min: minMeta, max: maxMeta },
        floorCache: { min: minCache, max: maxCache },
      },
      sampleRows: sampleRows.slice(0, 40),
      tailRows: sampleRows.slice(-20),
    };
  }
}
