/**
 * @fileoverview Shared sun direction helpers for all V2 shadow producers.
 *
 * The project had several subtly different time-of-day → sun-vector mappings.
 * Keep one implementation here and fan the result out through ShadowDriverState.
 */

import { weatherController } from '../../core/WeatherController.js';

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

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
  if (!Number.isFinite(az)) {
    let hour = 12.0;
    try {
      if (weatherController && typeof weatherController.timeOfDay === 'number') {
        hour = weatherController.timeOfDay;
      }
    } catch (_) {}
    // Full 24h fallback, retained only for cold-start frames before SkyColor updates.
    az = ((hour % 24.0) / 24.0 - 0.5) * 360.0;
  }

  const el = Number.isFinite(Number(elevationDeg)) ? Number(elevationDeg) : 45.0;
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

export function clamp01(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? clamp(n, 0.0, 1.0) : fallback;
}

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
