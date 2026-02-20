/**
 * @fileoverview Effect construction, registration, and cross-wiring tables.
 *
 * Extracted from canvas-replacement.js to isolate:
 * - The independent effect definitions table (name → class)
 * - Graphics capabilities registry population
 * - Graphics settings ↔ effect instance wiring
 * - Base mesh distribution to surface effects
 * - window.MapShine effect exposure
 *
 * All functions are pure-ish: they accept dependencies and return results.
 * createThreeCanvas remains the orchestrator.
 *
 * @module foundry/effect-wiring
 */

// ── Effect Class Imports ────────────────────────────────────────────────────
import { SpecularEffect } from '../effects/SpecularEffect.js';
import { IridescenceEffect } from '../effects/IridescenceEffect.js';
import { FluidEffect } from '../effects/FluidEffect.js';
import { WindowLightEffect } from '../effects/WindowLightEffect.js';
import { ColorCorrectionEffect } from '../effects/ColorCorrectionEffect.js';
import { FilmGrainEffect } from '../effects/FilmGrainEffect.js';
import { DotScreenEffect } from '../effects/DotScreenEffect.js';
import { HalftoneEffect } from '../effects/HalftoneEffect.js';
import { SharpenEffect } from '../effects/SharpenEffect.js';
import { AsciiEffect } from '../effects/AsciiEffect.js';
import { SmellyFliesEffect } from '../particles/SmellyFliesEffect.js';
import { LightningEffect } from '../effects/LightningEffect.js';
import { PrismEffect } from '../effects/PrismEffect.js';
import { WaterEffectV2 } from '../effects/WaterEffectV2.js';
import { WorldSpaceFogEffect } from '../effects/WorldSpaceFogEffect.js';
import { BushEffect } from '../effects/BushEffect.js';
import { TreeEffect } from '../effects/TreeEffect.js';
import { OverheadShadowsEffect } from '../effects/OverheadShadowsEffect.js';
import { BuildingShadowsEffect } from '../effects/BuildingShadowsEffect.js';
import { CloudEffect } from '../effects/CloudEffect.js';
import { AtmosphericFogEffect } from '../effects/AtmosphericFogEffect.js';
import { DistortionManager } from '../effects/DistortionManager.js';
import { BloomEffect } from '../effects/BloomEffect.js';
import { LensflareEffect } from '../effects/LensflareEffect.js';
import { DazzleOverlayEffect } from '../effects/DazzleOverlayEffect.js';
import { MaskDebugEffect } from '../effects/MaskDebugEffect.js';
import { DebugLayerEffect } from '../effects/DebugLayerEffect.js';
import { PlayerLightEffect } from '../effects/PlayerLightEffect.js';
import { SkyColorEffect } from '../effects/SkyColorEffect.js';
import { VisionModeEffect } from '../effects/VisionModeEffect.js';

import { createLogger } from '../core/log.js';

const log = createLogger('EffectWiring');

// Re-export effect classes so consumers (initializeUI) can access static methods
// like getControlSchema() from a single import instead of 30+ individual imports.
export {
  SpecularEffect,
  IridescenceEffect,
  FluidEffect,
  WindowLightEffect,
  ColorCorrectionEffect,
  FilmGrainEffect,
  DotScreenEffect,
  HalftoneEffect,
  SharpenEffect,
  AsciiEffect,
  SmellyFliesEffect,
  LightningEffect,
  PrismEffect,
  WaterEffectV2,
  WorldSpaceFogEffect,
  BushEffect,
  TreeEffect,
  OverheadShadowsEffect,
  BuildingShadowsEffect,
  CloudEffect,
  AtmosphericFogEffect,
  DistortionManager,
  BloomEffect,
  LensflareEffect,
  DazzleOverlayEffect,
  MaskDebugEffect,
  DebugLayerEffect,
  PlayerLightEffect,
  SkyColorEffect,
  VisionModeEffect
};

// ── Independent Effect Definitions ──────────────────────────────────────────
// Order matters: Map insertion order is preserved so render order is deterministic.

/**
 * Returns the [displayName, EffectClass] pairs for all independent effects.
 * These are constructed synchronously, then batch-initialized with concurrency.
 * @returns {Array<[string, Function]>}
 */
