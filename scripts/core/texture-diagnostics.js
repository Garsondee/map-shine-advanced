/**
 * @fileoverview Classify and describe GPU texture inflation in the tile streaming
 * pipeline. Shared by the adaptive budget controller, crash recovery, streaming
 * diagnostics UI, and the `MapShine.diagnoseTextures()` console helper.
 *
 * @module core/texture-diagnostics
 */

import { createLogger } from './log.js';
import { getTextureBudgetTracker } from '../assets/TextureBudgetTracker.js';
import { auditPyramidTextureCache, getTileDecodePoolStats } from '../streaming/texture-pyramid-builder.js';
import { getTextureLeakProbeReport } from './texture-leak-probe.js';

const log = createLogger('TextureDiagnostics');

/** Material map slots counted when auditing scene-graph texture references. */
const _TEXTURE_MAP_KEYS = [
  'map', 'normalMap', 'alphaMap', 'emissiveMap', 'roughnessMap', 'metalnessMap',
  'aoMap', 'lightMap', 'bumpMap', 'displacementMap', 'envMap',
];

/**
 * Human-readable catalog for {@link resolvePrimaryLeakId} codes.
 * @type {Readonly<Record<string, { label: string, short: string, detail: string }>>}
 */
export const TEXTURE_LEAK_CATALOG = Object.freeze({
  streaming_culled_cell_leak: {
    label: 'Culled streaming cell leak',
    short: 'Off-screen streaming cells still hold GPU textures after cull',
    detail: 'Panning or LOD changes marked cells culled but their decoded albedo textures were not disposed.',
  },
  pyramid_cache_leak: {
    label: 'Pyramid cache leak',
    short: 'LOD pyramid RAM cache retains textures no longer mounted on any cell',
    detail: 'Decoded pyramid tiles are cached beyond what resident streaming cells need.',
  },
  pyramid_cache_mesh_overlap: {
    label: 'Pyramid cache overlap',
    short: 'Pyramid cache entries still alive while the same tile is mounted on a mesh',
    detail: 'A cell upgrade may have duplicated the GPU texture instead of reusing the cache entry.',
  },
  streaming_lod_texture_leak: {
    label: 'Streaming LOD churn leak',
    short: 'LOD upgrades or panning left old cell textures alive outside the budget tracker',
    detail: 'More GPU textures exist than visible/resident streaming cells can explain — typical of dispose() gaps during LOD swaps.',
  },
  streaming_budget_over_register: {
    label: 'Streaming budget over-register',
    short: 'Budget tracker lists more stream tiles than resident cells',
    detail: 'Stream tile registrations are not being unregistered when cells evict.',
  },
  active_untracked_texture_leak: {
    label: 'Active untracked leak',
    short: 'Live texture count is still climbing while streaming grids look clean',
    detail: 'Something outside tile streaming is allocating GPU textures without dispose() — see leak probe top sites.',
  },
  probable_historical_stream_leak: {
    label: 'Historical streaming leak',
    short: 'High GPU texture count with clean streaming now — likely accumulated earlier in the session',
    detail: 'Earlier pan/LOD paths may have leaked before fixes were loaded; hard-refresh (Ctrl+F5) after updating.',
  },
  untracked_texture_leak: {
    label: 'Untracked texture inflation',
    short: 'Hundreds of GPU textures are alive but not referenced in the scene graph or budget tracker',
    detail: 'Textures were created and uploaded but dropped without dispose() — invisible to scene-graph scans.',
  },
  lighting_per_floor_snapshot_leak: {
    label: 'Lighting snapshot leak',
    short: 'LightingEffectV2 per-floor snapshot render targets created without dispose()',
    detail: 'endStackedLightBuffer cleared reuse maps each frame while new WebGLRenderTargets were allocated.',
  },
  scene_graph_orphan_estimate: {
    label: 'Scene graph orphan estimate',
    short: 'Renderer texture counter exceeds textures reachable from scanned scene graphs',
    detail: 'Some textures may still be referenced only by uniforms or stale material slots.',
  },
  none: {
    label: 'No classified leak',
    short: 'Texture counts are within expected bounds for this scene',
    detail: '',
  },
});

/**
 * @param {string} leakId
 * @returns {{ label: string, short: string, detail: string }}
 */
