/**
 * Remote Preview — U2's own "cheap eyes before Foundry eyes" rung, mirroring
 * tools/studio-preview/ for U1. Mounts the REAL `installRemote()` with a
 * REAL `buildAstrolabeDial()` dial (imported directly, same as boot.js
 * does, since the 2026-08-18 fix — see astrolabe-dial.js's own header) fed
 * no-op engine callbacks — proving the shell, corner clusters, dial, and
 * camera-path popover all render and wire correctly without a live Foundry
 * canvas, which only boot.js's own real integration can ultimately prove
 * (see Petition P11's honesty note on that gap).
 *
 * Run: node tools/shader-lab/serve.mjs, then open
 * http://localhost:8934/tools/remote-preview/index.html
 */
import { installTokens, THEMES } from '../../src/ui/tokens.js';
import { installRemote, buildAstrolabeDial } from '../../src/ui/index.js';
import {
  WEATHER_ARCHETYPES,
  mergeFadeState,
  pruneExpired,
  computeEasedValue,
  isEntryExpired,
  createFadeSourceRegistry,
} from '../../src/world/index.js';
import { validateCue, orderedCues, cueToFadePatch } from '../../src/core/cues-schema.js';

installTokens();
document.documentElement.dataset.theme = 'dark';

const fakeSky = {
  todHour: 14,
  rateHoursPerMinute: 0,
  windDirectionDeg: 45,
  windSpeed01: 0.3,
  cloudCover01: 0.2,
  mode: 'almanac',
  // Realistically empty by default -- nothing in this harness simulates the
  // Almanac's own autonomous weather walk that pins/unpins axes for real.
  // To see the pin glyph, set `__preview.fakeSky.weatherPinnedAxes =
  // ['cloudCover01']` from devtools, then `__preview.remote.refreshWeatherBoard()`.
  weatherPinnedAxes: [],
};
// Mirrors boot.js's own lastNonZeroRateHoursPerMinute — the speed badge
// shows what flow will resume at, not the raw live rate (which is 0 while
// paused), same reasoning as boot.js's own getFlowRate comment.
let lastNonZeroRate = 1;

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

// ---- THE CUE DECK'S OWN SEED DATA (U3) ------------------------------------
// The Remote has no capture UI of its own (that's the CUES department's
// job, see tools/studio-preview/) — these two are throwaway harness seed
// data, matching the mock's own 3-entry CUES demo fixture in spirit, not
// real captured state. fireCueById uses the REAL validateCue/cueToFadePatch
// (core/cues-schema.js) feeding the SAME real mergeFadeState this file's
// own fadeToArchetype already uses above.
const cueStack = [
  {
    id: 'demo-golden',
    name: 'Act I — Golden Afternoon',
    order: 0,
    targets: {
      'weather.cloudCover01': { to: 0.15, overMs: 10000, curve: 'ease' },
      'weather.precip01': { to: 0, overMs: 10000, curve: 'ease' },
    },
  },
  {
    id: 'demo-storm',
    name: 'Act II — The Storm Breaks',
    order: 1,
    targets: {
      'weather.cloudCover01': { to: 0.95, overMs: 60000, curve: 'ease' },
      'weather.precip01': { to: 0.85, overMs: 60000, curve: 'ease' },
    },
  },
];
function fireCueById(id) {
  const cue = cueStack.find((c) => c.id === id);
  if (!cue) return { ok: false, reason: `no cue with id '${id}'` };
  const check = validateCue(cue, () => 'float'); // preview: every weather.* key is a float
  if (!check.ok) return { ok: false, reason: check.errors.join('; ') };
  const nowMs = performance.now(); // preview-only stand-in for wallClockMs()
  const patch = cueToFadePatch(
    cue,
    (key) => fadeRegistry.readLive(key),
    () => 'float'
  );
  fadeState = mergeFadeState(fadeState, patch, nowMs);
  log(`cue fired -> ${cue.name}`);
  return { ok: true, reason: null };
}

