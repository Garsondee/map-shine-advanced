/**
 * Shared static parsers for getControlSchema() bodies (Foundry-free).
 */

export const SCHEMA_METHOD_NAMES = ['getControlSchema', 'getBubblesControlSchema'];

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
