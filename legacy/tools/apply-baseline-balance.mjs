#!/usr/bin/env node
/**
 * Rebuild data/presets/baseline.json:
 *   1. Neutral display grade (identity color correction + sky — chart-safe)
 *   2. Balanced lighting / shadow stack (playable defaults)
 *   3. Moderate fog / bloom (atmosphere on, low color push)
 *
 * Run: node scripts/tools/apply-baseline-balance.mjs
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '../..');
const presetPath = path.join(root, 'data/presets/baseline.json');

const preset = JSON.parse(fs.readFileSync(presetPath, 'utf8'));
const mm = preset.settings.mapMaker.effects;

preset.name = 'Baseline';
preset.description =
  'Neutral starting preset: identity color grade and sky (no channel tints or golden push), ' +
  'with balanced lighting, shadows, and moderate fog/bloom for everyday scenes. ' +
  'Add mood presets on top rather than fighting wild defaults.';

/** Identity color-correction / grade (matches calibration-neutral chart reference). */
function applyNeutralGrade(cc) {
  if (!cc) return;
  cc.enabled = true;
  cc.todTimelineEnabled = false;
  cc.localWarmLightPreserve = 0;
  cc.localTodOverrideExposure = 0;
  cc.localTodOverrideSaturation = 1;
  cc.localWarmEmissiveAdd = 0;
  cc.exposure = 1;
  cc.dynamicExposure = 1;
  cc.temperature = 0;
  cc.tint = 0;
  cc.brightness = 0;
  cc.contrast = 1;
  cc.saturation = 1;
  cc.vibrance = 0;
  // Slight display lift so typical sRGB map art reads closer to the source PNG
  // (calibration-neutral keeps 1.0 for chart truth).
  cc.masterGamma = 1.12;
  cc.toneMapping = 0;
  cc.vignetteStrength = 0;
  cc.vignetteSoftness = 0;
  cc.grainStrength = 0;
  cc.atmosphereEnabled = false;
  cc.liftColor = { r: 0, g: 0, b: 0 };
  // Shader: pow(color, 1/gamma) — identity is 1.0, not schema UI midpoint 0.5.
  cc.gammaColor = { r: 1, g: 1, b: 1 };
  cc.gainColor = { r: 1, g: 1, b: 1 };

  for (let i = 0; i < 8; i++) {
    const p = `tod${i}`;
    cc[`${p}GlobalTintR`] = 1;
    cc[`${p}GlobalTintG`] = 1;
    cc[`${p}GlobalTintB`] = 1;
    cc[`${p}InteriorTintR`] = 1;
    cc[`${p}InteriorTintG`] = 1;
    cc[`${p}InteriorTintB`] = 1;
    cc[`${p}GlobalExposure`] = 0;
    cc[`${p}GlobalSaturation`] = 1;
    cc[`${p}InteriorExposure`] = 0;
    cc[`${p}InteriorSaturation`] = 1;
  }

  cc.atmosphereEnabled = false;
  cc.intensity = 1;
  cc.saturationBoost = 0;
  cc.vibranceBoost = 0;
  cc.shadowGradePreserve = 0.35;
  cc.calendarDarknessBlend = 1;
  cc.dayNightGradePull = 1;
  cc.nightExtraDarkness = 0;
  cc.autoIntensityEnabled = false;
  cc.autoIntensityStrength = 1;
  cc.sunriseHour = 6;
  cc.sunsetHour = 18;
  cc.goldenHourWidth = 1.3;
  cc.goldenStrength = 1;
  cc.goldenPower = 1;
  cc.goldenOutdoorRecolorStrength = 0;
  cc.goldenOutdoorRecolorColor = { r: 1, g: 1, b: 1 };
  cc.nightFloor = 0;
  cc.analyticStrength = 0.85;
  cc.turbidity = 0.22;
  cc.rayleighStrength = 0.63;
  cc.mieStrength = 0.35;
  cc.forwardScatter = 0.3;
  cc.weatherInfluence = 0.67;
  cc.cloudToTurbidity = 0.25;
  cc.precipToTurbidity = 0.72;
  cc.overcastDesaturate = 0;
  cc.overcastContrastReduce = 0;
  cc.tempWarmAtHorizon = 0;
  cc.tempCoolAtNoon = 0;
  cc.nightCoolBoost = 0;
  cc.goldenSaturationBoost = 0;
  cc.nightSaturationFloor = 0;
  cc.hazeLift = 0;
  cc.hazeContrastLoss = 0;
}

