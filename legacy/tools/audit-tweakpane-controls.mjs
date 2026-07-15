#!/usr/bin/env node
/**
 * Audits every Tweakpane control in the main Map Shine config panel.
 * Parses getControlSchema() return objects from source (no Foundry runtime).
 *
 * Usage: node scripts/tools/audit-tweakpane-controls.mjs [--out Docs/...]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');

/** @type {Array<{id:string,name:string,category:string,source:string,method?:string}>} */
const EFFECT_REGISTRY = [
  { id: 'weather', name: 'Weather', category: 'atmospheric', source: 'scripts/core/WeatherController.js' },
  { id: 'scene-wind', name: 'Wind', category: 'atmospheric', source: 'scripts/core/SceneWindField.js' },
  { id: 'player-light', name: 'Player Light', category: 'gameplay', source: 'scripts/compositor-v2/effects/PlayerLightEffectV2.js' },
  { id: 'fog', name: 'Fog of War', category: 'gameplay', source: 'scripts/compositor-v2/effects/FogOfWarEffectV2.js' },
  { id: 'visionMode', name: 'Vision Mode', category: 'gameplay', source: 'scripts/compositor-v2/effects/VisionModeEffectV2.js' },
  { id: 'grid', name: 'Grid', category: 'gameplay', source: 'scripts/scene/grid-renderer.js' },
  { id: 'floor-depth-blur', name: 'Floor Depth Blur', category: 'gameplay', source: 'scripts/compositor-v2/effects/FloorDepthBlurEffect.js' },
  { id: 'contextualSceneGrade', name: 'Contextual Scene Grade', category: 'gameplay', source: 'scripts/compositor-v2/effects/ContextualSceneGradeEffectV2.js' },
  { id: 'lighting', name: 'Light Physics', category: 'lighting', source: 'scripts/compositor-v2/effects/LightingEffectV2.js' },
  { id: 'sky-color', name: 'Sky Environment', category: 'lighting', source: 'scripts/compositor-v2/effects/SkyColorEffectV2.js' },
  { id: 'windowLight', name: 'Window Light', category: 'lighting', source: 'scripts/compositor-v2/effects/WindowLightEffectV2.js' },
  { id: 'bloom', name: 'Bloom Highlights', category: 'lighting', source: 'scripts/compositor-v2/effects/BloomEffectV2.js' },
  { id: 'overhead-shadows', name: 'Overhead Shadows', category: 'lighting', source: 'scripts/compositor-v2/effects/OverheadStampEffectV2.js' },
  { id: 'building-shadows', name: 'Building Shadows', category: 'lighting', source: 'scripts/compositor-v2/effects/BuildingShadowsEffectV2.js' },
  { id: 'sky-reach-shadows', name: 'Sky Reach Shadows', category: 'lighting', source: 'scripts/compositor-v2/effects/SkyReachShadowsEffectV2.js' },
  { id: 'painted-shadows', name: 'Painted Shadows', category: 'lighting', source: 'scripts/compositor-v2/effects/PaintedShadowEffectV2.js' },
  { id: 'atmospheric-fog', name: 'Fog & Air', category: 'atmospheric', source: 'scripts/compositor-v2/effects/AtmosphericFogEffectV2.js' },
  { id: 'lightning', name: 'Lightning', category: 'atmospheric', source: 'scripts/compositor-v2/effects/LightningEffectV2.js' },
  { id: 'weather-lightning', name: 'Landscape Lightning', category: 'atmospheric', source: 'scripts/compositor-v2/effects/WeatherLightningEffectV2.js' },
  { id: 'ash-clouds', name: 'Ash Ground Clouds', category: 'atmospheric', source: 'scripts/compositor-v2/effects/AshCloudEffectV2.js' },
  { id: 'cloud', name: 'Sprite Clouds', category: 'atmospheric', source: 'scripts/compositor-v2/effects/CloudEffectV2.js' },
  { id: 'specular', name: 'Metallic / Specular', category: 'surface', source: 'scripts/compositor-v2/effects/specular-control-schema.js', method: 'getSpecularControlSchema' },
  { id: 'fluid', name: 'Fluid', category: 'surface', source: 'scripts/compositor-v2/effects/FluidEffectV2.js' },
  { id: 'iridescence', name: 'Iridescence', category: 'surface', source: 'scripts/compositor-v2/effects/IridescenceEffectV2.js' },
  { id: 'prism', name: 'Prism', category: 'surface', source: 'scripts/compositor-v2/effects/PrismEffectV2.js' },
  { id: 'bush', name: 'Bush', category: 'surface', source: 'scripts/compositor-v2/effects/BushEffectV2.js' },
  { id: 'tree', name: 'Tree', category: 'surface', source: 'scripts/compositor-v2/effects/TreeEffectV2.js' },
  { id: 'water', name: 'Water', category: 'surface', source: 'scripts/compositor-v2/effects/WaterEffectV2.js' },
  { id: 'filter', name: 'Ink & Line AO', category: 'surface', source: 'scripts/compositor-v2/effects/FilterEffectV2.js' },
  { id: 'fire-sparks', name: 'Fire', category: 'particle', source: 'scripts/compositor-v2/effects/FireEffectV2.js' },
  { id: 'ash-disturbance', name: 'Ash Disturbance', category: 'particle', source: 'scripts/compositor-v2/effects/AshDisturbanceEffectV2.js' },
  { id: 'dust', name: 'Dust Motes', category: 'particle', source: 'scripts/compositor-v2/effects/DustEffectV2.js' },
  { id: 'water-splashes', name: 'Water Splashes', category: 'particle', source: 'scripts/compositor-v2/effects/WaterSplashesEffectV2.js' },
  { id: 'underwater-bubbles', name: 'Underwater Bubbles', category: 'particle', source: 'scripts/compositor-v2/effects/WaterSplashesEffectV2.js', method: 'getBubblesControlSchema' },
  { id: 'smelly-flies', name: 'Smelly Flies', category: 'particle', source: 'scripts/particles/SmellyFliesEffect.js' },
  { id: 'candle-flames', name: 'Candle Flames', category: 'particle', source: 'scripts/compositor-v2/effects/CandleFlamesEffectV2.js' },
  { id: 'colorCorrection', name: 'Camera Grade (HDR → LDR)', category: 'post', source: 'scripts/compositor-v2/effects/ColorCorrectionEffectV2.js' },
  { id: 'sharpen', name: 'Sharpen', category: 'post', source: 'scripts/compositor-v2/effects/SharpenEffectV2.js' },
  { id: 'lens', name: 'Lens', category: 'post', source: 'scripts/compositor-v2/effects/LensEffectV2.js' },
  { id: 'dotScreen', name: 'Dot Screen', category: 'post', source: 'scripts/compositor-v2/effects/DotScreenEffectV2.js' },
  { id: 'halftone', name: 'Halftone', category: 'post', source: 'scripts/compositor-v2/effects/HalftoneEffectV2.js' },
  { id: 'ascii', name: 'ASCII Art', category: 'post', source: 'scripts/compositor-v2/effects/AsciiEffectV2.js' },
  { id: 'dazzleOverlay', name: 'Dazzle Overlay', category: 'post', source: 'scripts/compositor-v2/effects/DazzleOverlayEffectV2.js' },
  { id: 'invert', name: 'Color Invert', category: 'post', source: 'scripts/compositor-v2/effects/InvertEffectV2.js' },
  { id: 'sepia', name: 'Sepia Tone', category: 'post', source: 'scripts/compositor-v2/effects/SepiaEffectV2.js' },
  { id: 'ash-weather', name: 'Ash (Weather)', category: 'particle', source: 'scripts/foundry/canvas-replacement.js', method: 'ashWeatherSchema' },
];

