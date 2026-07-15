/**
 * @fileoverview Probes scene/effect runtime state for authored mask textures.
 * Emits standardized missingRequiredMask health check results.
 *
 * @module core/diagnostics/MaskPresenceEvaluator
 */

import {
  getEffectMaskHealthEntry,
  isCatalogEffectEnabled,
  maskIdToSuffix,
  maskIdsToSuffixList,
} from './EffectMaskHealthCatalog.js';
import { getMaskTextureManifest } from '../../settings/mask-manifest-flags.js';

const PAINTED_MASK_ALIASES = ['handPaintedShadow', 'paintedShadow', 'shadow'];

/**
 * @param {object} ctx HealthEvaluatorService
 * @returns {import('../../masks/GpuSceneMaskCompositor.js').GpuSceneMaskCompositor|null}
 */
function getCompositor(ctx) {
  return ctx.gpuSceneMaskCompositor
    ?? window.MapShine?.sceneComposer?._sceneMaskCompositor
    ?? null;
}

/**
 * @param {object} ctx
 * @returns {number}
 */
function activeFloorIndex(ctx) {
  return Number(ctx._getRuntimeSnapshot?.()?.activeFloor ?? 0);
}

/**
 * @param {object} ctx
 * @returns {string|null}
 */
function activeCompositorKey(ctx) {
  const active = window.MapShine?.floorStack?.getActiveFloor?.() ?? null;
  const ck = active?.compositorKey ?? null;
  if (ck) return String(ck);
  const ctxKey = window.MapShine?.activeLevelContext ?? null;
  if (ctxKey && Number.isFinite(ctxKey.bottom) && Number.isFinite(ctxKey.top)) {
    return `${ctxKey.bottom}:${ctxKey.top}`;
  }
  return null;
}

/**
 * @param {import('../../masks/GpuSceneMaskCompositor.js').GpuSceneMaskCompositor|null} compositor
 * @param {string} maskId
 * @param {string|null} floorKey
 * @returns {boolean}
 */
function compositorHasMask(compositor, maskId, floorKey) {
  if (!compositor || !floorKey) return false;
  try {
    const tex = compositor.getFloorTexture?.(floorKey, maskId);
    if (tex) return true;
  } catch (_) {}
  if (maskId === 'handPaintedShadow') {
    for (const alias of PAINTED_MASK_ALIASES) {
      try {
        if (compositor.getFloorTexture?.(floorKey, alias)) return true;
      } catch (_) {}
    }
  }
  try {
    if (compositor._floorMeta?.has?.(floorKey)) {
      const bundle = compositor._floorMeta.get(floorKey);
      const masks = bundle?.masks ?? [];
      const idLower = String(maskId).toLowerCase();
      if (masks.some((m) => {
        const mid = String(m?.id ?? m?.type ?? '').toLowerCase();
        return mid === idLower && !!m?.texture;
      })) return true;
    }
  } catch (_) {}
  try {
    if (compositor._floorCache && typeof compositor._floorCache.entries === 'function') {
      for (const [fk, maskMap] of compositor._floorCache.entries()) {
        if (String(fk) !== String(floorKey)) continue;
        const tex = maskMap?.get?.(maskId)?.texture ?? null;
        if (tex) return true;
        if (maskId === 'handPaintedShadow') {
          for (const alias of PAINTED_MASK_ALIASES) {
            if (maskMap?.get?.(alias)?.texture) return true;
          }
        }
      }
    }
  } catch (_) {}
  return false;
}

/**
 * @param {string} maskId
 * @returns {boolean}
 */
function manifestHasMaskPath(maskId) {
  try {
    const flag = getMaskTextureManifest(canvas?.scene ?? null);
    const pbm = flag?.pathsByMaskId ?? null;
    if (!pbm) return false;
    const v = pbm[maskId] ?? pbm[String(maskId).toLowerCase()];
    return typeof v === 'string' && !!v.trim();
  } catch (_) {
    return false;
  }
}

/**
 * @param {object} ctx
 * @param {string} maskId
 * @returns {boolean}
 */
function tileCacheHasMask(ctx, maskId) {
  try {
    const tm = ctx.maskManager ?? window.MapShine?.tileManager ?? null;
    const map = tm?._tileEffectMasks;
    if (!map || typeof map.forEach !== 'function') return false;
    let found = false;
    map.forEach((m) => {
      if (found) return;
      const row = m?.get?.(maskId) ?? m?.get?.(String(maskId).toLowerCase());
      if (row?.texture) found = true;
    });
    return found;
  } catch (_) {
    return false;
  }
}

/**
 * @param {object} ctx
 * @param {string} maskId
 * @param {string|null} floorKey
 * @returns {{ present: boolean, probe: string }}
 */
