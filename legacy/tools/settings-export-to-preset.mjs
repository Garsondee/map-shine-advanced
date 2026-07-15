/**
 * One-off: parse "Current Effect Settings" clipboard export → scene preset JSON.
 * Usage: node scripts/tools/settings-export-to-preset.mjs < export.txt
 */
import fs from 'fs';

const SKIP_KEYS = new Set([
  'textureStatus',
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

const inputPath = process.argv[2];
const input = inputPath ? fs.readFileSync(inputPath, 'utf8') : fs.readFileSync(0, 'utf8');
const effects = parseExport(input);

const preset = {
  msaVersion: 'scene-settings-v1',
  id: 'lightning-storm-horror',
  name: 'Lightning Storm Horror',
  description:
    'Oppressive lightning storm with heavy rain, near-black lighting, sepia dread, and landscape lightning flashes — tuned for horror atmosphere.',
  enabled: true,
  settings: {
    mapMaker: {
      enabled: true,
      version: '0.2.0',
      effects,
      renderer: {
        antialias: true,
        pixelRatio: 'auto',
      },
      performance: {
        targetFPS: 30,
        adaptiveQuality: true,
      },
    },
    gm: null,
    player: {},
    version: '0.2.0',
  },
};

process.stdout.write(JSON.stringify(preset, null, 2));
