/**
 * Remote Preview — U2's own "cheap eyes before Foundry eyes" rung, mirroring
 * tools/studio-preview/ for U1. Mounts the REAL `installRemote()` with a
 * REAL `createAstrolabe()` dial (imported directly, same as boot.js does)
 * fed FAKE phase bands and no-op engine callbacks — proving the shell,
 * corner clusters, and camera-path popover all render and wire correctly
 * without a live Foundry canvas, which only boot.js's own real integration
 * can ultimately prove (see Petition P11's honesty note on that gap).
 *
 * Run: node tools/shader-lab/serve.mjs, then open
 * http://localhost:8934/tools/remote-preview/index.html
 */
import { installTokens, THEMES } from '../../src/ui/tokens.js';
import { installRemote } from '../../src/ui/index.js';
import { createAstrolabe } from '../../src/ui/astrolabe.js';
import {
  WEATHER_ARCHETYPES,
  mergeFadeState,
  pruneExpired,
  computeEasedValue,
  isEntryExpired,
  createFadeSourceRegistry,
} from '../../src/world/index.js';

installTokens();
document.documentElement.dataset.theme = 'dark';

// ---- fake phase bands, real ringArcPath math (astrolabe.js's own) --------
const FAKE_PHASE_BANDS = [
  { key: 'night', startHour: 0, endHour: 5 },
  { key: 'astronomical', startHour: 5, endHour: 5.5 },
  { key: 'nautical', startHour: 5.5, endHour: 6 },
  { key: 'civil', startHour: 6, endHour: 6.5 },
  { key: 'golden', startHour: 6.5, endHour: 7.5 },
  { key: 'day', startHour: 7.5, endHour: 16.5 },
  { key: 'golden', startHour: 16.5, endHour: 17.5 },
  { key: 'civil', startHour: 17.5, endHour: 18 },
  { key: 'nautical', startHour: 18, endHour: 18.5 },
  { key: 'astronomical', startHour: 18.5, endHour: 19 },
  { key: 'night', startHour: 19, endHour: 24 },
];

const fakeSky = {
  todHour: 14,
  rateHoursPerMinute: 0,
  windDirectionDeg: 45,
  windSpeed01: 0.3,
  cloudCover01: 0.2,
  mode: 'almanac',
};

let remoteDialInstance = null;

function log(text) {
  document.getElementById('log').textContent = text;
}

// ---- THE REAL FADE ENGINE, fed a fake weather store ----------------------
// Every function below (mergeFadeState/computeEasedValue/isEntryExpired/
// pruneExpired/createFadeSourceRegistry) is the ACTUAL production code —
// only fakeSky and the tick loop stand in for boot.js's real skyScope/
// editSky/requestAnimationFrame wiring, proving the real fade math end to
// end in a browser, not just Node.
fakeSky.precip01 = 0;
fakeSky.weatherArchetype = 'clear';
const fadeRegistry = createFadeSourceRegistry();
fadeRegistry.registerSource('weather', {
  keys: () => ['cloudCover01', 'precip01'],
  typeOf: () => 'float',
  readLive: (field) => fakeSky[field] ?? 0,
  write: (field, value) => {
    fakeSky[field] = value;
  },
});
let fadeState = {};
const pendingCompletions = new Map();
function fadeToArchetype(archetypeId, overMs) {
  const archetype = WEATHER_ARCHETYPES.find((a) => a.id === archetypeId);
  if (!archetype) return;
  const nowMs = performance.now(); // preview-only stand-in for wallClockMs()
  const gestureId = `archetype:${archetypeId}:${nowMs}`;
  const targets = {};
  for (const field of ['cloudCover01', 'precip01']) {
    const to = archetype.axes?.[field];
    if (!Number.isFinite(to)) continue;
    targets[`weather.${field}`] = {
      to,
      type: 'float',
      overMs,
      curve: 'ease',
      from: fadeRegistry.readLive(`weather.${field}`),
    };
  }
  fadeState = mergeFadeState(fadeState, { id: gestureId, label: archetype.label, targets }, nowMs);
  pendingCompletions.set(gestureId, archetypeId);
  fakeSky.weatherArchetype = 'custom';
  log(`fading -> ${archetype.label} over ${overMs}ms`);
}
function tickFades() {
  const nowMs = performance.now();
  for (const [key, entry] of Object.entries(fadeState)) {
    if (isEntryExpired(entry, nowMs)) continue;
    fadeRegistry.write(key, computeEasedValue(entry, nowMs));
  }
  let anyCompleted = false;
  for (const [gestureId, archetypeId] of pendingCompletions) {
    const own = Object.values(fadeState).filter((e) => e.id === gestureId);
    if (own.length > 0 && own.every((e) => isEntryExpired(e, nowMs))) {
      pendingCompletions.delete(gestureId);
      fakeSky.weatherArchetype = archetypeId;
      log(`arrived -> ${archetypeId}`);
      anyCompleted = true;
    }
  }
  fadeState = pruneExpired(fadeState, nowMs);
  if (anyCompleted) remote.refreshWeatherBoard();
  requestAnimationFrame(tickFades);
}

