/**
 * @fileoverview Frame-synced environment ramp driver for Camera Path playback.
 *
 * @module foundry/environment-playback-driver
 */
import { createLogger } from '../core/log.js';
import { environmentControlApi } from '../ui/environment-control-api.js';
import { normalizeEnvironmentSnapshot } from '../ui/environment-override-specs.js';

const log = createLogger('EnvironmentPlaybackDriver');

/** @typedef {'idle'|'armed'|'ramping'|'holdingEnd'} EnvironmentPlaybackPhase */

export class EnvironmentPlaybackDriver {
  constructor() {
    /** @type {EnvironmentPlaybackPhase} */
    this.phase = 'idle';

    /** @type {import('../ui/environment-control-api.js').EnvironmentSnapshot|null} */
    this._start = null;

    /** @type {import('../ui/environment-control-api.js').EnvironmentSnapshot|null} */
    this._end = null;

    /** @type {number} */
    this._rampDurationMs = 0;

    /** @type {number} Wall-clock ramp origin (performance.now). */
    this._rampWallStartMs = 0;

    /** @type {boolean} */
    this._syncToPlayers = false;

    /** @type {number} */
    this._lastBroadcastAt = 0;

    /** @type {number} */
    this._broadcastMinIntervalMs = 75;

    /** @type {number} */
    this.cameraPipelineOrder = 1.5;
  }

  /**
   * @param {import('../ui/environment-control-api.js').EnvironmentSnapshot} start
   */
  async armStart(start) {
    this._start = normalizeEnvironmentSnapshot(start);
    this._end = null;
    this.phase = 'armed';
    await environmentControlApi.applySnapshot(this._start, {
      persist: false,
      syncUi: false,
      applyDarkness: true,
      syncFoundryTime: false,
    });
  }

  /**
   * @param {import('../ui/environment-control-api.js').EnvironmentSnapshot} start
   * @param {import('../ui/environment-control-api.js').EnvironmentSnapshot} end
   * @param {number} durationMs
   * @param {boolean} [syncToPlayers=false]
   */
  startRamp(start, end, durationMs, syncToPlayers = false) {
    this._start = normalizeEnvironmentSnapshot(start);
    this._end = normalizeEnvironmentSnapshot(end);
    this._rampDurationMs = Math.max(0, Number(durationMs) || 0);
    this._rampWallStartMs = performance.now();
    this._syncToPlayers = syncToPlayers === true;
    this.phase = 'ramping';
  }

  /**
   * @param {import('../ui/environment-control-api.js').EnvironmentSnapshot} [end]
   */
  async holdEnd(end = null) {
    if (end) this._end = normalizeEnvironmentSnapshot(end);
    this.phase = 'holdingEnd';
    if (this._end) {
      await environmentControlApi.applySnapshot(this._end, {
        persist: false,
        syncUi: false,
        applyDarkness: true,
        syncFoundryTime: false,
      });
      this._broadcastEnvironment(this._end, 1);
    }
  }

  stop() {
    this.phase = 'idle';
    this._start = null;
    this._end = null;
    this._rampDurationMs = 0;
    this._rampWallStartMs = 0;
    this._syncToPlayers = false;
  }

  /**
   * @param {import('../effects/EffectComposer.js').TimeInfo} timeInfo
   */
  update(timeInfo) {
    void timeInfo;
    if (this.phase !== 'ramping' || !this._start || !this._end) return;

    const wallElapsedMs = Math.max(0, performance.now() - this._rampWallStartMs);
    const durationMs = this._rampDurationMs;
    const t = durationMs > 0
      ? Math.max(0, Math.min(1, wallElapsedMs / durationMs))
      : 1;

    try {
      const snap = environmentControlApi.applyInterpolated(this._start, this._end, t, {
        persist: false,
        syncUi: false,
        applyDarkness: true,
        syncFoundryTime: false,
        transient: true,
      });
      this._broadcastEnvironment(snap, t);
    } catch (err) {
      log.warn('Environment ramp apply failed', err);
    }

    if (t >= 1) {
      this.phase = 'holdingEnd';
    }
  }

  /**
   * @param {import('../ui/environment-control-api.js').EnvironmentSnapshot} snapshot
   * @param {number} t
   * @private
   */
  _broadcastEnvironment(snapshot, t) {
    if (!this._syncToPlayers) return;
    const now = Date.now();
    if (now - this._lastBroadcastAt < this._broadcastMinIntervalMs) return;
    this._lastBroadcastAt = now;

    try {
      window.MapShine?.cinematicCameraManager?.broadcastEnvironmentSnapshot?.(snapshot, t);
    } catch (_) {}
  }

  /** @returns {boolean} */
  broadcastEnvironmentRelease() {
    if (!this._syncToPlayers) return false;
    try {
      window.MapShine?.cinematicCameraManager?.broadcastEnvironmentRelease?.();
      return true;
    } catch (_) {
      return false;
    }
  }
}

export const environmentPlaybackDriver = new EnvironmentPlaybackDriver();

/**
 * @param {number} segmentCount
 * @param {number} totalDurationSec
 * @param {number} [preHoldMs=800]
 * @param {number} [segmentHoldMs=800]
 * @returns {number}
 */
export function computeCameraPathMotionDurationMs(
  segmentCount,
  totalDurationSec,
  preHoldMs = 800,
  segmentHoldMs = 800,
) {
  const n = Math.max(1, Number(segmentCount) || 1);
  const segmentMs = (Math.max(0, Number(totalDurationSec) || 0) / n) * 1000;
  return n * segmentMs + Math.max(0, preHoldMs) + Math.max(0, n - 1) * Math.max(0, segmentHoldMs);
}
