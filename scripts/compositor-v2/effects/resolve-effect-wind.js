/**
 * @fileoverview Shared wind resolution for V2 effects (water, splashes, etc.).
 * Matches WaterEffectV2: WeatherController when initialized (target direction,
 * MS speed when present), else CloudEffectV2 fallback. World-space Y-up vectors.
 * @module compositor-v2/effects/resolve-effect-wind
 */

import { weatherController, WeatherController } from '../../core/WeatherController.js';

const MAX_WIND_MS = WeatherController.MAX_WIND_MS;

/**
 * Resolve wind direction and normalized speed for CPU-side effects.
 * @returns {{ dirX: number, dirY: number, speed01: number }}
 */
export function resolveEffectWindWorld() {
  let dirX = 1.0;
  let dirY = 0.0;
  let speed01 = 0.15;
  try {
    const wcInitialized = weatherController?.initialized === true;
    const ws = wcInitialized ? weatherController?.getCurrentState?.() : null;
    const wst = wcInitialized ? weatherController?.targetState : null;
    if (ws) {
      const dirSrc = wst?.windDirection ? wst : ws;
      const wx = Number(dirSrc.windDirection?.x);
      const wy = Number(dirSrc.windDirection?.y);
      const wvMS = Number(ws.windSpeedMS);
      const wv01 = Number(ws.windSpeed);
      if (Number.isFinite(wx) && Number.isFinite(wy)) {
        const len = Math.hypot(wx, wy);
        if (len > 1e-5) {
          dirX = wx / len;
          dirY = wy / len;
        }
      }
      if (Number.isFinite(wvMS)) {
        speed01 = Math.max(0.0, Math.min(1.0, wvMS / MAX_WIND_MS));
      } else if (Number.isFinite(wv01)) {
        speed01 = Math.max(0.0, Math.min(1.0, wv01));
      }
    } else {
      const cloud = window.MapShine?.effectComposer?._floorCompositorV2?._cloudEffect;
      const cs = cloud?._getWeatherState?.();
      if (cs) {
        const wx = Number(cs.windDirX);
        const wy = Number(cs.windDirY);
        const wv = Number(cs.windSpeed);
        if (Number.isFinite(wx) && Number.isFinite(wy)) {
          const len = Math.hypot(wx, wy);
          if (len > 1e-5) {
            dirX = wx / len;
            dirY = wy / len;
          }
        }
        if (Number.isFinite(wv)) speed01 = Math.max(0, Math.min(1, wv));
      }
    }
  } catch (_) {}
  return { dirX, dirY, speed01 };
}
