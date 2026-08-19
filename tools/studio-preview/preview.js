/**
 * Studio Preview — U1's own "cheap eyes before Foundry eyes" rung (matching
 * the widget gallery's role for U0). Mounts the REAL `installStudio()` with
 * three synthetic effect view-models — one shaped exactly like the real
 * water wiring this session added to boot.js (schema, presets, mask, tier,
 * fohKeys, live getValue/onChange), one simpler (bloom, no mask/presets/
 * tier), one proving `paintVerb` (candleFlame, an anchor-placement onPaint
 * rather than a mask brush) — and a fake `debugPanel` stub standing in for
 * `MapShine.debug` (LAB department needs SOMETHING to mount; a live
 * Foundry+effectRegistry session is what actually proves the real wiring
 * for any of boot.js's own registerEffectCard calls, not this file — see
 * Petition P10's honesty note on that gap, still standing).
 *
 * Run: node tools/shader-lab/serve.mjs, then open
 * http://localhost:8934/tools/studio-preview/index.html
 */
import { installTokens, THEMES } from '../../src/ui/tokens.js';
import { installStudio, installPlayer } from '../../src/ui/index.js';
import { validateCue, validateCueStack, orderedCues } from '../../src/core/cues-schema.js';
import { computeEasedValue, isEntryExpired } from '../../src/world/index.js';
// U6 (docs/holy/UI-Testament.md §9) — the REAL water schema/dials, not a
// hand-rolled stand-in, so this harness proves the real dial content (all
// five authored dials, their real drives/ranges) and the real read-tracking
// mechanism end to end, not just the card shell around a fake.
import { WATER_PARAMS, WATER_DIALS } from '../../src/effects/water/water.js';
import { wrapForReadTracking, getParamHealth } from '../../src/diag/param-read-health.js';

installTokens();
document.documentElement.dataset.theme = 'dark';

// ---- a fake debugPanel, just real enough to prove the LAB mount path ------
const fakeDebugPanel = {
  isGM: () => true,
  renderLabBody({ getStatusEl }) {
    const root = document.createElement('div');
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = 'Run fake report';
    btn.addEventListener('click', () => {
      getStatusEl().textContent = `✔ Ran at ${new Date().toLocaleTimeString()}`;
    });
    root.append(btn);
    return root;
  },
};

// ---- THE CUES DEPARTMENT'S OWN ENGINE STAND-IN (U3) -----------------------
// Real core/cues-schema.js functions (validateCue/validateCueStack/
// orderedCues), real world/fade-engine.js math (computeEasedValue/
// isEntryExpired) — only the orchestration (cueStack, the fake weather
// store, wallClockMs's preview-only performance.now() stand-in) is
// throwaway glue, matching remote-preview/preview.js's own established
// precedent for fadeToArchetype/tickFades. Studio preview has no astrolabe/
// sky visualization, so a test-fire's effect is only visible via the
// readout below, not a rendered sky.
const fakeWeather = { cloudCover01: 0.3, precip01: 0.1 };
function resolveType(key) {
  const [ns, field] = key.split('.');
  return ns === 'weather' && field in fakeWeather ? 'float' : undefined;
}
function readLive(key) {
  const [ns, field] = key.split('.');
  return ns === 'weather' ? (fakeWeather[field] ?? 0) : 0;
}
function writeLive(key, value) {
  const [ns, field] = key.split('.');
  if (ns === 'weather') fakeWeather[field] = value;
}
function paintWeatherReadout() {
  const el = document.getElementById('weatherReadout');
  if (el)
    el.textContent = `cloudCover01=${fakeWeather.cloudCover01.toFixed(2)}  precip01=${fakeWeather.precip01.toFixed(2)}`;
}
paintWeatherReadout();

let cueStack = [];
/** @type {{targets: object, startedAtMs: number}|null} */
let cueTestPreview = null;
/** @type {Record<string, number>|null} */
let cueTestSnapshot = null;

