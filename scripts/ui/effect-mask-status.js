/**
 * @fileoverview Mask availability probing + authoring templates for Tweakpane effect panels.
 * Templates cover any suffixed texture from the asset loader registry.
 *
 * @module ui/effect-mask-status
 */

import { getEffectMaskRegistry } from '../assets/loader.js';

/** @typedef {'searching'|'found'|'missing-muted'|'missing-alert'} MaskStatusPhase */

/**
 * @typedef {Object} MaskStatusTemplate
 * @property {string} maskId Registry key (e.g. 'water')
 * @property {string} suffix Authored suffix (e.g. '_Water')
 * @property {string} [label] Row label in Tweakpane
 * @property {string} [exampleBase] Base filename without suffix/extension
 * @property {string[]} [formats] Supported extensions
 * @property {string[]} [placement] Where to put the file (bullet lines)
 * @property {string[]} [authoring] How to paint / interpret the mask
 * @property {string} [extra] Optional effect-specific paragraph
 */

/**
 * @typedef {Object} MaskStatusGroupConfig
 * @property {string} [maskId]
 * @property {string} [suffix]
 * @property {string} [label]
 * @property {string} [example]
 * @property {string} [templateId] Alias for maskId when different from effect id
 */

/**
 * @typedef {Object} MaskStatusResult
 * @property {MaskStatusPhase} phase
 * @property {string} message Short status chip text
 * @property {number} [count]
 */

const SUPPORTED_FORMATS = ['webp', 'png', 'jpg', 'jpeg'];

/** @type {Record<string, MaskStatusTemplate>} */
export const MASK_STATUS_TEMPLATES = {
  water: {
    maskId: 'water',
    suffix: '_Water',
    label: 'Texture',
    exampleBase: 'BattleMap',
    formats: SUPPORTED_FORMATS,
    placement: [
      'Place the mask in the same folder as each battlemap albedo image (scene background or tile texture).',
      'Use the same base filename as the art, then add the _Water suffix before the extension.',
      'Example: BattleMap.webp (albedo) and BattleMap_Water.webp (mask) in the same directory.',
      'Multi-floor scenes: add a matching _Water file for each level background and any tiles that need water.',
    ],
    authoring: [
      'Paint a grayscale or RGB mask — Map Shine reads luminance (brightness).',
      'Black (dark) pixels = dry land, no water.',
      'Brighter and whiter pixels = more water; the whitest areas indicate the greatest depth.',
      'Depth drives wave strength, refraction weight, foam, and depth shading in the Water effect.',
    ],
    extra: 'You can use .webp, .png, .jpg, or .jpeg. WebP is recommended for large maps.',
  },
  bush: {
    maskId: 'bush',
    suffix: '_Bush',
    label: 'Texture',
    exampleBase: 'BattleMap',
    formats: SUPPORTED_FORMATS,
    placement: [
      'Place the _Bush texture in the same folder as each battlemap albedo (scene background or tile).',
      'Same base filename + _Bush suffix before the extension (e.g. BattleMap_Bush.webp).',
      'One overlay is created per tile or background that has a matching file.',
    ],
    authoring: [
      'Use an RGBA image — alpha defines the bush silhouette (not a grayscale mask).',
      'Opaque RGB with no alpha may work when the loader derives alpha from luminance.',
      'Weather wind drives motion; sun direction offsets the soft canopy shadow in the shader.',
    ],
    extra: 'Supports .webp, .png, .jpg, and .jpeg.',
  },
  tree: {
    maskId: 'tree',
    suffix: '_Tree',
    label: 'Texture',
    exampleBase: 'BattleMap',
    formats: SUPPORTED_FORMATS,
    placement: [
      'Place the _Tree texture in the same folder as each battlemap albedo (scene background or tile).',
      'Same base filename + _Tree suffix before the extension (e.g. BattleMap_Tree.webp).',
      'High-canopy overlays stack above bushes on the same floor when both are present.',
    ],
    authoring: [
      'Use an RGBA canopy texture — alpha cuts out the treetop shape.',
      'Motion matches bush wind math with optional extra turbulence for high-frequency chop.',
      'Canopy shadow uses the same offset/blur sample pattern as bushes.',
    ],
    extra: 'Supports .webp, .png, .jpg, and .jpeg.',
  },
};

