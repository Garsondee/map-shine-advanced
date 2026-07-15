/**
 * One-off helper: parse "Current Effect Settings" clipboard dump into scene preset JSON.
 * Usage: node scripts/tools/build-preset-from-dump.js <dump.txt> <output.json> [--id slug] [--name "Name"] [--description "..."]
 */
import fs from 'node:fs';
import path from 'node:path';

const SKIP_KEYS = new Set([
  'textureStatus',
  'queueFromCurrent',
  'startQueuedTransition',
  'rebuildRainFlowMap',
  'triggerSmallStrike',
  'triggerBigStrike',
  'triggerStrikeSeries'
]);

function parseValue(raw) {
  const v = raw.trim();
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (v === 'undefined') return undefined;
  if (v.startsWith('"') && v.endsWith('"')) return JSON.parse(v);
  if (v.startsWith('{') || v.startsWith('[')) return JSON.parse(v);
  if (/^-?\d+(?:\.\d+)?(?:e[+-]?\d+)?$/i.test(v)) return Number(v);
  return v;
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

function parseDump(text) {
  const effects = {};
  let current = null;
  for (const line of text.split(/\r?\n/)) {
    const effectMatch = line.match(/^--- Effect: (.+) ---$/);
    if (effectMatch) {
      current = effectMatch[1].trim();
      effects[current] = effects[current] || {};
      continue;
    }
    if (!current) continue;
    const kv = line.match(/^([A-Za-z0-9_.]+)\s*=\s*(.+)$/);
    if (!kv) continue;
    const [, key, rawVal] = kv;
    if (SKIP_KEYS.has(key)) continue;
    const value = parseValue(rawVal);
    if (value === undefined) continue;
    setNested(effects[current], key, value);
  }
  return effects;
}

function buildPreset(effects, meta) {
  return {
    msaVersion: 'scene-settings-v1',
    id: meta.id,
    name: meta.name,
    description: meta.description,
    enabled: true,
    settings: {
      mapMaker: {
        enabled: true,
        version: '0.2.0',
        effects,
        renderer: {
          antialias: true,
          pixelRatio: 'auto'
        },
        performance: {
          targetFPS: 30,
          adaptiveQuality: true
        }
      },
      gm: null,
      player: {},
      version: '0.2.0'
    }
  };
}

function main() {
  const args = process.argv.slice(2);
  const dumpPath = args[0];
  const outPath = args[1];
  if (!dumpPath || !outPath) {
    console.error('Usage: node build-preset-from-dump.js <dump.txt> <output.json> [--id slug] [--name Name] [--description text]');
    process.exit(1);
  }

  let id = 'furnace-forge';
  let name = 'Furnace / Forge';
  let description = '';
  let preserveMetaFrom = null;
  for (let i = 2; i < args.length; i++) {
    if (args[i] === '--preserve-meta' && args[i + 1]) preserveMetaFrom = args[++i];
    else if (args[i] === '--id' && args[i + 1]) id = args[++i];
    else if (args[i] === '--name' && args[i + 1]) name = args[++i];
    else if (args[i] === '--description' && args[i + 1]) description = args[++i];
  }

  if (preserveMetaFrom && fs.existsSync(preserveMetaFrom)) {
    const existing = JSON.parse(fs.readFileSync(preserveMetaFrom, 'utf8'));
    id = existing.id ?? id;
    name = existing.name ?? name;
    description = existing.description ?? description;
  }

  const text = fs.readFileSync(dumpPath, 'utf8');
  const effects = parseDump(text);
  const preset = buildPreset(effects, { id, name, description });
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(preset, null, 2) + '\n', 'utf8');
  console.log(`Wrote ${Object.keys(effects).length} effects to ${outPath}`);
}

main();
