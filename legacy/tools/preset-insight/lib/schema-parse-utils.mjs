/**
 * Shared static parsers for getControlSchema() bodies (Foundry-free).
 */

export const SCHEMA_METHOD_NAMES = [
  'getControlSchema',
  'getBubblesControlSchema',
  'getSpecularControlSchema',
  'getCloudControlSchema',
];

/**
 * @param {string} src
 * @param {string} methodName
 * @returns {string|null}
 */
export function extractSchemaMethodBody(src, methodName) {
  const re = new RegExp(`static\\s+${methodName}\\s*\\([^)]*\\)\\s*\\{`, '');
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
 * @param {string} schemaBody
 * @returns {string|null}
 */
export function extractTopLevelParametersBlock(schemaBody) {
  const re = /\bparameters\s*:\s*\{/g;
  let best = null;
  let m;
  while ((m = re.exec(schemaBody)) !== null) {
    const brace = m.index + m[0].length - 1;
    let depth = 0;
    let i = brace;
    for (; i < schemaBody.length; i++) {
      const c = schemaBody[i];
      if (c === '{') depth++;
      else if (c === '}') {
        depth--;
        if (depth === 0) {
          best = schemaBody.slice(brace, i + 1);
          break;
        }
      }
    }
  }
  return best;
}

/**
 * @param {string} block parameters: { ... } inner content including outer braces
 * @returns {Map<string, string>}
 */
export function splitParameterEntries(block) {
  const inner = block.startsWith('{') ? block.slice(1, -1) : block;
  const entries = new Map();
  const keyRe = /(?:^|\n)\s{6,10}([a-zA-Z_][a-zA-Z0-9_]*|'[^']+'|"[^"]+")\s*:\s*\{/g;
  let m;
  while ((m = keyRe.exec(inner)) !== null) {
    let key = m[1];
    if ((key.startsWith("'") && key.endsWith("'")) || (key.startsWith('"') && key.endsWith('"'))) {
      key = key.slice(1, -1);
    }
    const braceStart = m.index + m[0].length - 1;
    let depth = 0;
    let i = braceStart;
    for (; i < inner.length; i++) {
      const c = inner[i];
      if (c === '{') depth++;
      else if (c === '}') {
        depth--;
        if (depth === 0) {
          entries.set(key, inner.slice(braceStart, i + 1));
          keyRe.lastIndex = i + 1;
          break;
        }
      }
    }
  }
  return entries;
}

/**
 * @param {string} entryBody
 * @returns {{ type?: string, label?: string, min?: number, max?: number, step?: number, default?: unknown }}
 */
export function parseParameterMeta(entryBody) {
  const meta = {};
  const typeM = entryBody.match(/\btype\s*:\s*['"]([^'"]+)['"]/);
  if (typeM) meta.type = typeM[1];
  const labelM = entryBody.match(/\blabel\s*:\s*['"]([^'"]*)['"]/);
  if (labelM) meta.label = labelM[1];
  for (const field of ['min', 'max', 'step']) {
    const re = new RegExp(`\\b${field}\\s*:\\s*(-?[\\d.]+(?:e[+-]?\\d+)?)`, 'i');
    const fm = entryBody.match(re);
    if (fm) meta[field] = Number(fm[1]);
  }
  const defM = entryBody.match(/\bdefault\s*:\s*(-?[\d.]+(?:e[+-]?\d+)?|true|false)/);
  if (defM) {
    const raw = defM[1];
    if (raw === 'true') meta.default = true;
    else if (raw === 'false') meta.default = false;
    else meta.default = Number(raw);
  }
  if (/hidden\s*:\s*true/.test(entryBody)) meta.hidden = true;
  if (/readonly\s*:\s*true/.test(entryBody)) meta.readonly = true;
  if (/gmOnly\s*:\s*true/.test(entryBody)) meta.gmOnly = true;
  if (/advanced\s*:\s*true/.test(entryBody)) meta.advanced = true;
  const groupM = entryBody.match(/\bgroup\s*:\s*['"]([^'"]+)['"]/);
  if (groupM) meta.group = groupM[1];
  if (!meta.type && meta.min !== undefined && meta.max !== undefined) meta.type = 'slider';
  return meta;
}

/**
 * @param {string} schemaBody
 * @returns {Map<string, ReturnType<typeof parseParameterMeta>>}
 */
export function extractParametersFromSchemaBody(schemaBody) {
  const block = extractTopLevelParametersBlock(schemaBody);
  if (!block) return new Map();
  const entries = splitParameterEntries(block);
  const out = new Map();
  for (const [key, body] of entries) {
    out.set(key, parseParameterMeta(body));
  }
  return out;
}

/**
 * Extract inline `const fooSchema = {` from canvas-replacement.
 * @param {string} src
 * @param {string} varName
 * @returns {string|null}
 */
/**
 * @param {string} schemaBody
 * @returns {string[]}
 */
export function extractGroupParamRefs(schemaBody) {
  return extractGroupParamRefsFromArrays(schemaBody);
}

/**
 * Group refs from `groups: [{ parameters: [...] }]` only.
 * @param {string} schemaBody
 * @returns {string[]}
 */
export function extractGroupParamRefsFromArrays(schemaBody) {
  const refs = new Set();
  const re = /parameters:\s*\[([\s\S]*?)\]/g;
  let m;
  while ((m = re.exec(schemaBody)) !== null) {
    const inner = m[1];
    for (const q of inner.match(/'([^']+)'/g) ?? []) refs.add(q.slice(1, -1));
    for (const q of inner.match(/"([^"]+)"/g) ?? []) refs.add(q.slice(1, -1));
  }
  return [...refs];
}

/**
 * @param {string} src
 * @param {number} openIdx index of `{`
 * @returns {string|null}
 */
function extractBalancedObject(src, openIdx) {
  let depth = 0;
  for (let i = openIdx; i < src.length; i++) {
    const c = src[i];
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return src.slice(openIdx, i + 1);
    }
  }
  return null;
}

/**
 * @param {string} src
 * @param {string} constName
 * @returns {string[]}
 */
export function extractConstObjectKeys(src, constName) {
  const re = new RegExp(`(?:const|let|var)\\s+${constName}\\s*=\\s*(?:Object\\.freeze\\s*\\()?\\{`, '');
  const m = re.exec(src);
  if (!m) return [];
  const open = src.indexOf('{', m.index);
  const block = extractBalancedObject(src, open);
  if (!block) return [];
  return extractObjectLiteralKeys(block);
}

/**
 * Top-level keys from `{ key: value, ... }`.
 * @param {string} block includes outer braces
 * @returns {string[]}
 */
export function extractObjectLiteralKeys(block) {
  const inner = block.startsWith('{') ? block.slice(1, -1) : block;
  const keys = new Set();
  for (const rx of [
    /(?:^|[\n,{])\s*([a-zA-Z_][\w$]*)\s*:/gm,
    /(?:^|[\n,{])\s*['"]([^'"]+)['"]\s*:/gm,
  ]) {
    let m;
    while ((m = rx.exec(inner)) !== null) keys.add(m[1]);
  }
  return [...keys];
}

/**
 * @param {string} src
 * @param {string} className
 * @param {string} methodName
 * @returns {string[]}
 */
export function extractStaticMethodReturnKeys(src, className, methodName) {
  const re = new RegExp(`static\\s+${methodName}\\s*\\([^)]*\\)\\s*\\{[\\s\\S]*?return\\s*\\{`, '');
  const m = re.exec(src);
  if (!m) return [];
  const open = src.indexOf('{', m.index + m[0].length - 1);
  const block = extractBalancedObject(src, open);
  if (!block) return [];
  return extractObjectLiteralKeys(block);
}

/**
 * @param {string} src
 * @param {string} prop e.g. params, settings
 * @returns {string[]}
 */
export function extractThisAssignmentKeys(src, prop) {
  const marker = `this.${prop} = {`;
  const idx = src.indexOf(marker);
  if (idx < 0) return [];
  const open = idx + marker.length - 1;
  const block = extractBalancedObject(src, open);
  if (!block) return [];
  const keys = new Set(extractObjectLiteralKeys(block));
  const inner = block.slice(1, -1);
  for (const m of inner.matchAll(/\.\.\.([A-Za-z_$][\w$]*)/g)) {
    for (const k of extractConstObjectKeys(src, m[1])) keys.add(k);
  }
  return [...keys];
}

/**
 * Nested dotted paths from a const object (one level of nesting).
 * @param {string} src
 * @param {string} constName
 * @returns {string[]}
 */
export function extractNestedConstPaths(src, constName) {
  const re = new RegExp(`(?:const|let|var)\\s+${constName}\\s*=\\s*\\{`, '');
  const m = re.exec(src);
  if (!m) return [];
  const open = src.indexOf('{', m.index);
  const block = extractBalancedObject(src, open);
  if (!block) return [];

  const paths = new Set(extractObjectLiteralKeys(block));
  const inner = block.slice(1, -1);
  const sectionRe = /([a-zA-Z_][\w$]*)\s*:\s*\{/g;
  let sm;
  while ((sm = sectionRe.exec(inner)) !== null) {
    const section = sm[1];
    const secOpen = sm.index + sm[0].length - 1;
    const relOpen = inner.indexOf('{', secOpen - sm.index) + sm.index;
    const secBlock = extractBalancedObject(inner, relOpen - sm.index);
    if (!secBlock) continue;
    for (const child of extractObjectLiteralKeys(secBlock)) {
      paths.add(`${section}.${child}`);
    }
  }
  return [...paths];
}

/**
 * Virtual schema param ids from `this.fooTuning = { bar: ... }` → `fooBar`.
 * @param {string} src
 * @returns {string[]}
 */
export function extractTuningBagVirtualKeys(src) {
  const out = new Set();
  const re = /this\.([a-zA-Z_][\w$]*)Tuning\s*=\s*\{/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    const prefix = m[1];
    const open = m.index + m[0].length - 1;
    const block = extractBalancedObject(src, open);
    if (!block) continue;
    for (const key of extractObjectLiteralKeys(block)) {
      out.add(prefix + key.charAt(0).toUpperCase() + key.slice(1));
      if (prefix === 'roofDrip' && key === 'enabled') out.add('roofDripEnabled');
    }
  }
  return [...out];
}

/**
 * @param {string} src
 * @param {string} [canvasSrc]
 * @returns {Set<string>}
 */
export function buildRuntimeParamKeySet(src, canvasSrc = '') {
  const keys = new Set();

  for (const k of extractThisAssignmentKeys(src, 'params')) keys.add(k);

  const factory = src.match(/this\.params\s*=\s*([A-Za-z_$][\w$]*)\.createDefaultParams\s*\(\s*\)/);
  if (factory) {
    for (const k of extractStaticMethodReturnKeys(src, factory[1], 'createDefaultParams')) keys.add(k);
  }

  for (const k of extractThisAssignmentKeys(src, 'settings')) keys.add(k);

  for (const k of extractTuningBagVirtualKeys(src)) keys.add(k);

  for (const m of src.matchAll(/this\.params\s*=\s*\{([\s\S]*?)\n\s*\};/g)) {
    for (const sp of m[1].matchAll(/\.\.\.([A-Za-z_$][\w$]*)/g)) {
      for (const k of extractConstObjectKeys(src, sp[1])) keys.add(k);
    }
  }

  for (const m of src.matchAll(/(?:const|let|var)\s+([A-Z][A-Z0-9_]*)\s*=\s*(?:Object\.freeze\s*\()?\{/g)) {
    for (const k of extractConstObjectKeys(src, m[1])) keys.add(k);
  }

  for (const m of src.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*\{/g)) {
    if (/_CONFIG|_DEFAULTS|_CORE/i.test(m[1])) {
      for (const k of extractNestedConstPaths(src, m[1])) keys.add(k);
    }
  }

  if (canvasSrc) {
    for (const k of extractWeatherUiBridgeParamIds(canvasSrc)) keys.add(k);
  }

  for (const k of extractDirectParamHandlerIds(src)) keys.add(k);

  return keys;
}

/**
 * Param ids handled via `if (param === 'foo')` / `paramId === 'foo'` outside schema.
 * @param {string} src
 * @returns {string[]}
 */
export function extractDirectParamHandlerIds(src) {
  const ids = new Set();
  for (const m of src.matchAll(/(?:param|paramId)\s*===\s*['"]([^'"]+)['"]/g)) {
    ids.add(m[1]);
  }
  return [...ids];
}

/**
 * @param {string} paramId
 * @param {Set<string>} runtimeKeys
 * @returns {boolean}
 */
export function paramIdInRuntimeKeySet(paramId, runtimeKeys) {
  if (runtimeKeys.has(paramId)) return true;
  if (paramId.includes('.')) {
    const leaf = paramId.split('.').pop();
    if (leaf && runtimeKeys.has(leaf)) return true;
  }
  for (const entry of runtimeKeys) {
    if (entry.startsWith('__prefix__:') && paramId.startsWith(entry.slice(11))) return true;
  }
  return false;
}

/**
 * @param {string} canvasSrc
 * @returns {string[]}
 */
export function extractWeatherUiBridgeParamIds(canvasSrc) {
  const ids = new Set();
  const start = canvasSrc.indexOf('const onWeatherUpdate');
  if (start < 0) return [];

  const end = canvasSrc.indexOf("registerEffect('weather'", start);
  const chunk = end > start ? canvasSrc.slice(start, end) : canvasSrc.slice(start, start + 12000);

  for (const m of chunk.matchAll(/paramId\s*===\s*['"]([^'"]+)['"]/g)) ids.add(m[1]);
  for (const m of chunk.matchAll(/paramId\.startsWith\(\s*['"]([^'"]+)['"]\s*\)/g)) {
    ids.add(`__prefix__:${m[1]}`);
  }

  for (const mapName of ['rainMap', 'snowMap', 'roofDripMap']) {
    const mapRe = new RegExp(`const\\s+${mapName}\\s*=\\s*\\{([\\s\\S]*?)\\};`, '');
    const mm = mapRe.exec(chunk);
    if (mm) {
      for (const km of mm[1].matchAll(/([a-zA-Z_][\w$]*)\s*:/g)) ids.add(km[1]);
    }
  }

  const bridgeChunk = canvasSrc.includes('applyWeatherManualParam')
    ? canvasSrc
    : '';
  if (bridgeChunk) ids.add('__applyWeatherManualParam__');

  return [...ids];
}

/**
 * @param {string} paramId
 * @param {Set<string>} bridgeKeys
 * @returns {boolean}
 */
export function paramIdInWeatherBridge(paramId, bridgeKeys) {
  if (bridgeKeys.has(paramId)) return true;
  for (const entry of bridgeKeys) {
    if (entry.startsWith('__prefix__:') && paramId.startsWith(entry.slice(11))) return true;
  }
  if (bridgeKeys.has('__applyWeatherManualParam__')) {
    const manual = new Set([
      'precipitation', 'cloudCover', 'fogDensity', 'wetness', 'freezeLevel',
      'ashIntensity', 'windSpeed', 'windDirection',
    ]);
    if (manual.has(paramId)) return true;
  }
  return false;
}

/**
 * @param {string} src
 * @param {string[]} [methodNames]
 * @returns {string}
 */
export function stripSchemaMethods(src, methodNames = SCHEMA_METHOD_NAMES) {
  let out = src;
  for (const name of methodNames) {
    const patterns = [
      new RegExp(`static\\s+${name}\\s*\\([^)]*\\)\\s*\\{`, 'g'),
      new RegExp(`export\\s+function\\s+${name}\\s*\\([^)]*\\)\\s*\\{`, 'g'),
      new RegExp(`function\\s+${name}\\s*\\([^)]*\\)\\s*\\{`, 'g'),
    ];
    for (const re of patterns) {
      let m;
      while ((m = re.exec(out)) !== null) {
        let i = m.index + m[0].length;
        let depth = 1;
        for (; i < out.length && depth > 0; i++) {
          const c = out[i];
          if (c === '{') depth++;
          else if (c === '}') depth--;
        }
        const blank = ' '.repeat(i - m.index);
        out = out.slice(0, m.index) + blank + out.slice(i);
        re.lastIndex = m.index + blank.length;
      }
    }
  }
  return out;
}

/**
 * Extract top-level keys from the first `this.params = { ... }` block.
 * @param {string} src
 * @returns {string[]}
 */
export function extractThisParamsKeys(src) {
  return extractThisAssignmentKeys(src, 'params');
}

/**
 * Collect param-prefix families from startsWith('foo') patterns in source.
 * @param {string} src
 * @returns {string[]}
 */
export function extractParamPrefixFamilies(src) {
  const prefixes = new Set();
  const re = /(?:paramId|_paramId|key)\.startsWith\(\s*['"]([^'"]+)['"]\s*\)/g;
  let m;
  while ((m = re.exec(src)) !== null) prefixes.add(m[1]);
  return [...prefixes];
}

/**
 * Collect explicit param key strings from const arrays/sets in source.
 * @param {string} src
 * @returns {Set<string>}
 */
export function extractExplicitParamKeySets(src) {
  const keys = new Set();
  const arrayRe = /(?:PARAM|REBUILD|KEY)[\w]*\s*=\s*(?:new Set\(\[|\[)([\s\S]*?)(?:\]|(?:\)\)))/g;
  let m;
  while ((m = arrayRe.exec(src)) !== null) {
    for (const q of m[1].match(/'([^']+)'/g) ?? []) keys.add(q.slice(1, -1));
    for (const q of m[1].match(/"([^"]+)"/g) ?? []) keys.add(q.slice(1, -1));
  }
  return keys;
}

/**
 * @param {string} haystack
 * @param {string} paramId
 * @param {{ prefixFamilies?: string[], explicitKeys?: Set<string> }} [ctx]
 * @returns {{ count: number, prefixWired: boolean, inExplicitSet: boolean }}
 */
export function countParamRefs(haystack, paramId, ctx = {}) {
  if (paramId === 'enabled') {
    return { count: -1, prefixWired: false, inExplicitSet: false };
  }

  const esc = paramId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const patterns = paramId.includes('.')
    ? [esc, new RegExp(`\\b${esc.split('.').pop()}\\b`).source]
    : [`\\b${esc}\\b`];

  let count = 0;
  for (const pat of patterns) {
    const re = new RegExp(pat, 'g');
    count = Math.max(count, (haystack.match(re) ?? []).length);
  }

  const prefixFamilies = ctx.prefixFamilies ?? [];
  const prefixWired = prefixFamilies.some((pfx) => paramId.startsWith(pfx));
  const inExplicitSet = ctx.explicitKeys?.has(paramId) ?? false;

  return { count, prefixWired, inExplicitSet };
}

export function extractInlineSchemaVar(src, varName) {
  const re = new RegExp(`const\\s+${varName}\\s*=\\s*\\{`, '');
  const m = re.exec(src);
  if (!m) return null;
  let i = m.index + m[0].length - 1;
  let depth = 0;
  const start = i;
  for (; i < src.length; i++) {
    const c = src[i];
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  return null;
}
