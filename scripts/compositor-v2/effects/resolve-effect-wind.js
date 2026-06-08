/**
 * @fileoverview Shared wind resolution for V2 effects (water, splashes, etc.).
 * Matches WaterEffectV2: WeatherController when initialized (target direction,
 * MS speed when present), else CloudEffectV2 fallback; honors WaterEffectV2
 * Wind Override when enabled. Direction vectors use Foundry/weather storage
 * (Y-down, same as WeatherController and the astrolabe wind degrees).
 * @module compositor-v2/effects/resolve-effect-wind
 */

import { weatherController, WeatherController } from '../../core/WeatherController.js';
import { sceneWindField } from '../../core/SceneWindField.js';

const MAX_WIND_MS = WeatherController.MAX_WIND_MS;

/** @returns {object|null} */
function getFloorCompositorV2() {
  try {
    return window.MapShine?.floorCompositorV2
      ?? window.MapShine?.effectComposer?._floorCompositorV2
      ?? null;
  } catch (_) {
    return null;
  }
}

/**
 * Convert a scene wind compass bearing (degrees) to a normalized direction vector.
 * Matches WeatherController._windDirFromAngleDeg / scene wind UI (Foundry Y-down).
 * @param {number} bearingDeg
 * @returns {{ dirX: number, dirY: number }}
 */
export function windDirFromBearingDeg(bearingDeg) {
  const deg = Number(bearingDeg);
  const rad = (Number.isFinite(deg) ? deg : 0.0) * (Math.PI / 180.0);
  const dirX = Math.cos(rad);
  const dirY = -Math.sin(rad);
  const len = Math.hypot(dirX, dirY);
  if (len > 1e-6) return { dirX: dirX / len, dirY: dirY / len };
  return { dirX: 1.0, dirY: 0.0 };
}

/**
 * WaterEffectV2 "Wind Override" when enabled (shared by water, splashes, etc.).
 * @returns {{ dirX: number, dirY: number, speed01: number }|null}
 */
function resolveWaterWindOverride() {
  try {
    const wp = getFloorCompositorV2()?._waterEffect?.params;
    if (!wp?.windOverrideEnabled) return null;
    const { dirX, dirY } = windDirFromBearingDeg(wp.windOverrideBearingDeg);
    const speed01 = Math.max(0.0, Math.min(1.0, Number(wp.windOverrideSpeed01) ?? 0.35));
    return { dirX, dirY, speed01 };
  } catch (_) {
    return null;
  }
}

/**
 * Resolve wind direction and normalized speed for CPU-side effects.
 * @param {number} [worldX] Optional world X for spatial field sample (Three Y-up).
 * @param {number} [worldY] Optional world Y for spatial field sample (Three Y-up).
 * @returns {{ dirX: number, dirY: number, speed01: number, spatial01?: number, fieldStrength01?: number, inLull?: boolean }}
 */
export function resolveEffectWindWorld(worldX, worldY) {
  const override = resolveWaterWindOverride();
  if (override) {
    const sample = Number.isFinite(worldX) && Number.isFinite(worldY)
      ? sceneWindField.getSampleWorld(worldX, worldY)
      : null;
    return {
      ...override,
      spatial01: sample?.spatial01 ?? 1,
      fieldStrength01: sample?.strength01 ?? override.speed01,
      inLull: sample?.inLull ?? false,
    };
  }

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

  let spatial01 = 1.0;
  let fieldStrength01 = speed01;
  let inLull = false;
  try {
    if (sceneWindField?.params?.enabled !== false) {
      const sx = Number.isFinite(worldX) ? worldX : 0;
      const sy = Number.isFinite(worldY) ? worldY : 0;
      const sample = sceneWindField.getSampleWorld(sx, sy);
      spatial01 = sample.spatial01;
      fieldStrength01 = sample.strength01;
      inLull = sample.inLull;
      speed01 = fieldStrength01;
    }
  } catch (_) {}

  return { dirX, dirY, speed01, spatial01, fieldStrength01, inLull };
}

/**
 * Wind direction for three.quarks / Three.js particle drift (Y-up scene space).
 * Prefer {@link WaterEffectV2#getParticleWindDrift} so splashes/bubbles match the
 * live water surface (including Wind Override), regardless of update order.
 * @returns {{ dirX: number, dirY: number, speed01: number }}
 */
export function resolveEffectWindParticleDrift() {
  try {
    const water = getFloorCompositorV2()?._waterEffect;
    if (water && typeof water.getParticleWindDrift === 'function') {
      return water.getParticleWindDrift();
    }
  } catch (_) {}
  const w = resolveEffectWindWorld();
  return { dirX: w.dirX, dirY: w.dirY, speed01: w.speed01 };
}
