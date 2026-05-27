#!/usr/bin/env node
/**
 * One-shot builder for data/presets/calibration-neutral.json from baseline.
 * Run: node scripts/tools/build-calibration-neutral-preset.mjs
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '../..');
const baselinePath = path.join(REPO, 'data/presets/baseline.json');
const outPath = path.join(REPO, 'data/presets/calibration-neutral.json');

const baseline = JSON.parse(fs.readFileSync(baselinePath, 'utf8'));
const preset = structuredClone(baseline);

preset.id = 'calibration-neutral';
preset.name = 'Calibration Neutral';
preset.description =
  'Display-neutral reference for color-chart calibration scenes only. ' +
  'Minimizes grade, fog, bloom, and mood lighting so measured patches should match authored sRGB. ' +
  'Do not use as a gameplay mood preset — tune on chart scene then promote values into baseline.';

const effects = preset.settings.mapMaker.effects;

const disableOptional = [
  'ash-weather', 'ash-disturbance', 'ash-clouds', 'bloom', 'atmospheric-fog', 'sepia', 'lens',
  'invert', 'dotScreen', 'halftone', 'ascii', 'dazzleOverlay', 'fire-sparks', 'lightning',
  'weather-lightning', 'candle-flames', 'dust', 'water-splashes', 'underwater-bubbles',
  'smelly-flies', 'fluid', 'iridescence', 'prism', 'sharpen', 'fog',
];

for (const id of disableOptional) {
  if (effects[id]) effects[id].enabled = false;
}

if (effects.weather) {
  effects.weather.dynamicEnabled = false;
  effects.weather.dynamicPaused = true;
  effects.weather.precipitation = 0;
  effects.weather.cloudCover = 0;
  effects.weather.fogDensity = 0;
  effects.weather.ashIntensity = 0;
}

if (effects.lighting) {
  effects.lighting.enabled = true;
  effects.lighting.lightIntensity = 1;
  effects.lighting.colorationStrength = 0;
  effects.lighting.colorationReflectivity = 0;
  effects.lighting.colorationSaturation = 0;
  effects.lighting.colorationChromaCurve = 0;
  effects.lighting.colorationAchromaticMix = 1;
  effects.lighting.ambientDayScale = 1;
  effects.lighting.ambientNightScale = 1;
  effects.lighting.globalIllumination = 1;
  effects.lighting.minIlluminationScale = 1;
  effects.lighting.interiorDarkness = 0;
  effects.lighting.negativeDarknessStrength = 0;
  effects.lighting.darknessPunchGain = 0;
  effects.lighting.combinedShadowEffectStrength = 0;
}

if (effects.colorCorrection) {
  const cc = effects.colorCorrection;
  cc.enabled = true;
  cc.exposure = 1;
  cc.dynamicExposure = 1;
  cc.temperature = 0;
  cc.tint = 0;
  cc.brightness = 0;
  cc.contrast = 1;
  cc.saturation = 1;
  cc.vibrance = 0;
  cc.masterGamma = 1;
  cc.toneMapping = 0;
  cc.todTimelineEnabled = false;
  cc.atmosphereEnabled = false;
  cc.vignetteStrength = 0;
  cc.vignetteSoftness = 0;
  cc.grainStrength = 0;
  cc.localWarmLightPreserve = 0;
  cc.localTodOverrideExposure = 0;
  cc.localTodOverrideSaturation = 1;
  cc.localWarmEmissiveAdd = 0;
  cc.liftColor = { r: 0, g: 0, b: 0 };
  cc.gammaColor = { r: 1, g: 1, b: 1 };
  cc.gainColor = { r: 1, g: 1, b: 1 };
  for (let i = 0; i < 8; i++) {
    cc[`tod${i}GlobalTintR`] = 1;
    cc[`tod${i}GlobalTintG`] = 1;
    cc[`tod${i}GlobalTintB`] = 1;
    cc[`tod${i}InteriorTintR`] = 1;
    cc[`tod${i}InteriorTintG`] = 1;
    cc[`tod${i}InteriorTintB`] = 1;
    cc[`tod${i}GlobalExposure`] = 0;
    cc[`tod${i}GlobalSaturation`] = 1;
    cc[`tod${i}InteriorExposure`] = 0;
    cc[`tod${i}InteriorSaturation`] = 1;
  }
}

if (effects['player-light']) {
  effects['player-light'].enabled = false;
}

if (effects.windowLight) {
  effects.windowLight.enabled = false;
}

if (effects.filter) {
  effects.filter.enabled = false;
}

delete preset.controlState;

fs.writeFileSync(outPath, JSON.stringify(preset, null, 2), 'utf8');
console.log(`Wrote ${outPath}`);
