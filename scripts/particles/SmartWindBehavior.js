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
  }

  initialize(particle, system) {
    // If susceptibility is not set, default to 1.0 (Outdoors/Legacy behavior)
    if (typeof particle._windSusceptibility !== 'number') {
      particle._windSusceptibility = 1.0;
    }
  }

  update(particle, delta, system) {
    if (!particle || typeof delta !== 'number') return;

    // Sanity check delta to prevent physics explosions on lag spikes
    let dt = delta;
    if (!Number.isFinite(dt)) return;
    dt = Math.min(Math.max(dt, 0), 0.1);
    if (dt <= 0.0001) return;

    // 1. Check Susceptibility
    const susceptibility = typeof particle._windSusceptibility === 'number'
      ? particle._windSusceptibility
      : 1.0;
    if (!Number.isFinite(susceptibility) || susceptibility <= 0.001) return; // Optimization: Skip indoor particles

    // 2. Get Global Wind State
    const state = weatherController.getCurrentState();
    let windSpeed = state && typeof state.windSpeed === 'number' ? state.windSpeed : 0;
    if (!Number.isFinite(windSpeed) || windSpeed <= 0.001) return;

    const windDir = state && state.windDirection; // Vector2
    if (!windDir || !Number.isFinite(windDir.x) || !Number.isFinite(windDir.y)) return;

    // 3. Calculate Force
    // Base magnitude scaling matches FireSparksEffect / WeatherParticles tuning
    // We can allow an optional system-level multiplier via system.userData or similar if needed.
    // For now, we use a standard base force of 300.0 (matches FireSparksEffect).
    
    // Check for system-level overrides
    let influence = 1.0;
    if (system && system.userData && typeof system.userData.windInfluence === 'number') {
        influence = system.userData.windInfluence;
    }
    if (!Number.isFinite(influence)) influence = 1.0;

    // When influence is effectively zero (e.g. Fire UI Wind Influence = 0), we
    // want particles to *stop* being carried by the wind, not just stop
    // accelerating further. Apply a gentle horizontal damping so any existing
    // wind-driven velocity decays quickly.
    if (influence <= 0.001) {
      if (particle.velocity) {
        particle.velocity.x *= 0.85;
        particle.velocity.y *= 0.85;
      }
      return;
    }

    const forceMag = windSpeed * 300.0 * influence * susceptibility;
    if (!Number.isFinite(forceMag)) return;

    // 4. Apply to Velocity
    // Standard Euler integration: v += a * dt
    // Wind acts as a force (acceleration).
    
    if (particle.velocity) {
      const dvx = windDir.x * forceMag * dt;
      const dvy = windDir.y * forceMag * dt;

      if (Number.isFinite(dvx) && Number.isFinite(dvy)) {
        particle.velocity.x += dvx;
        particle.velocity.y += dvy;
      }
    }
  }

  frameUpdate(delta) { 
    // No per-frame global update needed, we pull from WeatherController directly
  }

  clone() {
    return new SmartWindBehavior();
  }

  reset() { 
    // No internal state to reset
  }
}
