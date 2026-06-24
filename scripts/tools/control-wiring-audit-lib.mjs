/**
 * Control wiring audit — static analysis for disconnected Tweakpane params.
 * @module tools/control-wiring-audit-lib
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSchemaRegistry } from './preset-insight/lib/schema-registry.mjs';
import {
  buildRuntimeParamKeySet,
  countParamRefs,
  extractExplicitParamKeySets,
  extractGroupParamRefs,
  extractInlineSchemaVar,
  extractParamPrefixFamilies,
  extractParametersFromSchemaBody,
  extractSchemaMethodBody,
  extractWeatherUiBridgeParamIds,
  paramIdInRuntimeKeySet,
  paramIdInWeatherBridge,
  stripSchemaMethods,
} from './preset-insight/lib/schema-parse-utils.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../..');
const SCRIPTS_DIR = path.join(REPO_ROOT, 'scripts');

/** @type {string|null} */
let _canvasSrcCache = null;

function getCanvasSrc() {
  if (_canvasSrcCache === null) {
    try {
      _canvasSrcCache = readScript('foundry/canvas-replacement.js');
    } catch (_) {
      _canvasSrcCache = '';
    }
  }
  return _canvasSrcCache;
}

/** @type {Set<string>|null} */
let _weatherBridgeKeys = null;

function getWeatherBridgeKeys() {
  if (!_weatherBridgeKeys) {
    _weatherBridgeKeys = new Set(extractWeatherUiBridgeParamIds(getCanvasSrc()));
  }
  return _weatherBridgeKeys;
}

/** Schema file → effect implementation file (params + runtime live elsewhere). */
const SCHEMA_TO_IMPL = {
  'compositor-v2/effects/specular-control-schema.js': 'compositor-v2/effects/SpecularEffectV2.js',
  'compositor-v2/effects/cloud-sprites/cloud-control-schema.js': 'compositor-v2/effects/CloudEffectV2.js',
};

/**
 * @param {string} relPath scripts-relative
 * @returns {string}
 */
