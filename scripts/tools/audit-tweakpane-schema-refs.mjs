/**
 * Audit: compare getControlSchema() parameter keys to references in the rest of the file.
 * Run: node scripts/tools/audit-tweakpane-schema-refs.mjs
 *
 * Heuristic only — manual follow-up for dynamic access, uniform rename maps, etc.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoScripts = path.resolve(__dirname, '..');

const FILES = [
  'compositor-v2/effects/LightingEffectV2.js',
  'compositor-v2/effects/BushEffectV2.js',
  'compositor-v2/effects/TreeEffectV2.js',
  'compositor-v2/effects/BuildingShadowsEffectV2.js',
  'compositor-v2/effects/WaterSplashesEffectV2.js',
  'compositor-v2/effects/WaterEffectV2.js',
  'compositor-v2/effects/SpecularEffectV2.js',
  'compositor-v2/effects/FogOfWarEffectV2.js',
  'compositor-v2/effects/FireEffectV2.js',
  'compositor-v2/effects/SkyColorEffectV2.js',
  'compositor-v2/effects/WindowLightEffectV2.js',
  'compositor-v2/effects/OverheadShadowsEffectV2.js',
  'compositor-v2/effects/VisionModeEffectV2.js',
  'compositor-v2/effects/PlayerLightEffectV2.js',
  'compositor-v2/effects/DistortionManager.js',
  'compositor-v2/effects/CloudEffectV2.js',
  'compositor-v2/effects/DustEffectV2.js',
  'compositor-v2/effects/FloorDepthBlurEffect.js',
  'compositor-v2/effects/FluidEffectV2.js',
  'compositor-v2/effects/LensEffectV2.js',
  'compositor-v2/effects/AtmosphericFogEffectV2.js',
  'compositor-v2/effects/FilterEffectV2.js',
  'scene/grid-renderer.js',
  'particles/SmellyFliesEffect.js',
  'compositor-v2/effects/IridescenceEffectV2.js',
  'compositor-v2/effects/PrismEffectV2.js',
  'compositor-v2/effects/AshDisturbanceEffectV2.js',
  'effects/DebugLayerEffect.js',
  'compositor-v2/effects/CandleFlamesEffectV2.js',
  'compositor-v2/effects/LightningEffectV2.js',
  'compositor-v2/effects/BloomEffectV2.js',
  'compositor-v2/effects/AsciiEffectV2.js',
  'compositor-v2/effects/SepiaEffectV2.js',
  'compositor-v2/effects/InvertEffectV2.js',
  'compositor-v2/effects/HalftoneEffectV2.js',
  'compositor-v2/effects/DotScreenEffectV2.js',
  'compositor-v2/effects/DazzleOverlayEffectV2.js',
  'compositor-v2/effects/ColorCorrectionEffectV2.js',
  'compositor-v2/effects/SharpenEffectV2.js',
  'particles/DustMotesEffect.js',
  'effects/MaskDebugEffect.js',
];

const SCHEMA_METHOD_NAMES = [
  'getControlSchema',
  'getBubblesControlSchema',
];

function stripSchemaMethods(src) {
  let out = src;
  for (const name of SCHEMA_METHOD_NAMES) {
    const re = new RegExp(
      `static\\s+${name}\\s*\\([^)]*\\)\\s*\\{`,
      'g'
    );
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
  return out;
}

function extractFirstSchemaBlock(src, methodName) {
  const re = new RegExp(
    `static\\s+${methodName}\\s*\\([^)]*\\)\\s*\\{`,
    ''
  );
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

function extractTopLevelParametersBlock(schemaBody) {
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

function extractParameterKeys(schemaBody) {
  const block = extractTopLevelParametersBlock(schemaBody);
  if (!block) return [];
  const keys = new Set();
  for (const rx of [
    /^\s{8}([a-zA-Z_][a-zA-Z0-9_]*)\s*:/gm,
    /^\s{8}['"]([^'"]+)['"]\s*:/gm,
  ]) {
    let mm;
    while ((mm = rx.exec(block)) !== null) keys.add(mm[1]);
  }
  return [...keys];
}

function extractGroupParamRefs(schemaBody) {
  const refs = new Set();
  const re = /parameters:\s*\[([\s\S]*?)\]/g;
  let m;
  while ((m = re.exec(schemaBody)) !== null) {
    const inner = m[1];
    const sq = inner.match(/'([^']+)'/g) || [];
    const dq = inner.match(/"([^"]+)"/g) || [];
    for (const q of sq) refs.add(q.slice(1, -1));
    for (const q of dq) refs.add(q.slice(1, -1));
  }
  return [...refs];
}

function countRefsOutside(haystack, key) {
  if (key === 'enabled') return -1;
  const esc = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const patterns = key.includes('.')
    ? [esc, new RegExp(`\\b${esc.split('.').pop()}\\b`).source]
    : [`\\b${esc}\\b`];
  let max = 0;
  for (const pat of patterns) {
    const re = new RegExp(pat, 'g');
    const n = (haystack.match(re) || []).length;
    max = Math.max(max, n);
  }
  return max;
}

function auditFile(relPath) {
  const full = path.join(repoScripts, relPath.split('/').join(path.sep));
  if (!fs.existsSync(full)) {
    return { relPath, error: 'missing' };
  }
  const src = fs.readFileSync(full, 'utf8');
  const stripped = stripSchemaMethods(src);
  const methods = [];
  for (const mn of SCHEMA_METHOD_NAMES) {
    const body = extractFirstSchemaBlock(src, mn);
    if (!body) continue;
    const keys = extractParameterKeys(body);
    const groupRefs = new Set(extractGroupParamRefs(body));
    const notInGroup = keys.filter((k) => k !== 'enabled' && !groupRefs.has(k));
    const zeroRef = keys.filter((k) => countRefsOutside(stripped, k) === 0);
    methods.push({ method: mn, keys, notInGroup, zeroRef });
  }
  return { relPath, methods };
}

for (const f of FILES) {
  const r = auditFile(f);
  if (r.error) {
    console.log(`\n## ${f}\n  ERROR: ${r.error}`);
    continue;
  }
  if (!r.methods.length) {
    console.log(`\n## ${f}\n  (no schema methods)`);
    continue;
  }
  for (const m of r.methods) {
    console.log(`\n## ${f} :: ${m.method}`);
    console.log(`  keys: ${m.keys.length}`);
    if (m.notInGroup.length)
      console.log(`  NOT_IN_ANY_GROUP: ${m.notInGroup.join(', ')}`);
    if (m.zeroRef.length)
      console.log(`  ZERO_REFS_OUTSIDE_SCHEMA_METHODS: ${m.zeroRef.join(', ')}`);
  }
}
