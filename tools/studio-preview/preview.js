/**
 * Studio Preview — U1's own "cheap eyes before Foundry eyes" rung (matching
 * the widget gallery's role for U0). Mounts the REAL `installStudio()` with
 * two synthetic effect view-models — one shaped exactly like the real water
 * wiring this session added to boot.js (schema, presets, mask, tier,
 * fohKeys, live getValue/onChange), one simpler — and a fake `debugPanel`
 * stub standing in for `MapShine.debug` (LAB department needs SOMETHING to
 * mount; a live Foundry+effectRegistry session is what actually proves the
 * real wiring, not this file — see Petition P10's honesty note on that gap).
 *
 * Run: node tools/shader-lab/serve.mjs, then open
 * http://localhost:8934/tools/studio-preview/index.html
 */
import { installTokens, THEMES } from '../../src/ui/tokens.js';
import { installStudio } from '../../src/ui/index.js';

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

const studio = installStudio({ debugPanel: fakeDebugPanel });

// ---- water-shaped view-model: mirrors boot.js's real registerEffectCard('water', ...) exactly in structure ----
const waterState = {
  enabled: true,
  params: { depth: 0.6, pollution: 0.1, opacity: 0.85, foam: 0.4, flowAngleDeg: 180, flowSpeedPx: 12, tint: '#3a7ea8' },
};
const WATER_SCHEMA = {
  depth: {
    type: 'float',
    min: 0,
    max: 1,
    step: 0.01,
    default: 0.5,
    category: 'Look',
    label: 'Depth',
    help: 'How deep the water reads.',
  },
  pollution: {
    type: 'float',
    min: 0,
    max: 1,
    step: 0.01,
    default: 0,
    category: 'Look',
    label: 'Pollution',
    help: 'Murkiness tint.',
  },
  opacity: {
    type: 'float',
    min: 0,
    max: 1,
    step: 0.01,
    default: 0.8,
    category: 'Look',
    label: 'Opacity',
    help: 'How much the bed shows through.',
  },
  foam: {
    type: 'float',
    min: 0,
    max: 1,
    step: 0.01,
    default: 0.3,
    category: 'Look',
    label: 'Foam',
    help: 'Surface break amount.',
  },
  flowAngleDeg: {
    type: 'angle',
    default: 180,
    category: 'Motion',
    label: 'Flow direction',
    help: 'Which way the water travels — the compass dial.',
  },
  flowSpeedPx: {
    type: 'float',
    min: 0,
    max: 60,
    step: 1,
    default: 10,
    category: 'Motion',
    label: 'Flow speed',
    help: 'How fast it travels.',
  },
  tint: {
    type: 'color',
    space: 'srgb',
    default: '#3a7ea8',
    category: 'Technical',
    label: 'Tint',
    help: 'Base colour.',
  },
};
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
  schema: WATER_SCHEMA,
  fohKeys: ['depth', 'pollution', 'opacity', 'foam', 'flowAngleDeg', 'flowSpeedPx'],
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

document.getElementById('toggleBtn').addEventListener('click', () => studio.toggle());

let themeIdx = 0;
document.getElementById('themeBtn').addEventListener('click', () => {
  themeIdx = (themeIdx + 1) % THEMES.length;
  document.documentElement.dataset.theme = THEMES[themeIdx];
  document.getElementById('log').textContent = `theme -> ${THEMES[themeIdx]}`;
});

studio.open();