async function captureCueFromLive(name, overMs = 5000, curve = 'ease') {
  const id = `cue-${performance.now()}`;
  const targets = {};
  for (const field of ['cloudCover01', 'precip01']) {
    targets[`weather.${field}`] = { to: readLive(`weather.${field}`), overMs, curve };
  }
  const order = cueStack.length === 0 ? 0 : Math.max(...cueStack.map((c) => c.order)) + 1;
  const candidate = { id, name, order, targets };
  const nextStack = [...cueStack, candidate];
  const check = validateCueStack(nextStack, resolveType);
  if (!check.ok) return { ok: false, reason: check.errors.join('; '), cue: null };
  cueStack = nextStack;
  document.getElementById('log').textContent = `captured cue: ${name}`;
  return { ok: true, reason: null, cue: candidate };
}
function updateCueFadeMs(id, overMs) {
  const ix = cueStack.findIndex((c) => c.id === id);
  if (ix === -1) return { ok: false, reason: `no cue with id '${id}'` };
  const targets = {};
  for (const [key, t] of Object.entries(cueStack[ix].targets)) targets[key] = { ...t, overMs };
  const nextStack = cueStack.map((c, i) => (i === ix ? { ...c, targets } : c));
  const check = validateCueStack(nextStack, resolveType);
  if (!check.ok) return { ok: false, reason: check.errors.join('; ') };
  cueStack = nextStack;
  return { ok: true, reason: null };
}
function moveCueOrder(id, direction) {
  const ordered = orderedCues(cueStack);
  const ix = ordered.findIndex((c) => c.id === id);
  if (ix === -1) return { ok: false, reason: `no cue with id '${id}'` };
  const neighbourIx = ix + direction;
  if (neighbourIx < 0 || neighbourIx >= ordered.length) return { ok: true, reason: null };
  const a = ordered[ix];
  const b = ordered[neighbourIx];
  cueStack = cueStack.map((c) => {
    if (c.id === a.id) return { ...c, order: b.order };
    if (c.id === b.id) return { ...c, order: a.order };
    return c;
  });
  return { ok: true, reason: null };
}
function testFireCue(id) {
  const cue = cueStack.find((c) => c.id === id);
  if (!cue) return { ok: false, reason: `no cue with id '${id}'` };
  if (cueTestSnapshot) return { ok: false, reason: 'a test is already active — revert it first' };
  const check = validateCue(cue, resolveType);
  if (!check.ok) return { ok: false, reason: check.errors.join('; ') };
  const CAP_MS = 4000;
  const snapshot = {};
  const targets = {};
  for (const [key, t] of Object.entries(cue.targets)) {
    const from = readLive(key);
    snapshot[key] = from;
    targets[key] = { from, to: t.to, type: resolveType(key), curve: t.curve, overMs: Math.min(t.overMs, CAP_MS) };
  }
  cueTestSnapshot = snapshot;
  cueTestPreview = { targets, startedAtMs: performance.now() };
  document.getElementById('log').textContent = `testing cue: ${cue.name}`;
  return { ok: true, reason: null };
}
function revertCueTest() {
  if (!cueTestSnapshot) return { ok: false, reason: 'nothing to revert' };
  const targets = {};
  for (const [key, value] of Object.entries(cueTestSnapshot)) {
    targets[key] = { from: readLive(key), to: value, type: resolveType(key), curve: 'ease', overMs: 400 };
  }
  cueTestSnapshot = null;
  cueTestPreview = { targets, startedAtMs: performance.now() };
  document.getElementById('log').textContent = 'reverted test';
  return { ok: true, reason: null };
}
function isCueTestActive() {
  return cueTestSnapshot !== null;
}
function pumpCueTestPreview(nowMs) {
  if (!cueTestPreview) return;
  const { targets, startedAtMs } = cueTestPreview;
  let allDone = true;
  for (const [key, target] of Object.entries(targets)) {
    const entry = { ...target, startedAtMs };
    writeLive(key, computeEasedValue(entry, nowMs));
    if (!isEntryExpired(entry, nowMs)) allDone = false;
  }
  if (allDone) cueTestPreview = null;
  paintWeatherReadout();
}
requestAnimationFrame(function tick() {
  pumpCueTestPreview(performance.now());
  requestAnimationFrame(tick);
});

// ---- THE PAINTER DEPARTMENT'S OWN STAND-IN (U4) ---------------------------
// Two fake tiles, one "found" one not, matching the real listPaintableEffects
// shape exactly ({id,title,suffixes,found}) -- there's no real painter or
// mask-authority to launch in this harness, so armBrush just logs, same
// "throwaway orchestration, real shape" precedent as the rest of this file.
const FAKE_PAINTABLE = [
  { id: 'fire', title: 'Fire', suffixes: ['_Fire'], found: false },
  { id: 'water', title: 'Water', suffixes: ['_Water'], found: true },
];