function readScript(relPath) {
  const full = path.join(SCRIPTS_DIR, relPath.replace(/\//g, path.sep));
  return fs.readFileSync(full, 'utf8');
}

/**
 * @param {string} src
 * @param {string} methodName
 * @returns {string|null}
 */
function extractExportFunctionBody(src, methodName) {
  const re = new RegExp(`export\\s+function\\s+${methodName}\\s*\\([^)]*\\)\\s*\\{`, '');
  const m = re.exec(src);
  if (!m) return null;
  let i = m.index + m[0].length;
  let depth = 1;
  const start = i;
  for (; i < src.length && depth > 0; i++) {
    const c = src[i];
    if (c === '{') depth++;
    else if (c === '}') depth--;
  }
  return src.slice(start, i - 1);
}

/**
 * @param {string} src
 * @param {string} methodName
 * @returns {string|null}
 */
function resolveSchemaBody(src, methodName) {
  let body = extractSchemaMethodBody(src, methodName);
  if (!body) body = extractExportFunctionBody(src, methodName);
  if (!body && methodName === 'getControlSchema') {
    body = extractExportFunctionBody(src, methodName);
  }
  if (body && /return\s+getCloudControlSchema\s*\(/.test(body)) {
    const cloudSrc = readScript('compositor-v2/effects/cloud-sprites/cloud-control-schema.js');
    return extractExportFunctionBody(cloudSrc, 'getCloudControlSchema');
  }
  if (body && /return\s+getSpecularControlSchema\s*\(/.test(body)) {
    const specSrc = readScript('compositor-v2/effects/specular-control-schema.js');
    return extractExportFunctionBody(specSrc, 'getSpecularControlSchema');
  }
  return body;
}

/**
 * @param {string} schemaRel
 * @returns {string}
 */
function resolveEffectImplFile(schemaRel) {
  if (SCHEMA_TO_IMPL[schemaRel]) return SCHEMA_TO_IMPL[schemaRel];
  return schemaRel;
}

/**
 * @param {string} implRel scripts-relative
 * @returns {string[]}
 */
function resolveLocalShaderImports(implRel) {
  const src = readScript(implRel);
  const dir = path.dirname(implRel);
  const out = [];
  const re = /from\s+['"](\.\/[^'"]+)['"]/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    const rel = path.posix.join(dir.replace(/\\/g, '/'), m[1]);
    if (/shader/i.test(rel) || rel.endsWith('-shader.js')) {
      out.push(rel);
    }
  }
  return out;
}

/**
 * @param {string} implRel
 * @returns {{ haystack: string, stripped: string, prefixFamilies: string[], explicitKeys: Set<string>, shaderOnly: string }}
 */
export function buildAuditHaystack(implRel) {
  const src = readScript(implRel);
  const stripped = stripSchemaMethods(src);
  const prefixFamilies = extractParamPrefixFamilies(stripped);
  const explicitKeys = extractExplicitParamKeySets(stripped);

  let shaderOnly = '';
  for (const shaderRel of resolveLocalShaderImports(implRel)) {
    try {
      shaderOnly += '\n' + readScript(shaderRel);
    } catch (_) {}
  }

  return {
    haystack: stripped + shaderOnly,
    stripped,
    shaderOnly,
    prefixFamilies,
    explicitKeys,
  };
}

/**
 * @param {string[]} signals
 * @param {{ type?: string, hidden?: boolean, label?: string }} meta
 * @returns {{ score: number, bucket: string }}
 */
export function scoreParam(signals, meta) {
  const type = meta.type ?? '';
  if (type === 'button' || meta.readonly) {
    return { score: 0, bucket: 'info' };
  }

  let score = 0;
  if (signals.includes('NOT_IN_RUNTIME_PARAMS')) score += 40;
  if (signals.includes('ZERO_CODE_REFS')) score += 35;
  if (signals.includes('NOT_IN_UI_GROUP') && !signals.includes('HIDDEN')) score += 10;
  if (signals.includes('UI_BRIDGE_WIRED')) score -= 45;
  if (signals.includes('RUNTIME_RESOLVED')) score -= 35;
  if (signals.includes('PREFIX_WIRED')) score -= 20;
  if (signals.includes('SHADER_REF')) score -= 15;
  if (signals.includes('HIDDEN')) score -= 30;
  if (signals.includes('MARKED_UNUSED')) score -= 40;

  // Ungrouped but wired — UI housekeeping only, not a disconnect.
  if (
    signals.includes('NOT_IN_UI_GROUP')
    && (signals.includes('RUNTIME_RESOLVED') || signals.includes('UI_BRIDGE_WIRED'))
    && (signals.includes('PREFIX_WIRED') || !signals.includes('ZERO_CODE_REFS'))
  ) {
    score -= 15;
  }

  score = Math.max(0, Math.min(100, score));

  let bucket = 'info';
  if (score >= 60) bucket = 'high';
  else if (score >= 30) bucket = 'medium';
  else if (score >= 10) bucket = 'low';

  return { score, bucket };
}

/**
 * @param {object} opts
 * @returns {object}
 */
export function auditParam(opts) {
  const {
    effectId,
    paramId,
    meta = {},
    runtimeKeys,
    weatherBridgeKeys,
    inGroup,
    haystackCtx,
    shaderOnly,
  } = opts;

  const signals = [];
  const type = meta.type ?? '';

  if (meta.hidden) signals.push('HIDDEN');
  if (meta.label && /\(unused\)/i.test(meta.label)) signals.push('MARKED_UNUSED');

  const bridgeWired = effectId === 'weather' && paramIdInWeatherBridge(paramId, weatherBridgeKeys);
  if (bridgeWired) signals.push('UI_BRIDGE_WIRED');

  const inRuntime = paramIdInRuntimeKeySet(paramId, runtimeKeys) || bridgeWired;
  if (inRuntime) signals.push('RUNTIME_RESOLVED');
  else if (paramId !== 'enabled') signals.push('NOT_IN_RUNTIME_PARAMS');

  const inUiGroup = inGroup || !!meta.group;
  if (!inUiGroup && paramId !== 'enabled' && type !== 'button') signals.push('NOT_IN_UI_GROUP');

  const refInfo = countParamRefs(haystackCtx.haystack, paramId, {
    prefixFamilies: haystackCtx.prefixFamilies,
    explicitKeys: haystackCtx.explicitKeys,
  });

  if (refInfo.prefixWired || refInfo.inExplicitSet) signals.push('PREFIX_WIRED');

  const shaderRef = countParamRefs(shaderOnly, paramId, {}).count > 0;
  if (shaderRef) signals.push('SHADER_REF');

  const hasCodeRef = refInfo.count > 0 || refInfo.prefixWired || refInfo.inExplicitSet || bridgeWired;
  if (!hasCodeRef && paramId !== 'enabled' && type !== 'button') {
    signals.push('ZERO_CODE_REFS');
  }

  const { score, bucket } = scoreParam(signals, meta);

  return {
    effectId,
    paramId,
    label: meta.label ?? paramId,
    type,
    hidden: !!meta.hidden,
    signals,
    score,
    bucket,
  };
}

/**
 * @typedef {object} SchemaAuditUnit
 * @property {string} effectId
 * @property {string} schemaFile
 * @property {string} implFile
 * @property {string} methodName
 */

/**
 * Discover schema audit units from registry + canvas registration.
 * @returns {Promise<SchemaAuditUnit[]>}
 */
export async function discoverEffectSchemas() {
  const registry = await buildSchemaRegistry();
  const canvasSrc = readScript('foundry/canvas-replacement.js');

  /** @type {Map<string, SchemaAuditUnit>} */
  const units = new Map();

  for (const spec of registry.values()) {
    if (spec.source !== 'effect') continue;
    const schemaFile = spec.schemaFile ?? '';
    const key = `${spec.effectId}::${schemaFile}`;
    if (!units.has(key)) {
      units.set(key, {
        effectId: spec.effectId,
        schemaFile,
        implFile: resolveEffectImplFile(schemaFile),
        methodName: 'getControlSchema',
      });
    }
  }

  // Bubbles schema shares file with splashes — separate effect id.
  const splashesSrc = readScript('compositor-v2/effects/WaterSplashesEffectV2.js');
  if (extractSchemaMethodBody(splashesSrc, 'getBubblesControlSchema')) {
    units.set('underwater-bubbles::compositor-v2/effects/WaterSplashesEffectV2.js', {
      effectId: 'underwater-bubbles',
      schemaFile: 'compositor-v2/effects/WaterSplashesEffectV2.js',
      implFile: 'compositor-v2/effects/WaterSplashesEffectV2.js',
      methodName: 'getBubblesControlSchema',
    });
  }

  // Specular schema file.
  if (fs.existsSync(path.join(SCRIPTS_DIR, 'compositor-v2/effects/specular-control-schema.js'))) {
    units.set('specular::compositor-v2/effects/specular-control-schema.js', {
      effectId: 'specular',
      schemaFile: 'compositor-v2/effects/specular-control-schema.js',
      implFile: 'compositor-v2/effects/SpecularEffectV2.js',
      methodName: 'getSpecularControlSchema',
    });
  }

  // Cloud delegated schema.
  units.set('cloud::compositor-v2/effects/cloud-sprites/cloud-control-schema.js', {
    effectId: 'cloud',
    schemaFile: 'compositor-v2/effects/cloud-sprites/cloud-control-schema.js',
    implFile: 'compositor-v2/effects/CloudEffectV2.js',
    methodName: 'getCloudControlSchema',
  });

  // Ash weather inline schema.
  const ashBody = extractInlineSchemaVar(canvasSrc, 'ashWeatherSchema');
  if (ashBody) {
    units.set('ash-weather::foundry/canvas-replacement.js', {
      effectId: 'ash-weather',
      schemaFile: 'foundry/canvas-replacement.js (ashWeatherSchema)',
      implFile: 'foundry/canvas-replacement.js',
      methodName: 'ashWeatherSchema',
    });
  }

  return [...units.values()];
}

/**
 * @param {SchemaAuditUnit} unit
 * @returns {{ findings: object[], reverseOrphans: object[], warning?: string }}
 */
function auditSchemaUnit(unit) {
  /** @type {object[]} */
  const findings = [];
  /** @type {object[]} */
  const reverseOrphans = [];

  let schemaBody = null;
  if (unit.methodName === 'ashWeatherSchema') {
    schemaBody = extractInlineSchemaVar(readScript('foundry/canvas-replacement.js'), 'ashWeatherSchema');
  } else {
    const schemaSrc = readScript(unit.schemaFile.split(' ')[0]);
    schemaBody = resolveSchemaBody(schemaSrc, unit.methodName);
  }

  if (!schemaBody) {
    return { findings, reverseOrphans, warning: `Could not parse schema: ${unit.effectId} (${unit.methodName})` };
  }

  const params = extractParametersFromSchemaBody(schemaBody);
  const groupRefs = new Set(extractGroupParamRefs(schemaBody));
  const schemaKeys = new Set(params.keys());

  let implFile = unit.implFile;
  if (!fs.existsSync(path.join(SCRIPTS_DIR, implFile.replace(/\//g, path.sep)))) {
    return { findings, reverseOrphans, warning: `Impl file missing: ${implFile}` };
  }

  const haystackCtx = buildAuditHaystack(implFile);
  const implSrc = readScript(implFile);
  const canvasSrc = getCanvasSrc();
  const runtimeKeys = buildRuntimeParamKeySet(
    implSrc,
    unit.effectId === 'weather' || implFile.includes('WeatherController') ? canvasSrc : '',
  );
  const weatherBridgeKeys = getWeatherBridgeKeys();

  for (const [paramId, meta] of params) {
    const result = auditParam({
      effectId: unit.effectId,
      paramId,
      meta,
      runtimeKeys,
      weatherBridgeKeys,
      inGroup: groupRefs.has(paramId),
      haystackCtx,
      shaderOnly: haystackCtx.shaderOnly,
    });
    result.schemaFile = unit.schemaFile;
    result.implFile = implFile;
    findings.push(result);
  }

  for (const key of runtimeKeys) {
    if (key.startsWith('__')) continue;
    if (key === 'enabled' || schemaKeys.has(key)) continue;
    reverseOrphans.push({
      effectId: unit.effectId,
      paramId: key,
      implFile,
      signals: ['RUNTIME_ONLY_NOT_IN_SCHEMA'],
      score: 10,
      bucket: 'low',
    });
  }

  return { findings, reverseOrphans };
}

/**
 * @param {{ minScore?: number, effectFilter?: string|null }} [options]
 * @returns {Promise<object>}
 */
export async function runControlWiringAudit(options = {}) {
  const minScore = options.minScore ?? 0;
  const effectFilter = options.effectFilter ?? null;

  const units = await discoverEffectSchemas();
  /** @type {object[]} */
  const allFindings = [];
  /** @type {object[]} */
  const allReverseOrphans = [];
  /** @type {string[]} */
  const warnings = [];

  for (const unit of units) {
    if (effectFilter && unit.effectId !== effectFilter) continue;
    const { findings, reverseOrphans, warning } = auditSchemaUnit(unit);
    if (warning) warnings.push(warning);
    allFindings.push(...findings);
    allReverseOrphans.push(...reverseOrphans);
  }

  const filtered = allFindings.filter((f) => f.score >= minScore);
  filtered.sort((a, b) => b.score - a.score || a.effectId.localeCompare(b.effectId));

  const bucketCounts = { high: 0, medium: 0, low: 0, info: 0 };
  for (const f of allFindings) {
    bucketCounts[f.bucket] = (bucketCounts[f.bucket] ?? 0) + 1;
  }

  return {
    generatedAt: new Date().toISOString(),
    totalParamsScanned: allFindings.length,
    totalEffects: units.length,
    bucketCounts,
    warnings,
    findings: filtered,
    allFindings,
    reverseOrphans: allReverseOrphans,
    topSuspects: filtered.filter((f) => f.bucket === 'high' || f.bucket === 'medium').slice(0, 20),
  };
}
