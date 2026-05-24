/**
 * @fileoverview Smooth cross-fade for time, weather scalars, wind, fog, and lightning.
 * Supports per-channel retarget when a slider overrides an in-progress transition.
 * Long time-of-day fades are split into chunked mini-fades so Foundry darkness and
 * darkness-gated lights refresh at each leg boundary.
 *
 * @module ui/environment-fade-controller
 */

import { createLogger } from '../core/log.js';
import { environmentControlApi } from './environment-control-api.js';
import {
  lerpEnvironmentField,
  lerpEnvironmentSnapshots,
  normalizeEnvironmentSnapshot,
} from './environment-override-specs.js';
import { GUSTINESS_LABELS } from './control-panel/widgets/astrolabe-dial.js';
import { readManualFogDensityFromControlState } from './atmospheric-fog-bridge.js';
import { readLightningIntensityFromControlState } from './landscape-lightning-bridge.js';

const log = createLogger('EnvironmentFade');
const DRIVE_TOKEN = 'cp-environment-fade';
const TICK_MS = 100;
const MODULE_ID = 'map-shine-advanced';

/** @typedef {{ ashIntensity: number, gustinessIndex: number }} FadeExtras */
/** @typedef {string} FadeChannelId */

/** @type {ReadonlyArray<FadeChannelId>} */
export const FADE_CHANNEL_IDS = Object.freeze([
  'timeOfDay',
  'manualFogDensity',
  'lightning',
  'precipitation',
  'cloudCover',
  'freezeLevel',
  'windSpeed',
  'windDirection',
  'ashIntensity',
  'gustiness',
]);

/**
 * @typedef {Object} ChannelState
 * @property {number} start
 * @property {number} end
 * @property {number} startMs
 * @property {number} durationMs
 * @property {boolean} [angular]
 * @property {number} [period]
 */

/**
 * @typedef {Object} SegmentDriveOptions
 * @property {boolean} [beginDrive=false]
 * @property {boolean} [endDrive=false]
 * @property {boolean} [skipCancel=false]
 * @property {boolean} [applyExtrasAsLast=false]
 */

/** @type {Record<FadeChannelId, { angular?: boolean, period?: number }>} */
const CHANNEL_META = Object.freeze({
  timeOfDay: { angular: true, period: 24 },
  windDirection: { angular: true, period: 360 },
  manualFogDensity: {},
  lightning: {},
  precipitation: {},
  cloudCover: {},
  freezeLevel: {},
  windSpeed: {},
  ashIntensity: {},
  gustiness: {},
});

/** @returns {number} */
export function readEnvironmentFadeChunkLegSeconds() {
  try {
    const v = Number(globalThis.game?.settings?.get?.(MODULE_ID, 'environmentFadeChunkLegSeconds'));
    if (Number.isFinite(v)) return Math.max(5, Math.min(60, v));
  } catch (_) {}
  return 10;
}

/** @returns {number} */
export function readEnvironmentFadeChunkSettleMs() {
  try {
    const v = Number(globalThis.game?.settings?.get?.(MODULE_ID, 'environmentFadeChunkSettleMs'));
    if (Number.isFinite(v)) return Math.max(0, Math.min(2000, v));
  } catch (_) {}
  return 300;
}

/** @returns {number} */
export function readEnvironmentFadeChunkMinHourDelta() {
  try {
    const v = Number(globalThis.game?.settings?.get?.(MODULE_ID, 'environmentFadeChunkMinHourDelta'));
    if (Number.isFinite(v)) return Math.max(0.1, Math.min(12, v));
  } catch (_) {}
  return 0.5;
}

export function snapshotFromControlState(controlState, maxWindMs = 78) {
  const cs = controlState || {};
  const preset = cs.directedCustomPreset && typeof cs.directedCustomPreset === 'object'
    ? cs.directedCustomPreset
    : {};
  const windMS = Number(cs.windSpeedMS);
  const clampedMS = Number.isFinite(windMS) ? Math.max(0, Math.min(maxWindMs, windMS)) : 0;

  return normalizeEnvironmentSnapshot({
    timeOfDay: cs.timeOfDay,
    manualFogDensity: readManualFogDensityFromControlState(cs),
    lightning: readLightningIntensityFromControlState(cs),
    weather: {
      precipitation: preset.precipitation,
      cloudCover: preset.cloudCover,
      freezeLevel: preset.freezeLevel,
      windSpeed: clampedMS / maxWindMs,
      windDirection: cs.windDirection,
    },
  });
}

