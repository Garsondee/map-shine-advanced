/**
 * @fileoverview Unified wind profile — derive temporal/spatial wind behavior from a single 0..1 slider.
 * @module core/wind-profile
 */

import { WeatherController } from './WeatherController.js';

export const MAX_WIND_MS = WeatherController.MAX_WIND_MS;

/** @typedef {'calm'|'light'|'windy'|'storm'|'hurricane'} WindTier */

export const WIND_TIER_LABELS = Object.freeze({
  calm: 'Calm',
  light: 'Breeze',
  windy: 'Windy',
  storm: 'Storm',
  hurricane: 'Hurricane',
});

/** Gustiness labels used only for legacy migration. */
const LEGACY_GUSTINESS = Object.freeze(['calm', 'light', 'moderate', 'strong', 'extreme']);

/** @param {number} t @param {number} a @param {number} b */
function lerp(t, a, b) {
  return a + (b - a) * t;
}

/** @param {number} t @param {number} edge0 @param {number} edge1 */
function smoothstep(edge0, edge1, t) {
  const x = Math.max(0, Math.min(1, (t - edge0) / Math.max(1e-6, edge1 - edge0)));
  return x * x * (3 - 2 * x);
}

/** @param {number} w @returns {WindTier} */
export function windTierFrom01(w) {
  const wind01 = Math.max(0, Math.min(1, Number(w) || 0));
  if (wind01 < 0.15) return 'calm';
  if (wind01 < 0.40) return 'light';
  if (wind01 < 0.75) return 'windy';
  if (wind01 < 0.92) return 'storm';
  return 'hurricane';
}

/**
 * Derive full wind behavior profile from master slider 0..1.
 * @param {number} wind01
 * @returns {{
 *   wind01: number,
 *   tier: WindTier,
 *   tierLabel: string,
 *   windSpeedMS: number,
 *   variability: number,
 *   gapRatio: number,
 *   gapSoftness: number,
 *   waveSharpness: number,
 *   spatialFloor: number,
 *   directionJitterRad: number,
 *   stormSwingRad: number,
 *   flutterBias: number,
 *   bendBias: number,
 *   bendWindStart: number,
 *   cloudLullSurplus: number,
 * }}
 */
