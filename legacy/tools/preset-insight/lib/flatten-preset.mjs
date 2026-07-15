/**
 * Flatten scene preset JSON into dotted paths with typed values.
 */

import fs from 'fs';
import path from 'path';

/**
 * @param {unknown} obj
 * @param {string} prefix
 * @param {Map<string, { value: unknown, kind: string }>} out
 */
function walk(obj, prefix, out) {
  if (obj === null || obj === undefined) return;
  if (typeof obj !== 'object' || Array.isArray(obj)) {
    out.set(prefix, { value: obj, kind: typeof obj });
    return;
  }
  for (const [k, v] of Object.entries(obj)) {
    const p = prefix ? `${prefix}.${k}` : k;
    if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
      walk(v, p, out);
    } else {
      const kind = Array.isArray(v) ? 'array' : typeof v;
      out.set(p, { value: v, kind });
    }
  }
}

/**
 * @param {object} preset parsed JSON
 * @returns {{ id: string, name: string, flat: Map<string, { value: unknown, kind: string }> }}
 */
export function flattenPreset(preset) {
  const flat = new Map();
  const effects = preset?.settings?.mapMaker?.effects;
  if (effects && typeof effects === 'object') {
    for (const [effectId, effectObj] of Object.entries(effects)) {
      if (!effectObj || typeof effectObj !== 'object') continue;
      for (const [paramId, value] of Object.entries(effectObj)) {
        const path = `effects.${effectId}.${paramId}`;
        if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
          walk(value, path, flat);
        } else {
          flat.set(path, {
            value,
            kind: Array.isArray(value) ? 'array' : typeof value,
          });
        }
      }
    }
  }
  if (preset.controlState && typeof preset.controlState === 'object') {
    walk(preset.controlState, 'controlState', flat);
  }
  return {
    id: preset.id ?? 'unknown',
    name: preset.name ?? preset.id ?? 'unknown',
    flat,
  };
}

/**
 * @param {string} presetsDir
 * @returns {object[]}
 */
export function loadPresetsFromDir(presetsDir) {
  const files = fs.readdirSync(presetsDir).filter((f) => f.endsWith('.json'));
  return files.map((f) => {
    const raw = fs.readFileSync(path.join(presetsDir, f), 'utf8');
    return JSON.parse(raw);
  });
}
