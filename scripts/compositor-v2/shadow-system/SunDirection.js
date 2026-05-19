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
  const hour = wrapHour24(hourRaw);
  const sunrise = wrapHour24(sunriseHour);
  const sunset = wrapHour24(sunrise + 12);
  return Math.max(
    peakHour(hour, sunrise, widthHours),
    peakHour(hour, sunset, widthHours),
  );
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
export function computeSunDirection2D(azimuthDeg, elevationDeg, latitudeScale = 0.1, fallback = null) {
  let az = Number(azimuthDeg);
  let elFromAngles = null;
  if (!Number.isFinite(az)) {
    let hour = 12.0;
    try {
      if (weatherController && typeof weatherController.timeOfDay === 'number') {
        hour = weatherController.timeOfDay;
      }
    } catch (_) {}
    const angles = computeSunAnglesFromHour(hour);
    az = angles.azimuthDeg;
    elFromAngles = angles.elevationDeg;
  }

  const el = Number.isFinite(Number(elevationDeg))
    ? Number(elevationDeg)
    : (Number.isFinite(elFromAngles) ? elFromAngles : 45.0);
  const lat = Number.isFinite(Number(latitudeScale)) ? clamp(Number(latitudeScale), 0.0, 1.0) : 0.1;
  const rad = az * (Math.PI / 180.0);
  let x = -Math.sin(rad);
  let y = -Math.cos(rad) * lat;

  const lenSq = x * x + y * y;
  if (lenSq < 1e-8) {
    const fx = Number(fallback?.x);
    const fy = Number(fallback?.y);
    const fl = fx * fx + fy * fy;
    if (Number.isFinite(fl) && fl > 1e-8) {
      x = fx;
      y = fy;
    } else {
      x = Math.cos(rad) >= 0.0 ? -1.0 : 1.0;
      y = 0.0;
    }
  }

  return { x, y, azimuthDeg: az, elevationDeg: el };
}

export { clamp01 };

/**
 * Latitude scale for the 2D shadow plane: must match
 * {@link ShadowDriverState#update} (`_overheadShadowEffect.params.sunLatitude`)
 * so Building/SkyReach `uSunDir` equals `computeSunDirection2D` for the same azimuth.
 *
 * @param {number} [effectFallback=0.1] Used when overhead params are unavailable (unit tests / startup).
 */
export function getUnifiedShadowLatitudeScale(effectFallback = 0.1) {
  const raw = window.MapShine?.floorCompositorV2?._overheadShadowEffect?.params?.sunLatitude;
  if (Number.isFinite(Number(raw))) return clamp(Number(raw), 0.0, 1.0);
  return clamp(Number(effectFallback), 0.0, 1.0);
}