/**
 * Merge registry metadata, built-in template, and schema group overrides.
 * @param {string} maskId
 * @param {MaskStatusGroupConfig} [overrides]
 * @returns {MaskStatusTemplate}
 */
export function getMaskStatusTemplate(maskId, overrides = {}) {
  const id = String(overrides?.maskId || overrides?.templateId || maskId || '').trim();
  const registry = getEffectMaskRegistry()?.[id] ?? null;
  const builtIn = MASK_STATUS_TEMPLATES[id] ?? null;

  const suffix = overrides?.suffix || builtIn?.suffix || registry?.suffix || '_Mask';
  const exampleBase = builtIn?.exampleBase || 'YourMap';

  return {
    maskId: id || maskId,
    suffix,
    label: overrides?.label || builtIn?.label || 'Texture',
    exampleBase,
    formats: builtIn?.formats || SUPPORTED_FORMATS,
    placement: builtIn?.placement || [
      `Place ${suffix} next to each albedo image that should use this mask.`,
      'Same folder, same base name + suffix before the extension.',
    ],
    authoring: builtIn?.authoring || [
      registry?.description
        ? String(registry.description)
        : `Luminance in the ${suffix} mask controls where this effect is active.`,
    ],
    extra: builtIn?.extra || null,
  };
}

/**
 * Long-form help for the (?) control — plain text with paragraph breaks.
 * @param {MaskStatusTemplate} template
 * @returns {string}
 */
export function buildMaskSetupHelpText(template) {
  const fmt = (template.formats || SUPPORTED_FORMATS).join(', .');
  const example = `${template.exampleBase}${template.suffix}.${(template.formats || SUPPORTED_FORMATS)[0]}`;

  const parts = [
    `Required mask: ${example}`,
    '',
    'Naming & placement',
    ...(template.placement || []).map((line) => `• ${line}`),
    '',
    'Painting the mask',
    ...(template.authoring || []).map((line) => `• ${line}`),
  ];

  if (template.extra) {
    parts.push('', template.extra);
  }

  return parts.join('\n');
}

/**
 * User-facing status chip text for the texture row.
 * @param {MaskStatusTemplate} template
 * @param {'searching'|'loaded'|'found'|'missing'} variant
 * @returns {string}
 */
export function formatTextureStatusMessage(template, variant) {
  const suffix = template?.suffix || '_Mask';
  switch (variant) {
    case 'searching':
      return `Searching for ${suffix}…`;
    case 'loaded':
      return `${suffix} Texture Loaded`;
    case 'found':
      return `${suffix} Texture Found`;
    case 'missing':
      return `No ${suffix} Texture Found`;
    default:
      return `${suffix} Texture…`;
  }
}

/**
 * Main Tweakpane host (`uiManager`); legacy alias `tweakpaneManager` is not set on MapShine.
 * @returns {import('./tweakpane-manager.js').TweakpaneManager|null}
 */
function getTweakpaneUiManager() {
  return window.MapShine?.uiManager ?? window.MapShine?.tweakpaneManager ?? null;
}

/**
 * Live V2 compositor (EffectComposer exposes `floorCompositorV2`, not `floorCompositor`).
 * @returns {import('../compositor-v2/FloorCompositor.js').FloorCompositor|null}
 */
function getFloorCompositorInstance() {
  return window.MapShine?.floorCompositorV2
    ?? window.MapShine?.effectComposer?._floorCompositorV2
    ?? window.MapShine?.floorCompositor
    ?? null;
}

/**
 * @returns {import('../compositor-v2/effects/WaterEffectV2.js').WaterEffectV2|null}
 */