export function describeLeakId(leakId) {
  return TEXTURE_LEAK_CATALOG[leakId] ?? {
    label: leakId || 'Unknown texture issue',
    short: leakId || 'Unclassified GPU texture inflation',
    detail: '',
  };
}

/**
 * Register every THREE.Texture reachable from a material (map slots + shader uniforms).
 * @param {object|null|undefined} mat
 * @param {Set<object>} textures
 */
function _addTexturesFromMaterial(mat, textures) {
  if (!mat) return;
  const mats = Array.isArray(mat) ? mat : [mat];
  for (const m of mats) {
    for (const key of _TEXTURE_MAP_KEYS) {
      const tex = m?.[key];
      if (tex?.isTexture) textures.add(tex);
    }
    const uniforms = m?.uniforms;
    if (uniforms && typeof uniforms === 'object') {
      for (const entry of Object.values(uniforms)) {
        const val = entry?.value ?? entry;
        if (val?.isTexture) textures.add(val);
      }
    }
  }
}

/**
 * Collect unique THREE.Texture references reachable from an Object3D subtree.
 * @param {import('three').Object3D|null|undefined} root
 * @returns {Set<object>}
 */
function _collectTexturesFromObject3D(root) {
  /** @type {Set<object>} */
  const textures = new Set();
  if (!root || typeof root.traverse !== 'function') return textures;
  try {
    root.traverse((obj) => _addTexturesFromMaterial(obj?.material, textures));
  } catch (_) {}
  return textures;
}

/** @returns {object} */
function _collectCompositorRenderTargetAudit() {
  /** @type {Set<object>} */
  const textures = new Set();
  let renderTargetCount = 0;
  try {
    const comp = window.MapShine?.floorCompositorV2 ?? window.MapShine?.floorCompositor ?? null;
    const candidates = [
      comp?._sceneRT,
      comp?._postA,
      comp?._postB,
      comp?._levelCompositeRT,
      comp?._levelCompositeScratch,
    ];
    for (const rt of candidates) {
      if (!rt?.isWebGLRenderTarget) continue;
      renderTargetCount += 1;
      if (rt.texture?.isTexture) textures.add(rt.texture);
      if (rt.depthTexture?.isTexture) textures.add(rt.depthTexture);
    }
  } catch (_) {}
  return { renderTargetCount, textureRefs: textures.size };
}

/** @returns {object} */
function _collectEffectTextureAudit() {
  const out = {
    fire: {
      floorStates: 0,
      activeFloors: 0,
      batchRenderers: 0,
      batchCount: 0,
      particleSystems: 0,
      coalOverlays: 0,
      sharedSpriteTextures: 0,
    },
    candle: {
      flameInstances: 0,
      glowBuckets: 0,
    },
    tileManagerSprites: 0,
  };
  try {
    const comp = window.MapShine?.floorCompositorV2 ?? window.MapShine?.floorCompositor ?? null;
    const fire = comp?._fireEffect ?? null;
    if (fire) {
      out.fire.floorStates = fire._floorStates?.size ?? 0;
      out.fire.activeFloors = fire._activeFloors?.size ?? 0;
      out.fire.coalOverlays = fire._coalOverlays?.size ?? 0;
      out.fire.sharedSpriteTextures = [fire._fireTexture, fire._emberTexture, fire._smokeTexture]
        .filter((t) => t?.isTexture).length;
      for (const st of fire._floorStates?.values?.() ?? []) {
        if (st?.batchRenderer) {
          out.fire.batchRenderers += 1;
          out.fire.batchCount += st.batchRenderer.batches?.length ?? 0;
        }
        out.fire.particleSystems += (st?.systems?.length ?? 0)
          + (st?.emberSystems?.length ?? 0)
          + (st?.smokeSystems?.length ?? 0);
      }
    }
    const candle = comp?._candleFlamesEffect ?? null;
    if (candle) {
      out.candle.flameInstances = candle._flameMesh?.count ?? 0;
      out.candle.glowBuckets = candle._glowBucketsByFloor?.size ?? 0;
    }
    const tm = window.MapShine?.tileManager ?? null;
    for (const { sprite } of tm?.tileSprites?.values?.() ?? []) {
      const tex = sprite?.material?.map ?? null;
      if (tex?.isTexture) out.tileManagerSprites += 1;
    }
  } catch (_) {}
  return out;
}