const CATEGORY_TITLES = {
  gameplay: 'Gameplay & Interaction',
  lighting: 'Lighting & Shadows',
  atmospheric: 'Atmosphere & Weather',
  surface: 'Surface & Materials',
  particle: 'Particles & VFX',
  post: 'Camera & Post',
  debug: 'Developer Tools',
};

const WORLD_BASED_IDS = new Set(['lighting', 'colorCorrection']);

/**
 * @param {string} src
 * @param {number} openIdx index of opening brace
 */
function extractBalancedBlock(src, openIdx) {
  let depth = 0;
  let inStr = null;
  let escape = false;
  for (let i = openIdx; i < src.length; i++) {
    const ch = src[i];
    if (inStr) {
      if (escape) { escape = false; continue; }
      if (ch === '\\') { escape = true; continue; }
      if (ch === inStr) inStr = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') { inStr = ch; continue; }
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return src.slice(openIdx, i + 1);
    }
  }
  return null;
}

/**
 * @param {string} filePath
 * @param {string} methodName
 */
function extractSchemaFromFile(filePath, methodName = 'getControlSchema') {
  const abs = path.join(ROOT, filePath);
  const src = fs.readFileSync(abs, 'utf8');

  if (methodName === 'ashWeatherSchema') {
    const marker = 'const ashWeatherSchema = ';
    const idx = src.indexOf(marker);
    if (idx < 0) throw new Error(`ashWeatherSchema not found in ${filePath}`);
    const open = src.indexOf('{', idx);
    const block = extractBalancedBlock(src, open);
    if (!block) throw new Error('Failed to parse ashWeatherSchema block');
    return block;
  }

  const patterns = [
    new RegExp(`static\\s+${methodName}\\s*\\(\\s*\\)\\s*\\{[\\s\\S]*?return\\s*\\{`),
    new RegExp(`export\\s+function\\s+${methodName}\\s*\\([\\s\\S]*?\\)\\s*\\{[\\s\\S]*?return\\s*\\{`),
    new RegExp(`function\\s+${methodName}\\s*\\([\\s\\S]*?\\)\\s*\\{[\\s\\S]*?return\\s*\\{`),
  ];

  let match = null;
  for (const re of patterns) {
    match = src.match(re);
    if (match) break;
  }
  if (!match) throw new Error(`${methodName} not found in ${filePath}`);

  const open = src.indexOf('{', match.index + match[0].length - 1);
  const block = extractBalancedBlock(src, open);
  if (!block) throw new Error(`Failed to parse ${methodName} return in ${filePath}`);
  return block;
}