export function deriveWindProfile(wind01) {
  const w = Math.max(0, Math.min(1, Number(wind01) || 0));
  const tier = windTierFrom01(w);

  const windSpeedMS = Math.pow(w, 1.4) * MAX_WIND_MS;

  // Temporal gustiness — replaces discrete Gust fader.
  let variability = 0;
  if (w > 0.08) {
    const varT = smoothstep(0.08, 1.0, w);
    variability = lerp(varT, 0.02, 0.85);
    if (w < 0.15) variability *= smoothstep(0.08, 0.15, w) * 0.35;
  }

  // Spatial gap ratio — gentle ripples at low wind; never fully blanks vegetation at high wind.
  let gapRatio;
  if (w < 0.15) {
    gapRatio = lerp(w / 0.15, 0.0, 0.06);
  } else if (w < 0.75) {
    const t = (w - 0.15) / 0.6;
    gapRatio = lerp(t, 0.06, 0.28);
  } else {
    const t = (w - 0.75) / 0.25;
    gapRatio = lerp(t, 0.28, 0.18);
  }

  // Spatial floor — mid wind keeps rustle; storm/hurricane leave room for gust fronts.
  let spatialFloor = 0;
  if (w >= 0.45 && w < 0.75) {
    spatialFloor = smoothstep(0.45, 0.75, w) * 0.42;
  } else if (w >= 0.75) {
    const t = (w - 0.75) / 0.25;
    spatialFloor = lerp(t, 0.42, 0.22);
  }

  // Gap softness — wider transitions at low/mid wind.
  let gapSoftness;
  if (w < 0.15) {
    gapSoftness = 0.22;
  } else if (w < 0.75) {
    const t = (w - 0.15) / 0.6;
    gapSoftness = lerp(t, 0.22, 0.14);
  } else {
    const t = (w - 0.75) / 0.25;
    gapSoftness = lerp(t, 0.14, 0.06);
  }

  // Wave sharpness — crisper mid-windy, softer in storm on higher floor.
  let waveSharpness;
  if (w < 0.15) {
    waveSharpness = 1.5;
  } else if (w < 0.75) {
    const t = (w - 0.15) / 0.6;
    waveSharpness = lerp(t, 1.5, 4.0);
  } else {
    const t = (w - 0.75) / 0.25;
    waveSharpness = lerp(t, 4.0, 2.8);
  }

  // Storm direction swing ±45° at full hurricane.
  const stormSwingRad = w >= 0.75
    ? smoothstep(0.75, 1.0, w) * (Math.PI / 4)
    : 0;

  // Micro direction jitter scales with wind even at calm.
  const directionJitterRad = 0.02 + w * 0.12;

  // Vegetation flutter vs bend bias — hurricane favors canopy bend over leaf shimmer.
  const flutterBias = w < 0.15 ? 1.0 : Math.max(0.22, 1.0 - (w - 0.15) * 0.95);
  const bendBias = smoothstep(0.12, 0.45, w) + smoothstep(0.68, 1.0, w) * 0.95;
  const bendWindStart = w < 0.15 ? 0.85 : lerp(smoothstep(0.15, 0.4, w), 0.85, 0.05);

  // Cloud lull surplus retention — higher floor in storm keeps clouds moving.
  const cloudLullSurplus = w >= 0.75
    ? lerp(smoothstep(0.75, 1.0, w), 0.55, 0.82)
    : 0.55;

  return {
    wind01: w,
    tier,
    tierLabel: WIND_TIER_LABELS[tier] || 'Calm',
    windSpeedMS,
    variability,
    gapRatio,
    gapSoftness,
    waveSharpness,
    spatialFloor,
    directionJitterRad,
    stormSwingRad,
    flutterBias,
    bendBias,
    bendWindStart,
    cloudLullSurplus,
  };
}

/**
 * Reconstruct master wind01 from legacy speed + gustiness for saved scenes.
 * @param {{ windSpeedMS?: number, windSpeed?: number, gustiness?: string }} legacy
 * @returns {number}
 */
export function wind01FromLegacy(legacy = {}) {
  const ms = Number(legacy.windSpeedMS);
  const ws = Number(legacy.windSpeed);
  let speed01 = 0;
  if (Number.isFinite(ms) && ms > 0) {
    speed01 = Math.max(0, Math.min(1, ms / MAX_WIND_MS));
  } else if (Number.isFinite(ws) && ws > 0) {
    speed01 = Math.max(0, Math.min(1, ws));
  } else {
    speed01 = 0;
  }

  // Invert approximate speed curve: windSpeedMS = w^1.4 * MAX
  let wind01 = speed01 > 0 ? Math.pow(speed01, 1 / 1.4) : 0;

  const gustKey = String(legacy.gustiness || 'moderate');
  const gustIdx = LEGACY_GUSTINESS.indexOf(gustKey);
  if (gustIdx >= 0) {
    const gustBoost = gustIdx * 0.04;
    wind01 = Math.max(wind01, Math.min(1, gustBoost));
    if (gustIdx >= 3 && wind01 < 0.75) wind01 = 0.75 + gustIdx * 0.04;
    else if (gustIdx >= 2 && wind01 < 0.5) wind01 = Math.max(wind01, 0.5);
  }

  return Math.max(0, Math.min(1, wind01));
}

/**
 * Map environment-fade gustiness index (0..4) to wind01 hint.
 * @param {number} gustinessIndex
 * @returns {number}
 */
export function wind01FromGustinessIndex(gustinessIndex) {
  const idx = Math.max(0, Math.min(4, Math.round(Number(gustinessIndex) || 0)));
  const table = [0.05, 0.25, 0.45, 0.72, 0.9];
  return table[idx] ?? 0.45;
}
