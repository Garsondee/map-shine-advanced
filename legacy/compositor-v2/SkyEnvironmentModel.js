/**
 * @fileoverview CPU-side analytic sky / outdoor atmosphere model.
 *
 * Evaluates weather-aware outdoor grade offsets and exported sky tint/sun data.
 * Camera Grade ({@link ColorCorrectionEffectV2}) applies `atmosphereGrade` on the
 * merged HDR frame; this module does not run a GPU pass.
 *
 * @module compositor-v2/SkyEnvironmentModel
 */

import { weatherController } from '../core/WeatherController.js';
import { getFoundryTimePhaseHours } from '../core/foundry-time-phases.js';
import { LightingDirector } from '../core/LightingDirector.js';

const clamp01 = (n) => Math.max(0, Math.min(1, n));

const wrapHour24 = (h) => {
  const hour = Number.isFinite(h) ? h : 0;
  return ((hour % 24) + 24) % 24;
};

const wrapDistHours = (a, b) => {
  const d = Math.abs(a - b);
  return Math.min(d, 24 - d);
};

const peakHour = (hour, center, widthHours) => {
  const d = wrapDistHours(hour, center);
  const t = clamp01(1 - d / Math.max(0.0001, widthHours));
  return t * t * (3 - 2 * t);
};

const lerp = (a, b, t) => a + (b - a) * t;

/** Default atmosphere tuning (shared by SkyColor facade and Camera Grade). */
export const DEFAULT_ATMOSPHERE_PARAMS = Object.freeze({
  intensity: 1,
  saturationBoost: 0.5,
  vibranceBoost: 0.07,

  sunriseHour: 6.0,
  sunsetHour: 18.0,
  goldenHourWidth: 6.0,
  goldenStrength: 4,
  goldenPower: 3,
  nightFloor: 0.5,

  analyticStrength: 0.85,
  turbidity: 0.22,
  rayleighStrength: 0.63,
  mieStrength: 0.35,
  forwardScatter: 0.3,

  weatherInfluence: 0.67,
  cloudToTurbidity: 0.25,
  precipToTurbidity: 0.72,
  overcastDesaturate: 0.3,
  overcastContrastReduce: 0.38,

  tempWarmAtHorizon: 0.85,
  tempCoolAtNoon: -0.45,
  nightCoolBoost: -0.25,
  goldenSaturationBoost: 0.29,
  nightSaturationFloor: 0.33,
  hazeLift: 0.08,
  hazeContrastLoss: 0.0,

  autoIntensityEnabled: false,
  autoIntensityStrength: 1.0,
  goldenOutdoorRecolorStrength: 3.25,
  goldenOutdoorRecolorColor: { r: 1.35, g: 0.80, b: 0.50 },

  shadowGradePreserve: 0.35,

  calendarDarknessBlend: 1.0,
  dayNightGradePull: 1.0,
  nightExtraDarkness: 0.0,
});

/**
 * @typedef {object} AtmosphereGrade
 * @property {number} exposureStops
 * @property {number} saturationMul
 * @property {number} contrastMul
 * @property {{ r: number, g: number, b: number }} tintMul
 * @property {number} goldenRecolorStrength
 * @property {{ r: number, g: number, b: number }} goldenRecolorColor
 * @property {number} strength - effective outdoor atmosphere blend 0..1
 * @property {number} shadowGradePreserve
 */

/**
 * @typedef {object} SkyEnvironmentState
 * @property {{ r: number, g: number, b: number }} skyTintColor
 * @property {number} skyIntensity01
 * @property {number} sunAzimuthDeg
 * @property {number} sunElevationDeg
 * @property {AtmosphereGrade} atmosphereGrade
 * @property {number} dayFactor
 * @property {number} effectiveDarkness
 */

/**
 * @param {number} temperature
 * @param {number} [tint=0]
 * @returns {{ r: number, g: number, b: number }}
 */
