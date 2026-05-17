/**
 * @fileoverview Per-frame unified shadow driver snapshot.
 */

import { weatherController } from '../../core/WeatherController.js';
import { computeSunDirection2D, clamp01 } from './SunDirection.js';
import { ShadowMaskBindings } from './ShadowMaskBindings.js';

const safeNumber = (value, fallback = 0) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
};

export class ShadowDriverState {
  constructor() {
    this.maskBindings = new ShadowMaskBindings();
    this.frame = 0;
    this.sun = { azimuthDeg: 180, elevationDeg: 45, dir: { x: 0, y: 1 } };
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
      shadowOpacityScale: 1.0,
      shadowSharpenForSunPower: 1.0,
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
    const elevation = safeNumber(skyColorEffect?.currentSunElevationDeg, 45);
    const latitudeScale = safeNumber(floorCompositor?._overheadShadowEffect?.params?.sunLatitude, 0.1);
    const prev = this.sun?.dir ?? null;
    const sun = computeSunDirection2D(skyColorEffect?.currentSunAzimuthDeg, elevation, latitudeScale, prev);

    this.sun = {
      azimuthDeg: sun.azimuthDeg,
      elevationDeg: sun.elevationDeg,
      dir: { x: sun.x, y: sun.y },
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
    // Upper-floor masks & sky-reach casters use floors with index > receiverBaseIndex.
    // This MUST track the viewed (active) band — not the lowest visible floor — or
    // multi-level visibility keeps receiverBase pinned to ground while the camera
    // shows a higher story; sky-reach then darkens the wrong sheet (ground shadow on middle).
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

  /**
   * Active viewed floor index: floors strictly above this contribute to the upper
   * `floorAlpha` stack (sky occlusion, sky-reach casters). Tied to
   * {@link FloorCompositor#_activeFloorIndex}, not `min(visible)` — lower stories
   * can stay visible in the stack while the user navigates upstairs; pinning to
   * the lowest visible index mis-assigns the shadow receiver plane.
   */
  _resolveReceiverBaseIndex(activeFloorIndex) {
    return Number.isFinite(Number(activeFloorIndex)) ? Number(activeFloorIndex) : 0;
  }

  _deriveTuning() {
    const cloud = this.weather.cloudCover;
    const elevation01 = clamp01(this.sun.elevationDeg / 90.0, 0.5);
    const cloudDiffusionFactor = 3.0;
    const shadowSoftnessScale = 1.0 + (cloudDiffusionFactor - 1.0) * cloud;
    const shadowLengthScale = 1.0 + (1.0 - elevation01) * 1.5;
    const shadowOpacityScale = Math.max(0.25, 1.0 - this.weather.effectiveDarkness * 0.25);
    return {
      cloudDiffusionFactor,
      shadowSoftnessScale,
      shadowLengthScale,
      shadowOpacityScale,
      shadowSharpenForSunPower: Math.pow(Math.max(0.0, this.weather.sunlightFactor), 1.0 / 2.2),
    };
  }
}