export function getIndependentEffectDefs() {
  return [
    ['Specular', SpecularEffect],
    ['Iridescence', IridescenceEffect],
    ['Fluid', FluidEffect],
    ['Window Lights', WindowLightEffect],
    ['Color Correction', ColorCorrectionEffect],
    ['Film Grain', FilmGrainEffect],
    ['Dot Screen', DotScreenEffect],
    ['Halftone', HalftoneEffect],
    ['Sharpen', SharpenEffect],
    ['ASCII', AsciiEffect],
    ['Lightning', LightningEffect],
    ['Prism', PrismEffect],
    ['Water', WaterEffectV2],
    ['Fog', WorldSpaceFogEffect],
    ['Bushes', BushEffect],
    ['Trees', TreeEffect],
    ['Overhead Shadows', OverheadShadowsEffect],
    ['Building Shadows', BuildingShadowsEffect],
    ['Clouds', CloudEffect],
    ['Atmospheric Fog', AtmosphericFogEffect],
    ['Distortion', DistortionManager],
    ['Bloom', BloomEffect],
    ['Lensflare', LensflareEffect],
    ['Dazzle Overlay', DazzleOverlayEffect],
    ['Mask Debug', MaskDebugEffect],
    ['Debug Layers', DebugLayerEffect],
    ['Player Lights', PlayerLightEffect],
    ['Sky Color', SkyColorEffect],
    ['Vision Mode', VisionModeEffect]
  ];
}

// ── Graphics Capabilities Registry ──────────────────────────────────────────
// Maps effect IDs to their display metadata for the Graphics Settings UI.

/**
 * @typedef {Object} CapabilityDef
 * @property {string} effectId
 * @property {string} displayName
 * @property {string} category   - surface | water | global | atmospheric | structure | particle
 * @property {string} performanceImpact - low | medium | high
 */

/** @type {CapabilityDef[]} */
const CAPABILITIES = [
  { effectId: 'specular',          displayName: 'Metallic / Specular',       category: 'surface',      performanceImpact: 'medium' },
  { effectId: 'fluid',             displayName: 'Fluid',                     category: 'surface',      performanceImpact: 'medium' },
  { effectId: 'iridescence',       displayName: 'Iridescence',               category: 'surface',      performanceImpact: 'low' },
  { effectId: 'window-lights',     displayName: 'Window Lights',             category: 'structure',    performanceImpact: 'medium' },
  { effectId: 'water',             displayName: 'Water',                     category: 'water',        performanceImpact: 'high' },
  { effectId: 'fog',               displayName: 'Fog of War',               category: 'global',       performanceImpact: 'medium' },
  { effectId: 'bloom',             displayName: 'Bloom',                     category: 'global',       performanceImpact: 'high' },
  { effectId: 'lensflare',         displayName: 'Lensflare',                category: 'global',       performanceImpact: 'medium' },
  { effectId: 'color-correction',  displayName: 'Color Correction',          category: 'global',       performanceImpact: 'low' },
  { effectId: 'film-grain',        displayName: 'Film Grain',                category: 'global',       performanceImpact: 'low' },
  { effectId: 'dot-screen',        displayName: 'Dot Screen',                category: 'global',       performanceImpact: 'low' },
  { effectId: 'clouds',            displayName: 'Clouds',                   category: 'atmospheric',  performanceImpact: 'medium' },
  { effectId: 'overhead-shadows',  displayName: 'Overhead Shadows',         category: 'structure',    performanceImpact: 'medium' },
  { effectId: 'building-shadows',  displayName: 'Building Shadows',         category: 'structure',    performanceImpact: 'medium' },
  { effectId: 'distortion',        displayName: 'Distortion',               category: 'global',       performanceImpact: 'medium' },
  { effectId: 'fire-sparks',       displayName: 'Fire & Embers',            category: 'particle',     performanceImpact: 'high' },
  { effectId: 'dust-motes',        displayName: 'Dust Motes',               category: 'particle',     performanceImpact: 'low' },
  { effectId: 'smelly-flies',      displayName: 'Smelly Flies',             category: 'particle',     performanceImpact: 'low' },
  { effectId: 'lightning',         displayName: 'Lightning',                category: 'particle',     performanceImpact: 'medium' },
  { effectId: 'atmospheric-fog',   displayName: 'Atmospheric Fog',          category: 'atmospheric',  performanceImpact: 'medium' },
  { effectId: 'ascii',             displayName: 'ASCII',                    category: 'global',       performanceImpact: 'high' },
  { effectId: 'halftone',          displayName: 'Halftone',                 category: 'global',       performanceImpact: 'medium' },
  { effectId: 'sharpen',           displayName: 'Sharpen',                  category: 'global',       performanceImpact: 'low' },
  { effectId: 'prism',             displayName: 'Prism / Refraction',       category: 'surface',      performanceImpact: 'medium' },
  { effectId: 'sky-color',         displayName: 'Sky Color',                category: 'global',       performanceImpact: 'low' },
  { effectId: 'player-light',      displayName: 'Player Lights',            category: 'global',       performanceImpact: 'low' },
  { effectId: 'window-light',      displayName: 'Window Lights',            category: 'surface',      performanceImpact: 'low' },
  { effectId: 'trees',             displayName: 'Animated Trees (Canopy)',   category: 'surface',      performanceImpact: 'medium' },
  { effectId: 'bushes',            displayName: 'Animated Bushes',          category: 'surface',      performanceImpact: 'medium' },
  { effectId: 'candle-flames',     displayName: 'Candle Flames',            category: 'particle',     performanceImpact: 'low' },
  { effectId: 'lighting',          displayName: 'Lighting',                 category: 'global',       performanceImpact: 'high' },
  { effectId: 'visionMode',        displayName: 'Vision Mode',              category: 'global',       performanceImpact: 'low' },
];

