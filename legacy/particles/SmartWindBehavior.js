import { weatherController } from '../core/WeatherController.js';

/**
 * Applies wind force to particles, respecting a per-particle susceptibility tag.
 * - Particles with `_windSusceptibility = 1.0` get full wind (Outdoors).
 * - Particles with `_windSusceptibility = 0.0` get no wind (Indoors).
 * - Values in between are interpolated.
 *
 * This replaces the standard ApplyForce for wind in systems that need indoor/outdoor awareness.
 */
export class SmartWindBehavior {
  constructor() {
    this.type = 'SmartWind';
    /** @type {{ windSpeed: number, windDirX: number, windDirY: number, hasWind: boolean }} */
    this._frameWind = { windSpeed: 0, windDirX: 0, windDirY: 0, hasWind: false };
  }

  initialize(particle, system) {
    // If susceptibility is not set, default to 1.0 (Outdoors/Legacy behavior)
    if (typeof particle._windSusceptibility !== 'number') {
      particle._windSusceptibility = 1.0;
    }
  }

  /** @private */
  _refreshFrameWind() {
    const cache = this._frameWind;
    cache.windSpeed = 0;
    cache.windDirX = 0;
    cache.windDirY = 0;
    cache.hasWind = false;

    let state;
    try {
      state = weatherController.getCurrentState();
    } catch (_) {
      return;
    }

    let windSpeed = 0;
    if (state && typeof state.windSpeedMS === 'number' && Number.isFinite(state.windSpeedMS)) {
      windSpeed = Math.max(0.0, Math.min(1.0, state.windSpeedMS / 78.0));
    } else if (state && typeof state.windSpeed === 'number' && Number.isFinite(state.windSpeed)) {
      windSpeed = Math.max(0.0, Math.min(1.0, state.windSpeed));
    }
    if (!Number.isFinite(windSpeed) || windSpeed <= 0.001) return;

    const windDir = state?.windDirection;
    if (!windDir || !Number.isFinite(windDir.x) || !Number.isFinite(windDir.y)) return;

    cache.windSpeed = windSpeed;
    cache.windDirX = windDir.x;
    cache.windDirY = windDir.y;
    cache.hasWind = true;
  }

  update(particle, delta, system) {
    if (!particle || typeof delta !== 'number') return;

    const isSmoke = !!(system && system.userData && system.userData.isSmoke);

    // Sanity check delta to prevent physics explosions on lag spikes
    let dt = delta;
    if (!Number.isFinite(dt)) return;
    dt = Math.min(Math.max(dt, 0), 0.1);
    if (dt <= 0.0001) return;

    // 1. Check Susceptibility
    let susceptibility = typeof particle._windSusceptibility === 'number'
      ? particle._windSusceptibility
      : 1.0;
    if (typeof particle._flameMotionScale === 'number' && Number.isFinite(particle._flameMotionScale)) {
      susceptibility *= Math.max(0, Math.min(1, particle._flameMotionScale));
    }
    if (!Number.isFinite(susceptibility) || susceptibility <= 0.001) return;

    const frameWind = this._frameWind;
    if (!frameWind.hasWind) {
      if (particle.velocity) {
        const decay = isSmoke ? 0.992 : 0.85;
        particle.velocity.x *= decay;
        particle.velocity.y *= decay;
      }
      return;
    }

    // Check for system-level overrides
    let influence = 1.0;
    if (system && system.userData && typeof system.userData.windInfluence === 'number') {
      influence = system.userData.windInfluence;
    }
    if (!Number.isFinite(influence)) influence = 1.0;

    if (influence <= 0.001) {
      if (particle.velocity) {
        particle.velocity.x *= 0.85;
        particle.velocity.y *= 0.85;
      }
      return;
    }

    const smokeWindMul = isSmoke ? 0.42 : 1.0;
    const forceMag = frameWind.windSpeed * 300.0 * influence * susceptibility * smokeWindMul;
    if (!Number.isFinite(forceMag)) return;

    if (particle.velocity) {
      const dvx = frameWind.windDirX * forceMag * dt;
      const dvy = frameWind.windDirY * forceMag * dt;

      if (Number.isFinite(dvx) && Number.isFinite(dvy)) {
        particle.velocity.x += dvx;
        particle.velocity.y += dvy;
      }
    }
  }

  frameUpdate(delta) {
    this._refreshFrameWind();
  }

  clone() {
    return new SmartWindBehavior();
  }

  reset() {}
}