// ---- THE SYSTEM PANEL'S OWN STAND-IN (U5) ----------------------------------
// A tiny fake settings store (plain object) standing in for game.settings --
// real GLOBAL_SETTING_KEYS values, real effectEnableKey convention, real
// ENABLE_OVERRIDES/PERFORMANCE_PROFILES vocab, imported directly since this
// harness has no zones/one-door wall to cross (it's tools/, not src/).
const fakeSettingsStore = {
  msaEnabled: true,
  performanceProfile: 'standard',
  reducePhotosensitiveEffects: false,
  reducedMotion: false,
  uiTheme: 'dark',
  'fire.playerEnable': 'auto',
  'fire.gmEnable': 'auto',
  'water.playerEnable': 'on',
  'water.gmEnable': 'auto',
};
const FAKE_EFFECT_ROWS = [
  { id: 'fire', title: 'Fire', photosensitive: true, playerKey: 'fire.playerEnable', gmKey: 'fire.gmEnable' },
  { id: 'water', title: 'Water', photosensitive: false, playerKey: 'water.playerEnable', gmKey: 'water.gmEnable' },
];
function getSystemPanelCtx() {
  return {
    read: (key) => fakeSettingsStore[key],
    write: (key, value) => {
      fakeSettingsStore[key] = value;
      document.getElementById('log').textContent = `setting ${key} -> ${value}`;
    },
    profiles: ['low', 'performance', 'standard', 'quality', 'extreme'].map((v) => ({ value: v, label: v })),
    enableChoices: ['auto', 'on', 'off'].map((v) => ({ value: v, label: v })),
    effectRows: FAKE_EFFECT_ROWS,
    keys: {
      msaEnabled: 'msaEnabled',
      profile: 'performanceProfile',
      reducePhotosensitive: 'reducePhotosensitiveEffects',
      reducedMotion: 'reducedMotion',
      theme: 'uiTheme',
    },
  };
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
    fire: () => {
      document.getElementById('log').textContent = 'Strike fired (preview stand-in)';
      return { ok: true, message: 'Strike fired (preview stand-in).' };
    },
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
    fire: () => {
      document.getElementById('log').textContent = 'Gust fired (preview stand-in)';
      return { ok: true, message: 'Gust fired (preview stand-in).' };
    },
  },
];

const studio = installStudio({
  debugPanel: fakeDebugPanel,
  impulses: IMPULSES,
  listCues: () => orderedCues(cueStack),
  captureCue: (name) => captureCueFromLive(name),
  updateCueFadeMs: (id, overMs) => updateCueFadeMs(id, overMs),
  moveCueOrder: (id, direction) => moveCueOrder(id, direction),
  testFireCue: (id) => testFireCue(id),
  revertCueTest: () => revertCueTest(),
  isCueTestActive: () => isCueTestActive(),
  validateCue: (cue) => validateCue(cue, resolveType),
  listPaintableEffects: () => FAKE_PAINTABLE,
  armBrush: (effectId) => {
    document.getElementById('log').textContent = `armBrush('${effectId}') -- no real painter in this harness`;
  },
  getSystemPanelCtx: () => getSystemPanelCtx(),
});

// The Player room (U5) -- same fake ctx, isGM hard-false inside installPlayer
// itself (never read from anywhere), proving the SAME generated tree renders
// correctly with the GM-only "Table Defaults" section absent.
const player = installPlayer({ getSystemPanelCtx: () => getSystemPanelCtx() });

// ---- water-shaped view-model: mirrors boot.js's real registerEffectCard('water', ...), now using the REAL schema/dials (U6) ----
const waterState = { enabled: true, params: {} };
for (const [key, decl] of Object.entries(WATER_PARAMS)) waterState.params[key] = decl.default;

// Simulate a partial render-path read, exactly the shape water-registration.
// js#getRenderState() produces every frame in production — touch MOST params
// through the tracked proxy, but deliberately skip a few (chop, caustics) so
// this harness visibly proves U6's own exit gate: "a deliberately orphaned
// param shows up wearing its badge within one session."
{
  const tracked = wrapForReadTracking('water', waterState.params);
  for (const key of Object.keys(WATER_PARAMS)) {
    if (key === 'chop' || key === 'caustics') continue; // left deliberately unread
    void tracked[key];
  }
}