/**
 * @param {import('../compositor-v2/FloorRenderBus.js').FloorRenderBus|null|undefined} bus
 * @returns {{ busTexturesWithMap: number, busStreamingWithMap: number }}
 */
function _countBusTextureMaps(bus) {
  let busTexturesWithMap = 0;
  let busStreamingWithMap = 0;
  try {
    for (const [id, entry] of bus?._tiles?.entries?.() ?? []) {
      const key = String(id ?? '');
      if (key.startsWith('__')) continue;
      const tex = entry?.material?.map ?? entry?.mesh?.material?.map ?? null;
      if (!tex?.isTexture) continue;
      busTexturesWithMap += 1;
      if (entry?.mapShineStreamedRegion || entry?.mesh?.userData?.mapShineStreaming) {
        busStreamingWithMap += 1;
      }
    }
  } catch (_) {}
  return { busTexturesWithMap, busStreamingWithMap };
}

/**
 * @param {object|null} tileStreaming
 * @returns {{ streamCellsWithMap: number, streamFallbackCells: number, culledWithMap: number }}
 */
function _summarizeStreamingTextureCells(tileStreaming) {
  let streamCellsWithMap = 0;
  let streamFallbackCells = 0;
  let culledWithMap = 0;
  try {
    for (const grid of [...(tileStreaming?.backgroundGrids ?? []), ...(tileStreaming?.regionGrids ?? [])]) {
      streamFallbackCells += Number(grid?.fallbackCellCount) || 0;
      for (const cell of grid?.cells ?? []) {
        if (cell?.hasMap) {
          streamCellsWithMap += 1;
          if (cell.state === 'culled') culledWithMap += 1;
        }
      }
    }
  } catch (_) {}
  return { streamCellsWithMap, streamFallbackCells, culledWithMap };
}

/**
 * @param {object} audit
 * @returns {string}
 */
export function resolvePrimaryLeakId(audit) {
  if (audit.pyramidCache?.alsoOnMesh > 0) return 'pyramid_cache_mesh_overlap';
  if (audit.culledWithMap > 0) return 'streaming_culled_cell_leak';
  if (audit.pyramidCache?.inCacheOnly > Math.max(8, (audit.streamCellsWithMap ?? 0) + 4)) {
    return 'pyramid_cache_leak';
  }
  const trueGap = audit.trueOrphanEstimate ?? audit.gapVsAccounted ?? 0;
  const probe = audit.textureLeakProbe ?? null;
  const topSite = String(probe?.topSites?.[0]?.site ?? '');
  if (topSite.includes('LightingEffectV2._snapshotLightRtForFloor')) {
    return 'lighting_per_floor_snapshot_leak';
  }
  const climbDelta = (probe?.lastSampleTextures ?? 0) - (probe?.sessionMinTextures ?? 0);
  const activeClimb = (probe?.climbStreak ?? 0) >= 30 && climbDelta >= 96;
  const streamingClean = (audit.streamCellsWithMap ?? 0) <= (audit.visibleStreamCells ?? 0) + 2
    && (audit.culledStreamCells ?? 0) === 0
    && (audit.pyramidCache?.inCacheOnly ?? 0) === 0;
  if (trueGap > 100 && activeClimb && streamingClean) {
    return 'active_untracked_texture_leak';
  }
  if (trueGap > 100 && (audit.budgetBySource?.streamTile ?? 0) > (audit.streamResidentCells ?? 0) + 4) {
    return 'streaming_budget_over_register';
  }
  if (trueGap > 100 && streamingClean) {
    if (trueGap > 200 && !activeClimb) return 'probable_historical_stream_leak';
    return 'untracked_texture_leak';
  }
  if (trueGap > 100) return 'streaming_lod_texture_leak';
  if ((audit.untrackedEstimate ?? 0) > 150) return 'untracked_texture_leak';
  if ((audit.orphanEstimate ?? 0) > 100) return 'scene_graph_orphan_estimate';
  return 'none';
}

/**
 * Compare Three.js renderer texture counter vs textures actually referenced by the scene.
 * @param {any} renderer
 * @param {object|null} [tileStreaming]
 * @param {{ probeLimit?: number }} [options]
 * @returns {object}
 */