function probeMaskPresence(ctx, maskId, floorKey) {
  const compositor = getCompositor(ctx);
  if (compositor && floorKey && compositorHasMask(compositor, maskId, floorKey)) {
    return { present: true, probe: 'compositor' };
  }
  if (tileCacheHasMask(ctx, maskId)) {
    return { present: true, probe: 'tileCache' };
  }
  if (manifestHasMaskPath(maskId)) {
    return { present: true, probe: 'manifest' };
  }
  return { present: false, probe: 'none' };
}

/**
 * @param {object} ctx
 * @param {object|null} instance
 * @param {string|null} levelKey
 * @returns {boolean}
 */
function detectWaterMaskPresent(ctx, instance, levelKey) {
  const water = ctx.floorCompositor?._waterEffect ?? instance;
  if (water?._hasAnyWaterData === true) return true;
  if (Array.isArray(water?._waterTiles) && water._waterTiles.length > 0) return true;
  if (water?._floorWater?.size > 0) return true;
  const idx = levelKey ? Number(String(levelKey).split(':')[1]) : NaN;
  if (Number.isFinite(idx) && water?._floorWater?.has?.(idx)) return true;
  const floorKey = activeCompositorKey(ctx);
  return probeMaskPresence(ctx, 'water', floorKey).present;
}

/**
 * @param {object} ctx
 * @param {object|null} instance
 * @returns {boolean}
 */
function detectPaintedShadowMaskPresent(ctx, instance) {
  const diag = instance?.getHealthDiagnostics?.() ?? null;
  if (diag?.paintedMaskFound) return true;
  const compositor = getCompositor(ctx);
  if (compositor && typeof instance?._hasAnyPerFloorPaintedShadow === 'function') {
    if (instance._hasAnyPerFloorPaintedShadow(compositor)) return true;
  }
  const floorKey = activeCompositorKey(ctx);
  if (probeMaskPresence(ctx, 'handPaintedShadow', floorKey).present) return true;
  return false;
}

/**
 * @param {object|null} instance
 * @param {string|null} levelKey
 * @returns {boolean}
 */
function detectFloorStatesPresent(instance, levelKey) {
  const states = instance?._floorStates;
  if (!states || typeof states.keys !== 'function') return false;
  if (levelKey && String(levelKey).startsWith('floor:')) {
    const idx = Number(String(levelKey).split(':')[1]);
    if (Number.isFinite(idx)) return states.has(idx);
  }
  return states.size > 0;
}

/**
 * @param {object|null} instance
 * @returns {boolean}
 */
function detectOverlaysPresent(instance) {
  const n = Number(instance?._overlays?.size ?? 0);
  return n > 0;
}

/**
 * @param {object} ctx
 * @returns {boolean}
 */
function detectOutdoorsPresent(ctx) {
  const floorKey = activeCompositorKey(ctx);
  if (probeMaskPresence(ctx, 'outdoors', floorKey).present) return true;
  try {
    const diag = ctx._buildGpuCompositorOutdoorsDiagnostics?.() ?? null;
    const af = activeFloorIndex(ctx);
    const row = (diag?.floorRows || []).find((r) => Number(r.floorIndex) === af);
    if (row?.resolvedOutdoors) return true;
  } catch (_) {}
  const fc = ctx.floorCompositor;
  if (fc?._lastOutdoorsTexture) return true;
  const wc = ctx.weatherController ?? window.MapShine?.weatherController ?? null;
  if (wc?.roofMap) return true;
  return false;
}

/**
 * @param {string} healthEffectId
 * @param {string} maskId
 * @param {object} ctx
 * @param {object|null} instance
 * @param {string|null} levelKey
 * @returns {boolean}
 */
function detectMaskForEffect(healthEffectId, maskId, ctx, instance, levelKey) {
  if (maskId === 'outdoors') return detectOutdoorsPresent(ctx);
  if (maskId === 'water') return detectWaterMaskPresent(ctx, instance, levelKey);
  if (maskId === 'handPaintedShadow') return detectPaintedShadowMaskPresent(ctx, instance);

  if (['fire', 'dust', 'ash'].includes(maskId)) {
    if (detectFloorStatesPresent(instance, levelKey)) return true;
  }

  const overlayEffects = new Set([
    'SpecularEffectV2', 'FluidEffectV2', 'TreeEffectV2', 'BushEffectV2',
    'IridescenceEffectV2', 'PrismEffectV2', 'WindowLightEffectV2',
  ]);
  if (overlayEffects.has(healthEffectId) && detectOverlaysPresent(instance)) {
    if (healthEffectId === 'WindowLightEffectV2') return true;
    if (maskId === 'specular' || maskId === 'fluid' || maskId === 'tree'
      || maskId === 'bush' || maskId === 'iridescence' || maskId === 'prism') {
      return true;
    }
  }

  if (healthEffectId === 'WindowLightEffectV2' && detectOverlaysPresent(instance)) {
    return true;
  }

  const floorKey = activeCompositorKey(ctx);
  return probeMaskPresence(ctx, maskId, floorKey).present;
}