// ---- IMPULSES (U7) — real shape, fake fire() (no live viewer here) --------
// Order matches boot.js's own IMPULSES exactly (strike, thunder, gust —
// 2026-08-18 fix, mirroring the mock's #cornerTR).
const IMPULSES = [
  {
    id: 'strike',
    label: 'Strike',
    icon: 'bolt',
    flashClass: true,
    fire: () => (log('Strike fired (preview stand-in)'), { ok: true, message: 'Strike fired (preview stand-in).' }),
  },
  {
    id: 'thunder',
    label: 'Thunder',
    icon: 'cloud',
    status: 'planned',
    plannedReason: 'No audio subsystem exists anywhere in this codebase yet.',
  },
  {
    id: 'gust',
    label: 'Gust',
    icon: 'wind',
    fire: () => (log('Gust fired (preview stand-in)'), { ok: true, message: 'Gust fired (preview stand-in).' }),
  },
];

const remote = installRemote({
  impulses: IMPULSES,
  // 2026-08-18 fix: the Remote's OWN dial (astrolabe-dial.js), matching the
  // approved mock for real instead of the old createAstrolabe()'s
  // pre-LANTERN styling — see that module's own header for the full story.
  mountAstrolabeDial: (container, dialCtx) => {
    const pushUpdate = () =>
      remoteDialInstance.update({
        hour: fakeSky.todHour,
        phase: 'day',
        windDirectionDeg: fakeSky.windDirectionDeg,
        windSpeed01: fakeSky.windSpeed01,
        cloudCover01: fakeSky.cloudCover01,
        // Mirrors day-clock.js's own `canSetHour: currentMode === 'aesthetic'`
        // (2026-08-18 fix, ring-lock gap-audit Gap 12) — `fakeSky.mode` is
        // this harness's stand-in for the resolved posture, same field
        // getPosture() below already reads.
        canSetHour: fakeSky.mode === 'aesthetic',
      });
    remoteDialInstance = buildAstrolabeDial({
      // Production tracks a drag live via pumpAstrolabe's own continuous
      // ~10Hz repaint loop reading the viewer's real env snapshot back —
      // this harness has no such loop, so it pushes the update synchronously
      // instead. Same visible result (the dial follows the pointer), simpler
      // plumbing for a harness with no frame loop to piggyback on.
      onTimeChange: (hour, committed) => {
        fakeSky.todHour = hour;
        log(`time -> ${hour.toFixed(2)} (committed=${committed})`);
        pushUpdate();
      },
      onLockedAttempt: () => {
        log('ring drag refused — clock mode is not Aesthetic');
        dialCtx?.onLockedAttempt?.();
      },
    });
    container.appendChild(remoteDialInstance.root);
    pushUpdate();
  },
  getPosture: () => fakeSky.mode,
  // The Clock-mode pill (2026-08-18 fix) — mirrors boot.js's own
  // onSetMode exactly.
  onSetMode: (mode) => {
    fakeSky.mode = mode;
    log(`clock -> ${mode}`);
    remote.syncAstrolabePanel();
    remoteDialInstance?.update({
      hour: fakeSky.todHour,
      phase: 'day',
      windDirectionDeg: fakeSky.windDirectionDeg,
      windSpeed01: fakeSky.windSpeed01,
      cloudCover01: fakeSky.cloudCover01,
      canSetHour: fakeSky.mode === 'aesthetic',
    });
  },
  isFlowPlaying: () => fakeSky.rateHoursPerMinute > 0,
  onFlowToggle: () => {
    if (fakeSky.rateHoursPerMinute > 0) {
      lastNonZeroRate = fakeSky.rateHoursPerMinute;
      fakeSky.rateHoursPerMinute = 0;
    } else {
      fakeSky.rateHoursPerMinute = lastNonZeroRate;
    }
    log(`flow -> ${fakeSky.rateHoursPerMinute > 0 ? 'playing' : 'paused'}`);
    remote.syncAstrolabePanel();
    remoteDialInstance?.update({
      hour: fakeSky.todHour,
      phase: 'day',
      windDirectionDeg: fakeSky.windDirectionDeg,
      windSpeed01: fakeSky.windSpeed01,
      cloudCover01: fakeSky.cloudCover01,
      canSetHour: fakeSky.mode === 'aesthetic',
    });
  },
  // The TL corner's speed badge (2026-08-18 fix) — mirrors boot.js's own
  // getFlowRate/onSetFlowRate exactly, same resume-safe reasoning.
  getFlowRate: () => (fakeSky.rateHoursPerMinute > 0 ? fakeSky.rateHoursPerMinute : lastNonZeroRate),
  onSetFlowRate: (rate) => {
    lastNonZeroRate = rate;
    fakeSky.rateHoursPerMinute = rate;
    log(`speed -> x${rate}`);
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
    // Pace, Sky Light, Atmosphere, Scene override (2026-08-18 fix) — mirrors
    // boot.js's own real wiring exactly.
    getWeatherVolatility: () => fakeSky.weatherVolatility ?? 1,
    onWeatherVolatilityCommit: (v) => {
      fakeSky.weatherVolatility = v;
      log(`pace -> x${v}`);
    },
    getSkyRealism: () => fakeSky.realism01 ?? 0,
    onSkyRealismCommit: (v) => {
      fakeSky.realism01 = v;
      log(`sky light -> ${v}`);
    },
    getGradeEnvStrength: () => fakeSky.gradeEnvStrength ?? 0,
    onGradeEnvStrengthCommit: (v) => {
      fakeSky.gradeEnvStrength = v;
      log(`atmosphere -> ${v}`);
    },
    getSceneOverride: () => fakeSky.sceneOverride === true,
    onSceneOverrideCommit: (enabled) => {
      fakeSky.sceneOverride = enabled;
      log(`scene override -> ${enabled}`);
    },
    getCloudPinned: () => fakeSky.weatherPinnedAxes.includes('cloudCover01'),
    onUnpinCloudCover: () => {
      fakeSky.weatherPinnedAxes = fakeSky.weatherPinnedAxes.filter((a) => a !== 'cloudCover01');
      log('cloud cover unpinned');
      remote.refreshWeatherBoard();
    },
  },
  onBaseline: (overMs) => {
    fadeToArchetype('clear', overMs); // preview stand-in: "baseline" = clear sky
    log(`baseline -> fading to clear over ${overMs}ms`);
  },
  cueDeck: {
    listCues: () => orderedCues(cueStack),
    fireCue: (id) => fireCueById(id),
  },
  // THE DEBUG ROW (2026-08-18 fix) — production pushes a real snapshot via
  // MapShine.__remote.updateDebugStrip() from bootHeartbeat(); this harness
  // has no such loop, so a fake ~250ms tick stands in below, same spirit as
  // tickFades' own preview-only stand-in for the real pump.
  debugStrip: {
    onProbe: () => log('probe armed (preview stand-in)'),
    onExport: () => log('export fired (preview stand-in)'),
  },
});

