/**
 * @fileoverview Per-frame unified shadow driver snapshot.
 */

import { weatherController } from '../../core/WeatherController.js';
import {
  computeShadowTimeTuning,
  getShadowSystemTuning,
  getUnifiedShadowLatitudeScale,
  clamp01,
} from './SunDirection.js';
import {
  computeShadowSunDirection2D,
  applyShadowSunDirection,
} from './ShadowSunDirection.js';
import { ShadowMaskBindings } from './ShadowMaskBindings.js';

const safeNumber = (value, fallback = 0) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
};

export class ShadowDriverState {
  constructor() {
    this.maskBindings = new ShadowMaskBindings();
    this.frame = 0;
    this.sun = {
      azimuthDeg: 180,
      elevationDeg: 45,
      dir: { x: 0, y: 1 },
      dirLength: 1.0,
    };
    this.weather = {
      cloudCover: 0,
      overcastFactor: 0,
      stormFactor: 0,
      effectiveDarkness: 0,
      sunlightFactor: 1,
      skyIntensity: 1,
    };
    this.masks = {
      activeOutdoors: null,
      activeSkyReach: null,
      activeFloorAlpha: null,
      floorIdTexture: null,
      upperFloorAlphaTextures: [],
      upperFloorAlphaKeys: [],
    };
    this.dynamicLightOverride = null;
    this.tuning = {
      cloudDiffusionFactor: 3.0,
      shadowSoftnessScale: 1.0,
      shadowLengthScale: 1.0,
      shadowSmearScale: 1.0,
      shadowOpacityScale: 1.0,
      shadowSharpenForSunPower: 1.0,
      timeSoftnessScale: 1.0,
      timeLengthScale: 1.0,
      timeSmearScale: 1.0,
    };
  }

  /**
   * Build a coherent frame snapshot. Call once per FloorCompositor frame after
   * SkyColorEffectV2.update() and light override mask rendering.
   */
  update({
    floorCompositor = null,
    skyColorEffect = null,
    lightingPerspectiveContext = null,
    dynamicLightOverride = null,
    activeFloorIndex = 0,
  } = {}) {
    this.frame += 1;
    const env = weatherController?.getEnvironment?.() ?? null;
    const currentWeather = weatherController?.getCurrentState?.() ?? {};
    const cloudCover = clamp01(currentWeather?.cloudCover ?? env?.cloudCover ?? 0, 0);
    const sunlightFactor = clamp01(env?.sunlightFactor ?? env?.skyIntensity ?? 1, 1);
    const overcastFactor = clamp01(env?.overcastFactor ?? cloudCover, cloudCover);
    const effectiveDarkness = clamp01(env?.effectiveDarkness ?? 0, 0);
    const azimuthDeg = safeNumber(skyColorEffect?.currentSunAzimuthDeg, 180);
    const elevationDeg = safeNumber(skyColorEffect?.currentSunElevationDeg, 45);
    const latitudeScale = getUnifiedShadowLatitudeScale(
      safeNumber(floorCompositor?._overheadShadowEffect?.params?.sunLatitude, 0.1),
    );
    const prev = this.sun?.dir ?? null;
    const sun2d = computeShadowSunDirection2D({
      azimuthRad: azimuthDeg * (Math.PI / 180.0),
      elevationDeg,
      latitudeScale,
      previousDir: prev,
    });

    this.sun = {
      azimuthDeg,
      elevationDeg,
      dir: { x: sun2d.x, y: sun2d.y },
      dirLength: Math.sqrt(Math.max(sun2d.lengthSq, 0)),
    };
    this.weather = {
      cloudCover,
      overcastFactor,
      stormFactor: clamp01(env?.stormFactor ?? currentWeather?.precipitation ?? 0, 0),
      effectiveDarkness,
      sunlightFactor,
      skyIntensity: clamp01(env?.skyIntensity ?? 1, 1),
      environment: env,
      current: currentWeather,
    };
    const receiverBaseIndex = this._resolveReceiverBaseIndex(activeFloorIndex);
    const upper = this.maskBindings.getUpperFloorAlphaStack({ receiverBaseIndex });
    this.masks = {
      activeOutdoors: this.maskBindings.getActiveOutdoors({
        purpose: 'shadow-receiver',
        levelContext: window.MapShine?.activeLevelContext ?? null,
      }),
      activeSkyReach: this.maskBindings.getActiveSkyReach(),
      activeFloorAlpha: this.maskBindings.getActiveFloorAlpha(),
      floorIdTexture: this.maskBindings.floorIdTexture,
      upperFloorAlphaTextures: upper.textures,
      upperFloorAlphaKeys: upper.keys,
      receiverBaseIndex,
      lightingPerspectiveContext,
    };
    this.dynamicLightOverride = dynamicLightOverride ?? null;
    this.tuning = this._deriveTuning();
    return this;
  }

  publish(effects = []) {
    for (const effect of effects) {
      try {
        effect?.setDriver?.(this);
      } catch (_) {}
    }
  }

  _resolveReceiverBaseIndex(activeFloorIndex) {
    return Number.isFinite(Number(activeFloorIndex)) ? Number(activeFloorIndex) : 0;
  }

  _deriveTuning() {
    const cfg = getShadowSystemTuning();
    const cloud = this.weather.cloudCover;
    const cloudDiffusionFactor = Number(cfg.cloudDiffusionFactor) || 3.0;
    const cloudSoftnessMul = 1.0 + (cloudDiffusionFactor - 1.0) * cloud;

    let hour = 12.0;
    let sunriseHour = 6.0;
    try {
      if (weatherController && typeof weatherController.timeOfDay === 'number') {
        hour = weatherController.timeOfDay;
      }
      const envSunrise = this.weather?.environment?.sunrise;
      if (Number.isFinite(Number(envSunrise))) sunriseHour = Number(envSunrise);
    } catch (_) {}

    const time = computeShadowTimeTuning(hour, sunriseHour, cfg);
    const elevationLengthMul = Math.max(0.15, this.sun.dirLength || 1.0);
    const shadowSoftnessScale = time.softnessScale * cloudSoftnessMul;
    const shadowLengthScale = time.lengthScale * elevationLengthMul;
    const shadowSmearScale = time.smearScale;
    const shadowOpacityScale = Math.max(0.25, 1.0 - this.weather.effectiveDarkness * 0.25);

    return {
      cloudDiffusionFactor,
      shadowSoftnessScale,
      shadowLengthScale,
      shadowSmearScale,
      shadowOpacityScale,
      shadowSharpenForSunPower: Math.pow(Math.max(0.0, this.weather.sunlightFactor), 1.0 / 2.2),
      timeSoftnessScale: time.softnessScale,
      timeLengthScale: time.lengthScale,
      timeSmearScale: time.smearScale,
      goldenFactor: time.goldenFactor,
      noonFactor: time.noonFactor,
      midnightFactor: time.midnightFactor,
    };
  }
}