export function fadeExtrasFromControlState(controlState, ashFallback = 0) {
  const cs = controlState || {};
  const gustKey = typeof cs.gustiness === 'string' ? cs.gustiness : 'moderate';
  let gustinessIndex = GUSTINESS_LABELS.indexOf(gustKey);
  if (gustinessIndex < 0) gustinessIndex = 2;

  let ashIntensity = ashFallback;
  const rows = window.MapShine?.controlPanel?._liveWeatherOverrideDom?.rows;
  const ashRow = rows?.ashIntensity;
  if (ashRow?.range && Number.isFinite(ashRow.range.valueAsNumber)) {
    ashIntensity = ashRow.range.valueAsNumber;
  }

  return {
    ashIntensity: Math.max(0, Math.min(1, Number(ashIntensity) || 0)),
    gustinessIndex,
  };
}

export function lerpFadeExtras(a, b, t) {
  const tt = Math.max(0, Math.min(1, Number(t) || 0));
  return {
    ashIntensity: a.ashIntensity + (b.ashIntensity - a.ashIntensity) * tt,
    gustinessIndex: a.gustinessIndex + (b.gustinessIndex - a.gustinessIndex) * tt,
  };
}

export function gustinessFromExtras(extras) {
  const idx = Math.round(Number(extras?.gustinessIndex) || 0);
  return GUSTINESS_LABELS[Math.max(0, Math.min(GUSTINESS_LABELS.length - 1, idx))] || 'moderate';
}

/** @param {number} a @param {number} b @returns {number} */
function shortestArcHourDelta(a, b) {
  let delta = b - a;
  if (delta > 12) delta -= 24;
  if (delta < -12) delta += 24;
  return Math.abs(delta);
}

/** @param {number} a @param {number} b @param {number} period @returns {number} */
function shortestArcDelta(a, b, period) {
  let delta = b - a;
  const half = period / 2;
  if (delta > half) delta -= period;
  if (delta < -half) delta += period;
  return Math.abs(delta);
}

/** @param {FadeChannelId} channelId @param {number} startVal @param {number} endVal @returns {number} */
function channelDelta(channelId, startVal, endVal) {
  if (channelId === 'timeOfDay') return shortestArcHourDelta(startVal, endVal);
  if (channelId === 'windDirection') return shortestArcDelta(startVal, endVal, 360);
  return Math.abs(startVal - endVal);
}

function readChannelValue(channelId, snap, extras) {
  switch (channelId) {
    case 'timeOfDay': return snap.timeOfDay;
    case 'manualFogDensity': return snap.manualFogDensity;
    case 'lightning': return snap.lightning;
    case 'precipitation': return snap.weather.precipitation;
    case 'cloudCover': return snap.weather.cloudCover;
    case 'freezeLevel': return snap.weather.freezeLevel;
    case 'windSpeed': return snap.weather.windSpeed;
    case 'windDirection': return snap.weather.windDirection;
    case 'ashIntensity': return extras.ashIntensity;
    case 'gustiness': return extras.gustinessIndex;
    default: return 0;
  }
}

function writeChannelValue(channelId, snap, extras, value) {
  switch (channelId) {
    case 'timeOfDay': snap.timeOfDay = value; break;
    case 'manualFogDensity': snap.manualFogDensity = value; break;
    case 'lightning': snap.lightning = value; break;
    case 'precipitation': snap.weather.precipitation = value; break;
    case 'cloudCover': snap.weather.cloudCover = value; break;
    case 'freezeLevel': snap.weather.freezeLevel = value; break;
    case 'windSpeed': snap.weather.windSpeed = value; break;
    case 'windDirection': snap.weather.windDirection = value; break;
    case 'ashIntensity': extras.ashIntensity = value; break;
    case 'gustiness': extras.gustinessIndex = value; break;
    default: break;
  }
}

