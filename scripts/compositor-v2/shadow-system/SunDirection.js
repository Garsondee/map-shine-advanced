/**
 * @fileoverview Shared sun direction helpers for all V2 shadow producers.
 *
 * The project had several subtly different time-of-day → sun-vector mappings.
 * Keep one implementation here and fan the result out through ShadowDriverState.
 */

import { weatherController } from '../../core/WeatherController.js';

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

const wrapHour24 = (h) => {
  const hour = Number(h);
  return Number.isFinite(hour) ? ((hour % 24) + 24) % 24 : 0;
};

const clamp01 = (value, fallback = 0) => {
  const n = Number(value);
  return Number.isFinite(n) ? clamp(n, 0.0, 1.0) : fallback;
};

const smooth01 = (x) => {
  const t = clamp01(x);
  return t * t * (3 - 2 * t);
};

const wrapDistHours = (a, b) => {
  const d = Math.abs(a - b);
  return Math.min(d, 24 - d);
};

/**
 * Smooth peak centered on `center` hour (0–24), falling to 0 over `widthHours`.
 * @param {number} hour
 * @param {number} center
 * @param {number} widthHours
 * @returns {number}
 */
export const peakHour = (hour, center, widthHours) => {
  const d = wrapDistHours(wrapHour24(hour), wrapHour24(center));
  const t = clamp01(1 - d / Math.max(0.0001, widthHours));
  return smooth01(t);
};

/**
 * Directional shadow length weight: 0 at solar noon and midnight, 1 at dawn/dusk.
 * Feeds {@link ShadowDriverState#tuning.shadowLengthScale}.
 *
 * @param {number} hourRaw
 * @param {number} [sunriseHour=6]
 * @param {number} [widthHours=2.5]
 * @returns {number}
 */
export function computeGoldenHourShadowLengthWeight(hourRaw, sunriseHour = 6, widthHours = 2.5) {
  const cfg = getShadowSystemTuning();
  const w = Number.isFinite(Number(cfg?.goldenHourWidthHours))
    ? Number(cfg.goldenHourWidthHours)
    : widthHours;
  return computeShadowTimeTuning(hourRaw, sunriseHour, cfg).lengthScale;
}

/**
 * Default unified shadow time-of-day tuning (overridden by Tweakpane `globalParams.shadowSystem`).
 * @type {Readonly<Record<string, number>>}
 */
export const DEFAULT_SHADOW_SYSTEM_TUNING = Object.freeze({
  goldenHourWidthHours: 2.5,
  noonWidthHours: 3.0,
  midnightWidthHours: 2.0,
  /** Multiplier on per-effect base softness at solar noon (lower = sharper). */
  softnessNoon: 0.42,
  /** Multiplier at dawn/dusk (higher = more diffuse). */
  softnessGolden: 1.85,
  /** Multiplier near midnight — moon shadows, sharper than golden hour. */
  softnessMidnight: 0.62,
  softnessNeutral: 1.0,
  /** Ray length / offset scale at noon (short underfoot shadows). */
  lengthNoon: 0.12,
  lengthGolden: 1.0,
  lengthMidnight: 0.38,
  lengthNeutral: 0.55,
  /** Directional smear along sun vector (building/sky-reach ray march). */
  smearNoon: 0.04,
  smearGolden: 1.0,
  smearMidnight: 0.32,
  smearNeutral: 0.18,
  cloudDiffusionFactor: 3.0,
});

/**
 * Live tuning from Tweakpane / UI manager, merged over {@link DEFAULT_SHADOW_SYSTEM_TUNING}.
 * @returns {Record<string, number>}
 */
export function getShadowSystemTuning() {
  const ui = globalThis.window?.MapShine?.tweakpaneManager
    ?? globalThis.window?.MapShine?.uiManager
    ?? null;
  const raw = ui?.globalParams?.shadowSystem;
  if (!raw || typeof raw !== 'object') return { ...DEFAULT_SHADOW_SYSTEM_TUNING };
  const out = { ...DEFAULT_SHADOW_SYSTEM_TUNING };
  for (const key of Object.keys(DEFAULT_SHADOW_SYSTEM_TUNING)) {
    const n = Number(raw[key]);
    if (Number.isFinite(n)) out[key] = n;
  }
  return out;
}

/**
 * Time-of-day multipliers shared by all shadow producers.
 * Softness peaks at dawn/dusk, sharp at noon, moderately sharp at midnight (moon).
 * Length and smear peak at golden hour for elongated diffuse shadows.
 *
 * @param {number} hourRaw
 * @param {number} [sunriseHour=6]
 * @param {Record<string, number>} [cfg]
 * @returns {{ softnessScale:number, lengthScale:number, smearScale:number, goldenFactor:number, noonFactor:number, midnightFactor:number }}
 */
