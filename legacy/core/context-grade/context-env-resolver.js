/**
 * @fileoverview Global environment classification for Tier 1 context grade modifiers.
 * @module core/context-grade/context-env-resolver
 */

import { LightingDirector } from '../LightingDirector.js';
import { finiteOr } from './context-grade-spec.js';

/** @typedef {'clear'|'overcast'|'storm'} SkyCondition */
/** @typedef {'day'|'twilight'|'night'} DayPhase */
/** @typedef {'normal'|'heavy'} DarknessMood */

/**
 * @param {number} sample
 * @param {SkyCondition} previous
 * @param {{ stormHigh?: number, overcastHigh?: number, overcastLow?: number }} opts
 * @returns {SkyCondition}
 */
export function classifySkyCondition(sample, previous = 'clear', opts = {}) {
  const stormHigh = finiteOr(opts.stormHigh, 0.55);
  const overcastHigh = finiteOr(opts.overcastHigh, 0.35);
  const overcastLow = finiteOr(opts.overcastLow, 0.18);
  const s = Number(sample);
  if (!Number.isFinite(s)) return previous;

  if (s >= stormHigh) return 'storm';
  if (s >= overcastHigh) return 'overcast';
  if (s <= overcastLow) return 'clear';
  return previous;
}

/**
 * @param {number} dayWeight
 * @param {DayPhase} previous
 * @param {{ twilightLow?: number, dayHigh?: number }} opts
 * @returns {DayPhase}
 */
export function classifyDayPhase(dayWeight, previous = 'day', opts = {}) {
  const twilightLow = finiteOr(opts.twilightLow, 0.22);
  const dayHigh = finiteOr(opts.dayHigh, 0.62);
  const w = Number(dayWeight);
  if (!Number.isFinite(w)) return previous;

  if (w >= dayHigh) return 'day';
  if (w <= twilightLow) return 'night';
  return 'twilight';
}

/**
 * @param {number} darkness
 * @param {DarknessMood} previous
 * @param {{ heavyHigh?: number, normalLow?: number }} opts
 * @returns {DarknessMood}
 */
export function classifyDarknessMood(darkness, previous = 'normal', opts = {}) {
  const heavyHigh = finiteOr(opts.heavyHigh, 0.72);
  const normalLow = finiteOr(opts.normalLow, 0.55);
  const d = Number(darkness);
  if (!Number.isFinite(d)) return previous;

  if (d >= heavyHigh) return 'heavy';
  if (d <= normalLow) return 'normal';
  return previous;
}

export class ContextEnvResolver {
  constructor() {
    /** @type {SkyCondition} */
    this.skyCondition = 'clear';
    /** @type {DayPhase} */
    this.dayPhase = 'day';
    /** @type {DarknessMood} */
    this.darknessMood = 'normal';
    /** @type {number} */
    this.overcastFactor = 0;
    /** @type {number} */
    this.stormFactor = 0;
    /** @type {number} */
    this.calendarDayWeight = 1;
    /** @type {number} */
    this.masterDarkness = 0;
  }

  /**
   * @param {Record<string, *>} [params]
   * @param {{ frozen?: boolean }} [opts]
   */
  update(params = {}, opts = {}) {
    if (opts.frozen) return;

    const wc = window.MapShine?.weatherController ?? null;
    const env = wc?.getEnvironment?.() ?? {};
    this.overcastFactor = finiteOr(env.overcastFactor, 0);
    this.stormFactor = finiteOr(env.stormFactor, 0);

    let ldState = null;
    try {
      ldState = LightingDirector.get?.() ?? null;
      if (!ldState || !Number.isFinite(ldState.calendarDayWeight)) {
        ldState = LightingDirector.update?.() ?? ldState;
      }
    } catch (_) {
    }
    this.calendarDayWeight = finiteOr(ldState?.calendarDayWeight, 1);
    this.masterDarkness = finiteOr(ldState?.masterDarkness, 0);

    const stormSample = Math.max(this.stormFactor, this.overcastFactor * 0.85);
    this.skyCondition = classifySkyCondition(stormSample, this.skyCondition, {
      stormHigh: finiteOr(params?.envStormThreshold, 0.55),
      overcastHigh: finiteOr(params?.envOvercastThreshold, 0.35),
      overcastLow: finiteOr(params?.envClearThreshold, 0.18),
    });

    this.dayPhase = classifyDayPhase(this.calendarDayWeight, this.dayPhase, {
      twilightLow: finiteOr(params?.envNightThreshold, 0.22),
      dayHigh: finiteOr(params?.envDayThreshold, 0.62),
    });

    this.darknessMood = classifyDarknessMood(this.masterDarkness, this.darknessMood, {
      heavyHigh: finiteOr(params?.envDarknessHeavyThreshold, 0.72),
      normalLow: finiteOr(params?.envDarknessNormalThreshold, 0.55),
    });
  }

  /** @returns {string} */
  getContextKeyFragment() {
    return `${this.skyCondition} · ${this.dayPhase}${this.darknessMood === 'heavy' ? ' · dark' : ''}`;
  }
}