/**
 * Split `{ key: value, ... }` into top-level [key, valueText] pairs.
 * @param {string} objectBlock
 * @returns {[string, string][]}
 */
function splitTopLevelObjectEntries(objectBlock) {
  /** @type {[string, string][]} */
  const entries = [];
  let depth = 0;
  let bracketDepth = 0;
  let inStr = null;
  let escape = false;
  let keyStart = -1;
  let valueStart = -1;
  let currentKey = '';

  for (let i = 0; i < objectBlock.length; i++) {
    const ch = objectBlock[i];
    if (inStr) {
      if (escape) { escape = false; continue; }
      if (ch === '\\') { escape = true; continue; }
      if (ch === inStr) inStr = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') { inStr = ch; continue; }

    if (ch === '{') {
      depth++;
      continue;
    }
    if (ch === '}') {
      if (depth === 1 && bracketDepth === 0 && currentKey && valueStart >= 0) {
        entries.push([currentKey, objectBlock.slice(valueStart, i).trim()]);
      }
      depth--;
      continue;
    }
    if (ch === '[') {
      bracketDepth++;
      continue;
    }
    if (ch === ']') {
      bracketDepth--;
      continue;
    }
    if (depth !== 1 || bracketDepth !== 0) continue;

    if (keyStart < 0 && /[A-Za-z_$]/.test(ch)) keyStart = i;

    if (keyStart >= 0 && valueStart < 0) {
      const head = objectBlock.slice(keyStart, i + 1);
      const km = head.match(/^([A-Za-z_][\w$]*)\s*:\s*/);
      if (km) {
        currentKey = km[1];
        valueStart = keyStart + km[0].length;
        keyStart = -1;
      }
    }

    if (valueStart >= 0 && ch === ',') {
      entries.push([currentKey, objectBlock.slice(valueStart, i).trim()]);
      currentKey = '';
      valueStart = -1;
      keyStart = -1;
    }
  }
  return entries;
}

/** @param {string} src @param {string} paramId */
function extractParamMetaFromSource(src, paramId) {
  const re = new RegExp(`\\b${paramId}\\s*:\\s*\\{`);
  const m = re.exec(src);
  if (!m) {
    const lineRe = new RegExp(`\\b${paramId}\\s*:\\s*\\{[^\\n]+`);
    const lm = lineRe.exec(src);
    if (lm) return parseParamMeta(lm[0]);
    return {};
  }
  const open = src.indexOf('{', m.index + m[0].length - 1);
  const block = extractBalancedBlock(src, open);
  return block ? parseParamMeta(block) : {};
}

/**
 * @param {string} filePath
 * @param {Record<string, any>} parameters
 * @param {string[]} paramIds
 */
function enrichParametersFromSource(filePath, parameters, paramIds) {
  const abs = path.join(ROOT, filePath);
  const src = fs.readFileSync(abs, 'utf8');
  const paramsIdx = src.search(/\bparameters\s*:\s*\{/);
  if (paramsIdx < 0) return parameters;
  const slice = src.slice(paramsIdx);

  const out = { ...parameters };
  for (const pid of paramIds) {
    if (out[pid]?.label) continue;
    const meta = extractParamMetaFromSource(slice, pid);
    if (Object.keys(meta).length) {
      out[pid] = { ...(out[pid] ?? {}), ...meta };
    } else if (!out[pid]) {
      out[pid] = {};
    }
  }
  return out;
}

/**
 * @param {string} block
 */
function collectSchemaParamIds(block, groups) {
  const ids = new Set(Object.keys(parseParameters(block)));
  for (const g of groups) {
    for (const pid of g.parameters ?? []) ids.add(pid);
  }
  return [...ids];
}

function parseParameters(block) {
  const paramsIdx = block.search(/\bparameters\s*:\s*\{/);
  if (paramsIdx < 0) return {};

  const open = block.indexOf('{', paramsIdx);
  const paramsBlock = extractBalancedBlock(block, open);
  if (!paramsBlock) return {};

  /** @type {Record<string, any>} */
  const out = {};
  for (const [key, valueText] of splitTopLevelObjectEntries(paramsBlock)) {
    if (key.startsWith('...')) continue;
    out[key] = parseParamMeta(valueText);
  }
  return out;
}

/** @param {string} text */
function parseParamMeta(text) {
  const meta = {};
  const label = text.match(/label\s*:\s*['"]([^'"]+)['"]/);
  if (label) meta.label = label[1];
  const type = text.match(/type\s*:\s*['"]([^'"]+)['"]/);
  if (type) meta.type = type[1];
  const hidden = /hidden\s*:\s*true/.test(text);
  if (hidden) meta.hidden = true;
  const readonly = /readonly\s*:\s*true/.test(text);
  if (readonly) meta.readonly = true;
  const gmOnly = /gmOnly\s*:\s*true/.test(text);
  if (gmOnly) meta.gmOnly = true;
  const advanced = /advanced\s*:\s*true/.test(text);
  if (advanced) meta.advanced = true;
  const title = text.match(/title\s*:\s*['"]([^'"]+)['"]/);
  if (title) meta.title = title[1];
  if (/type\s*:\s*['"]button['"]/.test(text) || /\btype\s*:\s*'button'/.test(text)) meta.type = 'button';
  return meta;
}

/**
 * @param {string} block
 */
function parseGroups(block) {
  const groupsIdx = block.search(/\bgroups\s*:/);
  if (groupsIdx < 0) return [];

  const arrOpen = block.indexOf('[', groupsIdx);
  const arrBlock = extractBalancedBlockArr(block, arrOpen);
  if (!arrBlock) return [];

  /** @type {any[]} */
  const groups = [];
  let depth = 0;
  let objStart = -1;
  let inStr = null;
  let escape = false;
  for (let i = 0; i < arrBlock.length; i++) {
    const ch = arrBlock[i];
    if (inStr) {
      if (escape) { escape = false; continue; }
      if (ch === '\\') { escape = true; continue; }
      if (ch === inStr) inStr = null;
      continue;
    }
    if (ch === '"' || ch === "'") { inStr = ch; continue; }
    if (ch === '{') {
      if (depth === 0) objStart = i;
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0 && objStart >= 0) {
        const objText = arrBlock.slice(objStart, i + 1);
        groups.push(parseGroupObject(objText));
        objStart = -1;
      }
    }
  }
  const spreadGroups = parseMaskStatusSpreads(arrBlock);
  return [...spreadGroups, ...groups];
}

/** @param {string} groupsArrText */
function parseMaskStatusSpreads(groupsArrText) {
  /** @type {any[]} */
  const out = [];
  const single = [...groupsArrText.matchAll(/createMaskStatusSchemaGroup\(\s*['"]([^'"]+)['"]/g)];
  for (const m of single) {
    out.push({
      label: `_${m[1]} mask status`,
      type: 'mask-status',
      categoryId: null,
      advanced: false,
      parameters: [],
    });
  }
  const multi = [...groupsArrText.matchAll(/createMaskStatusSchemaGroups\(\s*\[([\s\S]*?)\]/g)];
  for (const m of multi) {
    const ids = [...m[1].matchAll(/['"]([^'"]+)['"]/g)].map((x) => x[1]);
    for (const id of ids) {
      out.push({
        label: `_${id} mask status`,
        type: 'mask-status',
        categoryId: null,
        advanced: false,
        parameters: [],
      });
    }
  }
  return out;
}

/** @param {string} src @param {number} openIdx */
function extractBalancedBlockArr(src, openIdx) {
  let depth = 0;
  let inStr = null;
  let escape = false;
  for (let i = openIdx; i < src.length; i++) {
    const ch = src[i];
    if (inStr) {
      if (escape) { escape = false; continue; }
      if (ch === '\\') { escape = true; continue; }
      if (ch === inStr) inStr = null;
      continue;
    }
    if (ch === '"' || ch === "'") { inStr = ch; continue; }
    if (ch === '[') depth++;
    else if (ch === ']') {
      depth--;
      if (depth === 0) return src.slice(openIdx, i + 1);
    }
  }
  return null;
}

/** @param {string} objText */
function parseGroupObject(objText) {
  const label = objText.match(/label\s*:\s*['"]([^'"]+)['"]/);
  const type = objText.match(/type\s*:\s*['"]([^'"]+)['"]/);
  const categoryId = objText.match(/categoryId\s*:\s*['"]([^'"]+)['"]/);
  const advanced = /advanced\s*:\s*true/.test(objText);
  const paramsMatch = objText.match(/parameters\s*:\s*\[([\s\S]*?)\]/);
  const parameters = [];
  if (paramsMatch) {
    const inner = paramsMatch[1];
    const ids = inner.match(/['"]([A-Za-z_][\w]*)['"]/g) ?? inner.match(/\b([A-Za-z_][\w]*)\b/g) ?? [];
    for (const raw of ids) {
      const id = raw.replace(/['"]/g, '');
      if (!['parameters', 'type', 'folder', 'inline', 'mask', 'status', 'true', 'false'].includes(id)) {
        parameters.push(id);
      }
    }
  }
  return {
    label: label?.[1] ?? '(unnamed group)',
    type: type?.[1] ?? 'inline',
    categoryId: categoryId?.[1] ?? null,
    advanced,
    parameters,
  };
}

/** @param {string} block */
function hasPresets(block) {
  return /\bpresets\s*:/.test(block);
}

/** @param {string} block */
function hasHelp(block) {
  return /\bhelp\s*:/.test(block);
}

/** @param {any[]} groups */
function hasMaskStatus(groups) {
  return groups.some((g) => g.type === 'mask-status');
}

/**
 * @param {string} paramId
 * @param {any} meta
 */
function formatControl(paramId, meta) {
  const parts = [];
  const displayLabel = meta.label || meta.title || paramId;
  if (meta.type === 'button') {
    parts.push(`**${displayLabel}** (button)`);
  } else if (meta.label || meta.title) {
    parts.push(`**${displayLabel}** (\`${paramId}\`)`);
  } else {
    parts.push(`**${paramId}** (\`${paramId}\`)`);
  }
  const flags = [];
  if (meta.hidden) flags.push('hidden');
  if (meta.readonly) flags.push('readonly');
  if (meta.gmOnly) flags.push('GM only');
  if (meta.advanced) flags.push('advanced');
  if (meta.type && meta.type !== 'button') flags.push(meta.type);
  if (flags.length) parts.push(` — ${flags.join(', ')}`);
  return parts.join('');
}

/**
 * @param {string} effectId
 * @param {string} effectName
 * @param {string} category
 * @param {Record<string, any>} parameters
 * @param {any[]} groups
 * @param {string} schemaBlock
 */
function renderEffectSection(effectId, effectName, category, parameters, groups, schemaBlock) {
  const lines = [];
  lines.push(`### ${effectName}`);
  lines.push('');
  lines.push(`- **Effect ID:** \`${effectId}\``);
  lines.push(`- **Category:** ${CATEGORY_TITLES[category] ?? category}`);
  lines.push('');

  lines.push('#### Standard effect chrome');
  lines.push('');
  if (hasHelp(schemaBlock)) lines.push('- (?) Effect help (button)');
  if (WORLD_BASED_IDS.has(effectId)) lines.push('- **World Based** (toggle)');
  if (hasPresets(schemaBlock)) lines.push('- **Preset** (dropdown)');
  lines.push('- **Enabled** (toggle)');
  if (hasMaskStatus(groups)) lines.push('- **Texture / mask status row(s)** (readonly status under Enabled)');
  lines.push('- **Reset to Defaults** (button)');
  lines.push('- **Defaults prompt (for devs)** (button)');
  if (effectId === 'contextualSceneGrade') lines.push('- **Open live diagnostics…** (button)');
  lines.push('');

  const mainGroups = groups.filter((g) => !g.categoryId && g.type !== 'mask-status');
  const externalGroups = groups.filter((g) => g.categoryId && g.type !== 'mask-status');
  const maskGroups = groups.filter((g) => g.type === 'mask-status');

  if (maskGroups.length) {
    lines.push('#### Mask status (under Enabled)');
    lines.push('');
    for (const g of maskGroups) {
      lines.push(`- ${g.label || 'Texture status'}`);
    }
    lines.push('');
  }

  if (mainGroups.length) {
    lines.push('#### Parameter groups');
    lines.push('');
    for (const g of mainGroups) {
      const groupTitle = g.type === 'folder' ? g.label : (g.label || 'Inline');
      lines.push(`##### ${groupTitle}${g.advanced ? ' *(advanced)*' : ''}`);
      lines.push('');
      for (const pid of g.parameters) {
        const meta = parameters[pid] ?? {};
        if (meta.hidden) continue;
        lines.push(`- ${formatControl(pid, meta)}`);
      }
      lines.push('');
    }
  } else {
    lines.push('#### Parameters (flat)');
    lines.push('');
    for (const [pid, meta] of Object.entries(parameters)) {
      if (pid === 'enabled' || meta.hidden) continue;
      lines.push(`- ${formatControl(pid, meta)}`);
    }
    lines.push('');
  }

  if (externalGroups.length) {
    lines.push('#### Cross-category groups');
    lines.push('');
    lines.push('These groups render under another top-level category but persist under this effect.');
    lines.push('');
    for (const g of externalGroups) {
      lines.push(`##### ${g.label} → ${CATEGORY_TITLES[g.categoryId] ?? g.categoryId}${g.advanced ? ' *(advanced)*' : ''}`);
      lines.push('');
      for (const pid of g.parameters) {
        const meta = parameters[pid] ?? {};
        if (meta.hidden) continue;
        lines.push(`- ${formatControl(pid, meta)}`);
      }
      lines.push('');
    }
  }

  // Orphan params not in any group
  const grouped = new Set(groups.flatMap((g) => g.parameters));
  const orphans = Object.keys(parameters).filter((k) => !grouped.has(k) && k !== 'enabled' && !parameters[k]?.hidden);
  if (orphans.length && mainGroups.length) {
    lines.push('#### Ungrouped parameters');
    lines.push('');
    for (const pid of orphans) {
      lines.push(`- ${formatControl(pid, parameters[pid])}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

function renderManualSections() {
  return `
## Panel chrome (always visible)

### Universal toolbar
- **Scene status** — ON/OFF badge + Enable/Disable toggle *(GM only)*
- **Filter sections…** — search input
- **Advanced Mode** — checkbox *(reveals advanced-tagged controls)*

### Presets bar
- **Presets** — scene preset dropdown (built-in JSON presets + Custom)
- **Revert** — button *(visible after preset apply)*

---

## Top-level sections (outside effect categories)

### Quick Actions
Grid buttons *(several marked advanced — hidden until Advanced Mode)*:

| Button | Advanced |
|--------|----------|
| Defaults | yes |
| Undo Defaults | yes |
| Texture Manager | yes |
| Effect Stack | yes |
| Streaming Minimap | yes |
| Tile Streaming Report | no |
| Diagnostic Center | yes |
| Pixel Probe | yes |
| Breaker Box | yes |
| Performance Recorder | yes |
| Map Points | no *(GM only)* |
| Tile Motion | no |
| Token Movement | no |
| Camera Path | no *(GM only)* |
| Levels Authoring | no *(GM only)* |
| Copy From Scene | yes *(GM only)* |
| Reset Effects… | yes *(GM only)* |
| Apply to All Scenes… | yes *(GM only)* |
| Scene Recovery | yes |
| Scene Reset | yes |

### Panel Appearance
- **Colour scheme** (dropdown)

### Intros
- **Enable** (toggle)
- **Loading Screens…** (button)

### Getting Started *(onboarding only — scene not yet enabled)*
- Description text
- **Enable Map Shine Advanced for this Scene** / **Upgrade Scene…** (button)

### Support & Links *(advanced primary folder)*
- Report a Bug (link)
- Documentation (link)
- Discord (link)

---

## Gameplay & Interaction *(category)*

### Tokens & Character Rendering

#### Color Correction
- **Enabled**
- **Exposure**
- **Brightness**
- **Contrast**
- **Saturation**
- **Gamma** *(advanced)*
- **Temperature** *(advanced)*
- **Tint** *(advanced)*
- **Window Light Intensity** *(advanced)*
- **Reset Token CC** (button)

---

## Lighting & Shadows *(category)*

### Sun & Shadows

#### Direction
- **Sun latitude**

#### Time-of-day softness *(advanced folder)*
- **Noon (sharp)**
- **Golden hour (soft)**
- **Midnight (moon)**
- **Golden hour width (h)**
- **Noon peak width (h)**
- **Midnight peak width (h)**

#### Length & smear *(advanced folder)*
- **Noon length**
- **Golden hour length**
- **Midnight length**
- **Noon smear**
- **Golden hour smear**
- **Midnight smear**

#### Weather *(advanced folder)*
- **Cloud softness boost**

---

## Camera & Post *(category — external integrations)*

### Dice So Nice
- **Enabled**
- **Performance** *(advanced folder)*: Preset, Max Pixel Ratio, Max Upload FPS, Hide Delay (ms)
- **Look**: Opacity, Tint, Brightness, Saturation, Contrast, Gamma *(advanced)*
- **Reset Dice So Nice Look** (button)

### Sequencer / JB2A
- **Enabled**
- **Look**: Brightness, Tint
- **Mirror scale** *(advanced)*: Footprint multiplier
- **Placement** *(advanced)*: Along-cast delta, Toward target (+px), Z bias (world), Forward Pivot, Reverse Pivot
- **Diagnostics**: Probe Active Mirrors, Probe Active Mirrors (Deep)
- **Reset Sequencer Look + Placement** (button)

---

## Particles & VFX *(category)*

### Rope & Chain
- **Rope Texture** + Browse Rope Texture (button)
- **Chain Texture** + Browse Chain Texture (button)

#### Rope Defaults *(advanced)*
Segment Length, Damping, Wind Force, Wind Gust Amount, Invert Wind Direction, Gravity Strength, Slack Factor, Bend Stiffness, Constraint Iterations, Width, Tapering, UV Repeat (px), Window Light Boost, End Fade Size, End Fade Strength

#### Chain Defaults *(advanced)*
Same controls as Rope Defaults

---

## Developer Tools *(category — advanced primary folder)*

### UI
- **Run UI Validator** (button)

### Settings
- Copy Non-Default Settings, Copy Changed This Session, Copy All Current Settings (buttons)

### Scene
- Dump Surface Report, Pixel Probe — Pick on Map (A/B/C), Pixel Probe — Show Last Report, Pixel Probe — Cancel Pick, Paste Scene Settings, Copy effects from another scene… (buttons)

### Calibration
- **Calibration Mode** (dropdown)
- Chart Spec Path, Run Calibration Scan, Export Calibration Report, Run Calibration Scan (v2 tiled), **Workflow: apply neutral first**, Run Full Calibration Workflow, Apply Calibration Neutral Preset (buttons)

### Mask Registry
- Dump Registry State (button)
- Dump Tile Contributions (button)
- **Mask Type Toggles** *(folder)*: water, fire, outdoors, windows, specular, normal, tree, bush, dust, ash, iridescence, prism, roughness, fluid

### Mask overlay (V2)
- **Show overlay**
- **Mask** (dropdown)
- **Opacity**

### Indoors vs Outdoors (effective mask)
- **Show debug view**
- **View** (dropdown)
- **Replace scene (B&W)**
- **Overlay opacity**
- **Defringe strength**
- **Indoor edge cutoff**
- **Edge outdoor bleed**
- Rebuild masks (defringe), Log stack diagnostics (buttons)

### VRAM Budget
- Dump Budget State (button)
`.trim();
}

function main() {
  const outArgIdx = process.argv.indexOf('--out');
  const outPath = outArgIdx >= 0
    ? path.resolve(ROOT, process.argv[outArgIdx + 1])
    : path.join(ROOT, 'Docs', 'tweakpane-main-config-controls-report.md');

  const errors = [];
  /** @type {Map<string, string[]>} */
  const byCategory = new Map();

  for (const entry of EFFECT_REGISTRY) {
    try {
      const block = extractSchemaFromFile(entry.source, entry.method ?? 'getControlSchema');
      let parameters = parseParameters(block);
      const groups = parseGroups(block);
      const allParamIds = collectSchemaParamIds(block, groups);
      parameters = enrichParametersFromSource(entry.source, parameters, allParamIds);
      const section = renderEffectSection(entry.id, entry.name, entry.category, parameters, groups, block);
      if (!byCategory.has(entry.category)) byCategory.set(entry.category, []);
      byCategory.get(entry.category).push(section);
    } catch (e) {
      errors.push(`- \`${entry.id}\`: ${e.message}`);
    }
  }

  const categoryOrder = ['gameplay', 'lighting', 'atmospheric', 'surface', 'particle', 'post'];

  const lines = [];
  lines.push('# Map Shine Main Config Panel — Tweakpane Controls Report');
  lines.push('');
  lines.push(`Generated: ${new Date().toISOString().slice(0, 10)}`);
  lines.push('');
  lines.push('Complete inventory of controls in the main **Map Shine Advanced** Tweakpane panel (`TweakpaneManager`).');
  lines.push('Effect parameters are parsed from each effect\'s `getControlSchema()` source. Standard per-effect chrome (Enabled, Reset, etc.) is listed explicitly.');
  lines.push('');
  lines.push('**Notes:**');
  lines.push('- Controls tagged *advanced* are hidden until **Advanced Mode** is enabled in the toolbar.');
  lines.push('- Controls tagged *GM only* render only for GMs.');
  lines.push('- *Hidden* parameters exist in schema but do not render in the panel.');
  lines.push('- Weather **Rain Particles** group is registered under **Particles & VFX** via `categoryId`.');
  lines.push('');

  lines.push(renderManualSections());
  lines.push('');
  lines.push('---');
  lines.push('');
  lines.push('## Registered effects by category');
  lines.push('');

  for (const cat of categoryOrder) {
    const sections = byCategory.get(cat);
    if (!sections?.length) continue;
    lines.push(`## ${CATEGORY_TITLES[cat]}`);
    lines.push('');
    lines.push(...sections);
    lines.push('');
  }

  if (errors.length) {
    lines.push('## Extraction errors');
    lines.push('');
    lines.push(...errors);
    lines.push('');
  }

  const totalEffects = EFFECT_REGISTRY.length - errors.length;
  lines.push('---');
  lines.push('');
  lines.push(`**Summary:** ${totalEffects} effect folders documented across ${categoryOrder.length} categories, plus manual panel sections above.`);

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, lines.join('\n'), 'utf8');
  console.log(`Wrote ${outPath}`);
  if (errors.length) {
    console.error(`${errors.length} extraction error(s); see report.`);
    process.exitCode = 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main();
}