const remote = installRemote({
  mountAstrolabeDial: (container) => {
    remoteDialInstance = createAstrolabe({
      phaseBands: FAKE_PHASE_BANDS,
      onTimeChange: (hour, committed) => {
        fakeSky.todHour = hour;
        log(`time -> ${hour.toFixed(2)} (committed=${committed})`);
      },
      onTimeStop: (hour) => log(`time stop -> ${hour}`),
      onTimeRateChange: (rate) => {
        fakeSky.rateHoursPerMinute = rate;
        log(`rate -> ${rate}`);
      },
      onTimeModeChange: (mode) => log(`mode -> ${mode}`),
      onWindDirectionChange: (deg) => (fakeSky.windDirectionDeg = deg),
      onWindSpeedChange: (v) => (fakeSky.windSpeed01 = v),
      onCloudChange: (v) => (fakeSky.cloudCover01 = v),
      onArchetypeChange: (id) => log(`archetype -> ${id}`),
      onWeatherModeChange: (m) => log(`weather mode -> ${m}`),
      onWeatherBiomeChange: (id) => log(`biome -> ${id}`),
      onWeatherVolatilityChange: () => {},
      onUnpinCloudCover: () => {},
      onSkyRealismChange: () => {},
      onGradeEnvChange: () => {},
      onSceneOverrideChange: () => {},
    });
    container.appendChild(remoteDialInstance.root);
    remoteDialInstance.update({ ...fakeSky, canSetHour: true, phase: 'day', rising: true });
  },
  getPosture: () => fakeSky.mode,
  isFlowPlaying: () => fakeSky.rateHoursPerMinute > 0,
  onFlowToggle: () => {
    fakeSky.rateHoursPerMinute = fakeSky.rateHoursPerMinute > 0 ? 0 : 1;
    log(`flow -> ${fakeSky.rateHoursPerMinute > 0 ? 'playing' : 'paused'}`);
    remoteDialInstance?.update({ ...fakeSky, canSetHour: true, phase: 'day', rising: true });
  },
  weatherBoard: {
    getWeatherMode: () => (fakeSky.weatherMode === 'almanac' ? 'almanac' : 'director'),
    onWeatherModeChange: (mode) => {
      fakeSky.weatherMode = mode;
      log(`weather mode -> ${mode}`);
    },
    getWeatherBiome: () => fakeSky.weatherBiome ?? null,
    onWeatherBiomeChange: (id) => {
      fakeSky.weatherBiome = id;
      log(`biome -> ${id}`);
    },
    getWeatherArchetype: () => fakeSky.weatherArchetype,
    fadeToArchetype: (archetypeId, overMs) => fadeToArchetype(archetypeId, overMs),
    getAxisValue: (axisName) => fadeRegistry.readLive(`weather.${axisName}`),
    onAxisCommit: (axisName, value) => {
      fakeSky[axisName] = value;
      fakeSky.weatherArchetype = 'custom';
      log(`${axisName} -> ${value}`);
    },
  },
  onBaseline: (overMs) => {
    fadeToArchetype('clear', overMs); // preview stand-in: "baseline" = clear sky
    log(`baseline -> fading to clear over ${overMs}ms`);
  },
});

requestAnimationFrame(tickFades);

document.getElementById('toggleBtn').addEventListener('click', () => remote.toggle());

let themeIdx = 0;
document.getElementById('themeBtn').addEventListener('click', () => {
  themeIdx = (themeIdx + 1) % THEMES.length;
  document.documentElement.dataset.theme = THEMES[themeIdx];
  log(`theme -> ${THEMES[themeIdx]}`);
});

remote.open();