const fakeSparkHistory = [];
setInterval(() => {
  const ratio = 0.7 + Math.random() * 0.3;
  fakeSparkHistory.push({ ratio, level: ratio < 0.6 ? 'warn' : 'ok' });
  if (fakeSparkHistory.length > 24) fakeSparkHistory.shift();
  remote.updateDebugStrip({
    fpsText: `${(ratio * 120).toFixed(0)}fps`,
    msText: (1000 / (ratio * 120)).toFixed(1),
    vramText: '1.2/2.5G',
    sparkHistory: fakeSparkHistory,
  });
}, 250);

requestAnimationFrame(tickFades);

// A console-debug door (2026-08-18 fix), same spirit as the UI mock's own
// documented `window.__mock` hook — `fakeSky` is otherwise module-private,
// and a few of its fields (weatherPinnedAxes chief among them) have no real
// UI trigger in this harness at all, since nothing here simulates the
// Almanac's own autonomous weather walk. Set `__preview.fakeSky.<field>`,
// then call `__preview.remote.refreshWeatherBoard()` to repaint.
window.__preview = { fakeSky, remote };

document.getElementById('toggleBtn').addEventListener('click', () => remote.toggle());

let themeIdx = 0;
document.getElementById('themeBtn').addEventListener('click', () => {
  themeIdx = (themeIdx + 1) % THEMES.length;
  document.documentElement.dataset.theme = THEMES[themeIdx];
  log(`theme -> ${THEMES[themeIdx]}`);
});

remote.open();