/**
 * @param {import('./EffectMaskHealthCatalog.js').EffectMaskHealthEntry} entry
 * @param {import('./EffectMaskHealthCatalog.js').MaskRequirement} req
 * @param {object} ctx
 * @param {object|null} instance
 * @param {string|null} levelKey
 * @returns {{ satisfied: boolean, missingIds: string[], probes: string[] }}
 */
function evaluateRequirement(entry, req, ctx, instance, levelKey) {
  const maskIds = Array.isArray(req.maskIds) ? req.maskIds : [];
  const mode = req.mode || 'any';
  const probes = [];
  const presentIds = [];
  const missingIds = [];

  for (const maskId of maskIds) {
    const present = detectMaskForEffect(entry.healthEffectId, maskId, ctx, instance, levelKey);
    if (present) {
      presentIds.push(maskId);
      probes.push(`${maskId}:runtime`);
    } else {
      missingIds.push(maskId);
      const floorKey = activeCompositorKey(ctx);
      probes.push(`${maskId}:${probeMaskPresence(ctx, maskId, floorKey).probe}`);
    }
  }

  if (mode === 'all') {
    return { satisfied: missingIds.length === 0, missingIds, probes };
  }
  return { satisfied: presentIds.length > 0, missingIds: presentIds.length > 0 ? [] : maskIds, probes };
}

/**
 * @param {string} healthEffectId
 * @param {object|null} instance
 * @param {object} ctx HealthEvaluatorService
 * @param {string|null} [levelKey]
 * @returns {{ pass: boolean, skipped?: boolean, severity?: string, message: string, tooltip?: string, evidence?: object }}
 */
export function evaluateEffectMaskHealth(healthEffectId, instance, ctx, levelKey = null) {
  const entry = getEffectMaskHealthEntry(healthEffectId);
  if (!entry) {
    return { pass: true, skipped: true, message: 'No mask health catalog entry' };
  }

  if (!isCatalogEffectEnabled(entry, ctx, instance)) {
    return { pass: true, skipped: true, message: 'Effect disabled — mask check N/A' };
  }

  /** @type {string[]} */
  const allMissing = [];
  /** @type {string[]} */
  const missingSuffixes = [];
  let worstSeverity = 'warn';
  const evidenceRows = [];

  for (const req of entry.maskRequirements || []) {
    const result = evaluateRequirement(entry, req, ctx, instance, levelKey);
    if (result.satisfied) continue;
    for (const id of result.missingIds) {
      if (!allMissing.includes(id)) {
        allMissing.push(id);
        missingSuffixes.push(maskIdToSuffix(id));
      }
    }
    if (req.severity === 'error') worstSeverity = 'error';
    evidenceRows.push({
      maskIds: req.maskIds,
      mode: req.mode || 'any',
      severity: req.severity,
      missingIds: result.missingIds,
      probes: result.probes,
    });
  }

  if (allMissing.length === 0) {
    return { pass: true, message: 'Required mask texture(s) present' };
  }

  const suffixLabel = missingSuffixes.join(', ');
  const isCritical = worstSeverity === 'error';
  const message = isCritical
    ? `Missing critical mask: ${suffixLabel}`
    : `Missing mask texture: ${suffixLabel}`;
  const sceneNames = (entry.sceneEffectIds || []).filter(Boolean).join(', ') || entry.healthEffectId;
  const tooltip = isCritical
    ? `Missing critical mask ${suffixLabel} — indoor/outdoor gating will fail across multiple effects.`
    : `${sceneNames} is enabled but no ${suffixLabel} mask was found on this scene.`;

  return {
    pass: false,
    severity: worstSeverity,
    message,
    tooltip,
    evidence: {
      healthEffectId: entry.healthEffectId,
      sceneEffectIds: entry.sceneEffectIds,
      missingMaskIds: allMissing,
      missingSuffixes,
      requirements: evidenceRows,
      levelKey,
    },
  };
}

/**
 * Factory for HealthEvaluatorService contract rules.
 * @param {string} healthEffectId
 * @returns {object}
 */
export function createMissingMaskHealthRule(healthEffectId) {
  return {
    id: 'missingRequiredMask',
    tier: 'structural',
    severity: 'warn',
    check: (instance, ctx, levelKey) => evaluateEffectMaskHealth(healthEffectId, instance, ctx, levelKey),
  };
}

/**
 * @param {object} ctx
 * @param {string} healthEffectId
 * @returns {boolean}
 */
export function isMissingRequiredMask(ctx, instance, healthEffectId, levelKey = null) {
  const out = evaluateEffectMaskHealth(healthEffectId, instance, ctx, levelKey);
  return !out.pass && !out.skipped;
}