function normalizeChannelEnd(channelId, value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  if (channelId === 'gustiness') {
    return Math.max(0, Math.min(GUSTINESS_LABELS.length - 1, Math.round(n)));
  }
  if (channelId === 'timeOfDay') return ((n % 24) + 24) % 24;
  if (channelId === 'windDirection') return ((n % 360) + 360) % 360;
  if (
    channelId === 'windSpeed' || channelId === 'ashIntensity' || channelId.endsWith('Level')
    || channelId.includes('Density') || channelId === 'lightning'
    || channelId === 'precipitation' || channelId === 'cloudCover'
  ) {
    return Math.max(0, Math.min(1, n));
  }
  return n;
}

function channelProgress(ch, nowMs = Date.now()) {
  if (!ch.durationMs || ch.durationMs <= 1) return 1;
  return Math.max(0, Math.min(1, (nowMs - ch.startMs) / ch.durationMs));
}

function lerpChannel(ch, t) {
  if (ch.angular) {
    return lerpEnvironmentField(
      ch.period === 360 ? 'windDirection' : 'timeOfDay',
      ch.start,
      ch.end,
      t,
    );
  }
  return ch.start + (ch.end - ch.start) * t;
}

export class EnvironmentFadeController {
  constructor() {
    this._intervalId = null;
    this._running = false;
    this._channels = new Map();
    this._startSnap = null;
    this._startExtras = null;
    this._endSnap = null;
    this._endExtras = null;
    this._hooks = null;
    this._resolvePromise = null;
    this._rejectPromise = null;
    /** @type {boolean} */
    this._segmentEndDrive = true;
    /** @type {number} */
    this._runGeneration = 0;
    /** @type {number} */
    this._segmentGeneration = 0;
    /** @type {number} Monotonic epoch; stale tick callbacks from a prior leg bail out. */
    this._segmentEpoch = 0;
    /** @type {boolean} True for the full multi-leg chunked sequence. */
    this._chunkedFadeActive = false;
    /** @type {boolean} */
    this._segmentApplyExtrasAsLast = false;
  }

  get isRunning() {
    return this._running === true || this._chunkedFadeActive === true;
  }

  cancel() {
    this._runGeneration += 1;
    this._segmentEpoch += 1;
    this._chunkedFadeActive = false;
    if (this._intervalId) {
      clearInterval(this._intervalId);
      this._intervalId = null;
    }
    const resolve = this._resolvePromise;
    this._running = false;
    this._channels.clear();
    this._startSnap = null;
    this._startExtras = null;
    this._endSnap = null;
    this._endExtras = null;
    this._hooks = null;
    this._resolvePromise = null;
    this._rejectPromise = null;
    this._segmentEndDrive = true;
    this._segmentApplyExtrasAsLast = false;
    try {
      environmentControlApi.endExternalDrive(DRIVE_TOKEN, { restore: false });
    } catch (_) {}
    // Resolve so superseding transitions can unwind await/finally handlers.
    resolve?.();
  }

  _durationMs(transitionMinutes) {
    const minsNum = Number(transitionMinutes);
    const safeMinutes = Number.isFinite(minsNum) ? Math.max(0, Math.min(60, minsNum)) : 0;
    return safeMinutes * 60 * 1000;
  }

  /**
   * @param {number} transitionMinutes
   * @param {import('./environment-control-api.js').EnvironmentSnapshot} startSnap
   * @param {import('./environment-control-api.js').EnvironmentSnapshot} endSnap
   * @returns {boolean}
   */
  _shouldChunk(transitionMinutes, startSnap, endSnap) {
    const durationMs = this._durationMs(transitionMinutes);
    const legMs = readEnvironmentFadeChunkLegSeconds() * 1000;
    if (durationMs <= legMs) return false;

    const minHourDelta = readEnvironmentFadeChunkMinHourDelta();
    const hourDelta = shortestArcHourDelta(
      Number(startSnap?.timeOfDay) || 0,
      Number(endSnap?.timeOfDay) || 0,
    );
    return hourDelta >= minHourDelta;
  }

