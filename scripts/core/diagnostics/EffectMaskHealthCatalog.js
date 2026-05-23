/**
 * @fileoverview Central registry mapping V2 health effect IDs to required mask textures.
 * Used by MaskPresenceEvaluator + HealthEvaluatorService missingRequiredMask rules.
 *
 * @module core/diagnostics/EffectMaskHealthCatalog
 */

import { getEffectMaskRegistry } from '../../assets/loader.js';
import * as sceneSettings from '../../settings/scene-settings.js';

/** @typedef {'warn'|'error'} MaskHealthSeverity */

/**
 * @typedef {Object} MaskRequirement
 * @property {string[]} maskIds Registry mask ids (e.g. 'water', 'handPaintedShadow')
 * @property {MaskHealthSeverity} severity warn = orange degraded, error = red broken
 * @property {'any'|'all'} [mode='any'] When multiple maskIds, any one satisfies (OR) vs all required
 */

/**
 * @typedef {Object} EffectMaskHealthEntry
 * @property {string} healthEffectId Breaker Box contract id (e.g. WaterEffectV2)
 * @property {string[]} sceneEffectIds Scene settings effect keys (OR — any enabled counts)
 * @property {MaskRequirement[]} maskRequirements
 * @property {(ctx: object, instance: object|null) => boolean} [isEffectEnabled] Override enable gate
 * @property {(ctx: object, instance: object|null, levelKey: string|null) => boolean} [requiresParentWaterPass] Water splashes only
 */

/** @type {Map<string, { suffix: string, description?: string }>} */
let _suffixByMaskId = null;

function suffixByMaskId() {
  if (_suffixByMaskId) return _suffixByMaskId;
  _suffixByMaskId = new Map();
  const reg = getEffectMaskRegistry();
  for (const [id, def] of Object.entries(reg || {})) {
    if (def?.suffix) _suffixByMaskId.set(id, { suffix: def.suffix, description: def.description });
  }
  return _suffixByMaskId;
}

export function maskIdToSuffix(maskId) {
  const hit = suffixByMaskId().get(String(maskId || ''));
  return hit?.suffix ?? `_${String(maskId || 'unknown')}`;
}

export function maskIdsToSuffixList(maskIds) {
  return (Array.isArray(maskIds) ? maskIds : []).map((id) => maskIdToSuffix(id));
}

/**
 * @param {import('foundry').Scene|null} scene
 * @param {string[]} sceneEffectIds
 * @returns {boolean}
 */
export function isAnySceneEffectEnabled(scene, sceneEffectIds) {
  if (!scene || !Array.isArray(sceneEffectIds) || sceneEffectIds.length === 0) return false;
  try {
    const effects = sceneSettings.getEffectiveSettings(scene)?.effects || {};
    return sceneEffectIds.some((id) => !!effects?.[id]?.enabled);
  } catch (_) {
    return false;
  }
}

/**
 * Standard V2 pass gate: instance.enabled + params.enabled.
 * @param {object|null} instance
 * @returns {boolean}
 */
export function isV2InstanceEnabled(instance) {
  if (!instance) return false;
  if (instance.enabled === false) return false;
  if (instance.params && instance.params.enabled === false) return false;
  return true;
}

/**
 * @param {object} ctx HealthEvaluatorService
 * @returns {boolean}
 */
export function isWaterPassEnabled(ctx) {
  const water = ctx.floorCompositor?._waterEffect ?? null;
  if (!water) return false;
  return water.enabled !== false && water.params?.enabled !== false;
}

