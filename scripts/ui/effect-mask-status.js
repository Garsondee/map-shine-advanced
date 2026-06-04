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
 * @property {string} [label] Row label override (e.g. dynamic _Windows vs _Structural)
 * @property {string} [helpMaskId] Template key for the ? setup dialog
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
  iridescence: {
    maskId: 'iridescence',
    suffix: '_Iridescence',
    label: 'Texture',
    exampleBase: 'BattleMap',
    formats: SUPPORTED_FORMATS,
    placement: [
      'Place the _Iridescence texture beside each battlemap albedo (scene background or tile).',
      'Same base filename + _Iridescence before the extension (e.g. BattleMap_Iridescence.webp).',
      'One holographic overlay is created per tile or background that has a matching file.',
    ],
    authoring: [
      'Map Shine uses luminance × alpha — paint bright (usually white) where thin-film shimmer should appear.',
      'Transparent areas stay empty. Use **Invert mask** in the effect if you painted dark-on-light instead.',
      'Foundry lights tint the layer; **Ignore darkness** keeps color visible in shadow.',
    ],
    extra: 'Supports .webp, .png, .jpg, and .jpeg.',
  },
  prism: {
    maskId: 'prism',
    suffix: '_Prism',
    label: 'Texture',
    exampleBase: 'BattleMap',
    formats: SUPPORTED_FORMATS,
    placement: [
      'Place the _Prism texture beside each battlemap albedo (scene background or tile).',
      'Same base filename + _Prism before the extension (e.g. BattleMap_Prism.webp).',
      'One crystal/refraction overlay is created per masked source.',
    ],
    authoring: [
      'Grayscale or RGB — brightness above **Mask brightness cutoff** defines glass or crystal areas.',
      'Brighter mask pixels = stronger refraction, facets, and surface glint.',
      'Pairs with the tile albedo for parallax and spectral spread in the shader.',
    ],
    extra: 'Supports .webp, .png, .jpg, and .jpeg.',
  },
  fluid: {
    maskId: 'fluid',
    suffix: '_Fluid',
    label: 'Texture',
    exampleBase: 'BattleMap',
    formats: SUPPORTED_FORMATS,
    placement: [
      'Place the _Fluid mask beside each battlemap albedo (scene background or tile).',
      'Same base filename + _Fluid before the extension (e.g. BattleMap_Fluid.webp).',
      'One fluid overlay is created per masked source on the floor bus.',
    ],
    authoring: [
      'Grayscale mask — luminance between **Low** and **High threshold** defines where fluid simulates.',
      'Paint flow channels, pools, and streams; RGB tint uniforms color young vs aged fluid in the shader.',
      'Supports caustics, foam, iridescence, and churn on top of the masked region.',
    ],
    extra: 'Supports .webp, .png, .jpg, and .jpeg.',
  },
  specular: {
    maskId: 'specular',
    suffix: '_Specular',
    label: '_Specular',
    exampleBase: 'BattleMap',
    formats: SUPPORTED_FORMATS,
    placement: [
      'Place the _Specular texture beside each battlemap albedo (scene background or tile).',
      'Same base filename + _Specular before the extension (e.g. BattleMap_Specular.webp).',
      'One additive shine overlay is created per masked tile or background.',
    ],
    authoring: [
      'Grayscale or RGB — brighter pixels add metallic/stripe/sparkle response on top of the albedo.',
      'Stripes, wetness, frost, and Foundry lights multiply into this mask (not a PBR normal map).',
      'Tune **Mask brightness cutoff** if highlights bleed into dark paint.',
    ],
    extra: 'Supports .webp, .png, .jpg, and .jpeg.',
  },
  windows: {
    maskId: 'windows',
    suffix: '_Windows',
    label: '_Windows',
    exampleBase: 'BattleMap',
    formats: SUPPORTED_FORMATS,
    placement: [
      'Place the _Windows mask beside each floor’s battlemap background (and tiles when authored per-tile).',
      'Same base filename + _Windows before the extension (e.g. BattleMap_Windows.webp).',
      'Window Light reads this from GpuSceneMaskCompositor in scene UV (per-floor slots 0–3).',
    ],
    authoring: [
      'Grayscale or RGBA — bright pixels mark window glass for emissive glow in scene space.',
      'Used with the time-of-day timeline and cloud dimming; pairs with Glass Refraction in the shader.',
      'Legacy battlemaps may use _Structural instead — the status row switches to that suffix when only the old file is present.',
    ],
    extra: 'Supports .webp, .png, .jpg, and .jpeg.',
  },
  structural: {
    maskId: 'structural',
    suffix: '_Structural',
    label: '_Structural',
    exampleBase: 'BattleMap',
    formats: SUPPORTED_FORMATS,
    placement: [
      'Legacy window mask suffix — same folder/naming as _Windows (e.g. BattleMap_Structural.webp).',
      'Loaded when no _Windows file is present for that art path; compositor treats it as the window mask tier.',
    ],
    authoring: [
      'Same painting rules as _Windows — bright = lit window areas in scene UV.',
      'Prefer migrating art to _Windows; _Structural remains supported for older battlemaps.',
    ],
    extra: 'Supports .webp, .png, .jpg, and .jpeg.',
  },
  fire: {
    maskId: 'fire',
    suffix: '_Fire',
    label: '_Fire',
    exampleBase: 'BattleMap',
    formats: SUPPORTED_FORMATS,
    placement: [
      'Place the _Fire mask beside each battlemap albedo (scene background or tile).',
      'Same base filename + _Fire before the extension (e.g. BattleMap_Fire.webp).',
      'Spawn points are picked up on the CPU per floor; particles stack on the FloorRenderBus.',
    ],
    authoring: [
      'Grayscale or RGBA — bright pixels become flame, ember, and smoke spawn sites.',
      'Tune **Fire Mask Pickup** thresholds if sparks appear on albedo instead of painted fire.',
      'Multi-floor Levels: each level background can carry its own _Fire for that floor index.',
    ],
    extra: 'Supports .webp, .png, .jpg, and .jpeg.',
  },
  dust: {
    maskId: 'dust',
    suffix: '_Dust',
    label: '_Dust',
    exampleBase: 'BattleMap',
    formats: SUPPORTED_FORMATS,
    placement: [
      'Place the _Dust mask beside each battlemap albedo (scene background or tile).',
      'Same base filename + _Dust before the extension (e.g. BattleMap_Dust.webp).',
      'Optional Map Points dust sources can supplement mask scans per floor.',
    ],
    authoring: [
      'Grayscale mask — bright pixels spawn floating dust motes in a vertical volume above the art.',
      'Glitter and sky tint are optional artistic layers on top of the base particle field.',
      'Multi-floor Levels: bind each level background _Dust to its floor index.',
    ],
    extra: 'Supports .webp, .png, .jpg, and .jpeg.',
  },
  ash: {
    maskId: 'ash',
    suffix: '_Ash',
    label: '_Ash',
    exampleBase: 'BattleMap',
    formats: SUPPORTED_FORMATS,
    placement: [
      'Place the _Ash mask beside each battlemap albedo (scene background or tile).',
      'Same base filename + _Ash before the extension (e.g. BattleMap_Ash.webp).',
      'Bursts trigger when tokens move across bright mask pixels on the active floor.',
    ],
    authoring: [
      'Grayscale mask — brighter pixels define where foot traffic kicks up ash puffs.',
      'Works with Manual Weather ash intensity; effect can stay enabled with zero weather ash.',
      'CPU scan is strided for performance — very fine detail may need a higher-resolution mask.',
    ],
    extra: 'Supports .webp, .png, .jpg, and .jpeg.',
  },
  handPaintedShadow: {
    maskId: 'handPaintedShadow',
    suffix: '_Shadow',
    label: '_Shadow',
    exampleBase: 'BattleMap',
    formats: SUPPORTED_FORMATS,
    placement: [
      'Place the _Shadow mask beside each floor’s battlemap background (and tiles when authored per-tile).',
      'Same base filename + _Shadow before the extension (e.g. BattleMap_Shadow.webp).',
      'GpuSceneMaskCompositor loads it in scene UV; multi-floor maps may use per-level variants.',
    ],
    authoring: [
      'Grayscale mask — **dark = shadow caster** (trees, awnings, rooflines) projected along the sun direction.',
      'Painted shadow only affects **outdoor** pixels gated by the scene _Outdoors mask.',
      'Blur, contact preserve, and edge inflate tune how crisp the projected penumbra reads.',
    ],
    extra: 'Supports .webp, .png, .jpg, and .jpeg.',
  },
  outdoors: {
    maskId: 'outdoors',
    suffix: '_Outdoors',
    label: '_Outdoors',
    exampleBase: 'BattleMap',
    formats: SUPPORTED_FORMATS,
    placement: [
      'Place the _Outdoors mask beside each floor’s battlemap art (background and tiles).',
      'Same base filename + _Outdoors before the extension (e.g. BattleMap_Outdoors.webp).',
      'Multi-floor scenes may use per-level variants (_Outdoors_0, _Outdoors_1, …) via the GPU mask compositor.',
    ],
    authoring: [
      'Grayscale mask — **white = outdoor**, **black = indoor** (roofed) for stripe and wet-surface gating.',
      'Specular samples this from GpuSceneMaskCompositor per floor when available.',
      'Camera Grade uses this for interior vs outdoor timeline exposure/saturation and outdoor atmosphere gating.',
      'Without _Outdoors, outdoor stripe modulation and wet response fall back to neutral.',
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
 * @param {object|null} effect
 * @returns {number}
 */
function waterSplashesMaskLoadedCount(effect) {
  if (!effect) return 0;
  try {
    if (effect._floorStates?.size > 0) return 1;
    for (const [, st] of effect._floorStates ?? []) {
      const n = (st?.foamSystems?.length ?? 0)
        + (st?.splashSystems?.length ?? 0)
        + (st?.foamSystems2?.length ?? 0)
        + (st?.splashSystems2?.length ?? 0);
      if (n > 0) return 1;
    }
  } catch (_) {}
  return 0;
}

/**
 * @param {MaskStatusGroupConfig} [config]
 * @param {string} [effectId]
 * @returns {MaskStatusResult}
 */
function resolveWaterSplashesMaskStatus(config = {}, effectId = 'water-splashes') {
  const template = getMaskStatusTemplate('water', config);
  const effect = getFloorCompositorEffect('_waterSplashesEffect');
  return resolvePopulatedMaskStatus(
    template,
    effect,
    effectId,
    () => waterSplashesMaskLoadedCount(effect),
  );
}

/** Refresh _Water rows on Water Splashes and Underwater Bubbles panels. */
export function refreshWaterSplashesMaskStatusUi() {
  try {
    refreshEffectMaskStatusUi('water-splashes');
    refreshEffectMaskStatusUi('underwater-bubbles');
  } catch (_) {}
}

/**
 * @param {object|null} effect
 * @returns {number}
 */
function dustMaskLoadedCount(effect) {
  if (!effect) return 0;
  try {
    for (const [, st] of effect._floorStates ?? []) {
      if (st?.points?.length > 0 || (st?.systems?.length ?? 0) > 0) return 1;
    }
    if (effect._floorStates?.size > 0) return 1;
  } catch (_) {}
  return 0;
}

/**
 * @param {MaskStatusGroupConfig} [config]
 * @param {string} [effectId]
 * @returns {MaskStatusResult}
 */
function resolveDustMaskStatus(config = {}, effectId = 'dust') {
  const template = getMaskStatusTemplate('dust', config);
  const effect = getFloorCompositorEffect('_dustEffect');
  return resolvePopulatedMaskStatus(
    template,
    effect,
    effectId,
    () => dustMaskLoadedCount(effect),
  );
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
 * Overlay effects (Bush/Tree/Prism/Iridescence): status from _overlays after populate.
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

function resolveIridescenceMaskStatus(config = {}, effectId = 'iridescence') {
  return resolveOverlayMaskStatus('iridescence', config, '_iridescenceEffect', effectId);
}

function resolvePrismMaskStatus(config = {}, effectId = 'prism') {
  return resolveOverlayMaskStatus('prism', config, '_prismEffect', effectId);
}

function resolveFluidMaskStatus(config = {}, effectId = 'fluid') {
  return resolveOverlayMaskStatus('fluid', config, '_fluidEffect', effectId);
}

/**
 * @returns {import('../masks/GpuSceneMaskCompositor.js').GpuSceneMaskCompositor|null}
 */
function getGpuSceneMaskCompositor() {
  return window.MapShine?.gpuSceneMaskCompositor
    ?? window.MapShine?.sceneComposer?._sceneMaskCompositor
    ?? null;
}

/**
 * @param {'outdoors'|'windows'|'structural'} maskType
 * @returns {boolean}
 */
function compositorHasMaskType(maskType) {
  const compositor = getGpuSceneMaskCompositor();
  if (!compositor) return false;
  if (compositor.getGroundFloorMaskTexture?.(maskType)) return true;
  const floors = window.MapShine?.floorStack?.getFloors?.() ?? [];
  for (const floor of floors) {
    const key = floor?.compositorKey;
    if (key && compositor.getFloorTexture?.(String(key), maskType)) return true;
  }
  try {
    const meta = compositor._floorMeta;
    if (meta && typeof meta.forEach === 'function') {
      for (const [k] of meta) {
        if (compositor.getFloorTexture?.(String(k), maskType)) return true;
      }
    } else if (meta && typeof meta.keys === 'function') {
      for (const k of meta.keys()) {
        if (compositor.getFloorTexture?.(String(k), maskType)) return true;
      }
    }
  } catch (_) {}
  try {
    const cache = compositor._floorCache;
    if (cache && typeof cache.keys === 'function') {
      for (const k of cache.keys()) {
        if (compositor.getFloorTexture?.(String(k), maskType)) return true;
      }
    }
  } catch (_) {}
  return false;
}

/**
 * @returns {number} 1 if any runtime _Outdoors binding exists, else 0
 */
function outdoorsRuntimeLoadedCount() {
  if (compositorHasMaskType('outdoors')) return 1;
  try {
    if (globalThis.weatherController?.roofMap) return 1;
  } catch (_) {}
  try {
    if (window.MapShine?.maskManager?.getTexture?.('outdoors.scene')) return 1;
  } catch (_) {}
  return 0;
}

/**
 * @param {object|null} effect
 * @param {'windows'|'structural'|'outdoors'} maskId
 * @returns {number}
 */
function windowLightMaskTypeLoadedCount(effect, maskId) {
  const id = String(maskId || '').toLowerCase();
  if (id === 'outdoors') return outdoorsRuntimeLoadedCount();
  if (!effect) return compositorHasMaskType(id) ? 1 : 0;
  if (id === 'windows' && effect._runtimeMaskWindows) return 1;
  if (id === 'structural' && effect._runtimeMaskStructural) return 1;
  return compositorHasMaskType(id) ? 1 : 0;
}

/**
 * Which window-mask suffix to show in the single Window Light row (_Windows default).
 * @param {object|null} effect
 * @returns {'windows'|'structural'}
 */
function resolveWindowLightActiveWindowMaskId(effect) {
  if (windowLightMaskTypeLoadedCount(effect, 'windows') > 0) return 'windows';
  if (windowLightMaskTypeLoadedCount(effect, 'structural') > 0) return 'structural';
  return 'windows';
}

/**
 * @param {object|null} effect
 * @returns {number}
 */
function windowLightWindowMaskLoadedCount(effect) {
  return Math.max(
    windowLightMaskTypeLoadedCount(effect, 'windows'),
    windowLightMaskTypeLoadedCount(effect, 'structural'),
  );
}

/**
 * @param {MaskStatusGroupConfig} config
 * @param {string} [effectId]
 * @returns {MaskStatusResult}
 */
function resolveWindowLightWindowsMaskStatus(config = {}, effectId = 'windowLight') {
  const effect = getFloorCompositorEffect('_windowLightEffect');
  const activeId = resolveWindowLightActiveWindowMaskId(effect);
  const template = getMaskStatusTemplate(activeId, config);
  const base = resolvePopulatedMaskStatus(
    template,
    effect,
    effectId,
    () => windowLightWindowMaskLoadedCount(effect),
  );
  return {
    ...base,
    label: template.suffix,
    helpMaskId: activeId,
  };
}

/**
 * @param {string} maskId
 * @param {MaskStatusGroupConfig} config
 * @param {string} [effectId]
 * @returns {MaskStatusResult}
 */
function resolveWindowLightMaskStatus(maskId, config = {}, effectId = 'windowLight') {
  const id = String(maskId || '').toLowerCase();
  if (id === 'windows' || id === 'structural') {
    return resolveWindowLightWindowsMaskStatus(config, effectId);
  }
  const template = getMaskStatusTemplate(maskId, config);
  const effect = getFloorCompositorEffect('_windowLightEffect');
  return resolvePopulatedMaskStatus(
    template,
    effect,
    effectId,
    () => windowLightMaskTypeLoadedCount(effect, maskId),
  );
}

/**
 * @param {MaskStatusGroupConfig} [config]
 * @param {string} [effectId]
 * @param {string} [compositorProp]
 * @returns {MaskStatusResult}
 */
function resolveOutdoorsMaskStatus(config = {}, effectId = 'specular', compositorProp = '_specularEffect') {
  const template = getMaskStatusTemplate('outdoors', config);
  const effect = getFloorCompositorEffect(compositorProp);
  return resolvePopulatedMaskStatus(
    template,
    effect,
    effectId,
    () => outdoorsRuntimeLoadedCount(),
  );
}

function resolveSpecularMaskStatus(config = {}, effectId = 'specular') {
  return resolveOverlayMaskStatus('specular', config, '_specularEffect', effectId);
}

const PAINTED_SHADOW_COMPOSITOR_MASK_TYPES = ['handPaintedShadow', 'paintedShadow', 'shadow'];

/**
 * @returns {boolean}
 */
function compositorHasPaintedShadowMask() {
  for (const maskType of PAINTED_SHADOW_COMPOSITOR_MASK_TYPES) {
    if (compositorHasMaskType(maskType)) return true;
  }
  return false;
}

/**
 * @param {object|null} effect
 * @returns {number}
 */
function paintedShadowMaskLoadedCount(effect) {
  if (effect) {
    for (let i = 0; i < 4; i += 1) {
      if (typeof effect._hasValidLitMask === 'function' && effect._hasValidLitMask(i)) return 1;
    }
    try {
      if (effect._lastPaintedTexForSlots) return 1;
      for (const tex of effect._paintedBundleByBasePath?.values?.() ?? []) {
        if (tex) return 1;
      }
    } catch (_) {}
  }
  return compositorHasPaintedShadowMask() ? 1 : 0;
}

/**
 * @param {MaskStatusGroupConfig} [config]
 * @param {string} [effectId]
 * @returns {MaskStatusResult}
 */
function resolvePaintedShadowMaskStatus(config = {}, effectId = 'painted-shadows') {
  const template = getMaskStatusTemplate('handPaintedShadow', config);
  const effect = getFloorCompositorEffect('_paintedShadowEffect');
  return resolvePopulatedMaskStatus(
    template,
    effect,
    effectId,
    () => paintedShadowMaskLoadedCount(effect),
  );
}

/**
 * @param {object|null} effect
 * @returns {number}
 */
function fireMaskLoadedCount(effect) {
  if (!effect) return 0;
  try {
    for (const [, st] of effect._floorStates ?? []) {
      if ((st?.systems?.length ?? 0) > 0
        || (st?.emberSystems?.length ?? 0) > 0
        || (st?.smokeSystems?.length ?? 0) > 0) {
        return 1;
      }
    }
    for (const pts of effect._glowSourcePointsByFloor?.values?.() ?? []) {
      if (pts?.length > 0) return 1;
    }
  } catch (_) {}
  return 0;
}

/**
 * @param {MaskStatusGroupConfig} [config]
 * @param {string} [effectId]
 * @returns {MaskStatusResult}
 */
function resolveFireMaskStatus(config = {}, effectId = 'fire-sparks') {
  const template = getMaskStatusTemplate('fire', config);
  const effect = getFloorCompositorEffect('_fireEffect');
  return resolvePopulatedMaskStatus(
    template,
    effect,
    effectId,
    () => fireMaskLoadedCount(effect),
  );
}

/**
 * @param {object|null} effect
 * @returns {number}
 */
function ashMaskLoadedCount(effect) {
  if (!effect) return 0;
  try {
    for (const [, st] of effect._floorStates ?? []) {
      if (st?.points?.length > 0) return 1;
    }
  } catch (_) {}
  return 0;
}

/**
 * @param {MaskStatusGroupConfig} [config]
 * @param {string} [effectId]
 * @returns {MaskStatusResult}
 */
function resolveAshMaskStatus(config = {}, effectId = 'ash-disturbance') {
  const template = getMaskStatusTemplate('ash', config);
  const effect = getFloorCompositorEffect('_ashDisturbanceEffect');
  return resolvePopulatedMaskStatus(
    template,
    effect,
    effectId,
    () => ashMaskLoadedCount(effect),
  );
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
      if (effectId === 'water-splashes' || effectId === 'underwater-bubbles') {
        return resolveWaterSplashesMaskStatus(config, effectId);
      }
      return resolveWaterMaskStatus(config, effectId);
    case 'dust':
      return resolveDustMaskStatus(config, effectId);
    case 'fire':
      return resolveFireMaskStatus(config, effectId);
    case 'ash':
      return resolveAshMaskStatus(config, effectId);
    case 'bush':
      return resolveBushMaskStatus(config, effectId);
    case 'tree':
      return resolveTreeMaskStatus(config, effectId);
    case 'iridescence':
      return resolveIridescenceMaskStatus(config, effectId);
    case 'prism':
      return resolvePrismMaskStatus(config, effectId);
    case 'fluid':
      return resolveFluidMaskStatus(config, effectId);
    case 'specular':
      return resolveSpecularMaskStatus(config, effectId);
    case 'handPaintedShadow':
    case 'paintedShadow':
    case 'shadow':
      return resolvePaintedShadowMaskStatus(config, effectId);
    case 'outdoors':
      if (effectId === 'windowLight') return resolveWindowLightMaskStatus('outdoors', config, effectId);
      if (effectId === 'building-shadows') {
        return resolveOutdoorsMaskStatus(config, effectId, '_buildingShadowEffect');
      }
      if (effectId === 'colorCorrection') {
        return resolveOutdoorsMaskStatus(config, effectId, '_colorCorrectionEffect');
      }
      return resolveOutdoorsMaskStatus(config, effectId);
    case 'windows':
    case 'structural':
      if (effectId === 'windowLight') return resolveWindowLightWindowsMaskStatus(config, effectId);
      return resolveWindowLightMaskStatus(maskId, config, effectId);
    default:
      if (effectId === 'bush') return resolveBushMaskStatus(config, effectId);
      if (effectId === 'tree') return resolveTreeMaskStatus(config, effectId);
      if (effectId === 'iridescence') return resolveIridescenceMaskStatus(config, effectId);
      if (effectId === 'prism') return resolvePrismMaskStatus(config, effectId);
      if (effectId === 'fluid') return resolveFluidMaskStatus(config, effectId);
      if (effectId === 'specular') return resolveSpecularMaskStatus(config, effectId);
      if (effectId === 'windowLight') {
        const wlMask = config?.maskId || config?.templateId;
        if (wlMask) return resolveWindowLightMaskStatus(wlMask, config, effectId);
      }
      if (effectId === 'painted-shadows') return resolvePaintedShadowMaskStatus(config, effectId);
      if (effectId === 'building-shadows') {
        return resolveOutdoorsMaskStatus(config, effectId, '_buildingShadowEffect');
      }
      if (effectId === 'fire-sparks') return resolveFireMaskStatus(config, effectId);
      if (effectId === 'ash-disturbance') return resolveAshMaskStatus(config, effectId);
      if (effectId === 'dust') return resolveDustMaskStatus(config, effectId);
      if (effectId === 'water-splashes' || effectId === 'underwater-bubbles') {
        return resolveWaterSplashesMaskStatus(config, effectId);
      }
      if (effectId === 'colorCorrection') {
        return resolveOutdoorsMaskStatus(config, effectId, '_colorCorrectionEffect');
      }
      return null;
  }
}