  /**
   * @param {number} ms
   * @param {number} gen
   * @returns {Promise<void>}
   */
  async _delaySettle(ms, gen) {
    const endAt = Date.now() + ms;
    while (Date.now() < endAt) {
      if (gen !== this._runGeneration) return;
      const remaining = endAt - Date.now();
      await new Promise((resolve) => setTimeout(resolve, Math.min(50, remaining)));
    }
  }

  _makeChannel(channelId, startVal, endVal, durationMs) {
    const meta = CHANNEL_META[channelId] || {};
    return {
      start: startVal,
      end: endVal,
      startMs: Date.now(),
      durationMs: Math.max(1, durationMs),
      angular: meta.angular === true,
      period: meta.period,
    };
  }

  _compose() {
    const snap = normalizeEnvironmentSnapshot(this._startSnap || this._endSnap);
    const extras = {
      ashIntensity: this._startExtras?.ashIntensity ?? 0,
      gustinessIndex: this._startExtras?.gustinessIndex ?? 2,
    };

    const nowMs = Date.now();
    let allDone = this._channels.size > 0;

    for (const [channelId, ch] of this._channels) {
      const t = channelProgress(ch, nowMs);
      if (t < 1) allDone = false;
      const val = t >= 1 ? ch.end : lerpChannel(ch, t);
      writeChannelValue(channelId, snap, extras, val);
    }

    if (this._channels.size === 0) allDone = true;

    return { snap, extras, allDone };
  }

  _ensureLoop() {
    if (this._intervalId) return;

    this._intervalId = setInterval(() => {
      void (async () => {
        const tickEpoch = this._segmentEpoch;
        try {
          if (tickEpoch !== this._segmentEpoch) return;

          const { snap, extras, allDone } = this._compose();
          if (tickEpoch !== this._segmentEpoch) return;

          await environmentControlApi.applySnapshot(snap, {
            persist: false,
            syncUi: false,
            applyDarkness: false,
            syncFoundryTime: false,
          });
          if (tickEpoch !== this._segmentEpoch) return;

          if (this._hooks?.applyExtras) await this._hooks.applyExtras(extras, false);
          if (this._hooks?.onTick) {
            const maxT = this._channels.size
              ? Math.max(0, ...[...this._channels.values()].map((ch) => channelProgress(ch)))
              : 1;
            this._hooks.onTick(snap, extras, maxT);
          }

          if (allDone && this._endSnap && this._endExtras) {
            if (tickEpoch !== this._segmentEpoch) return;

            const segmentGen = this._segmentGeneration;
            if (segmentGen !== this._runGeneration) return;

            if (this._intervalId) {
              clearInterval(this._intervalId);
              this._intervalId = null;
            }
            this._running = false;

            await environmentControlApi.applySnapshot(this._endSnap, {
              persist: false,
              syncUi: false,
              applyDarkness: true,
              syncFoundryTime: false,
            });
            if (tickEpoch !== this._segmentEpoch) return;
            if (segmentGen !== this._runGeneration) return;

            const segmentLast = this._segmentApplyExtrasAsLast === true;
            if (this._hooks?.applyExtras) await this._hooks.applyExtras(this._endExtras, segmentLast);
            if (this._hooks?.onTick) this._hooks.onTick(this._endSnap, this._endExtras, 1);

            const resolve = this._resolvePromise;
            const endDrive = this._segmentEndDrive;
            this._resolvePromise = null;
            this._hooks = null;
            this._channels.clear();
            this._segmentEndDrive = true;
            this._segmentApplyExtrasAsLast = false;

            if (endDrive) {
              try {
                environmentControlApi.endExternalDrive(DRIVE_TOKEN, { restore: false });
              } catch (_) {}
            }
            resolve?.();
          }
        } catch (err) {
          if (tickEpoch !== this._segmentEpoch) return;
          this.cancel();
          log.error('Environment fade tick failed', err);
          this._rejectPromise?.(err);
          this._rejectPromise = null;
        }
      })();
    }, TICK_MS);
  }

