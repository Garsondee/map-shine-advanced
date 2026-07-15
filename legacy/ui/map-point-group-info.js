/**
 * @fileoverview Clipboard debug reports for Map Point Groups (support / diagnostics).
 * @module ui/map-point-group-info
 */

import { createLogger } from '../core/log.js';
import Coordinates from '../utils/coordinates.js';
import {
  describeMapPointGroupLevelBinding,
  getMapPointLevelOptions,
} from './map-point-level-binding-ui.js';
import {
  MAP_POINT_RENDER_LAYER_ABOVE,
  MAP_POINT_RENDER_LAYER_BELOW,
} from '../scene/map-points-manager.js';
import {
  buildMapPointGroupSpawnPool,
  inferMapPointGroupEmissionShape,
  resolveMapPointGroupEmissionWeight,
  triangulateMapPointPolygon,
} from '../scene/map-point-emission-sampling.js';

const log = createLogger('MapPointGroupInfo');

/**
 * @param {import('../scene/map-points-manager.js').MapPointGroup|null|undefined} group
 * @returns {'below-overhead'|'above-overhead'}
 */
function resolveGroupRenderLayer(group) {
  return group?.metadata?.renderLayer === MAP_POINT_RENDER_LAYER_ABOVE
    ? MAP_POINT_RENDER_LAYER_ABOVE
    : MAP_POINT_RENDER_LAYER_BELOW;
}

/**
 * @param {import('../scene/map-points-manager.js').MapPointGroup} group
 * @param {import('../scene/map-points-manager.js').MapPointsManager} mapPointsManager
 * @returns {object|null}
 */
function gatherCandleFlamesRuntime(group, mapPointsManager) {
  const candles = window.MapShine?.candleFlamesEffectV2
    ?? window.MapShine?.floorCompositorV2?._candleFlamesEffect
    ?? null;
  if (!candles) {
    return { available: false, reason: 'CandleFlamesEffectV2 not initialized' };
  }

  const activeLevelContext = window.MapShine?.activeLevelContext ?? null;
  const renderLayer = resolveGroupRenderLayer(group);
  const bucketSize = Math.max(32, Number(candles.params?.glowBucketSizePx) || 128);
  /** @type {Set<string>} */
  const groupBucketKeys = new Set();
  for (const p of group.points || []) {
    if (!p) continue;
    const bx = Math.floor(p.x / bucketSize);
    const by = Math.floor(p.y / bucketSize);
    groupBucketKeys.add(`${bx},${by}:${renderLayer}`);
  }

  const matchingClusters = (candles._clusters || []).filter((c) => {
    if (!c) return false;
    if (groupBucketKeys.has(c.key)) return true;
    return (group.points || []).some((p) => {
      if (!p) return false;
      const dx = p.x - (c.cxWorld ?? 0);
      const dy = p.y - (c.cyWorld ?? 0);
      return Math.hypot(dx, dy) < Math.max(32, Number(c.radiusPx) || 64) * 2;
    });
  });

  /** @type {Array<object>} */
  const glowBuckets = [];
  if (candles._glowBuckets?.size) {
    for (const [key, entry] of candles._glowBuckets.entries()) {
      if (!entry) continue;
      const clusterMatch = matchingClusters.some((c) => c.key === key);
      if (!groupBucketKeys.has(key) && !clusterMatch) continue;
      const lm0 = entry?.lightMeshes?.[0] ?? entry?.lightMesh ?? null;
      glowBuckets.push({
        key,
        renderLayer: entry?.renderLayer ?? MAP_POINT_RENDER_LAYER_BELOW,
        lightMeshCount: entry?.lightMeshes?.length ?? (entry?.lightMesh ? 1 : 0),
        intensity: entry?.intensity,
        outdoor: entry?.outdoor,
        meshVisible: !!lm0?.mesh?.visible,
        emissionGain: lm0?.material?.uniforms?.uEmissionGain?.value ?? null,
      });
    }
  }

  const lighting = window.MapShine?.floorCompositorV2?._lightingEffect ?? null;
  const includedInRebuild = (typeof mapPointsManager.getGroupsByEffectForContext === 'function')
    ? mapPointsManager.getGroupsByEffectForContext('candleFlame', activeLevelContext)
      .some((g) => g.id === group.id)
    : null;

  return {
    available: true,
    includedInActiveContextRebuild: includedInRebuild,
    effectParams: {
      enabled: !!candles.params?.enabled,
      glowEnabled: !!candles.params?.glowEnabled,
      flamesEnabled: !!candles.params?.flamesEnabled,
      wallClipEnabled: !!candles.params?.wallClipEnabled,
      glowMaxBuckets: candles.params?.glowMaxBuckets,
      glowBucketSizePx: bucketSize,
    },
    flameInstanceCounts: {
      below: candles._flameMeshBelow?.count ?? 0,
      above: candles._flameMeshAbove?.count ?? 0,
      belowVisible: !!candles._flameMeshBelow?.visible,
      aboveVisible: !!candles._flameMeshAbove?.visible,
    },
    resolvedGroupRenderLayer: renderLayer,
    groupBucketKeys: [...groupBucketKeys],
    matchingClusters: matchingClusters.map((c) => ({
      key: c.key,
      renderLayer: c.renderLayer ?? MAP_POINT_RENDER_LAYER_BELOW,
      cxWorld: c.cxWorld,
      cyWorld: c.cyWorld,
      radiusPx: c.radiusPx,
      intensity: c.intensity,
      outdoor: c.outdoor,
      clipElevation: c.clipElevation,
    })),
    glowBuckets,
    glowScene: {
      attachedToLightScene: candles._glowGroup?.parent === candles._lightingEffect?.lightScene,
      glowGroupVisible: !!candles._glowGroup?.visible,
      glowGroupChildCount: candles._glowGroup?.children?.length ?? 0,
      needsGlowRebuild: !!candles._needsGlowRebuild,
    },
    totals: {
      clusterCount: candles._clusters?.length ?? 0,
      glowBucketCount: candles._glowBuckets?.size ?? 0,
      aboveOverheadBucketCount: [...(candles._glowBuckets?.values() ?? [])]
        .filter((e) => (e?.renderLayer ?? MAP_POINT_RENDER_LAYER_BELOW) === MAP_POINT_RENDER_LAYER_ABOVE).length,
    },
    lighting: lighting ? {
      aboveOverheadLightRt: lighting._aboveOverheadLightRT
        ? { width: lighting._aboveOverheadLightRT.width, height: lighting._aboveOverheadLightRT.height }
        : null,
      composeHasAboveOverheadLightUniform: Number(lighting._composeMaterial?.uniforms?.uHasAboveOverheadLight?.value) || 0,
      candleEffectLinked: !!lighting._candleFlamesEffect,
    } : null,
  };
}