/**
 * Populate the EffectCapabilitiesRegistry with all known effect metadata.
 * @param {import('../effects/effect-capabilities-registry.js').EffectCapabilitiesRegistry} registry
 */
export function registerAllCapabilities(registry) {
  for (const cap of CAPABILITIES) {
    registry.register(cap);
  }
}

// ── Graphics Settings ↔ Effect Instance Wiring ──────────────────────────────
// Maps graphics-settings IDs to the display names used in the effectMap.

/**
 * Graphics settings ID → effectMap display name.
 * When the two are the same (kebab-case ID matches effect.id), we don't need an
 * entry here — but many effects have mismatched IDs.
 * @type {Array<[string, string]>}
 */
const GS_ID_TO_EFFECT_MAP_NAME = [
  ['specular',          'Specular'],
  ['iridescence',       'Iridescence'],
  ['window-light',      'Window Lights'],
  ['color-correction',  'Color Correction'],
  ['film-grain',        'Film Grain'],
  ['dot-screen',        'Dot Screen'],
  ['halftone',          'Halftone'],
  ['sharpen',           'Sharpen'],
  ['ascii',             'ASCII'],
  ['lightning',         'Lightning'],
  ['prism',             'Prism'],
  ['water',             'Water'],
  ['fog',               'Fog'],
  ['bushes',            'Bushes'],
  ['trees',             'Trees'],
  ['overhead-shadows',  'Overhead Shadows'],
  ['building-shadows',  'Building Shadows'],
  ['clouds',            'Clouds'],
  ['atmospheric-fog',   'Atmospheric Fog'],
  ['distortion',        'Distortion'],
  ['bloom',             'Bloom'],
  ['lensflare',         'Lensflare'],
  ['player-light',      'Player Lights'],
  ['sky-color',         'Sky Color'],
  // Dependent effects (registered after batch init)
  ['fire-sparks',       'Fire Sparks'],
  ['dust-motes',        'Dust Motes'],
  ['ash-disturbance',   'Ash Disturbance'],
  ['smelly-flies',      'Smelly Flies'],
  ['candle-flames',     'Candle Flames'],
  ['lighting',          'Lighting'],
  ['visionMode',        'Vision Mode'],
];

/**
 * Wire effect instances into the GraphicsSettingsManager so it can toggle them.
 * @param {import('../ui/graphics-settings-manager.js').GraphicsSettingsManager} graphicsSettings
 * @param {Map<string, Object>} effectMap - Display name → effect instance
 */
export function wireGraphicsSettings(graphicsSettings, effectMap) {
  for (const [gsId, mapName] of GS_ID_TO_EFFECT_MAP_NAME) {
    const instance = effectMap.get(mapName);
    if (instance) {
      graphicsSettings.registerEffectInstance(gsId, instance);
    }
  }
}

// ── Lazy Skip IDs (P2.1) ───────────────────────────────────────────────────

/**
 * Graphics-settings ID → effect.id mapping for effects where the two differ.
 * Used when reading localStorage overrides to determine which effects to skip.
 * @type {Map<string, string>}
 */
const GS_ID_TO_EFFECT_ID = new Map([
  ['trees', 'tree'],
  ['bushes', 'bush'],
  ['clouds', 'cloud'],
  ['film-grain', 'filmGrain'],
  ['dot-screen', 'dotScreen'],
  ['color-correction', 'colorCorrection'],
  ['distortion', 'distortion-manager'],
]);

