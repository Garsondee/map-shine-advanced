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

    // 1. Check Susceptibility
    const susceptibility = particle._windSusceptibility;
    if (susceptibility <= 0.001) return; // Optimization: Skip indoor particles

    // 2. Get Global Wind State
    const state = weatherController.getCurrentState();
    const windSpeed = state.windSpeed || 0;
    if (windSpeed <= 0.001) return;

    const windDir = state.windDirection; // Vector2
    if (!windDir) return;

    // 3. Calculate Force
    // Base magnitude scaling matches FireSparksEffect / WeatherParticles tuning
    // We can allow an optional system-level multiplier via system.userData or similar if needed.
    // For now, we use a standard base force of 300.0 (matches FireSparksEffect).
    
    // Check for system-level overrides
    let influence = 1.0;
    if (system && system.userData && typeof system.userData.windInfluence === 'number') {
        influence = system.userData.windInfluence;
    }

    const forceMag = windSpeed * 300.0 * influence * susceptibility;

    // 4. Apply to Velocity
    // Standard Euler integration: v += a * dt
    // Wind acts as a force (acceleration).
    
    if (particle.velocity) {
      particle.velocity.x += windDir.x * forceMag * delta;
      particle.velocity.y += windDir.y * forceMag * delta;
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