/** Sky / analytic grade: on but without golden-hour or temperature pushes. */
function applyNeutralSky(sky) {
  if (!sky) return;
  sky.enabled = true;
  sky.intensity = 1;
  sky.saturationBoost = 0;
  sky.vibranceBoost = 0;
  sky.goldenStrength = 1;
  sky.goldenPower = 1;
  sky.goldenOutdoorRecolorStrength = 0;
  sky.goldenOutdoorRecolorColor = { r: 1, g: 1, b: 1 };
  sky.goldenSaturationBoost = 0;
  sky.overcastDesaturate = 0;
  sky.overcastContrastReduce = 0;
  sky.tempWarmAtHorizon = 0;
  sky.tempCoolAtNoon = 0;
  sky.nightCoolBoost = 0;
  sky.hazeLift = 0;
  sky.hazeContrastLoss = 0;
  sky.skyTintDarknessLightsIntensity = 1;
  sky.noonExposureBoost = 0;
  sky.midnightExposureDrop = 0;
  sky.nightExtraDarkness = 0;
  sky.dayVignetteStrength = 0;
  sky.nightVignetteStrength = 0;
}

applyNeutralGrade(mm.colorCorrection);
applyNeutralSky(mm['sky-color']);

const lit = mm.lighting;
Object.assign(lit, {
  enabled: true,
  globalIllumination: 0.48,
  ambientDayScale: 0.86,
  ambientNightScale: 0.32,
  minIlluminationScale: 0.3,
  lightIntensity: 1.05,
  colorationStrength: 0.45,
  colorationReflectivity: 0.35,
  colorationSaturation: 0.55,
  colorationChromaCurve: 0.12,
  colorationAchromaticMix: 0.92,
  composeToneMapping: 0,
  composeToneExposure: 1,
  combinedShadowEffectStrength: 1.55,
  cloudShadowAmbientInfluence: 0.45,
  overheadShadowAmbientInfluence: 0.85,
  dynamicLightShadowOverrideStrength: 0,
  structuralSunAmbientOcclusion: 0.34,
  directStructuralOcclusionStrength: 0.28,
  interiorDarkness: 0,
  lightAnimWindInfluence: 1,
  lightAnimOutdoorPower: 1.4,
  negativeDarknessStrength: 0.58,
  darknessPunchGain: 0,
});

const atmo = mm['atmospheric-fog'];
if (atmo) {
  atmo.enabled = true;
  atmo.maxOpacity = 0.66;
  atmo.hdrHazeStrength = 0.88;
  atmo.fogRefLuminance = 0.18;
  atmo.lightOcclusionStrength = 0.62;
  atmo.darknessStrength = 0;
  atmo.darknessColorMin = 0.32;
  atmo.indoorFogReduction = 0.85;
  atmo.macroStrength = 0.48;
  atmo.cutoutStrength = 0.45;
}

const fog = mm.fog;
if (fog) {
  fog.enabled = true;
  fog.exploredOpacity = 0.42;
  fog.softness = 2.5;
  fog.noiseStrength = 1.4;
}

const bloom = mm.bloom;
if (bloom) {
  bloom.enabled = true;
  bloom.strength = 0.42;
  bloom.threshold = 1.35;
  bloom.waterSpecularBloomStrength = 3.5;
}

const spec = mm.specular;
if (spec) {
  spec.enabled = true;
  spec.intensity = 0.22;
  spec.buildingShadowSuppressionStrength = 0.55;
}

const weather = mm.weather;
if (weather) {
  weather.dynamicEnabled = false;
  weather.dynamicPaused = true;
  weather.precipitation = 0;
  weather.cloudCover = 0;
  weather.fogDensity = 0;
  weather.wetness = 0;
  weather.freezeLevel = 0;
  weather.ashIntensity = 0;
  weather.queuedPrecipitation = 0;
  weather.queuedCloudCover = 0;
  weather.queuedWindSpeed = 0;
  weather.queuedWindDirection = 180;
  weather.queuedFogDensity = 0;
  weather.queuedFreezeLevel = 0;
  weather.queuedAshIntensity = 0;
  weather.roofDripEnabled = false;
}

const win = mm['window-lights'] ?? mm.windowLights;
if (win) {
  win.rainOnGlassEnabled = false;
}

const ashWeather = mm['ash-weather'];
if (ashWeather) {
  ashWeather.enabled = false;
  ashWeather.ashIntensity = 0;
}

preset.controlState = {
  timeOfDay: 12,
  timeTransitionMinutes: 0,
  linkTimeToFoundry: false,
  weatherMode: 'directed',
  weatherPanelView: 'manual',
  dynamicEnabled: false,
  dynamicPaused: true,
  directedPresetId: 'Clear (Dry)',
  directedTransitionMinutes: 0,
  directedCustomPreset: {
    precipitation: 0,
    cloudCover: 0,
    windSpeed: 0,
    windDirection: 180,
    fogDensity: 0,
    freezeLevel: 0,
  },
  windSpeedMS: 0,
  windDirection: 180,
  gustiness: 'calm',
  landscapeLightning: { lightning: 0 },
  manualFogDensity: 0,
};

if (win && typeof win.lightIntensity === 'number') {
  win.lightIntensity = Math.min(win.lightIntensity, 1.4);
}

fs.writeFileSync(presetPath, `${JSON.stringify(preset, null, 2)}\n`);
console.log('Updated', presetPath);
