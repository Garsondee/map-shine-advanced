/**
 * @fileoverview Effect registration and capabilities metadata.
 *
 * V14-only: all V1 effect wiring (independent effect defs, base mesh distribution,
 * legacy effectMap exposure, graphics settings ↔ V1 instance wiring) has been
 * removed. V2 effects are owned by FloorCompositor and wired via FloorRenderBus.
 *
 * Remaining responsibilities:
 * - V2 effect class re-exports (for static getControlSchema() calls)
 * - Graphics capabilities registry population
 *
 * @module foundry/effect-wiring
 */

// ── V2 Effect Class Imports ─────────────────────────────────────────────────
import { SpecularEffectV2 } from '../compositor-v2/effects/SpecularEffectV2.js';
import { FluidEffectV2 } from '../compositor-v2/effects/FluidEffectV2.js';
import { IridescenceEffectV2 } from '../compositor-v2/effects/IridescenceEffectV2.js';
import { PrismEffectV2 } from '../compositor-v2/effects/PrismEffectV2.js';
import { WindowLightEffectV2 } from '../compositor-v2/effects/WindowLightEffectV2.js';
import { ColorCorrectionEffectV2 } from '../compositor-v2/effects/ColorCorrectionEffectV2.js';
import { SharpenEffectV2 } from '../compositor-v2/effects/SharpenEffectV2.js';
import { BloomEffectV2 } from '../compositor-v2/effects/BloomEffectV2.js';
import { SkyColorEffectV2 } from '../compositor-v2/effects/SkyColorEffectV2.js';
import { LightingEffectV2 } from '../compositor-v2/effects/LightingEffectV2.js';
import { FireEffectV2 } from '../compositor-v2/effects/FireEffectV2.js';
import { DustEffectV2 } from '../compositor-v2/effects/DustEffectV2.js';
import { CloudEffectV2 } from '../compositor-v2/effects/CloudEffectV2.js';
import { AsciiEffectV2 } from '../compositor-v2/effects/AsciiEffectV2.js';
import { WaterEffectV2 } from '../compositor-v2/effects/WaterEffectV2.js';
import { AtmosphericFogEffectV2 } from '../compositor-v2/effects/AtmosphericFogEffectV2.js';
import { FogOfWarEffectV2 } from '../compositor-v2/effects/FogOfWarEffectV2.js';
import { PlayerLightEffectV2 } from '../compositor-v2/effects/PlayerLightEffectV2.js';
import { SmellyFliesEffect } from '../particles/SmellyFliesEffect.js';

export {
  SpecularEffectV2,
  FluidEffectV2,
  IridescenceEffectV2,
  PrismEffectV2,
  WindowLightEffectV2,
  ColorCorrectionEffectV2,
  SharpenEffectV2,
  BloomEffectV2,
  SkyColorEffectV2,
  LightingEffectV2,
  FireEffectV2,
  DustEffectV2,
  SmellyFliesEffect,
  CloudEffectV2,
  AsciiEffectV2,
  WaterEffectV2,
  AtmosphericFogEffectV2,
  FogOfWarEffectV2,
  PlayerLightEffectV2,
};

// ── Graphics Capabilities Registry ──────────────────────────────────────────

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
  { effectId: 'dot-screen',        displayName: 'Dot Screen',                category: 'global',       performanceImpact: 'low' },
  { effectId: 'clouds',            displayName: 'Clouds',                   category: 'atmospheric',  performanceImpact: 'medium' },
  { effectId: 'overhead-shadows',  displayName: 'Overhead Shadows',         category: 'structure',    performanceImpact: 'medium' },
  { effectId: 'building-shadows',  displayName: 'Building Shadows',         category: 'structure',    performanceImpact: 'medium' },
  { effectId: 'fire-sparks',       displayName: 'Fire & Embers',            category: 'particle',     performanceImpact: 'high' },
  { effectId: 'dust',              displayName: 'Dust Motes',               category: 'particle',     performanceImpact: 'low' },
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
