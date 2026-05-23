/**
 * Merge a "Current Effect Settings" clipboard export into an existing preset JSON.
 * Usage: node scripts/tools/merge-export-into-preset.mjs <export.txt> <preset.json>
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

const [exportPath, presetPath] = process.argv.slice(2);
if (!exportPath || !presetPath) {
  console.error('Usage: node merge-export-into-preset.mjs <export.txt> <preset.json>');
  process.exit(1);
}

const exportText = fs.readFileSync(exportPath, 'utf8');
const effects = parseExport(exportText);
const preset = JSON.parse(fs.readFileSync(presetPath, 'utf8'));

preset.settings.mapMaker.effects = effects;
fs.writeFileSync(presetPath, JSON.stringify(preset, null, 2) + '\n', 'utf8');

console.log(`Merged ${Object.keys(effects).length} effects into ${presetPath}`);
