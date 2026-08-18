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
});

document.getElementById('toggleBtn').addEventListener('click', () => remote.toggle());

let themeIdx = 0;
document.getElementById('themeBtn').addEventListener('click', () => {
  themeIdx = (themeIdx + 1) % THEMES.length;
  document.documentElement.dataset.theme = THEMES[themeIdx];
  log(`theme -> ${THEMES[themeIdx]}`);
});

remote.open();
