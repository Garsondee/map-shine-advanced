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
// V2 effect classes (V1 equivalents deleted — use V2 for getControlSchema())
import { SpecularEffectV2 } from '../compositor-v2/effects/SpecularEffectV2.js';
import { FluidEffectV2 } from '../compositor-v2/effects/FluidEffectV2.js';
import { IridescenceEffectV2 } from '../compositor-v2/effects/IridescenceEffectV2.js';
import { PrismEffectV2 } from '../compositor-v2/effects/PrismEffectV2.js';
import { WindowLightEffectV2 } from '../compositor-v2/effects/WindowLightEffectV2.js';
import { ColorCorrectionEffectV2 } from '../compositor-v2/effects/ColorCorrectionEffectV2.js';
import { FilmGrainEffectV2 } from '../compositor-v2/effects/FilmGrainEffectV2.js';
import { SharpenEffectV2 } from '../compositor-v2/effects/SharpenEffectV2.js';
import { BloomEffectV2 } from '../compositor-v2/effects/BloomEffectV2.js';
import { SkyColorEffectV2 } from '../compositor-v2/effects/SkyColorEffectV2.js';
import { LightingEffectV2 } from '../compositor-v2/effects/LightingEffectV2.js';
import { FireEffectV2 } from '../compositor-v2/effects/FireEffectV2.js';
import { AshDisturbanceEffectV2 } from '../compositor-v2/effects/AshDisturbanceEffectV2.js';
import { CloudEffectV2 } from '../compositor-v2/effects/CloudEffectV2.js';
import { AsciiEffectV2 } from '../compositor-v2/effects/AsciiEffectV2.js';
import { WaterEffectV2 } from '../compositor-v2/effects/WaterEffectV2.js';
import { AtmosphericFogEffectV2 } from '../compositor-v2/effects/AtmosphericFogEffectV2.js';
import { FogOfWarEffectV2 } from '../compositor-v2/effects/FogOfWarEffectV2.js';
import { PlayerLightEffectV2 } from '../compositor-v2/effects/PlayerLightEffectV2.js';
import { SmellyFliesEffect } from '../particles/SmellyFliesEffect.js';

import { createLogger } from '../core/log.js';

const log = createLogger('EffectWiring');

// Re-export effect classes so consumers (initializeUI) can access static methods
// like getControlSchema() from a single import instead of 30+ individual imports.
// V2 classes replace deleted V1 originals for all ported effects.
export {
  SpecularEffectV2,
  FluidEffectV2,
  IridescenceEffectV2,
  PrismEffectV2,
  WindowLightEffectV2,
  ColorCorrectionEffectV2,
  FilmGrainEffectV2,
  SharpenEffectV2,
  BloomEffectV2,
  SkyColorEffectV2,
  LightingEffectV2,
  FireEffectV2,
  AshDisturbanceEffectV2,
  SmellyFliesEffect,
  CloudEffectV2,
  AsciiEffectV2,
  WaterEffectV2,
  AtmosphericFogEffectV2,
  FogOfWarEffectV2,
  PlayerLightEffectV2,
};

// ── Independent Effect Definitions ──────────────────────────────────────────
// Order matters: Map insertion order is preserved so render order is deterministic.

/**
 * Returns the [displayName, EffectClass] pairs for all independent effects.
 * These are constructed synchronously, then batch-initialized with concurrency.
 * @returns {Array<[string, Function]>}
 */
export function getIndependentEffectDefs() {
  // V2-only runtime: all compositor effects are owned by FloorCompositor.
  return [];
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
  { effectId: 'iridescence',       displayName: 'Iridescence',               category: 'surface',      performanceImpact: 'medium' },
  { effectId: 'prism',             displayName: 'Prism',                     category: 'surface',      performanceImpact: 'medium' },
  { effectId: 'window-lights',     displayName: 'Window Lights',             category: 'structure',    performanceImpact: 'medium' },
  { effectId: 'water',             displayName: 'Water',                     category: 'water',        performanceImpact: 'high' },
  { effectId: 'bloom',             displayName: 'Bloom',                     category: 'global',       performanceImpact: 'high' },
  { effectId: 'color-correction',  displayName: 'Color Correction',          category: 'global',       performanceImpact: 'low' },
  { effectId: 'film-grain',        displayName: 'Film Grain',                category: 'global',       performanceImpact: 'low' },
  { effectId: 'dot-screen',        displayName: 'Dot Screen',                category: 'global',       performanceImpact: 'low' },
  { effectId: 'clouds',            displayName: 'Clouds',                   category: 'atmospheric',  performanceImpact: 'medium' },
  { effectId: 'overhead-shadows',  displayName: 'Overhead Shadows',         category: 'structure',    performanceImpact: 'medium' },
  { effectId: 'building-shadows',  displayName: 'Building Shadows',         category: 'structure',    performanceImpact: 'medium' },
  { effectId: 'fire-sparks',       displayName: 'Fire & Embers',            category: 'particle',     performanceImpact: 'high' },
  { effectId: 'ash-disturbance',   displayName: 'Ash Disturbance',          category: 'particle',     performanceImpact: 'low' },
  { effectId: 'ascii',             displayName: 'ASCII',                    category: 'global',       performanceImpact: 'high' },
  { effectId: 'halftone',          displayName: 'Halftone',                 category: 'global',       performanceImpact: 'medium' },
  { effectId: 'sharpen',           displayName: 'Sharpen',                  category: 'global',       performanceImpact: 'low' },
  { effectId: 'sky-color',         displayName: 'Sky Color',                category: 'global',       performanceImpact: 'low' },
  { effectId: 'window-light',      displayName: 'Window Lights',            category: 'surface',      performanceImpact: 'low' },
  { effectId: 'trees',             displayName: 'Animated Trees (Canopy)',   category: 'surface',      performanceImpact: 'medium' },
  { effectId: 'bushes',            displayName: 'Animated Bushes',          category: 'surface',      performanceImpact: 'medium' },
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
// Maps graphics-settings IDs to effectMap display names for effects that still have V1 instances.
// V2-ported effects are no longer in effectMap and have been removed from this table.
const GS_ID_TO_EFFECT_MAP_NAME = [
  // V2-only runtime: no legacy effectMap instances are wired via this table.
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
// Only effects that are still V1 instances and use setBaseMesh() go here.
// V2 effects get their tile/scene data via FloorRenderBus.populate().
const BASE_MESH_EFFECTS = [
  'Bushes',
  'Trees',
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
// V2-ported effects are accessed via window.MapShine.effectComposer._getFloorCompositorV2().
// Only remaining V1 instances are exposed here.
const GLOBAL_EFFECT_EXPOSURES = [
  ['Dazzle Overlay',    'dazzleOverlayEffect'],
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