export function collectTextureAudit(renderer, tileStreaming = null, options = {}) {
  const rendererCounter = renderer?.info?.memory?.textures ?? null;

  let budgetEntryCount = null;
  /** @type {Record<string, number>} */
  let budgetBySource = {};
  try {
    const tracker = getTextureBudgetTracker();
    budgetEntryCount = tracker.getBudgetState()?.entryCount ?? null;
    budgetBySource = tracker.getSourceEntryCounts?.() ?? {};
  } catch (_) {}

  /** @type {Set<object>} */
  const sceneTextures = new Set();
  const sceneGraphBySubsystem = { floorRenderBus: 0, sceneComposer: 0, compositorBus: 0 };
  try {
    const ms = window.MapShine ?? {};
    const busSet = _collectTexturesFromObject3D(ms.floorRenderBus?._scene);
    const composerSet = _collectTexturesFromObject3D(ms.sceneComposer?.scene);
    const compositor = ms.floorCompositorV2 ?? ms.floorCompositor ?? null;
    const compositorBusSet = _collectTexturesFromObject3D(compositor?._renderBus?._scene);
    sceneGraphBySubsystem.floorRenderBus = busSet.size;
    sceneGraphBySubsystem.sceneComposer = composerSet.size;
    sceneGraphBySubsystem.compositorBus = compositorBusSet.size;
    for (const tex of busSet) sceneTextures.add(tex);
    for (const tex of composerSet) sceneTextures.add(tex);
    for (const tex of compositorBusSet) sceneTextures.add(tex);
  } catch (_) {}

  const effects = _collectEffectTextureAudit();
  const compositorRts = _collectCompositorRenderTargetAudit();
  /** @type {Set<object>} */
  const referencedTextures = new Set(sceneTextures);
  try {
    const comp = window.MapShine?.floorCompositorV2 ?? window.MapShine?.floorCompositor ?? null;
    for (const rt of [comp?._sceneRT, comp?._postA, comp?._postB, comp?._levelCompositeRT]) {
      if (rt?.texture?.isTexture) referencedTextures.add(rt.texture);
      if (rt?.depthTexture?.isTexture) referencedTextures.add(rt.depthTexture);
    }
  } catch (_) {}

  let pyramidCache = null;
  try {
    pyramidCache = auditPyramidTextureCache(sceneTextures);
  } catch (_) {}

  const streamResidentCells = tileStreaming?.totals?.residentCells ?? null;
  const visibleStreamCells = tileStreaming?.view?.visibleCellsInFrustum ?? null;
  const {
    streamCellsWithMap,
    streamFallbackCells,
    culledWithMap,
  } = _summarizeStreamingTextureCells(tileStreaming);

  let culledStreamCells = 0;
  try {
    for (const grid of [...(tileStreaming?.backgroundGrids ?? []), ...(tileStreaming?.regionGrids ?? [])]) {
      culledStreamCells += Number(grid?.cellSummary?.culled) || 0;
    }
  } catch (_) {}

  const { busTexturesWithMap, busStreamingWithMap } = _countBusTextureMaps(
    window.MapShine?.floorRenderBus ?? null,
  );

  const compositorRtCount = (budgetBySource.renderTarget ?? 0)
    + (budgetBySource.tileMask ?? 0)
    + (budgetBySource.sceneMask ?? 0);

  let preRenderLeakCount = null;
  try {
    preRenderLeakCount = Number(window.MapShine?.floorRenderBus?._lastPreRenderLeakCount ?? 0);
  } catch (_) {}

  let decodePool = null;
  try {
    const stats = getTileDecodePoolStats?.() ?? null;
    if (stats) {
      decodePool = {
        queueDepth: stats.queueDepth ?? null,
        activeRequests: stats.activeRequests ?? null,
        completedRequests: stats.completedRequests ?? null,
      };
    }
  } catch (_) {}

  const orphanEstimate = (Number.isFinite(rendererCounter) && referencedTextures.size >= 0)
    ? Math.max(0, rendererCounter - referencedTextures.size)
    : null;
  const trueOrphanEstimate = orphanEstimate;
  const untrackedEstimate = (Number.isFinite(rendererCounter) && Number.isFinite(budgetEntryCount))
    ? Math.max(0, rendererCounter - budgetEntryCount)
    : null;
  const cacheExcess = (Number.isFinite(pyramidCache?.size) && Number.isFinite(streamResidentCells))
    ? Math.max(0, pyramidCache.size - streamResidentCells)
    : 0;
  const residentExcess = (Number.isFinite(streamResidentCells) && Number.isFinite(visibleStreamCells))
    ? Math.max(0, streamResidentCells - visibleStreamCells)
    : 0;
  const accountedEstimate = (Number.isFinite(rendererCounter))
    ? Math.min(
      rendererCounter,
      referencedTextures.size
        + (pyramidCache?.inCacheOnly ?? 0)
        + Math.max(0, (budgetEntryCount ?? 0) - referencedTextures.size),
    )
    : null;
  const gapVsAccounted = (Number.isFinite(rendererCounter) && Number.isFinite(accountedEstimate))
    ? Math.max(0, rendererCounter - accountedEstimate)
    : null;
  const unregisteredAlive = (Number.isFinite(rendererCounter))
    ? Math.max(
      0,
      rendererCounter
        - (budgetEntryCount ?? 0)
        - (pyramidCache?.inCacheOnly ?? 0),
    )
    : null;

  const likelyStreamingLeak = (
    (culledWithMap > 0 || culledStreamCells > 0)
    || (pyramidCache?.alsoOnMesh ?? 0) > 0
    || (
      (gapVsAccounted ?? 0) > 100
      && (unregisteredAlive ?? 0) > 80
      && (
        cacheExcess > 8
        || residentExcess > 8
        || (streamCellsWithMap ?? 0) < (streamResidentCells ?? 0)
      )
    )
  );

  const likelyUntrackedLeak = (unregisteredAlive ?? 0) > 150 && !likelyStreamingLeak;

  const audit = {
    rendererCounter,
    sceneGraphTextures: sceneTextures.size,
    referencedTextures: referencedTextures.size,
    sceneGraphBySubsystem,
    budgetEntryCount,
    budgetBySource,
    pyramidCache,
    streamResidentCells,
    visibleStreamCells,
    streamCellsWithMap,
    streamFallbackCells,
    culledStreamCells,
    culledWithMap,
    busTexturesWithMap,
    busStreamingWithMap,
    compositorRtCount,
    compositorRts,
    effects,
    preRenderLeakCount,
    decodePool,
    orphanEstimate,
    trueOrphanEstimate,
    untrackedEstimate,
    accountedEstimate,
    gapVsAccounted,
    unregisteredAlive,
    likelyStreamingLeak,
    likelyUntrackedLeak,
    primaryLeakId: 'pending',
  };
  try {
    audit.textureLeakProbe = getTextureLeakProbeReport(options.probeLimit ?? 8);
  } catch (_) {
    audit.textureLeakProbe = null;
  }
  audit.primaryLeakId = resolvePrimaryLeakId(audit);
  return audit;
}