function getWaterEffectInstance() {
  const fc = getFloorCompositorInstance();
  return fc?._waterEffect ?? null;
}

function waterRuntimeHasMask(water) {
  if (!water) return false;
  if (typeof water.hasRenderableWater === 'function' && water.hasRenderableWater()) return true;
  if (water._hasAnyWaterData === true) return true;
  if (Array.isArray(water._waterTiles) && water._waterTiles.length > 0) return true;
  if (water._floorWater?.size > 0) return true;
  return false;
}

function waterSourceCount(water) {
  if (!water) return 0;
  if (Array.isArray(water._waterTiles) && water._waterTiles.length > 0) {
    return water._waterTiles.length;
  }
  if (water._floorWater?.size > 0) return water._floorWater.size;
  return water._hasAnyWaterData ? 1 : 0;
}

/**
 * Runtime mask status after populate — no searching, manifest, or discovery-phase UI.
 * @param {MaskStatusTemplate} template
 * @param {object|null} effect
 * @param {string} effectId
 * @param {() => number} getLoadedCount
 * @returns {MaskStatusResult}
 */
function resolvePopulatedMaskStatus(template, effect, effectId, getLoadedCount) {
  const count = getLoadedCount();
  if (count > 0) {
    return {
      phase: 'found',
      message: formatTextureStatusMessage(template, 'loaded'),
      count,
    };
  }
  return resolveMissingTextureStatus(template, effect, effectId);
}

/**
 * @param {MaskStatusGroupConfig} [config]
 * @param {string} [effectId]
 * @returns {MaskStatusResult}
 */
export function resolveWaterMaskStatus(config = {}, effectId = 'water') {
  const template = getMaskStatusTemplate('water', config);
  const water = getWaterEffectInstance();
  return resolvePopulatedMaskStatus(template, water, effectId, () => (
    waterRuntimeHasMask(water) ? waterSourceCount(water) : 0
  ));
}

/**
 * @param {string} compositorProp - e.g. '_bushEffect', '_treeEffect'
 * @returns {object|null}
 */
function getFloorCompositorEffect(compositorProp) {
  const fc = getFloorCompositorInstance();
  return fc?.[compositorProp] ?? null;
}

/**
 * Read the Enabled checkbox in the effect folder (matches what the user sees).
 * @param {string} effectId
 * @returns {boolean|null}
 */
function readEnabledCheckboxFromEffectFolder(effectId) {
  const folderEl = getTweakpaneUiManager()?.effectFolders?.[effectId]?.folder?.element;
  if (!folderEl) return null;
  const content = folderEl.querySelector('.tp-fldv_c') ?? folderEl;
  for (const blade of content.querySelectorAll('.tp-lblv')) {
    const label = blade.querySelector('.tp-lblv_l');
    if (label?.textContent?.trim() !== 'Enabled') continue;
    const input = blade.querySelector('input[type="checkbox"]');
    if (input) return input.checked;
  }
  return null;
}

/**
 * @param {object|null} effect
 * @param {string} [effectId]
 * @returns {boolean}
 */
function isEffectEnabledForTextureStatus(effect, effectId) {
  const checkboxEnabled = effectId ? readEnabledCheckboxFromEffectFolder(effectId) : null;
  if (checkboxEnabled !== null) return checkboxEnabled;

  const uiParams = effectId
    ? getTweakpaneUiManager()?.effectFolders?.[effectId]?.params
    : null;
  if (uiParams && Object.prototype.hasOwnProperty.call(uiParams, 'enabled')) {
    return uiParams.enabled !== false;
  }
  if (!effect) return true;
  if (effect.enabled === false || effect._enabled === false) return false;
  if (effect.params?.enabled === false) return false;
  return true;
}

/**
 * @param {MaskStatusTemplate} template
 * @param {object|null} effect
 * @param {string} [effectId]
 * @returns {MaskStatusResult}
 */