/**
 * Build a structured diagnostic payload for one map point group.
 * @param {import('../scene/map-points-manager.js').MapPointGroup} group
 * @param {import('../scene/map-points-manager.js').MapPointsManager} mapPointsManager
 * @returns {object}
 */
export function buildMapPointGroupInfoPayload(group, mapPointsManager) {
  const activeLevelContext = window.MapShine?.activeLevelContext ?? null;
  const levelOptions = getMapPointLevelOptions();
  const levelInfo = describeMapPointGroupLevelBinding(group, activeLevelContext, levelOptions);

  const controlClusters = (mapPointsManager.getControlClusters?.() || [])
    .filter((c) => c?.source !== 'mask' && Array.isArray(c?.memberGroupIds) && c.memberGroupIds.includes(group.id))
    .map((c) => ({
      id: c.id,
      enabled: c.enabled !== false,
      label: c.label ?? null,
      memberCount: c.memberGroupIds?.length ?? 0,
    }));

  const points = (group.points || []).map((p, index) => {
    const foundry = Coordinates.toFoundry(p.x, p.y);
    return {
      index,
      world: { x: p.x, y: p.y },
      foundry: { x: foundry.x, y: foundry.y },
      enabled: mapPointsManager.isGroupPointEnabled?.(group.id, index) !== false,
    };
  });

  const bounds = mapPointsManager.getAreaBounds?.(group.id)
    ?? mapPointsManager._computeBounds?.(group.points)
    ?? null;

  const emissionShape = inferMapPointGroupEmissionShape(group);
  const spawnPool = buildMapPointGroupSpawnPool(group);
  const spawnSiteCount = spawnPool.triples ? Math.floor(spawnPool.triples.length / 3) : 0;
  const emissionWeight = resolveMapPointGroupEmissionWeight(group, spawnPool.triples);
  const triangleCount = emissionShape === 'area' && group.points?.length
    ? triangulateMapPointPolygon(group.points).length
    : 0;

  /** @type {Record<string, unknown>} */
  const payload = {
    reportType: 'MapShine Map Point Group Info',
    generatedAt: new Date().toISOString(),
    scene: {
      id: canvas?.scene?.id ?? null,
      name: canvas?.scene?.name ?? null,
    },
    moduleVersion: game?.modules?.get?.('map-shine-advanced')?.version ?? null,
    activeLevelContext: activeLevelContext ? {
      levelId: activeLevelContext.levelId ?? null,
      bottom: activeLevelContext.bottom ?? null,
      top: activeLevelContext.top ?? null,
      index: activeLevelContext.index ?? null,
    } : null,
    group: {
      id: group.id,
      label: group.label ?? null,
      type: group.type,
      effectTarget: group.effectTarget,
      isEffectSource: group.isEffectSource !== false,
      isBroken: !!group.isBroken,
      reason: group.reason ?? null,
      emission: group.emission ?? null,
      metadata: group.metadata ?? null,
      renderLayer: resolveGroupRenderLayer(group),
      pointCount: points.length,
      points,
      bounds,
    },
    emissionSampling: {
      inferredShape: emissionShape,
      authoredType: group.type,
      spawnSiteCount,
      emissionWeight,
      triangleCount,
    },
    levelBinding: levelInfo,
    controlClusters,
  };

  if (group.effectTarget === 'candleFlame') {
    payload.candleFlamesRuntime = gatherCandleFlamesRuntime(group, mapPointsManager);
  }

  return payload;
}