/**
 * Pre-read graphics overrides from localStorage to find disabled effects.
 * Returns a Set of effect IDs that should be deferred (lazy init).
 * @returns {Set<string>|null} - Set of effect IDs to skip, or null if none
 */
export function readLazySkipIds() {
  try {
    const sceneId = canvas?.scene?.id || 'no-scene';
    const userId = game?.user?.id || 'no-user';
    const storageKey = `map-shine-advanced.graphicsOverrides.${sceneId}.${userId}`;
    const raw = localStorage.getItem(storageKey);
    if (!raw) return null;

    const parsed = JSON.parse(raw);
    const overrides = parsed?.effectOverrides;
    const globalOff = parsed?.globalDisableAll === true;
    if (!overrides || typeof overrides !== 'object') return null;

    const skipSet = new Set();
    for (const [gsId, ov] of Object.entries(overrides)) {
      if (ov?.enabled === false || globalOff) {
        const effectId = GS_ID_TO_EFFECT_ID.get(gsId) || gsId;
        skipSet.add(effectId);
      }
    }
    if (skipSet.size > 0) {
      log.info(`P2.1: Deferring ${skipSet.size} disabled effects: ${[...skipSet].join(', ')}`);
      return skipSet;
    }
  } catch (e) {
    log.debug('P2.1: Could not pre-read graphics settings, all effects will initialize normally', e);
  }
  return null;
}

// ── Base Mesh Wiring ────────────────────────────────────────────────────────

/**
 * Effects that receive the base plane mesh and asset bundle.
 * Order doesn't matter for correctness but is kept alphabetical for readability.
 * @type {string[]} - Display names from the effectMap
 */
const BASE_MESH_EFFECTS = [
  'Specular',
  'Iridescence',
  'Prism',
  'Water',
  'Window Lights',
  'Bushes',
  'Trees',
  'Lighting',
  'Overhead Shadows',
  'Building Shadows',
  'Clouds',
];

/**
 * Distribute the base plane mesh and asset bundle to all surface/environmental effects.
 * @param {Map<string, Object>} effectMap
 * @param {THREE.Mesh} basePlane
 * @param {Object} bundle - Asset bundle with masks, textures, etc.
 * @param {Function} [logFn] - Optional timing logger: (label, durationMs) => void
 */
export function wireBaseMeshes(effectMap, basePlane, bundle, logFn) {
  for (const name of BASE_MESH_EFFECTS) {
    const effect = effectMap.get(name);
    if (!effect?.setBaseMesh) continue;

    const t0 = performance.now();
    try {
      effect.setBaseMesh(basePlane, bundle);
    } catch (e) {
      log.error(`Failed to wire base mesh for ${name}`, e);
    }
    const dt = performance.now() - t0;
    if (logFn && dt > 50) logFn(name, dt);
  }

  // WindowLightEffect has an additional step to create its light render target
  try {
    const wl = effectMap.get('Window Lights');
    if (wl?.createLightTarget) wl.createLightTarget();
  } catch (e) {
    log.error('Failed to create Window Lights light target', e);
  }
}

// ── Global Exposure ─────────────────────────────────────────────────────────

/**
 * effectMap display name → window.MapShine property name.
 * @type {Array<[string, string]>}
 */
const GLOBAL_EFFECT_EXPOSURES = [
  ['Fluid',            'fluidEffect'],
  ['Window Lights',     'windowLightEffect'],
  ['Color Correction',  'colorCorrectionEffect'],
  ['Clouds',            'cloudEffect'],
  ['Atmospheric Fog',   'atmosphericFogEffect'],
  ['Distortion',        'distortionManager'],
  ['Bloom',             'bloomEffect'],
  ['Dazzle Overlay',    'dazzleOverlayEffect'],
  ['Sky Color',         'skyColorEffect'],
  ['Water',             'waterEffect'],
];

/**
 * Expose a subset of effects on window.MapShine immediately after construction.
 * This early exposure is needed because some effects cross-reference each other
 * via window.MapShine during initialization.
 * @param {Object} mapShine - The window.MapShine object
 * @param {Map<string, Object>} effectMap
 */
export function exposeEffectsEarly(mapShine, effectMap) {
  if (!mapShine) return;
  for (const [mapName, propName] of GLOBAL_EFFECT_EXPOSURES) {
    const instance = effectMap.get(mapName);
    if (instance) mapShine[propName] = instance;
  }
}