studio.registerEffectCard('water', () => ({
  id: 'water',
  icon: 'water',
  title: 'Water',
  accVar: '--c-atmos',
  filterCategory: 'surface',
  tier: { tier: 3, maxTier: 4, source: 'profile' },
  mask: { suffix: '_Water', found: true },
  presets: ['CalmLake', 'RagingRiver'],
  onPresetPick: (name) => {
    document.getElementById('log').textContent = `preset picked: ${name}`;
  },
  schema: WATER_PARAMS,
  fohKeys: ['depth', 'pollution', 'opacity', 'foam', 'flowAngleDeg', 'flowSpeedPx'],
  dialsSchema: WATER_DIALS,
  health: getParamHealth('water', WATER_PARAMS),
  getValue: (id) => waterState.params[id],
  onChange: (id, value) => {
    waterState.params[id] = value;
    document.getElementById('log').textContent = `water.${id} -> ${value}`;
  },
  enabled: waterState.enabled,
  onToggleEnabled: (next) => {
    waterState.enabled = next;
  },
  onPaint: () => {
    document.getElementById('log').textContent = 'paint armed (fake)';
  },
  status: () => (waterState.enabled ? '' : 'off'),
}));

// A second, simpler effect with NO mask/presets/tier — proves the card
// shell degrades gracefully when those fields are absent (matches the 11
// real effects with no preset table, per this session's own research).
const bloomState = { enabled: true, params: { strength: 0.5 } };
studio.registerEffectCard('bloom', () => ({
  id: 'bloom',
  icon: 'bloom',
  title: 'Bloom',
  accVar: '--c-post',
  filterCategory: 'post',
  schema: {
    strength: {
      type: 'float',
      min: 0,
      max: 1,
      step: 0.01,
      default: 0.4,
      category: 'Look',
      label: 'Strength',
      help: 'Glow amount.',
    },
  },
  fohKeys: ['strength'],
  getValue: (id) => bloomState.params[id],
  onChange: (id, value) => {
    bloomState.params[id] = value;
  },
  enabled: bloomState.enabled,
  onToggleEnabled: (next) => {
    bloomState.enabled = next;
  },
  status: () => (bloomState.enabled ? '' : 'off'),
}));

// A third card proving `paintVerb` (2026-08-19, effects-population round) —
// the one actual effects-department.js code change this round made: an
// onPaint whose action is PLACEMENT (an anchor icon), not a mask brush, so
// its button needs "Place X" wording rather than the default "Paint X".
// Mirrors candleFlame's real shape in boot.js (schema + onPaint pointed at
// a placement function + paintVerb:'Place'), minus the anchor system itself.
const candleState = { enabled: true, params: { sizePx: 24 } };
studio.registerEffectCard('candleFlame', () => ({
  id: 'candleFlame',
  icon: 'candle',
  title: 'Candle flames',
  accVar: '--c-lighting',
  filterCategory: 'lighting',
  schema: {
    sizePx: {
      type: 'float',
      min: 4,
      max: 64,
      step: 1,
      default: 24,
      category: 'Look',
      label: 'Size',
      help: 'Flame size.',
    },
  },
  fohKeys: ['sizePx'],
  getValue: (id) => candleState.params[id],
  onChange: (id, value) => {
    candleState.params[id] = value;
  },
  enabled: candleState.enabled,
  onToggleEnabled: (next) => {
    candleState.enabled = next;
  },
  onPaint: () => {
    document.getElementById('log').textContent = 'placement armed (fake)';
  },
  paintVerb: 'Place',
  status: () => (candleState.enabled ? '' : 'off'),
}));

document.getElementById('toggleBtn').addEventListener('click', () => studio.toggle());
document.getElementById('playerBtn').addEventListener('click', () => player.toggle());

let themeIdx = 0;
document.getElementById('themeBtn').addEventListener('click', () => {
  themeIdx = (themeIdx + 1) % THEMES.length;
  document.documentElement.dataset.theme = THEMES[themeIdx];
  document.getElementById('log').textContent = `theme -> ${THEMES[themeIdx]}`;
});

studio.open();