/** @type {EffectMaskHealthEntry[]} */
const EFFECT_MASK_HEALTH_ENTRIES = [
  {
    healthEffectId: 'WaterEffectV2',
    sceneEffectIds: ['water'],
    maskRequirements: [{ maskIds: ['water'], severity: 'warn' }],
    isEffectEnabled: (ctx, instance) => {
      const scene = canvas?.scene ?? null;
      return isAnySceneEffectEnabled(scene, ['water']) && isV2InstanceEnabled(instance);
    },
  },
  {
    healthEffectId: 'WaterSplashesEffectV2',
    sceneEffectIds: ['water-splashes'],
    maskRequirements: [{ maskIds: ['water'], severity: 'warn' }],
    isEffectEnabled: (ctx, instance) => {
      const scene = canvas?.scene ?? null;
      if (!isAnySceneEffectEnabled(scene, ['water-splashes'])) return false;
      if (!isV2InstanceEnabled(instance)) return false;
      return isWaterPassEnabled(ctx);
    },
  },
  {
    healthEffectId: 'PaintedShadowEffectV2',
    sceneEffectIds: ['painted-shadows'],
    maskRequirements: [{ maskIds: ['handPaintedShadow'], severity: 'warn' }],
  },
  {
    healthEffectId: 'FireEffectV2',
    sceneEffectIds: ['fire-sparks'],
    maskRequirements: [{ maskIds: ['fire'], severity: 'warn' }],
  },
  {
    healthEffectId: 'DustEffectV2',
    sceneEffectIds: ['dust'],
    maskRequirements: [{ maskIds: ['dust'], severity: 'warn' }],
  },
  {
    healthEffectId: 'AshDisturbanceEffectV2',
    sceneEffectIds: ['ash-disturbance'],
    maskRequirements: [{ maskIds: ['ash'], severity: 'warn' }],
  },
  {
    healthEffectId: 'SpecularEffectV2',
    sceneEffectIds: ['specular'],
    maskRequirements: [{ maskIds: ['specular'], severity: 'warn' }],
    isEffectEnabled: (ctx, instance) => {
      const scene = canvas?.scene ?? null;
      if (!isAnySceneEffectEnabled(scene, ['specular'])) return false;
      return isV2InstanceEnabled(instance);
    },
  },
  {
    healthEffectId: 'WindowLightEffectV2',
    sceneEffectIds: ['window-lights', 'window-light'],
    maskRequirements: [{ maskIds: ['windows', 'structural'], severity: 'warn', mode: 'any' }],
  },
  {
    healthEffectId: 'FluidEffectV2',
    sceneEffectIds: ['fluid'],
    maskRequirements: [{ maskIds: ['fluid'], severity: 'warn' }],
  },
  {
    healthEffectId: 'TreeEffectV2',
    sceneEffectIds: ['trees'],
    maskRequirements: [{ maskIds: ['tree'], severity: 'warn' }],
  },
  {
    healthEffectId: 'BushEffectV2',
    sceneEffectIds: ['bushes'],
    maskRequirements: [{ maskIds: ['bush'], severity: 'warn' }],
  },
  {
    healthEffectId: 'IridescenceEffectV2',
    sceneEffectIds: ['iridescence'],
    maskRequirements: [{ maskIds: ['iridescence'], severity: 'warn' }],
  },
  {
    healthEffectId: 'PrismEffectV2',
    sceneEffectIds: ['prism'],
    maskRequirements: [{ maskIds: ['prism'], severity: 'warn' }],
  },
  {
    healthEffectId: 'GpuSceneMaskCompositor',
    sceneEffectIds: [],
    maskRequirements: [{ maskIds: ['outdoors'], severity: 'error' }],
    isEffectEnabled: () => {
      try {
        return !!sceneSettings.isEnabled?.(canvas?.scene ?? null);
      } catch (_) {
        return true;
      }
    },
  },
];

/** @type {Map<string, EffectMaskHealthEntry>} */
const _byHealthEffectId = new Map(
  EFFECT_MASK_HEALTH_ENTRIES.map((e) => [e.healthEffectId, e])
);

export function getEffectMaskHealthEntry(healthEffectId) {
  return _byHealthEffectId.get(String(healthEffectId || '')) || null;
}

export function getAllEffectMaskHealthEntries() {
  return [...EFFECT_MASK_HEALTH_ENTRIES];
}

/**
 * Default enable gate: scene effect on + V2 instance enabled.
 * @param {EffectMaskHealthEntry} entry
 * @param {object} ctx
 * @param {object|null} instance
 */
export function isCatalogEffectEnabled(entry, ctx, instance) {
  if (typeof entry.isEffectEnabled === 'function') {
    return !!entry.isEffectEnabled(ctx, instance);
  }
  const scene = canvas?.scene ?? null;
  if (entry.sceneEffectIds?.length && !isAnySceneEffectEnabled(scene, entry.sceneEffectIds)) {
    return false;
  }
  if (entry.healthEffectId === 'GpuSceneMaskCompositor') {
    return typeof entry.isEffectEnabled === 'function'
      ? !!entry.isEffectEnabled(ctx, instance)
      : true;
  }
  return isV2InstanceEnabled(instance);
}