export function temperatureToTintMul(temperature, tint = 0) {
  const t = temperature;
  let tr;
  let tg;
  let tb;
  if (t >= 0) {
    tr = 1.0 + t * 0.4;
    tg = 1.0 - t * 0.15;
    tb = 1.0 - t * 0.55;
  } else {
    const at = -t;
    tr = 1.0 - at * 0.45;
    tg = 1.0 - at * 0.1;
    tb = 1.0 + at * 0.4;
  }
  const tintShiftG = 1.0 + tint;
  return {
    r: Math.max(0.01, tr),
    g: Math.max(0.01, tg * tintShiftG),
    b: Math.max(0.01, tb),
  };
}

/**
 * @param {Record<string, *>} params
 * @returns {number}
 */
function sceneDarknessForAtmosphere(params) {
  const director = LightingDirector.get();
  let sceneDarkness = clamp01(director.masterDarkness);
  const blend = clamp01(Number(params?.calendarDarknessBlend) ?? 1);
  if (blend < 1) {
    sceneDarkness = clamp01(
      director.foundryDarkness * (1 - blend) + sceneDarkness * blend,
    );
  }
  return sceneDarkness;
}

/**
 * Evaluate sky environment and outdoor atmosphere offsets for the current frame.
 *
 * @param {Record<string, *>} params - atmosphere tuning (see {@link DEFAULT_ATMOSPHERE_PARAMS})
 * @returns {SkyEnvironmentState}
 */