/**
 * Live audit with a compact tile-streaming snapshot (for console / growth alerts).
 * @param {{ maxCellsPerGrid?: number, probeLimit?: number }} [options]
 * @returns {Promise<object>}
 */
export async function collectLiveTextureAuditAsync(options = {}) {
  const renderer = window.MapShine?.renderer ?? null;
  let tileStreaming = null;
  try {
    const { buildTileStreamingCrashSnapshot } = await import('../ui/tile-streaming-report.js');
    tileStreaming = buildTileStreamingCrashSnapshot({
      maxCellsPerGrid: options.maxCellsPerGrid ?? 12,
    });
  } catch (_) {}
  return collectTextureAudit(renderer, tileStreaming, options);
}

/**
 * Synchronous live audit — uses any cached streaming report when available to
 * avoid import cycles with the tile streaming manager.
 * @param {{ maxCellsPerGrid?: number, probeLimit?: number }} [options]
 * @returns {object}
 */
export function collectLiveTextureAudit(options = {}) {
  const renderer = window.MapShine?.renderer ?? null;
  const cached = window.MapShine?.lastTileStreamingReport ?? null;
  const tileStreaming = cached ? _tileStreamingShapeFromReport(cached) : null;
  return collectTextureAudit(renderer, tileStreaming, options);
}

/**
 * @param {object} report
 * @returns {object}
 */