  retargetChannel(channelId, endValue, transitionMinutes, opts = {}) {
    if (!FADE_CHANNEL_IDS.includes(channelId)) return;

    const durationMs = this._durationMs(transitionMinutes);
    const endVal = normalizeChannelEnd(channelId, endValue);

    if (this._endSnap && this._endExtras) {
      writeChannelValue(channelId, this._endSnap, this._endExtras, endVal);
    }

    if (durationMs <= 1) {
      this._channels.delete(channelId);
      return;
    }

    const { snap, extras } = this._compose();
    const current = readChannelValue(channelId, snap, extras);
    const existing = this._channels.get(channelId);

    if (existing && opts.resetClock !== true) {
      existing.end = endVal;
      return;
    }

    this._channels.set(channelId, this._makeChannel(channelId, current, endVal, durationMs));

    if (!this._running) {
      this._running = true;
      if (!this._startSnap) this._startSnap = normalizeEnvironmentSnapshot(snap);
      if (!this._startExtras) this._startExtras = { ...extras };
      if (!this._endSnap) this._endSnap = normalizeEnvironmentSnapshot(snap);
      if (!this._endExtras) this._endExtras = { ...extras };
      void environmentControlApi.beginExternalDrive(DRIVE_TOKEN);
    }
    this._ensureLoop();
  }

  /**
   * Run one fade segment between two snapshots.
   *
   * @param {import('./environment-control-api.js').EnvironmentSnapshot} startSnap
   * @param {import('./environment-control-api.js').EnvironmentSnapshot} endSnap
   * @param {FadeExtras} startExtras
   * @param {FadeExtras} endExtras
   * @param {number} transitionMinutes
   * @param {Object} [hooks]
   * @param {SegmentDriveOptions} [driveOpts]
   * @returns {Promise<void>}
   */
  async _runSegment(startSnap, endSnap, startExtras, endExtras, transitionMinutes, hooks = {}, driveOpts = {}) {
    const {
      beginDrive = false,
      endDrive = false,
      skipCancel = false,
      applyExtrasAsLast = false,
    } = driveOpts;

    if (!skipCancel) {
      this.cancel();
    } else if (this._intervalId) {
      clearInterval(this._intervalId);
      this._intervalId = null;
    }

    this._segmentEpoch += 1;
    const segmentEpoch = this._segmentEpoch;

    const start = normalizeEnvironmentSnapshot(startSnap);
    const end = normalizeEnvironmentSnapshot(endSnap);
    const startEx = { ...startExtras };
    const endEx = { ...endExtras };
    const durationMs = this._durationMs(transitionMinutes);

    if (durationMs <= 1) {
      if (beginDrive) await environmentControlApi.beginExternalDrive(DRIVE_TOKEN);
      await environmentControlApi.applySnapshot(end, {
        persist: false,
        syncUi: false,
        applyDarkness: true,
        syncFoundryTime: false,
      });
      if (segmentEpoch !== this._segmentEpoch) return;
      if (hooks.applyExtras) await hooks.applyExtras(endEx, applyExtrasAsLast);
      if (hooks.onTick) hooks.onTick(end, endEx, 1);
      if (endDrive) {
        try {
          environmentControlApi.endExternalDrive(DRIVE_TOKEN, { restore: false });
        } catch (_) {}
      }
      return;
    }

    this._running = true;
    this._hooks = hooks;
    this._startSnap = start;
    this._startExtras = startEx;
    this._endSnap = end;
    this._endExtras = endEx;
    this._channels.clear();
    this._segmentEndDrive = endDrive;
    this._segmentApplyExtrasAsLast = applyExtrasAsLast;
    this._segmentGeneration = this._runGeneration;

    if (beginDrive) await environmentControlApi.beginExternalDrive(DRIVE_TOKEN);

    for (const channelId of FADE_CHANNEL_IDS) {
      const s = readChannelValue(channelId, start, startEx);
      const e = readChannelValue(channelId, end, endEx);
      const delta = channelDelta(channelId, s, e);
      const threshold = (channelId === 'timeOfDay' || channelId === 'windDirection') ? 0.05 : 0.0005;
      if (delta <= threshold) continue;
      this._channels.set(channelId, this._makeChannel(channelId, s, e, durationMs));
    }

    if (this._channels.size === 0) {
      if (segmentEpoch !== this._segmentEpoch) return;
      await environmentControlApi.applySnapshot(end, {
        persist: false,
        syncUi: false,
        applyDarkness: true,
        syncFoundryTime: false,
      });
      if (hooks.applyExtras) await hooks.applyExtras(endEx, applyExtrasAsLast);
      if (hooks.onTick) hooks.onTick(end, endEx, 1);
      this._running = false;
      this._hooks = null;
      if (endDrive) {
        try {
          environmentControlApi.endExternalDrive(DRIVE_TOKEN, { restore: false });
        } catch (_) {}
      }
      return;
    }

    if (segmentEpoch !== this._segmentEpoch) return;

    await environmentControlApi.applySnapshot(start, {
      persist: false,
      syncUi: false,
      applyDarkness: false,
      syncFoundryTime: false,
    });
    if (hooks.applyExtras) await hooks.applyExtras(startEx, false);
    if (hooks.onTick) hooks.onTick(start, startEx, 0);

    return new Promise((resolve, reject) => {
      this._resolvePromise = resolve;
      this._rejectPromise = reject;
      this._ensureLoop();
    });
  }