export function evaluateSkyEnvironment(params = {}) {
  const p = { ...DEFAULT_ATMOSPHERE_PARAMS, ...params };
  const director = LightingDirector.get();
  const hourRaw = Number.isFinite(Number(director?.hour))
    ? Number(director.hour)
    : (weatherController?.timeOfDay ?? 12.0);
  const hour = wrapHour24(hourRaw);

  let exposure = 0.0;
  let temperature = 0.0;
  let contrast = 1.0;
  let saturation = 1.0;
  let goldenEnergy = 0.0;
  let dayProgress = -1.0;
  let effectiveDarkness = 0.0;
  let dayFactor = 0.5;

  const isFoundryLinked = globalThis.window?.MapShine?.controlPanel?.controlState?.linkTimeToFoundry === true;
  const foundryPhases = isFoundryLinked ? getFoundryTimePhaseHours() : null;
  const sunrise = wrapHour24(Number.isFinite(foundryPhases?.sunrise) ? foundryPhases.sunrise : p.sunriseHour);
  const sunset = wrapHour24(Number.isFinite(foundryPhases?.sunset) ? foundryPhases.sunset : p.sunsetHour);

  dayProgress = 0.0;
  if (sunrise < sunset) {
    if (hour >= sunrise && hour <= sunset) {
      dayProgress = (hour - sunrise) / Math.max(0.0001, sunset - sunrise);
    } else {
      dayProgress = -1.0;
    }
  } else {
    const span = (24 - sunrise) + sunset;
    if (hour >= sunrise) {
      dayProgress = (hour - sunrise) / Math.max(0.0001, span);
    } else if (hour <= sunset) {
      dayProgress = (24 - sunrise + hour) / Math.max(0.0001, span);
    } else {
      dayProgress = -1.0;
    }
  }

  const sunFactorRaw = dayProgress >= 0.0 ? Math.sin(Math.PI * clamp01(dayProgress)) : 0.0;
  const dayFactorBase = Math.max(clamp01(p.nightFloor), clamp01(sunFactorRaw));

  const goldenWidth = Math.max(0.0001, p.goldenHourWidth);
  const goldenBase = clamp01(peakHour(hour, sunrise, goldenWidth) + peakHour(hour, sunset, goldenWidth));
  const goldenPow = Math.pow(goldenBase, Math.max(0.0001, p.goldenPower ?? 1.0));
  const golden = clamp01(goldenPow * Math.max(0.0, p.goldenStrength ?? 1.0));
  goldenEnergy = Math.max(0.0, Math.min(3.0, goldenPow * Math.max(0.0, p.goldenStrength ?? 1.0)));
  dayFactor = Math.max(dayFactorBase, golden * 0.45);

  const state = weatherController?.getCurrentState ? weatherController.getCurrentState() : null;
  const cloudCover = clamp01(state?.cloudCover ?? 0.0);
  const precipitation = clamp01(state?.precipitation ?? 0.0);
  let overcast = clamp01(cloudCover * 0.8 + precipitation * 0.6);
  let storm = precipitation;

  const env = weatherController?.getEnvironment ? weatherController.getEnvironment() : null;
  if (env) {
    if (Number.isFinite(env.overcastFactor)) overcast = clamp01(env.overcastFactor);
    if (Number.isFinite(env.stormFactor)) storm = clamp01(env.stormFactor);
  }

  const sceneDarkness = sceneDarknessForAtmosphere(p);
  const gradePull = Math.max(0, Number(p.dayNightGradePull) ?? 1);
  const nightExtra = Math.max(0, Number(p.nightExtraDarkness) || 0);

  const weatherInfluence = clamp01(p.weatherInfluence);
  const turbidityBase = clamp01(p.turbidity);
  const turbidityWeather = weatherInfluence * (
    (p.cloudToTurbidity ?? 0.0) * cloudCover +
    (p.precipToTurbidity ?? 0.0) * precipitation
  );
  const turbidityEff = clamp01(turbidityBase + turbidityWeather);

  effectiveDarkness = clamp01(
    sceneDarkness +
    overcast * 0.08 * weatherInfluence +
    storm * 0.06 * weatherInfluence +
    nightExtra,
  );

  const rayleigh = clamp01(p.rayleighStrength);
  const mie = clamp01(p.mieStrength);
  const forward = clamp01(p.forwardScatter);

  temperature =
    (p.tempWarmAtHorizon ?? 0.0) * golden * (0.5 + 0.5 * mie) +
    (p.tempCoolAtNoon ?? 0.0) * dayFactor * rayleigh +
    (p.nightCoolBoost ?? 0.0) * effectiveDarkness;

  const overcastDesat = clamp01(p.overcastDesaturate);
  const overcastContrast = clamp01(p.overcastContrastReduce);
  const hazeLoss = clamp01(p.hazeContrastLoss);

  saturation = 1.0;
  saturation += (p.goldenSaturationBoost ?? 0.0) * golden;
  saturation *= 1.0 - overcastDesat * overcast * weatherInfluence;
  saturation *= 1.0 - (turbidityEff * mie) * 0.35;
  const nightSatFloor = clamp01(p.nightSaturationFloor);

  contrast = 1.0;
  const overcastContrastNightWeight = 0.2;
  const overcastContrastWeight = lerp(overcastContrastNightWeight, 1.0, dayFactor);
  contrast *= 1.0 - overcastContrast * overcast * weatherInfluence * overcastContrastWeight;
  contrast *= 1.0 - turbidityEff * mie * hazeLoss;
  contrast *= 1.0 - effectiveDarkness * 0.2 * Math.min(1.5, gradePull);
  contrast = Math.max(0.5, Math.min(1.5, contrast));

  const daylightGradeFactor = dayProgress >= 0.0 ? dayFactor : 0.0;

  exposure = 0.25 * daylightGradeFactor
    - 0.35 * effectiveDarkness * gradePull
    - 0.10 * turbidityEff;
  exposure += forward * golden * 0.05;
  exposure = Math.max(-1.0, Math.min(1.0, exposure));

  const analyticStrength = Math.max(0.0, p.analyticStrength ?? 1.0);
  temperature = Math.max(-1.0, Math.min(1.0, temperature * analyticStrength));
  exposure = Math.max(-1.0, Math.min(1.0, exposure * analyticStrength));
  saturation = Math.max(0.0, Math.min(2.0, 1.0 + (saturation - 1.0) * analyticStrength));
  contrast = Math.max(0.5, Math.min(1.5, 1.0 + (contrast - 1.0) * analyticStrength));

  saturation = Math.max(nightSatFloor, lerp(saturation, nightSatFloor, effectiveDarkness * 0.75));
  saturation = Math.max(0.0, Math.min(2.0, saturation + (p.saturationBoost ?? 0.0)));

  const tintMul = temperatureToTintMul(temperature, 0.0);

  // Sky tint for downstream systems (water, windows, lights).
  const calNightBoost = dayProgress < 0 ? 0.38 : 0.0;
  const nightSkyMix = clamp01(effectiveDarkness * 0.82 + calNightBoost);
  const deepR = 0.22;
  const deepG = 0.34;
  const deepB = 0.92;
  const skyTintColor = {
    r: lerp(tintMul.r, deepR, nightSkyMix),
    g: lerp(tintMul.g, deepG, nightSkyMix),
    b: lerp(tintMul.b, deepB, nightSkyMix),
  };

  let effectiveIntensity = clamp01(Number(p.intensity) ?? 1);
  if (p.autoIntensityEnabled) {
    const localDayFactor = clamp01(dayFactor);
    const localSceneDarkness = sceneDarknessForAtmosphere(p);
    const localGradeIntensity = clamp01(
      (0.35 + 0.65 * (1.0 - localDayFactor)) *
      (0.85 + 0.15 * (1.0 - localSceneDarkness)),
    );
    const strength = clamp01(p.autoIntensityStrength);
    effectiveIntensity *= lerp(1.0, localGradeIntensity, strength);
  }

  const rc = p.goldenOutdoorRecolorColor ?? { r: 1.35, g: 0.80, b: 0.50 };
  const goldenRecolorStrength = clamp01(
    goldenEnergy * Math.max(0.0, Number(p.goldenOutdoorRecolorStrength ?? 0.0)),
  );

  const sunAzimuthDeg = Number.isFinite(director.sunAzDeg) ? director.sunAzDeg : 180.0;
  const sunElevationDeg = Number.isFinite(director.sunElDeg) ? director.sunElDeg : 45.0;

  return {
    skyTintColor,
    skyIntensity01: clamp01(effectiveIntensity),
    sunAzimuthDeg,
    sunElevationDeg,
    dayFactor,
    effectiveDarkness,
    atmosphereGrade: {
      exposureStops: exposure,
      saturationMul: saturation,
      contrastMul: contrast,
      tintMul,
      goldenRecolorStrength,
      goldenRecolorColor: {
        r: Math.max(0.01, Number(rc.r) || 1.35),
        g: Math.max(0.01, Number(rc.g) || 0.80),
        b: Math.max(0.01, Number(rc.b) || 0.50),
      },
      strength: clamp01(effectiveIntensity),
      shadowGradePreserve: clamp01(p.shadowGradePreserve ?? 0.35),
    },
  };
}