function _tileStreamingShapeFromReport(report) {
  const bg = report.streaming?.backgroundGrids ?? [];
  const rg = report.streaming?.regionGrids ?? [];
  const residentCells = bg.reduce((n, g) => n + (g.cellSummary?.total ?? 0), 0)
    + rg.reduce((n, g) => n + (g.cellSummary?.total ?? 0), 0);
  return {
    totals: { residentCells },
    view: { visibleCellsInFrustum: report.view?.visibleCellsInFrustum ?? null },
    backgroundGrids: bg,
    regionGrids: rg,
  };
}

/**
 * @param {object|null|undefined} audit
 * @returns {string}
 */
export function formatTextureAuditLine(audit) {
  const counter = audit?.rendererCounter;
  if (!Number.isFinite(counter)) return 'n/a';
  if (!audit || audit.error) return String(counter);

  const parts = [`${counter} Three.js counter`];
  if (Number.isFinite(audit.sceneGraphTextures)) {
    parts.push(`${audit.sceneGraphTextures} in scene graph`);
  }
  if (Number.isFinite(audit.budgetEntryCount)) {
    parts.push(`${audit.budgetEntryCount} budget-tracked`);
  }
  if (Number.isFinite(audit.streamCellsWithMap)) {
    parts.push(`${audit.streamCellsWithMap}/${audit.streamResidentCells ?? '?'} stream textured`);
  }
  if (Number.isFinite(audit.gapVsAccounted) && audit.gapVsAccounted > 20) {
    parts.push(`~${audit.gapVsAccounted} unaccounted`);
  } else if (Number.isFinite(audit.unregisteredAlive) && audit.unregisteredAlive > 50) {
    parts.push(`~${audit.unregisteredAlive} unregistered`);
  }
  if (audit.primaryLeakId && audit.primaryLeakId !== 'none') {
    const { label } = describeLeakId(audit.primaryLeakId);
    parts.push(label);
  }
  return parts.join(', ');
}

/**
 * Build a structured description from an audit snapshot.
 * @param {object} audit
 * @param {{ growthDelta?: number, sessionFloor?: number, growthStreakSec?: number, degradationLevel?: number, action?: string }} [context]
 * @returns {{ leakId: string, label: string, headline: string, summary: string, detail: string, metrics: string }}
 */
export function describeTextureSituation(audit, context = {}) {
  const leakId = audit.primaryLeakId ?? 'none';
  const { label, short, detail } = describeLeakId(leakId);
  const live = audit.rendererCounter ?? '?';
  const delta = context.growthDelta;
  const floor = context.sessionFloor;
  const streakSec = context.growthStreakSec;

  let headline = label;
  if (Number.isFinite(delta) && delta > 0) {
    headline = `${label}: ${live} GPU textures (+${delta} above session floor ${floor ?? '?'})`;
  } else if (Number.isFinite(live)) {
    headline = `${label}: ${live} GPU textures`;
  }

  const metricsParts = [];
  if (Number.isFinite(audit.referencedTextures ?? audit.sceneGraphTextures)) {
    metricsParts.push(`${audit.referencedTextures ?? audit.sceneGraphTextures} scene-referenced`);
  }
  if (Number.isFinite(audit.budgetEntryCount)) {
    metricsParts.push(`${audit.budgetEntryCount} budget-tracked`);
  }
  if (Number.isFinite(audit.streamCellsWithMap)) {
    metricsParts.push(
      `streaming ${audit.streamCellsWithMap}/${audit.streamResidentCells ?? '?'} resident cells textured`,
    );
  }
  if (Number.isFinite(audit.visibleStreamCells)) {
    metricsParts.push(`${audit.visibleStreamCells} visible in view`);
  }
  if ((audit.culledWithMap ?? 0) > 0) {
    metricsParts.push(`${audit.culledWithMap} culled cells still hold maps`);
  }
  if ((audit.pyramidCache?.inCacheOnly ?? 0) > 0) {
    metricsParts.push(`${audit.pyramidCache.inCacheOnly} pyramid cache-only`);
  }
  const gap = audit.unregisteredAlive ?? audit.gapVsAccounted ?? audit.trueOrphanEstimate;
  if (Number.isFinite(gap) && gap > 20) {
    metricsParts.push(`~${gap} unregistered alive`);
  }

  const metrics = metricsParts.join(' · ');
  let summary = short;
  if (metrics) summary = `${short}. ${metrics}`;
  if (Number.isFinite(streakSec) && streakSec > 0) {
    summary += ` (sustained ~${streakSec}s)`;
  }
  if (context.action) {
    summary += `. ${context.action}`;
  }

  let enrichedDetail = detail;
  const probe = audit.textureLeakProbe ?? null;
  const topSite = probe?.topSites?.[0]?.site ?? null;
  if (topSite && (leakId === 'active_untracked_texture_leak' || leakId === 'untracked_texture_leak')) {
    enrichedDetail += ` Top probe site: ${topSite.slice(0, 200)}.`;
  }

  return {
    leakId,
    label,
    headline,
    summary,
    detail: enrichedDetail,
    metrics,
  };
}