export function computeShadowTimeTuning(hourRaw, sunriseHour = 6, cfg = null) {
  const c = cfg ?? getShadowSystemTuning();
  const hour = wrapHour24(hourRaw);
  const sunrise = wrapHour24(sunriseHour);
  const sunset = wrapHour24(sunrise + 12);
  const goldenW = Math.max(0.25, Number(c.goldenHourWidthHours) || 2.5);
  const golden = Math.max(
    peakHour(hour, sunrise, goldenW),
    peakHour(hour, sunset, goldenW),
  );
  const noon = peakHour(hour, 12, Math.max(0.25, Number(c.noonWidthHours) || 3));
  const midnight = peakHour(hour, 0, Math.max(0.25, Number(c.midnightWidthHours) || 2));

  const blendPeak = (neutral, peakValue, factor) => (
    neutral + (peakValue - neutral) * clamp01(factor)
  );

  let softnessScale = blendPeak(c.softnessNeutral, c.softnessGolden, golden);
  softnessScale = blendPeak(softnessScale, c.softnessNoon, noon);
  softnessScale = blendPeak(softnessScale, c.softnessMidnight, midnight);

  let lengthScale = blendPeak(c.lengthNeutral, c.lengthGolden, golden);
  lengthScale = blendPeak(lengthScale, c.lengthNoon, noon);
  lengthScale = blendPeak(lengthScale, c.lengthMidnight, midnight);
  lengthScale = Math.max(0.05, lengthScale);

  let smearScale = blendPeak(c.smearNeutral, c.smearGolden, golden);
  smearScale = blendPeak(smearScale, c.smearNoon, noon);
  smearScale = blendPeak(smearScale, c.smearMidnight, midnight);
  smearScale = Math.max(0, smearScale);

  return {
    softnessScale: Math.max(0.05, softnessScale),
    lengthScale,
    smearScale,
    goldenFactor: golden,
    noonFactor: noon,
    midnightFactor: midnight,
  };
}

/**
 * Full 24h sun orbit for shadows, specular, and downstream consumers.
 *
 * Azimuth advances continuously: East (90°) at sunrise → South (180°) at solar
 * noon → West (270°) at sunset → North (0°) at solar midnight, then back to East.
 * Elevation follows a single daily cosine peak at solar noon and stays near the
 * horizon at sunrise, sunset, and midnight (clamped to 2° for shader stability).
 *
 * @param {number} hourRaw - Map Shine time of day 0–24
 * @param {number} [sunriseHour=6] - Orbit anchor; azimuth is 90° when hour equals sunrise
 * @returns {{azimuthDeg:number, elevationDeg:number}}
 */
export function computeSunAnglesFromHour(hourRaw, sunriseHour = 6) {
  const hour = wrapHour24(hourRaw);
  const sunrise = wrapHour24(sunriseHour);
  const hoursSinceSunrise = wrapHour24(hour - sunrise);
  const orbit = hoursSinceSunrise / 24.0;
  const azimuthDeg = (90 + orbit * 360) % 360;
  const elevRaw = Math.cos((orbit - 0.25) * Math.PI * 2) * 85.0;
  const elevationDeg = Math.max(2.0, elevRaw);
  return { azimuthDeg, elevationDeg };
}

/**
 * Convert an azimuth/elevation pair into the 2D shadow convention used by the
 * existing Building/Painted/SkyReach shaders.
 *
 * @param {number|null|undefined} azimuthDeg
 * @param {number|null|undefined} elevationDeg
 * @param {number} [latitudeScale=0.1]
 * @param {{x:number,y:number}|null} [fallback=null]
 * @returns {{x:number,y:number,azimuthDeg:number,elevationDeg:number}}
 */
export { clamp01 };

/**
 * Latitude scale for the 2D shadow plane: must match
 * {@link ShadowDriverState#update} (`_overheadShadowEffect.params.sunLatitude`)
 * so Building/SkyReach `uSunDir` equals `computeSunDirection2D` for the same azimuth.
 *
 * @param {number} [effectFallback=0.1] Used when overhead params are unavailable (unit tests / startup).
 */
export function getUnifiedShadowLatitudeScale(effectFallback = 0.1) {
  const ui = globalThis.window?.MapShine?.tweakpaneManager
    ?? globalThis.window?.MapShine?.uiManager
    ?? null;
  const globalLat = Number(ui?.globalParams?.sunLatitude);
  if (Number.isFinite(globalLat)) return clamp(globalLat, 0.0, 1.0);
  const fc = globalThis.window?.MapShine?.effectComposer?._floorCompositorV2
    ?? globalThis.window?.MapShine?.floorCompositorV2
    ?? null;
  const raw = fc?._overheadShadowEffect?.params?.sunLatitude;
  if (Number.isFinite(Number(raw))) return clamp(Number(raw), 0.0, 1.0);
  return clamp(Number(effectFallback), 0.0, 1.0);
}

/**
 * Resolve azimuth/elevation in degrees from explicit values or current time of day.
 * @param {number|null|undefined} azimuthDeg
 * @param {number|null|undefined} elevationDeg
 * @param {number} [sunriseHour=6]
 * @returns {{ azimuthDeg: number, elevationDeg: number }}
 */
export function resolveShadowSunAnglesDeg(azimuthDeg, elevationDeg, sunriseHour = 6) {
  let az = Number(azimuthDeg);
  let el = Number(elevationDeg);
  if (!Number.isFinite(az) || !Number.isFinite(el)) {
    let hour = 12.0;
    let sunrise = sunriseHour;
    try {
      if (weatherController && typeof weatherController.timeOfDay === 'number') {
        hour = weatherController.timeOfDay;
      }
      const envSunrise = weatherController?.getEnvironment?.()?.sunrise;
      if (Number.isFinite(Number(envSunrise))) sunrise = Number(envSunrise);
    } catch (_) {}
    const angles = computeSunAnglesFromHour(hour, sunrise);
    if (!Number.isFinite(az)) az = angles.azimuthDeg;
    if (!Number.isFinite(el)) el = angles.elevationDeg;
  }
  return { azimuthDeg: az, elevationDeg: el };
}