function resolveMissingTextureStatus(template, effect, effectId) {
  const enabled = isEffectEnabledForTextureStatus(effect, effectId);
  return {
    phase: enabled ? 'missing-alert' : 'missing-muted',
    message: formatTextureStatusMessage(template, 'missing'),
  };
}

/**
 * Overlay effects (Bush/Tree): status from _overlays after populate.
 * @param {string} maskId
 * @param {MaskStatusGroupConfig} config
 * @param {string} compositorProp
 * @param {string} [effectId]
 * @returns {MaskStatusResult}
 */
function resolveOverlayMaskStatus(maskId, config, compositorProp, effectId) {
  const template = getMaskStatusTemplate(maskId, config);
  const effect = getFloorCompositorEffect(compositorProp);
  return resolvePopulatedMaskStatus(
    template,
    effect,
    effectId,
    () => Number(effect?._overlays?.size ?? 0),
  );
}

function resolveBushMaskStatus(config = {}, effectId = 'bush') {
  return resolveOverlayMaskStatus('bush', config, '_bushEffect', effectId);
}

function resolveTreeMaskStatus(config = {}, effectId = 'tree') {
  return resolveOverlayMaskStatus('tree', config, '_treeEffect', effectId);
}

/**
 * Standard Tweakpane schema group for the mask-status row template.
 * @param {string} maskId - EFFECT_MASKS key (e.g. 'water', 'tree')
 * @param {MaskStatusGroupConfig} [overrides]
 * @returns {object}
 */
export function createMaskStatusSchemaGroup(maskId, overrides = {}) {
  const template = getMaskStatusTemplate(maskId, overrides);
  const multi = overrides?.multiMask === true;
  const { multiMask: _omitMulti, ...restOverrides } = overrides;
  return {
    name: `mask-status-${template.maskId}`,
    label: restOverrides?.label ?? (multi ? template.suffix : template.label),
    type: 'mask-status',
    maskId: template.maskId,
    templateId: template.maskId,
    suffix: template.suffix,
    parameters: [],
    ...restOverrides,
    type: 'mask-status',
  };
}

/**
 * One mask-status group per mask id, sorted alphabetically by authored suffix.
 * @param {string[]} maskIds - EFFECT_MASKS keys
 * @param {MaskStatusGroupConfig} [sharedOverrides]
 * @returns {object[]}
 */
export function createMaskStatusSchemaGroups(maskIds, sharedOverrides = {}) {
  const ids = [...(Array.isArray(maskIds) ? maskIds : [])].map((id) => String(id || '').trim()).filter(Boolean);
  const multi = ids.length > 1;
  ids.sort((a, b) => {
    const sa = getMaskStatusTemplate(a).suffix;
    const sb = getMaskStatusTemplate(b).suffix;
    return sa.localeCompare(sb, undefined, { sensitivity: 'base' });
  });
  return ids.map((id) => createMaskStatusSchemaGroup(id, { ...sharedOverrides, multiMask: multi }));
}

/**
 * Notify the main config panel to re-probe mask rows (after populate, etc.).
 * @param {string} effectId
 */
export function refreshEffectMaskStatusUi(effectId) {
  try {
    getTweakpaneUiManager()?.refreshEffectMaskStatus?.(effectId);
  } catch (_) {}
}

/**
 * @param {string} effectId
 * @param {MaskStatusGroupConfig} [config]
 * @returns {MaskStatusResult|null}
 */
export function resolveEffectMaskStatus(effectId, config = {}) {
  const maskId = config?.maskId || config?.templateId || effectId;
  switch (maskId) {
    case 'water':
      return resolveWaterMaskStatus(config, effectId);
    case 'bush':
      return resolveBushMaskStatus(config, effectId);
    case 'tree':
      return resolveTreeMaskStatus(config, effectId);
    default:
      if (effectId === 'bush') return resolveBushMaskStatus(config, effectId);
      if (effectId === 'tree') return resolveTreeMaskStatus(config, effectId);
      return null;
  }
}