/**
 * @param {object} payload
 * @returns {string}
 */
export function formatMapPointGroupInfoReport(payload) {
  const lines = [
    '=== Map Shine — Map Point Group Info ===',
    `Generated: ${payload.generatedAt}`,
    `Scene: ${payload.scene?.name ?? '?'} (${payload.scene?.id ?? '?'})`,
    `Module: map-shine-advanced v${payload.moduleVersion ?? '?'}`,
    '',
    '--- Group ---',
    `ID: ${payload.group?.id}`,
    `Label: ${payload.group?.label ?? '(unnamed)'}`,
    `Effect: ${payload.group?.effectTarget} · Type: ${payload.group?.type}`,
    `Render layer: ${payload.group?.renderLayer}`,
    `Active effect source: ${payload.group?.isEffectSource}`,
    `Points: ${payload.group?.pointCount}`,
    `Emission intensity: ${payload.group?.emission?.intensity ?? '?'}`,
    `Inferred emission shape: ${payload.emissionSampling?.inferredShape ?? '?'}`,
    `Precomputed spawn sites: ${payload.emissionSampling?.spawnSiteCount ?? '?'}`,
    `Emission triangles: ${payload.emissionSampling?.triangleCount ?? '?'}`,
    `Emission weight: ${payload.emissionSampling?.emissionWeight ?? '?'}`,
    '',
    '--- Level binding ---',
    JSON.stringify(payload.levelBinding, null, 2),
    '',
    '--- Active view context ---',
    JSON.stringify(payload.activeLevelContext, null, 2),
    '',
    '--- Control clusters ---',
    JSON.stringify(payload.controlClusters, null, 2),
    '',
    '--- Points (world + Foundry) ---',
    JSON.stringify(payload.group?.points, null, 2),
  ];

  if (payload.candleFlamesRuntime) {
    lines.push(
      '',
      '--- Candle flames runtime (live compositor) ---',
      JSON.stringify(payload.candleFlamesRuntime, null, 2),
    );
  }

  lines.push(
    '',
    '--- Full JSON ---',
    JSON.stringify(payload, null, 2),
  );

  return lines.join('\n');
}

/**
 * Copy diagnostic report for a map point group to the clipboard.
 * @param {string} groupId
 * @param {import('../scene/map-points-manager.js').MapPointsManager} mapPointsManager
 * @returns {Promise<boolean>}
 */
export async function copyMapPointGroupInfoToClipboard(groupId, mapPointsManager) {
  const group = mapPointsManager?.getGroup?.(groupId);
  if (!group) {
    globalThis.ui?.notifications?.warn?.('Map point group not found.');
    return false;
  }

  const payload = buildMapPointGroupInfoPayload(group, mapPointsManager);
  const text = formatMapPointGroupInfoReport(payload);

  try {
    if (globalThis.navigator?.clipboard?.writeText) {
      await globalThis.navigator.clipboard.writeText(text);
      globalThis.ui?.notifications?.info?.(
        `Copied debug info for "${group.label || 'Map Point Group'}" to clipboard`,
      );
      return true;
    }
  } catch (err) {
    log.warn('Clipboard copy failed:', err);
  }

  try {
    console.log('[MapShine Map Point Group Info]\n', text);
    globalThis.ui?.notifications?.warn?.(
      'Could not copy to clipboard — full report printed to browser console (F12).',
    );
    return false;
  } catch (err) {
    log.error('Failed to log map point group info:', err);
    globalThis.ui?.notifications?.error?.('Failed to export map point group info.');
    return false;
  }
}
