#!/usr/bin/env node
/**
 * Merge a "Current Effect Settings" export into data/presets/baseline.json,
 * then neutralize live weather state (clear/dry defaults).
 *
 * Usage: node scripts/tools/update-baseline-from-export.mjs <export.txt>
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '../..');
const presetPath = path.join(root, 'data/presets/baseline.json');

const SKIP_KEYS = new Set([
  'textureStatus',
  'statusSubject',
  'statusProbeAge',
  'statusOutdoorsSample',
  'statusIndoorOutdoor',
  'statusState',
  'statusMaskProbe',
  'statusCcOverlay',
  'statusSkyCondition',
  'statusDayPhase',
  'statusContextKey',
  'statusCoverShadow',
  'statusEyeAdaptation',
  'queueFromCurrent',
  'startQueuedTransition',
  'rebuildRainFlowMap',
  'triggerSmallStrike',
  'triggerBigStrike',
  'triggerStrikeSeries',
]);

function parseValue(raw) {
  const s = String(raw).trim();
  if (s === 'undefined') return undefined;
  if (s === 'true') return true;
  if (s === 'false') return false;
  if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s);
  if ((s.startsWith('{') && s.endsWith('}')) || (s.startsWith('[') && s.endsWith(']'))) {
    try {
      return JSON.parse(s);
    } catch {
      return s;
    }
  }
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1);
  }
  return s;
}

function setNested(obj, keyPath, value) {
  const parts = keyPath.split('.');
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const p = parts[i];
    if (!cur[p] || typeof cur[p] !== 'object') cur[p] = {};
    cur = cur[p];
  }
  cur[parts[parts.length - 1]] = value;
}

function parseExport(text) {
  const effects = {};
  let current = null;

  for (const line of text.split(/\r?\n/)) {
    const effectMatch = line.match(/^--- Effect: (.+) ---$/);
    if (effectMatch) {
      current = effectMatch[1].trim();
      effects[current] = {};
      continue;
    }
    if (!current) continue;
    const eq = line.indexOf(' = ');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    if (!key || SKIP_KEYS.has(key)) continue;
    const value = parseValue(line.slice(eq + 3));
    if (value === undefined) continue;
    setNested(effects[current], key, value);
  }
  return effects;
}

function applyNeutralWeather(mm) {
  const weather = mm.weather;
  if (weather) {
    weather.dynamicEnabled = false;
    weather.dynamicPresetId = 'Temperate Plains';
    weather.dynamicEvolutionSpeed = 15;
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
    weather.transitionDuration = 0;
    weather.roofDripEnabled = false;
  }

  const cloud = mm.cloud;
  if (cloud) {
    cloud.cloudCover = 0;
  }

  const ashWeather = mm['ash-weather'];
  if (ashWeather) {
    ashWeather.enabled = false;
    ashWeather.ashIntensity = 0;
  }

  const weatherLightning = mm['weather-lightning'];
  if (weatherLightning) {
    weatherLightning.stormIntensity = 0;
  }
}

const exportPath = path.resolve(process.argv[2]);
if (!exportPath || !fs.existsSync(exportPath)) {
  console.error('Usage: node scripts/tools/update-baseline-from-export.mjs <export.txt>');
  process.exit(1);
}

const exportText = fs.readFileSync(exportPath, 'utf8');
const effects = parseExport(exportText);
const preset = JSON.parse(fs.readFileSync(presetPath, 'utf8'));

preset.name = 'Baseline';
preset.description =
  'Town River Bridge tuned baseline: warm sepia grade, rich lighting/shadows, water and vegetation polish. ' +
  'Weather starts clear/dry — apply mood presets for rain, storm, or overcast.';

preset.settings.mapMaker.effects = effects;
applyNeutralWeather(preset.settings.mapMaker.effects);

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

fs.writeFileSync(presetPath, `${JSON.stringify(preset, null, 2)}\n`);
console.log(`Updated ${presetPath} (${Object.keys(effects).length} effects, weather neutralized)`);