/**
 * Copy atmosphere keys from a legacy SkyColor params object into Camera Grade params.
 * @param {Record<string, *>} target
 * @param {Record<string, *>} [source]
 */
export function migrateAtmosphereParams(target, source) {
  if (!target || !source) return;
  for (const key of Object.keys(DEFAULT_ATMOSPHERE_PARAMS)) {
    if (Object.prototype.hasOwnProperty.call(source, key) && !Object.prototype.hasOwnProperty.call(target, key)) {
      const v = source[key];
      if (v != null && typeof v === 'object' && !Array.isArray(v)) {
        target[key] = { ...v };
      } else {
        target[key] = v;
      }
    }
  }
}

/**
 * Pick atmosphere tuning keys from a params bag (Camera Grade or legacy Sky Color).
 * @param {Record<string, *>} params
 * @returns {Record<string, *>}
 */
export function pickAtmosphereParams(params) {
  if (!params) return {};
  const out = {};
  for (const key of Object.keys(DEFAULT_ATMOSPHERE_PARAMS)) {
    if (Object.prototype.hasOwnProperty.call(params, key)) {
      const v = params[key];
      if (v != null && typeof v === 'object' && !Array.isArray(v)) {
        out[key] = { ...v };
      } else {
        out[key] = v;
      }
    }
  }
  return out;
}
