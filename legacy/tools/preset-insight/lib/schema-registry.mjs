/**
 * Build a registry of control paths → min/max/default/type from Tweakpane schemas
 * and control-panel specs (Foundry-free static analysis).
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import {
  SCHEMA_METHOD_NAMES,
  extractSchemaMethodBody,
  extractParametersFromSchemaBody,
  extractInlineSchemaVar,
} from './schema-parse-utils.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../../../..');
const SCRIPTS_DIR = path.join(REPO_ROOT, 'scripts');

/** @typedef {'effect'|'controlState'} ParamSource */
/**
 * @typedef {Object} ParamSpec
 * @property {string} path dotted path e.g. effects.lighting.ambientStrength
 * @property {string} effectId
 * @property {string} paramId
 * @property {ParamSource} source
 * @property {string} [type]
 * @property {string} [label]
 * @property {number} [min]
 * @property {number} [max]
 * @property {number} [step]
 * @property {unknown} [default]
 * @property {string} [schemaFile]
 */

/** Extra controlState clamps from control-state-sanitize.js (not all in ENVIRONMENT_OVERRIDE_SPECS). */
const CONTROL_STATE_EXTRA = [
  { id: 'timeTransitionMinutes', min: 0, max: 60, step: 0.1, label: 'Time transition (min)' },
  { id: 'dynamicEvolutionSpeed', min: 0, max: 600, step: 1, label: 'Dynamic evolution speed' },
  { id: 'directedTransitionMinutes', min: 0.1, max: 60, step: 0.1, label: 'Directed transition (min)' },
  { id: 'windSpeedMS', min: 0, max: 78, step: 0.1, label: 'Wind speed (m/s)' },
  { id: 'tileMotionSpeedPercent', min: 0, max: 400, step: 1, label: 'Tile motion speed %' },
  { id: 'tileMotionTimeFactorPercent', min: 0, max: 200, step: 1, label: 'Tile motion time factor %' },
  { id: 'replicaOcclusionRadiusScale', min: 0.05, max: 100, step: 0.01, label: 'Replica occlusion radius scale' },
  { id: 'replicaOcclusionEdgeSoftness', min: 0, max: 100, step: 0.01, label: 'Replica occlusion edge softness' },
  { id: 'controlState.directedCustomPreset.precipitation', min: 0, max: 1, step: 0.01, label: 'Directed custom precipitation' },
  { id: 'controlState.directedCustomPreset.cloudCover', min: 0, max: 1, step: 0.01, label: 'Directed custom cloud cover' },
  { id: 'controlState.directedCustomPreset.windSpeed', min: 0, max: 1, step: 0.01, label: 'Directed custom wind speed' },
  { id: 'controlState.directedCustomPreset.fogDensity', min: 0, max: 1, step: 0.01, label: 'Directed custom fog density' },
  { id: 'controlState.directedCustomPreset.freezeLevel', min: 0, max: 1, step: 0.01, label: 'Directed custom freeze level' },
  { id: 'controlState.directedCustomPreset.windDirection', min: 0, max: 360, step: 1, label: 'Directed custom wind direction' },
  { id: 'controlState.landscapeLightning.lightning', min: 0, max: 1, step: 0.01, label: 'Landscape lightning' },
];

/**
 * @param {string} dir
 * @param {string[]} acc
 * @returns {string[]}
 */
function walkJsFiles(dir, acc = []) {
  if (!fs.existsSync(dir)) return acc;
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      if (ent.name === 'vendor' || ent.name === 'preset-insight') continue;
      walkJsFiles(full, acc);
    } else if (ent.isFile() && ent.name.endsWith('.js')) {
      acc.push(full);
    }
  }
  return acc;
}

/**
 * @param {string} src
 * @returns {Map<string, string>} classOrVarName -> effectId
 */