  /**
   * @param {import('./environment-control-api.js').EnvironmentSnapshot} startSnap
   * @param {import('./environment-control-api.js').EnvironmentSnapshot} endSnap
   * @param {FadeExtras} startExtras
   * @param {FadeExtras} endExtras
   * @param {number} transitionMinutes
   * @param {Object} [hooks]
   * @returns {Promise<void>}
   */
  async _startChunked(startSnap, endSnap, startExtras, endExtras, transitionMinutes, hooks = {}) {
    const start = normalizeEnvironmentSnapshot(startSnap);
    const end = normalizeEnvironmentSnapshot(endSnap);
    const startEx = { ...startExtras };
    const endEx = { ...endExtras };
    const totalMs = this._durationMs(transitionMinutes);
    const legMs = readEnvironmentFadeChunkLegSeconds() * 1000;
    const settleMs = readEnvironmentFadeChunkSettleMs();
    const numLegs = Math.max(1, Math.ceil(totalMs / legMs));
    const gen = this._runGeneration;
    this._chunkedFadeActive = true;

    let currentSnap = start;
    let currentEx = startEx;

    try {
      await environmentControlApi.beginExternalDrive(DRIVE_TOKEN);

      for (let i = 0; i < numLegs; i++) {
        if (gen !== this._runGeneration) return;

        const t1 = (i + 1) / numLegs;
        const legEnd = lerpEnvironmentSnapshots(start, end, t1);
        const legEndEx = lerpFadeExtras(startEx, endEx, t1);
        const remainingMs = totalMs - i * legMs;
        const thisLegMs = Math.min(legMs, remainingMs);
        const legMinutes = thisLegMs / 60000;
        const isFinalLeg = i === numLegs - 1;

        await this._runSegment(currentSnap, legEnd, currentEx, legEndEx, legMinutes, hooks, {
          beginDrive: false,
          endDrive: false,
          skipCancel: true,
          applyExtrasAsLast: isFinalLeg,
        });

        if (gen !== this._runGeneration) return;

        if (!isFinalLeg && settleMs > 0) {
          await this._delaySettle(settleMs, gen);
        }

        currentSnap = legEnd;
        currentEx = legEndEx;
      }

      if (gen === this._runGeneration) {
        try {
          environmentControlApi.endExternalDrive(DRIVE_TOKEN, { restore: false });
        } catch (_) {}
      }
    } finally {
      if (gen === this._runGeneration) {
        this._chunkedFadeActive = false;
      }
    }
  }

  async start(startSnap, endSnap, startExtras, endExtras, transitionMinutes, hooks = {}) {
    this.cancel();

    const start = normalizeEnvironmentSnapshot(startSnap);
    const end = normalizeEnvironmentSnapshot(endSnap);
    const startEx = { ...startExtras };
    const endEx = { ...endExtras };

    if (this._shouldChunk(transitionMinutes, start, end)) {
      return this._startChunked(start, end, startEx, endEx, transitionMinutes, hooks);
    }

    return this._runSegment(start, end, startEx, endEx, transitionMinutes, hooks, {
      beginDrive: true,
      endDrive: true,
      skipCancel: true,
      applyExtrasAsLast: true,
    });
  }
}

export const environmentFadeController = new EnvironmentFadeController();