/**
 * One-line log message for adaptive budget controller growth escalation.
 * @param {object} audit
 * @param {{ growthDelta: number, sessionFloor: number, growthStreakSec: number, degradationLevel: number }} context
 * @returns {string}
 */
export function formatTextureGrowthAlert(audit, context) {
  const desc = describeTextureSituation(audit, {
    growthDelta: context.growthDelta,
    sessionFloor: context.sessionFloor,
    growthStreakSec: context.growthStreakSec,
    degradationLevel: context.degradationLevel,
    action: `Raising proactive degradation to level ${context.degradationLevel} `
      + '(throttle GPU uploads, LOD-0 cooldown). Run MapShine.diagnoseTextures() for full audit.',
  });
  return `${desc.headline} — ${desc.summary}`;
}

/**
 * Console helper: classify live texture inflation and print a readable report.
 * @param {{ maxCellsPerGrid?: number }} [options]
 * @returns {Promise<{ audit: object, leakId: string, label: string, headline: string, summary: string, detail: string }>}
 */
export async function diagnoseTextures(options = {}) {
  const audit = await collectLiveTextureAuditAsync(options);
  const adaptive = window.MapShine?.adaptiveBudgetController?.getState?.() ?? null;
  const growthDelta = adaptive
    ? Math.max(0, (audit.rendererCounter ?? 0) - (adaptive.minTextureCount ?? 0))
    : undefined;
  const desc = describeTextureSituation(audit, {
    growthDelta: growthDelta > 0 ? growthDelta : undefined,
    sessionFloor: adaptive?.minTextureCount,
    growthStreakSec: adaptive?.growthAlertStreak,
  });

  try {
    // eslint-disable-next-line no-console
    console.groupCollapsed?.(
      `%c[MapShine] Texture diagnostics — ${desc.label}`,
      'color:#f59e0b;font-weight:bold',
    );
    // eslint-disable-next-line no-console
    console.log(desc.headline);
    // eslint-disable-next-line no-console
    console.log(desc.summary);
    if (desc.detail) {
      // eslint-disable-next-line no-console
      console.log(desc.detail);
    }
    // eslint-disable-next-line no-console
    console.log('Counters:', {
      renderer: audit.rendererCounter,
      sceneGraph: audit.sceneGraphTextures,
      referenced: audit.referencedTextures,
      budgetTracked: audit.budgetEntryCount,
      unregisteredAlive: audit.unregisteredAlive,
      gapVsAccounted: audit.gapVsAccounted,
      leakId: audit.primaryLeakId,
    });
    if (audit.textureLeakProbe?.topSites?.length) {
      // eslint-disable-next-line no-console
      console.table?.(audit.textureLeakProbe.topSites.map((s) => ({
        cls: s.cls,
        alive: s.alive,
        gcLeaked: s.gcLeaked,
        allocated: s.allocated,
        site: s.site.length > 120 ? `${s.site.slice(0, 117)}...` : s.site,
      })));
    }
    // eslint-disable-next-line no-console
    console.groupEnd?.();
  } catch (err) {
    log.warn('diagnoseTextures console output failed', err);
  }

  try {
    if (window.MapShine) {
      window.MapShine.lastTextureAudit = audit;
      window.MapShine.lastTextureDiagnosis = desc;
    }
  } catch (_) {}

  return { audit, ...desc };
}

/**
 * Install `window.MapShine.diagnoseTextures` (idempotent).
 */
export function exposeTextureDiagnosticsApi() {
  try {
    if (typeof window === 'undefined') return;
    const ms = window.MapShine || (window.MapShine = {});
    if (!ms.diagnoseTextures) {
      ms.diagnoseTextures = (opts) => diagnoseTextures(opts);
      log.info('Debug helper available: MapShine.diagnoseTextures()');
    }
  } catch (_) {}
}
