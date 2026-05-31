import { weatherController } from '../core/WeatherController.js';

/**
 * Applies buoyancy/updraft force per particle, respecting indoor/outdoor tags and rain.
 * - Indoor particles (_windSusceptibility ≈ 0) keep full updraft.
 * - Outdoor particles lose updraft strongly while precipitation is active.
 *
 * Magnitude is read from `system.userData.updraftForce` (typically an ApplyForce kept
 * off the behavior list so `_updateSystemParams` can drive the base strength).
 * Smoke systems set `userData.isSmoke` and use a map-plane updraft direction (XY+Z).
 */
export class SmartUpdraftBehavior {
  constructor() {
    this.type = 'SmartUpdraft';
    this._framePrecip = 0;
  }

  initialize(particle) {
    if (typeof particle._windSusceptibility !== 'number') {
      particle._windSusceptibility = 1.0;
    }
  }

  _readBaseMagnitude(system) {
    const force = system?.userData?.updraftForce;
    if (!force?.magnitude) return 0;
    if (typeof force.magnitude.value === 'number' && Number.isFinite(force.magnitude.value)) {
      return force.magnitude.value;
    }
    if (typeof force.magnitudeValue === 'number' && Number.isFinite(force.magnitudeValue)) {
      return force.magnitudeValue;
    }
    return 0;
  }

  _computeRainUpdraftScale(particle, system) {
    const outdoor = Math.max(0, Math.min(1, particle._windSusceptibility ?? 1.0));
    if (outdoor <= 0.001) return 1.0;

    const precip = this._framePrecip;
    if (!Number.isFinite(precip) || precip <= 0.001) return 1.0;

    const owner = system?.userData?.ownerEffect;
    const precipKill = owner?.params?.weatherPrecipKill ?? 0.5;
    const damp = Math.min(1.0, outdoor * precip * precipKill * 1.75);
    return Math.max(0.05, 1.0 - damp);
  }

  update(particle, delta, system) {
    if (!particle?.velocity || typeof delta !== 'number') return;

    let dt = delta;
    if (!Number.isFinite(dt)) return;
    dt = Math.min(Math.max(dt, 0), 0.1);
    if (dt <= 0.0001) return;

    const mag = this._readBaseMagnitude(system);
    if (!Number.isFinite(mag) || mag <= 0) return;

    let timeScale = 1.0;
    if (typeof particle._msTimeScaleFactor === 'number' && Number.isFinite(particle._msTimeScaleFactor)) {
      timeScale = Math.max(0.0, particle._msTimeScaleFactor);
    }

    const rainScale = this._computeRainUpdraftScale(particle, system);
    const motionScale = (typeof particle._flameMotionScale === 'number' && Number.isFinite(particle._flameMotionScale))
      ? Math.max(0, Math.min(1, particle._flameMotionScale))
      : 1;
    const scale = timeScale * rainScale * motionScale;
    if (scale <= 0.0001) return;

    const force = system?.userData?.updraftForce;
    const dir = force?.direction;
    if (dir) {
      particle.velocity.x += dir.x * mag * scale * dt;
      particle.velocity.y += dir.y * mag * scale * dt;
      particle.velocity.z += dir.z * mag * scale * dt;
    } else {
      particle.velocity.z += mag * scale * dt;
    }
  }

  frameUpdate() {
    let precip = 0;
    try {
      const state = (typeof weatherController?.getCurrentState === 'function')
        ? weatherController.getCurrentState()
        : (weatherController?.currentState ?? {});
      precip = state?.precipitation ?? 0;
    } catch (_) {
      precip = 0;
    }
    this._framePrecip = Number.isFinite(precip) ? precip : 0;
  }

  clone() {
    return new SmartUpdraftBehavior();
  }

  reset() {}
}