function parseRegisterEffectMap(src) {
  const map = new Map();
  const re = /registerEffect\s*\(\s*['"]([^'"]+)['"]/g;
  let m;
  const ids = [];
  while ((m = re.exec(src)) !== null) ids.push({ index: m.index, effectId: m[1] });

  for (let i = 0; i < ids.length; i++) {
    const chunk = src.slice(ids[i].index, ids[i + 1]?.index ?? src.length);
    const effectId = ids[i].effectId;
    const classM = chunk.match(/([A-Za-z_$][\w$]*)\.getControlSchema\s*\(/);
    if (classM) map.set(classM[1], effectId);
    const fnM = chunk.match(/getCloudControlSchema\s*\(/);
    if (fnM) map.set('getCloudControlSchema', 'cloud');
    const weatherM = chunk.match(/weatherSchema|WeatherController/);
    if (weatherM && effectId === 'weather') map.set('WeatherController', 'weather');
    if (chunk.includes('ashWeatherSchema')) map.set('ashWeatherSchema', 'ash-weather');
    if (chunk.includes('GridRenderer.getControlSchema')) map.set('GridRenderer', 'grid');
  }
  return map;
}

/**
 * @param {string} relPath scripts-relative
 * @returns {string|null}
 */
function inferEffectIdFromPath(relPath) {
  const base = path.basename(relPath, '.js');
  const overrides = {
    'WeatherController': 'weather',
    'grid-renderer': 'grid',
    'cloud-control-schema': 'cloud',
    'ash-cloud-control-schema': 'ash-clouds',
  };
  if (overrides[base]) return overrides[base];
  if (base.endsWith('EffectV2')) return base.replace(/EffectV2$/, '').replace(/([a-z])([A-Z])/g, '$1-$2').toLowerCase();
  if (base.endsWith('Effect')) return base.replace(/Effect$/, '').replace(/([a-z])([A-Z])/g, '$1-$2').toLowerCase();
  return null;
}

/**
 * @returns {Promise<Map<string, ParamSpec>>}
 */
export async function buildSchemaRegistry() {
  /** @type {Map<string, ParamSpec>} */
  const registry = new Map();

  const canvasPath = path.join(SCRIPTS_DIR, 'foundry', 'canvas-replacement.js');
  const canvasSrc = fs.readFileSync(canvasPath, 'utf8');
  const registerMap = parseRegisterEffectMap(canvasSrc);

  const classToFile = new Map();
  for (const file of walkJsFiles(SCRIPTS_DIR)) {
    const src = fs.readFileSync(file, 'utf8');
    if (!SCHEMA_METHOD_NAMES.some((mn) => src.includes(mn))) continue;
    const rel = path.relative(SCRIPTS_DIR, file).replace(/\\/g, '/');
    const classMatch = src.match(/export\s+class\s+([A-Za-z_$][\w$]*)/) || src.match(/class\s+([A-Za-z_$][\w$]*)/);
    const exportFn = rel.includes('cloud-control-schema') ? 'getCloudControlSchema' : null;
    if (classMatch) classToFile.set(classMatch[1], rel);
    if (exportFn) classToFile.set(exportFn, rel);
  }

  function addEffectParams(effectId, params, schemaFile) {
    for (const [paramId, meta] of params) {
      const spec = {
        path: `effects.${effectId}.${paramId}`,
        effectId,
        paramId,
        source: 'effect',
        type: meta.type,
        label: meta.label,
        min: meta.min,
        max: meta.max,
        step: meta.step,
        default: meta.default,
        schemaFile,
      };
      registry.set(spec.path, spec);
    }
  }

  for (const file of walkJsFiles(SCRIPTS_DIR)) {
    const rel = path.relative(SCRIPTS_DIR, file).replace(/\\/g, '/');
    const src = fs.readFileSync(file, 'utf8');
    if (!SCHEMA_METHOD_NAMES.some((mn) => src.includes(`static ${mn}`) || src.includes(`function ${mn}`) || src.includes(`export function ${mn}`))) {
      continue;
    }

    let effectId = null;
    const classMatch = src.match(/export\s+class\s+([A-Za-z_$][\w$]*)/) || src.match(/class\s+([A-Za-z_$][\w$]*)/);
    if (classMatch && registerMap.has(classMatch[1])) effectId = registerMap.get(classMatch[1]);
    if (!effectId && rel.includes('cloud-control-schema')) effectId = 'cloud';
    if (!effectId && rel.includes('WeatherController')) effectId = 'weather';
    if (!effectId && classMatch) effectId = registerMap.get(classMatch[1]) ?? inferEffectIdFromPath(rel);

    for (const mn of SCHEMA_METHOD_NAMES) {
      let body = extractSchemaMethodBody(src, mn);
      if (body && /return\s+getCloudControlSchema\s*\(/.test(body)) {
        const cloudFile = path.join(SCRIPTS_DIR, 'compositor-v2/effects/cloud-sprites/cloud-control-schema.js');
        if (fs.existsSync(cloudFile)) {
          const cloudSrc = fs.readFileSync(cloudFile, 'utf8');
          const fnRe = /export\s+function\s+getCloudControlSchema\s*\([^)]*\)\s*\{/;
          const fm = fnRe.exec(cloudSrc);
          if (fm) {
            let i = fm.index + fm[0].length;
            let depth = 1;
            const start = i;
            for (; i < cloudSrc.length && depth > 0; i++) {
              const c = cloudSrc[i];
              if (c === '{') depth++;
              else if (c === '}') depth--;
            }
            body = cloudSrc.slice(start, i - 1);
            effectId = 'cloud';
          }
        }
      }
      if (!body && mn === 'getControlSchema' && src.includes(`export function ${mn}`)) {
        const fnRe = new RegExp(`export\\s+function\\s+${mn}\\s*\\([^)]*\\)\\s*\\{`, '');
        const fm = fnRe.exec(src);
        if (fm) {
          let i = fm.index + fm[0].length;
          let depth = 1;
          const start = i;
          for (; i < src.length && depth > 0; i++) {
            const c = src[i];
            if (c === '{') depth++;
            else if (c === '}') depth--;
          }
          body = src.slice(start, i - 1);
        }
      }
      if (!body) continue;
      const params = extractParametersFromSchemaBody(body);
      if (!params.size) continue;
      const eid = effectId ?? inferEffectIdFromPath(rel) ?? path.basename(rel, '.js');
      addEffectParams(eid, params, rel);
    }
  }

  const ashBody = extractInlineSchemaVar(canvasSrc, 'ashWeatherSchema');
  if (ashBody) {
    const params = extractParametersFromSchemaBody(ashBody);
    addEffectParams('ash-weather', params, 'foundry/canvas-replacement.js (ashWeatherSchema)');
  }

  try {
    const envUrl = pathToFileURL(path.join(SCRIPTS_DIR, 'ui', 'environment-override-specs.js')).href;
    const envMod = await import(envUrl);
    for (const spec of envMod.ENVIRONMENT_OVERRIDE_SPECS ?? []) {
      const p = `controlState.${spec.id}`;
      registry.set(p, {
        path: p,
        effectId: 'controlState',
        paramId: spec.id,
        source: 'controlState',
        type: 'slider',
        label: spec.label,
        min: spec.min,
        max: spec.max,
        step: spec.step,
        schemaFile: 'ui/environment-override-specs.js',
      });
    }
  } catch (err) {
    console.warn('[preset-insight] Could not import environment-override-specs:', err.message);
  }

  for (const extra of CONTROL_STATE_EXTRA) {
    const p = extra.id.startsWith('controlState.') ? extra.id : `controlState.${extra.id}`;
    const paramId = p.replace(/^controlState\./, '');
    registry.set(p, {
      path: p,
      effectId: 'controlState',
      paramId,
      source: 'controlState',
      type: 'slider',
      label: extra.label,
      min: extra.min,
      max: extra.max,
      step: extra.step,
      schemaFile: 'settings/control-state-sanitize.js',
    });
  }

  return registry;
}

/**
 * @param {Map<string, ParamSpec>} registry
 * @param {string} path
 * @returns {ParamSpec|undefined}
 */
export function lookupSpec(registry, path) {
  if (registry.has(path)) return registry.get(path);
  if (path.startsWith('effects.')) return registry.get(path);
  const cs = path.startsWith('controlState.') ? path : `controlState.${path}`;
  return registry.get(cs);
}
