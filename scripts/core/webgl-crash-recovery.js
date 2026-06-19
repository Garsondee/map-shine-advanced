/**
 * @fileoverview WebGL crash detection, diagnosis and self-recovery.
 *
 * Responsibilities:
 * - Record every WebGL context loss with a full system-state snapshot
 *   (GPU, renderer stats, memory, scene, load phase, tab visibility).
 * - Show a crash dialog that explains what happened, lists the most likely
 *   causes and lets the user copy a diagnostic report or rebuild the scene.
 * - Apply a one-shot "safe mode" render-resolution downgrade when a crash
 *   happens, then restore the previous resolution automatically on the next
 *   scene load. Safe mode is not re-applied on every subsequent load unless
 *   the user crashes again in that session.
 * - Watchdog: if the browser never restores the context, trigger an automatic
 *   scene rebuild (fresh canvas + fresh WebGL context) once per session.
 *
 * All state is per-client (localStorage). Nothing here writes to the scene
 * document or any Foundry world setting.
 *
 * @module core/webgl-crash-recovery
 */

import { createLogger } from './log.js';
import { buildTileStreamingCrashSnapshot, buildCompositorPopulateSnapshot } from '../ui/tile-streaming-report.js';
import { getTextureBudgetTracker } from '../assets/TextureBudgetTracker.js';
import { auditPyramidTextureCache, getTileDecodePoolStats } from '../streaming/texture-pyramid-builder.js';
import { getAdaptiveBudgetController } from '../streaming/adaptive-budget-controller.js';
import { getGpuWorkScheduler } from '../streaming/gpu-work-scheduler.js';
import { getTextureLeakProbeReport } from './texture-leak-probe.js';

const log = createLogger('WebGLCrashRecovery');

/** Must match module.json — Foundry's game.modules version can lag until a hard refresh. */
const MODULE_MANIFEST_VERSION = '0.5.3.10';

const HISTORY_KEY = 'map-shine-advanced.webglCrashLog';
const SAFE_MODE_KEY = 'map-shine-advanced.webglSafeMode';
const SAFE_MODE_PRESET = '1280x720';
const HISTORY_MAX = 20;
/** Crashes within this window count toward "repeated" crash messaging only. */
const REPEAT_CRASH_WINDOW_MS = 30 * 60 * 1000;
/** Repeated-crash notice threshold (does not block auto-restore on next load). */
const REPEAT_CRASH_THRESHOLD = 3;
/** How long to wait for webglcontextrestored before forcing a rebuild. */
const RESTORE_WATCHDOG_MS = 12000;
/** Delay before the crash dialog appears (lets the restore race settle first). */
const CRASH_DIALOG_DELAY_MS = 1500;

const SESSION_ID = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

// ---------------------------------------------------------------------------
// Internal session state
// ---------------------------------------------------------------------------

/** @type {((reason: string) => Promise<boolean>)|null} */
let _requestRebuild = null;
let _safeModeAppliedThisSession = false;
let _autoRebuildAttempted = false;
let _dialogShownThisSession = false;
let _lossEpoch = 0;
let _restoreWatchdogId = null;
/** @type {object|null} */
let _lastCrashRecord = null;
/** @type {{ type: 'restored'|'staying-reduced', preset?: string }|null} */
let _pendingLoadNotice = null;

// ---------------------------------------------------------------------------
// Storage helpers
// ---------------------------------------------------------------------------

function _readJson(key) {
  try {
    const raw = globalThis.localStorage?.getItem?.(key);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch (_) {
    return null;
  }
}

function _writeJson(key, value) {
  try {
    globalThis.localStorage?.setItem?.(key, JSON.stringify(value));
    return true;
  } catch (_) {
    return false;
  }
}

function _removeKey(key) {
  try {
    globalThis.localStorage?.removeItem?.(key);
  } catch (_) {
  }
}

/**
 * Mirrors GraphicsSettingsManager._buildStorageKey so safe mode can operate on
 * persisted graphics overrides even when no manager instance exists yet.
 * @returns {string}
 */
function _buildGraphicsStorageKey() {
  try {
    const sceneId = canvas?.scene?.id || 'no-scene';
    const userId = game?.user?.id || 'no-user';
    return `map-shine-advanced.graphicsOverrides.${sceneId}.${userId}`;
  } catch (_) {
    return 'map-shine-advanced.graphicsOverrides';
  }
}

// ---------------------------------------------------------------------------
// Crash history
// ---------------------------------------------------------------------------

/** @returns {object[]} */
export function getCrashHistory() {
  const parsed = _readJson(HISTORY_KEY);
  return Array.isArray(parsed) ? parsed : [];
}

function _saveCrashHistory(history) {
  const trimmed = history.slice(-HISTORY_MAX);
  _writeJson(HISTORY_KEY, trimmed);
}

/**
 * Compact subset of a crash record persisted in the rolling crash log.
 * @param {object} record
 * @returns {object}
 */
function _compactRecord(record) {
  return {
    at: record.at,
    atMs: record.atMs,
    sessionId: record.sessionId,
    trigger: record.trigger,
    sceneId: record.scene?.id ?? null,
    sceneName: record.scene?.name ?? null,
    phase: record.load?.phase ?? null,
    loading: record.load?.sceneLoading ?? null,
    hidden: record.visibility?.hidden ?? null,
    gpu: record.gpu?.renderer ?? null,
    preset: record.graphics?.renderResolutionPreset ?? null,
    restored: record.restored === true,
    restoredAfterMs: record.restoredAfterMs ?? null,
    safeModeDowngradeApplied: record.safeModeDowngradeApplied === true,
    streamVramPct: record.tileStreaming?.budget?.usedPct ?? null,
    streamInflight: record.tileStreaming?.totals?.inflight ?? null,
    streamResidentCells: record.tileStreaming?.totals?.residentCells ?? null,
    streamBgGrids: record.tileStreaming?.manager?.backgroundGridCount ?? null,
    streamRegionGrids: record.tileStreaming?.manager?.regionGridCount ?? null,
    textures: record.rendererStats?.textures ?? null,
    orphanEstimate: record.textureAudit?.orphanEstimate ?? null,
    untrackedEstimate: record.textureAudit?.untrackedEstimate ?? null,
    gapVsAccounted: record.textureAudit?.gapVsAccounted ?? null,
    sceneGraphTextures: record.textureAudit?.sceneGraphTextures ?? null,
    primaryLeakId: record.textureAudit?.primaryLeakId ?? null,
    pyramidCacheInCacheOnly: record.textureAudit?.pyramidCache?.inCacheOnly ?? null,
    compositorRtCount: record.textureAudit?.compositorRtCount ?? null,
    preRenderLeakCount: record.textureAudit?.preRenderLeakCount ?? null,
    likelyStreamingLeak: record.textureAudit?.likelyStreamingLeak === true,
    likelyUntrackedLeak: record.textureAudit?.likelyUntrackedLeak === true,
    degradationLevel: record.adaptive?.degradationLevel ?? null,
    governorDeferred: record.governor?.deferredLastFrame ?? null,
    governorThrottle: record.governor?.throttleLevel ?? null,
    adaptiveBonusMB: record.adaptive?.adaptiveBonusMB ?? null,
    liveRendererTextures: record.adaptive?.liveRendererTextures ?? null,
  };
}

function _appendHistory(record) {
  const history = getCrashHistory();
  history.push(_compactRecord(record));
  _saveCrashHistory(history);
}

/** Material map slots counted when auditing scene-graph texture references. */
const _TEXTURE_MAP_KEYS = [
  'map', 'normalMap', 'alphaMap', 'emissiveMap', 'roughnessMap', 'metalnessMap',
  'aoMap', 'lightMap', 'bumpMap', 'displacementMap', 'envMap',
];

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

/**
 * @returns {object}
 */
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

/**
 * Snapshot active particle / candle effect state for crash reports.
 * @returns {object}
 */
function _collectEffectTextureAudit() {
  /** @type {object} */
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
function _resolvePrimaryLeakId(audit) {
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
 * @param {object|null} tileStreaming
 * @returns {object}
 */
function _collectTextureAudit(renderer, tileStreaming) {
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
  /** @type {{ floorRenderBus: number, sceneComposer: number, compositorBus: number }} */
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
    audit.textureLeakProbe = getTextureLeakProbeReport(8);
  } catch (_) {
    audit.textureLeakProbe = null;
  }
  audit.primaryLeakId = _resolvePrimaryLeakId(audit);
  return audit;
}

/** Re-persist the most recent history entry from the live record (e.g. after restore). */
function _updateLastHistoryEntry(record) {
  const history = getCrashHistory();
  if (!history.length) return;
  const last = history[history.length - 1];
  if (last?.atMs !== record.atMs) return;
  history[history.length - 1] = _compactRecord(record);
  _saveCrashHistory(history);
}

// ---------------------------------------------------------------------------
// Diagnostics collection
// ---------------------------------------------------------------------------

/**
 * Gather a full system-state snapshot for diagnosis. Every section is
 * individually guarded — a lost context must never prevent report collection.
 *
 * @param {{ renderer?: any, phase?: string|null, trigger?: string }} [extra]
 * @returns {object}
 */
export function collectDiagnostics(extra = {}) {
  const ms = (typeof window !== 'undefined' ? window.MapShine : null) ?? {};
  const renderer = extra.renderer ?? ms.renderer ?? null;
  const record = {
    at: new Date().toISOString(),
    atMs: Date.now(),
    sessionId: SESSION_ID,
    trigger: extra.trigger ?? 'manual',
    module: { id: 'map-shine-advanced', version: MODULE_MANIFEST_VERSION, runtimeVersion: null, versionMismatch: false },
    load: {},
    visibility: {},
    scene: {},
    gpu: {},
    rendererStats: {},
    graphics: {},
    memory: {},
    browser: {},
    crashHistorySummary: {},
    recentErrors: [],
    tileStreaming: null,
    populate: null,
  };

  try {
    const runtimeVersion = game?.modules?.get?.('map-shine-advanced')?.version ?? null;
    record.module.runtimeVersion = runtimeVersion;
    record.module.versionMismatch = runtimeVersion != null && runtimeVersion !== MODULE_MANIFEST_VERSION;
  } catch (_) {}

  try {
    record.load = {
      phase: extra.phase ?? ms.loadCoordinator?.state ?? null,
      coordinatorState: ms.loadCoordinator?.state ?? null,
      sceneLoading: ms.__msaSceneLoading === true,
      msSinceLoadStart: (typeof ms._loadTimerStartMs === 'number' && typeof performance !== 'undefined')
        ? Math.round(performance.now() - ms._loadTimerStartMs)
        : null,
      lastLoadDurationMs: (typeof ms._lastLoadDurationMs === 'number') ? Math.round(ms._lastLoadDurationMs) : null,
    };
  } catch (_) {}

  try {
    record.visibility = {
      hidden: typeof document !== 'undefined' ? document.hidden === true : null,
      visibilityState: typeof document !== 'undefined' ? (document.visibilityState ?? null) : null,
      hasFocus: typeof document !== 'undefined' && typeof document.hasFocus === 'function'
        ? document.hasFocus()
        : null,
    };
  } catch (_) {}

  try {
    const scene = canvas?.scene ?? null;
    if (scene) {
      record.scene = {
        id: scene.id ?? null,
        name: scene.name ?? null,
        width: scene.width ?? null,
        height: scene.height ?? null,
        tiles: scene.tiles?.size ?? null,
        tokens: scene.tokens?.size ?? null,
        lights: scene.lights?.size ?? null,
        walls: scene.walls?.size ?? null,
      };
    }
  } catch (_) {}

  try {
    const gl = renderer?.getContext?.() ?? null;
    const gpu = { contextLost: null, vendor: null, renderer: null, maxTextureSize: null };
    if (gl) {
      try { gpu.contextLost = gl.isContextLost?.() === true; } catch (_) {}
      try {
        const dbg = gl.getExtension?.('WEBGL_debug_renderer_info');
        if (dbg) {
          gpu.vendor = gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL) ?? null;
          gpu.renderer = gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) ?? null;
        }
      } catch (_) {}
      try { gpu.maxTextureSize = gl.getParameter(gl.MAX_TEXTURE_SIZE) ?? null; } catch (_) {}
      try {
        gpu.drawingBufferWidth = gl.drawingBufferWidth ?? null;
        gpu.drawingBufferHeight = gl.drawingBufferHeight ?? null;
      } catch (_) {}
    }
    try { gpu.tier = ms.capabilities?.tier ?? null; } catch (_) {}
    record.gpu = gpu;
  } catch (_) {}

  try {
    const info = renderer?.info ?? null;
    if (info) {
      record.rendererStats = {
        geometries: info.memory?.geometries ?? null,
        textures: info.memory?.textures ?? null,
        programs: Array.isArray(info.programs) ? info.programs.length : null,
        renderCalls: info.render?.calls ?? null,
        triangles: info.render?.triangles ?? null,
        frame: info.render?.frame ?? null,
      };
    }
    try { record.rendererStats.pixelRatio = renderer?.getPixelRatio?.() ?? null; } catch (_) {}
  } catch (_) {}

  try {
    const gs = ms.graphicsSettings ?? null;
    record.graphics = {
      renderResolutionPreset: gs?.getRenderResolutionPreset?.() ?? null,
      performanceProfile: gs?.state?.performanceProfile ?? null,
      devicePixelRatio: (typeof window !== 'undefined') ? (window.devicePixelRatio ?? null) : null,
      viewport: (typeof window !== 'undefined')
        ? { width: window.innerWidth ?? null, height: window.innerHeight ?? null }
        : null,
    };
  } catch (_) {}

  try {
    const perfMem = (typeof performance !== 'undefined') ? performance.memory : null;
    record.memory = {
      usedJSHeapMB: perfMem ? Math.round(perfMem.usedJSHeapSize / 1048576) : null,
      totalJSHeapMB: perfMem ? Math.round(perfMem.totalJSHeapSize / 1048576) : null,
      jsHeapLimitMB: perfMem ? Math.round(perfMem.jsHeapSizeLimit / 1048576) : null,
      deviceMemoryGB: (typeof navigator !== 'undefined') ? (navigator.deviceMemory ?? null) : null,
      hardwareConcurrency: (typeof navigator !== 'undefined') ? (navigator.hardwareConcurrency ?? null) : null,
    };
  } catch (_) {}

  try {
    record.browser = {
      userAgent: (typeof navigator !== 'undefined') ? (navigator.userAgent ?? null) : null,
      foundryVersion: game?.version ?? null,
    };
  } catch (_) {}

  try {
    const history = getCrashHistory();
    const now = Date.now();
    record.crashHistorySummary = {
      totalRecorded: history.length,
      withinLast30Min: history.filter((c) => (now - (c?.atMs ?? 0)) < REPEAT_CRASH_WINDOW_MS).length,
      lastCrashAt: history.length ? (history[history.length - 1]?.at ?? null) : null,
    };
  } catch (_) {}

  try {
    const errs = (typeof window !== 'undefined') ? window.__msaRecentErrors : null;
    if (Array.isArray(errs)) record.recentErrors = errs.slice(-10);
  } catch (_) {}

  try {
    record.populate = buildCompositorPopulateSnapshot();
  } catch (e) {
    record.populate = { error: String(e?.message ?? e) };
  }

  try {
    record.tileStreaming = buildTileStreamingCrashSnapshot({ maxCellsPerGrid: 20 });
  } catch (e) {
    record.tileStreaming = { error: String(e?.message ?? e) };
  }

  try {
    record.textureAudit = _collectTextureAudit(renderer, record.tileStreaming);
  } catch (e) {
    record.textureAudit = { error: String(e?.message ?? e) };
  }

  // Frame-paced GPU work governor + self-adjusting budget telemetry. These show
  // whether work pacing / degradation was active at crash time, and how the
  // software budget compares to the live (physical-ish) renderer texture count.
  try {
    record.governor = getGpuWorkScheduler().getStats();
    record.governor.lod0CooldownMs = Math.round(getGpuWorkScheduler().lod0CooldownRemainingMs());
  } catch (e) {
    record.governor = { error: String(e?.message ?? e) };
  }
  try {
    record.adaptive = getAdaptiveBudgetController().getState();
    const budget = getTextureBudgetTracker();
    record.adaptive.policyBudgetMB = budget.getPolicyBudgetMB?.() ?? null;
    record.adaptive.adaptiveBonusMB = budget.getAdaptiveBonusMB?.() ?? 0;
    record.adaptive.downscaleEngaged = budget.isDownscaleEngaged?.() ?? false;
    record.adaptive.liveRendererTextures = Number(renderer?.info?.memory?.textures) || null;
  } catch (e) {
    record.adaptive = { error: String(e?.message ?? e) };
  }

  // Texture allocation attribution: which code sites created the orphaned GPU
  // textures (confirmed leaks = GC'd without dispose()). This is the definitive
  // pointer to the leak source.
  try {
    record.textureLeakProbe = getTextureLeakProbeReport(10);
  } catch (e) {
    record.textureLeakProbe = { error: String(e?.message ?? e) };
  }

  return record;
}

// ---------------------------------------------------------------------------
// Diagnosis heuristics
// ---------------------------------------------------------------------------

/**
 * Derive human-readable "likely cause" statements from a crash record.
 * @param {object} record
 * @returns {string[]}
 */
export function diagnoseCrash(record) {
  const causes = [];
  try {
    const repeated = (record.crashHistorySummary?.withinLast30Min ?? 0) >= 3;
    const hidden = record.visibility?.hidden === true;
    const loading = record.load?.sceneLoading === true;
    const textures = record.rendererStats?.textures ?? 0;
    const audit = record.textureAudit ?? null;
    const heapUsed = record.memory?.usedJSHeapMB ?? 0;
    const heapLimit = record.memory?.jsHeapLimitMB ?? 0;
    const sceneMegapixels = ((record.scene?.width ?? 0) * (record.scene?.height ?? 0)) / 1e6;
    const dpr = record.graphics?.devicePixelRatio ?? 1;
    const preset = record.graphics?.renderResolutionPreset ?? 'native';
    const stream = record.tileStreaming ?? null;
    const populate = record.populate ?? stream?.populate ?? null;

    if (loading && populate?.populateComplete !== true) {
      causes.push(
        'FloorCompositor bus populate had not finished before the crash '
        + `(coordinator: ${populate?.coordinatorState ?? record.load?.coordinatorState ?? '?'}, `
        + `bus tiles: ${populate?.busTileCount ?? 0}). `
        + 'Tile streaming cannot register until populate runs — this crash blocked the map from loading.',
      );
    } else if (loading && (stream?.manager?.backgroundGridCount ?? 0) === 0 && (record.scene?.width ?? 0) >= 10000) {
      causes.push(
        'Large-scene tile streaming was not registered at crash time — background pyramid mount '
        + 'likely still in flight or populate had not reached the background loader yet.',
      );
    }

    if (stream?.budget?.overBudget) {
      causes.push(
        `Map Shine's software texture budget was over target (${stream.budget.usedPct ?? '?'}% of `
        + `${stream.budget.budgetMB ?? '?'} MB). NOTE: this is Map Shine's internal cap, not your physical `
        + 'GPU VRAM — on a high-VRAM card this rarely means true out-of-memory. The context loss is more '
        + 'likely a GPU work spike (many LOD-0 uploads + mask recompose at once); the work governor now '
        + 'paces these and the budget self-adjusts.',
      );
    } else if (stream?.budget?.usedPct != null && stream.budget.usedPct >= 92) {
      causes.push(
        `Map Shine's software texture budget was near target (${stream.budget.usedPct}% used) — streaming may have been `
        + 'under pressure to load or retain pyramid cells (software cap, not physical VRAM).',
      );
    }

    if (stream?.totals?.inflight > 0 && loading) {
      causes.push(
        `${stream.totals.inflight} tile streaming decode/upload(s) were in flight during the crash `
        + '— concurrent pyramid loads during scene init can spike GPU memory.'
      );
    }

    if (stream?.totals?.residentCells > 24 && loading) {
      causes.push(
        `${stream.totals.residentCells} streamed tile cells were resident in GPU memory at crash time.`
      );
    }

    if (stream?.manager?.regionGridCount > 0 && stream?.manager?.backgroundGridCount > 0) {
      causes.push(
        `Both background (${stream.manager.backgroundGridCount}) and region (${stream.manager.regionGridCount}) `
        + 'streaming grids were active — redundant region grids multiply VRAM use on large maps.'
      );
    }

    if (Array.isArray(stream?.warnings) && stream.warnings.length) {
      causes.push(`Tile streaming warnings at crash: ${stream.warnings.slice(0, 2).join(' ')}`);
    }

    if (repeated) {
      causes.push(
        'Repeated WebGL resets in a short period — this usually points at an unstable GPU driver, '
        + 'GPU overheating, or another application/tab competing for GPU memory. Consider updating '
        + 'your graphics drivers and closing other GPU-heavy tabs or applications.'
      );
    }
    if (hidden && loading) {
      causes.push(
        'The crash happened while the browser tab was hidden/unfocused during loading. Browsers '
        + 'aggressively throttle background tabs and some GPU drivers reset stalled contexts. '
        + 'Keeping the tab focused while a scene loads makes this much less likely.'
      );
    } else if (hidden) {
      causes.push('The browser tab was hidden when the GPU reset — background-tab throttling can contribute to driver resets.');
    }
    if (loading && !hidden) {
      causes.push(
        'The crash happened during scene loading, when texture uploads and shader compilation put '
        + 'the most pressure on the GPU. This is typically GPU memory pressure or a driver watchdog timeout.'
      );
    }
    if (record.module?.versionMismatch === true) {
      causes.push(
        `Foundry is still running module runtime ${record.module.runtimeVersion ?? '?'} while `
        + `files on disk are ${record.module.version ?? '?'}. Hard-refresh (Ctrl+F5) or reload Foundry `
        + 'before testing leak fixes — otherwise streaming/disposal patches may not be active.',
      );
    }

    if (audit?.likelyStreamingLeak) {
      const leakId = audit.primaryLeakId ?? 'streaming_lod_texture_leak';
      causes.push(
        `Texture leak (${leakId}): ${audit.rendererCounter ?? '?'} Three.js textures alive; `
        + `${audit.sceneGraphTextures ?? '?'} in scene graph; `
        + `${audit.budgetEntryCount ?? '?'} budget-tracked; `
        + `${audit.streamCellsWithMap ?? '?'}/${audit.streamResidentCells ?? '?'} streaming cells textured; `
        + `${audit.pyramidCache?.inCacheOnly ?? '?'} pyramid cache-only; `
        + `~${audit.unregisteredAlive ?? audit.gapVsAccounted ?? audit.orphanEstimate ?? '?'} unregistered alive. `
        + (audit.culledWithMap > 0
          ? `${audit.culledWithMap} culled cells still hold maps. `
          : audit.pyramidCache?.alsoOnMesh > 0
            ? `${audit.pyramidCache.alsoOnMesh} pyramid tiles still in RAM cache while mounted on meshes. `
            : 'Likely LOD upgrades or panning left disposed GPU objects alive outside the budget tracker.'),
      );
    } else if (audit?.likelyUntrackedLeak) {
      const leakId = audit.primaryLeakId ?? 'untracked_texture_leak';
      const fx = audit.effects ?? {};
      const fireLine = (fx.fire?.particleSystems ?? 0) > 0
        ? `Fire: ${fx.fire.particleSystems} systems / ${fx.fire.batchCount ?? 0} quarks batches / `
          + `${fx.fire.coalOverlays ?? 0} coal overlays / ${fx.fire.sharedSpriteTextures ?? 0} shared sprites. `
        : 'Fire: inactive. ';
      const candleLine = (fx.candle?.flameInstances ?? 0) > 0
        ? `Candles: ${fx.candle.flameInstances} instances / ${fx.candle.glowBuckets ?? 0} glow buckets. `
        : 'Candles: inactive. ';
      if (leakId === 'probable_historical_stream_leak') {
        causes.push(
          `Accumulated streaming texture leak (${leakId}): ${audit.rendererCounter ?? '?'} Three.js textures alive but `
          + `streaming is clean now (${audit.streamCellsWithMap ?? '?'}/${audit.streamResidentCells ?? '?'} cells, `
          + `pyramid cache ${audit.pyramidCache?.inCacheOnly ?? 0}). `
          + `~${audit.trueOrphanEstimate ?? audit.unregisteredAlive ?? '?'} are referenced nowhere in the scene graph — `
          + 'typical of earlier pan/LOD decode paths that created textures without dispose() (requires hard refresh after fixes). '
          + fireLine + candleLine,
        );
      } else if (leakId === 'lighting_per_floor_snapshot_leak') {
        causes.push(
          'Lighting per-floor snapshot leak: LightingEffectV2._snapshotLightRtForFloor created '
          + `${probe?.topSites?.[0]?.allocated ?? '?'} WebGLRenderTargets without dispose() `
          + '(endStackedLightBuffer cleared the reuse map each frame). Fixed by reusing snapshot RTs across frames.',
        );
      } else if (leakId === 'active_untracked_texture_leak') {
        const probe = audit.textureLeakProbe ?? record.textureLeakProbe ?? null;
        const topSite = probe?.topSites?.[0]?.site ?? null;
        causes.push(
          `Active untracked texture leak: live count climbed from `
          + `${probe?.sessionMinTextures ?? '?'} to ${probe?.lastSampleTextures ?? audit.rendererCounter ?? '?'} `
          + `(streak ${probe?.climbStreak ?? '?'} frames) while streaming stayed clean `
          + `(${audit.streamCellsWithMap ?? '?'}/${audit.streamResidentCells ?? '?'} cells). `
          + `~${audit.unregisteredAlive ?? audit.trueOrphanEstimate ?? '?'} textures are alive but not budget-tracked. `
          + (topSite ? `Top probe site: ${topSite.slice(0, 180)}. ` : '')
          + (probe?.constructorsWrapped === 0 && probe?.glHooksInstalled
            ? 'JS constructor probe missed allocations — see gl.createTexture sites in probe topSites. '
            : '')
          + fireLine + candleLine,
        );
      } else {
        causes.push(
          `Untracked texture inflation (${leakId}): ${audit.rendererCounter ?? '?'} Three.js textures, `
          + `${audit.referencedTextures ?? audit.sceneGraphTextures ?? '?'} referenced in scene/RT scan, `
          + `${audit.budgetEntryCount ?? '?'} budget entries `
          + `(~${audit.trueOrphanEstimate ?? audit.unregisteredAlive ?? '?'} true orphans). `
          + `Mask RTs tracked: ${audit.compositorRtCount ?? '?'}. `
          + fireLine + candleLine
          + (leakId === 'untracked_texture_leak'
            ? 'Fire/Candle share only a handful of sprite textures — this scale (~500+) is not explained by particle effects alone.'
            : ''),
        );
      }
    } else if (audit?.primaryLeakId && audit.primaryLeakId !== 'none' && (audit.gapVsAccounted ?? 0) > 50) {
      causes.push(
        `Texture accounting gap (${audit.primaryLeakId}): ${audit.rendererCounter ?? '?'} GPU textures, `
        + `${audit.sceneGraphTextures ?? '?'} in scanned scene graphs, `
        + `~${audit.gapVsAccounted} not explained by budget + pyramid cache.`,
      );
    } else if (textures > 200 || sceneMegapixels > 64) {
      const sceneTex = audit?.sceneGraphTextures;
      const counterNote = Number.isFinite(sceneTex)
        ? ` (${textures} Three.js counter, ~${sceneTex} in scene graph)`
        : ` (${textures} Three.js counter)`;
      causes.push(
        `This scene is GPU-heavy${counterNote}, ~${sceneMegapixels.toFixed(0)} MP map). `
        + 'GPU memory exhaustion is a likely contributor — a lower render resolution preset helps.',
      );
    }
    if (heapLimit > 0 && heapUsed / heapLimit > 0.85) {
      causes.push(`JavaScript memory is nearly exhausted (${heapUsed} / ${heapLimit} MB) — the browser may be under general memory pressure.`);
    }
    if (preset === 'native' && dpr >= 2) {
      causes.push(
        `You are rendering at native resolution on a high-DPI display (devicePixelRatio ${dpr}). `
        + 'Choosing a lower Render quality preset in Performance & Graphics significantly reduces GPU load.'
      );
    }
    if (!causes.length) {
      causes.push(
        'The browser reset the WebGL context. Common causes: a GPU driver reset/update, the system '
        + 'waking from sleep, too many open WebGL tabs, or transient GPU memory pressure.'
      );
    }
  } catch (_) {
    if (!causes.length) causes.push('The browser reset the WebGL context (no further details available).');
  }
  return causes;
}

// ---------------------------------------------------------------------------
// Safe-mode resolution lifecycle
// ---------------------------------------------------------------------------

/**
 * Compare two resolution presets; returns true when `a` is already at or below `b`.
 * 'native' is treated as the highest resolution.
 */
function _presetAtOrBelow(a, b) {
  const area = (p) => {
    if (!p || p === 'native') return Number.POSITIVE_INFINITY;
    const m = String(p).match(/^(\d+)x(\d+)$/i);
    if (!m) return Number.POSITIVE_INFINITY;
    return Number(m[1]) * Number(m[2]);
  };
  return area(a) <= area(b);
}

/**
 * Drop render resolution to the safe-mode preset and remember how to undo it.
 * Works through the live GraphicsSettingsManager when available, otherwise by
 * rewriting the persisted overrides JSON directly.
 *
 * @param {{ graphicsSettings?: any }} ctx
 * @returns {boolean} True when a downgrade was actually applied.
 */
function _applySafeModeDowngrade(ctx) {
  try {
    const gs = ctx?.graphicsSettings ?? null;
    const storageKey = gs?._storageKey ?? _buildGraphicsStorageKey();
    const currentPreset = gs?.getRenderResolutionPreset?.()
      ?? _readJson(storageKey)?.renderResolutionPreset
      ?? 'native';

    // Already at/below the safety floor (possibly user-chosen): leave it alone.
    if (_presetAtOrBelow(currentPreset, SAFE_MODE_PRESET)) return false;

    if (gs && typeof gs.setRenderResolutionPreset === 'function') {
      gs.setRenderResolutionPreset(SAFE_MODE_PRESET);
      gs.saveState?.();
    } else {
      const stored = _readJson(storageKey) ?? {};
      stored.renderResolutionPreset = SAFE_MODE_PRESET;
      _writeJson(storageKey, stored);
    }

    _writeJson(SAFE_MODE_KEY, {
      active: true,
      previousPreset: currentPreset,
      storageKey,
      at: Date.now(),
      sessionId: SESSION_ID,
    });
    log.warn(`Safe mode: render resolution reduced to ${SAFE_MODE_PRESET} (was ${currentPreset})`);
    return true;
  } catch (e) {
    log.warn('Safe mode downgrade failed', e);
    return false;
  }
}

/**
 * @param {number} [nowMs]
 * @returns {number}
 */
function _countRecentCrashes(nowMs = Date.now()) {
  return getCrashHistory()
    .filter((c) => (nowMs - (c?.atMs ?? 0)) < REPEAT_CRASH_WINDOW_MS)
    .length;
}

/**
 * Previously re-applied safe mode on every load after any recent crash.
 * Safe mode is now one-shot per context loss; restore happens on the next load
 * via maybeRestoreResolutionBeforeLoad().
 *
 * @param {{ id?: string|null }|null} [scene]
 * @returns {boolean}
 */
export function ensureConservativeGraphicsForLoad(scene = null) {
  void scene;
  return false;
}

/**
 * Called at the start of every scene load (before graphics settings are read).
 *
 * If a previous session crashed and auto-downgraded the resolution, restore the
 * original preset so the user gets full quality back without manual action —
 * unless any WebGL crash is still fresh, in which case safe mode stays and the
 * user is told why (after the load succeeds).
 */
export function maybeRestoreResolutionBeforeLoad() {
  try {
    const marker = _readJson(SAFE_MODE_KEY);
    if (!marker?.active) return;

    const previousPreset = marker.previousPreset || 'native';
    const stored = _readJson(marker.storageKey);
    if (stored && typeof stored === 'object') {
      stored.renderResolutionPreset = previousPreset;
      _writeJson(marker.storageKey, stored);
    }
    _removeKey(SAFE_MODE_KEY);

    const activeKey = window.MapShine?.graphicsSettings?._storageKey ?? _buildGraphicsStorageKey();
    if (marker.storageKey === activeKey) {
      _pendingLoadNotice = { type: 'restored', preset: previousPreset };
    }
    log.info(`Safe mode cleared: render resolution restored to "${previousPreset}"`);
  } catch (e) {
    log.warn('maybeRestoreResolutionBeforeLoad failed', e);
  }
}

/**
 * Called after a scene load completes successfully. Surfaces any pending
 * safe-mode messaging so the user understands why the scene looks the way it does.
 */
export function onLoadSucceeded() {
  try {
    const notice = _pendingLoadNotice;
    _pendingLoadNotice = null;
    if (!notice) return;
    if (notice.type === 'restored') {
      const label = (notice.preset && notice.preset !== 'native') ? notice.preset : 'full';
      globalThis.ui?.notifications?.info?.(
        `Map Shine: Render resolution restored to ${label} after the previous WebGL crash recovery.`
      );
    } else if (notice.type === 'staying-reduced') {
      globalThis.ui?.notifications?.warn?.(
        'Map Shine: Running at reduced render resolution because WebGL crashed repeatedly on this device. '
        + 'You can raise it under Performance & Graphics → Render quality.'
      );
    }
  } catch (_) {
  }
}

// ---------------------------------------------------------------------------
// Context loss / restore handling
// ---------------------------------------------------------------------------

/**
 * Wire the recovery callbacks. Called once from canvas-replacement.
 * @param {{ requestRebuild?: (reason: string) => Promise<boolean> }} options
 */
export function configure(options = {}) {
  if (typeof options.requestRebuild === 'function') {
    _requestRebuild = options.requestRebuild;
  }
}

/**
 * Handle a WebGL context loss on the main Three.js canvas.
 *
 * @param {{ renderer?: any, graphicsSettings?: any, loadingOverlay?: any, phase?: string|null }} ctx
 */
export function onContextLost(ctx = {}) {
  const epoch = ++_lossEpoch;

  const record = collectDiagnostics({
    renderer: ctx.renderer,
    phase: ctx.phase ?? null,
    trigger: 'webglcontextlost',
  });
  record.restored = false;
  record.restoredAfterMs = null;
  record.safeModeDowngradeApplied = false;
  _lastCrashRecord = record;

  // Staged crash-adaptive degradation: throttle the GPU work governor, forbid
  // LOD-0 uploads for a cooldown, and surrender any adaptive budget headroom.
  // Escalates on each crash and relaxes gradually once the session is stable
  // (handled by AdaptiveBudgetController.sample()).
  try { getAdaptiveBudgetController().noteCrash(); } catch (_) {}

  // One-shot per session: drop render resolution so a reload doesn't
  // immediately hit the same GPU wall.
  if (!_safeModeAppliedThisSession) {
    _safeModeAppliedThisSession = true;
    record.safeModeDowngradeApplied = _applySafeModeDowngrade(ctx);
  }
  _appendHistory(record);

  // Full report in the console for bug reports even if the dialog is dismissed.
  try {
    console.warn('Map Shine: WebGL context lost — diagnostic snapshot:', record);
  } catch (_) {}

  // User-facing messaging (accurate: we reduce resolution, not effects).
  try {
    const msg = record.safeModeDowngradeApplied
      ? 'Map Shine: WebGL crash detected — render resolution temporarily reduced. Full resolution returns automatically on the next load.'
      : 'Map Shine: WebGL crash detected — attempting to recover.';
    globalThis.ui?.notifications?.warn?.(msg);
    if (record.load?.sceneLoading) {
      ctx.loadingOverlay?.setStage?.('final', 1.0, 'WebGL reset detected — recovering...', { immediate: true });
      ctx.loadingOverlay?.fadeIn?.(300)?.catch?.(() => {});
    }
  } catch (_) {}

  _armRestoreWatchdog(epoch);

  if (!_dialogShownThisSession) {
    _dialogShownThisSession = true;
    setTimeout(() => {
      try {
        showCrashDialog(_lastCrashRecord);
      } catch (e) {
        log.warn('Failed to show crash dialog', e);
      }
    }, CRASH_DIALOG_DELAY_MS);
  }
}

/**
 * Handle webglcontextrestored: cancel the rebuild watchdog and update the record.
 */
export function onContextRestored() {
  try {
    if (_restoreWatchdogId != null) {
      clearTimeout(_restoreWatchdogId);
      _restoreWatchdogId = null;
    }
    const record = _lastCrashRecord;
    if (record && record.restored !== true) {
      record.restored = true;
      record.restoredAfterMs = Math.max(0, Date.now() - record.atMs);
      _updateLastHistoryEntry(record);
      log.info(`WebGL context restored after ${record.restoredAfterMs}ms`);
    }
  } catch (_) {
  }
}

/**
 * If the context never restores, rebuild the whole Three.js stack once
 * (fresh canvas → fresh WebGL context). A second unrecovered loss in the same
 * session escalates to "please refresh" guidance instead of looping rebuilds.
 * @param {number} epoch
 */
function _armRestoreWatchdog(epoch) {
  try {
    if (_restoreWatchdogId != null) clearTimeout(_restoreWatchdogId);
  } catch (_) {}

  const check = async () => {
    _restoreWatchdogId = null;
    // A newer loss event or a successful restore supersedes this watchdog.
    if (epoch !== _lossEpoch) return;
    if (_lastCrashRecord?.restored === true) return;

    // Mid-load rebuilds would race the in-flight createThreeCanvas; defer.
    if (window.MapShine?.__msaSceneLoading === true) {
      _restoreWatchdogId = setTimeout(check, 10000);
      return;
    }

    if (_autoRebuildAttempted || typeof _requestRebuild !== 'function') {
      try {
        globalThis.ui?.notifications?.error?.(
          'Map Shine: WebGL could not be recovered automatically. Please refresh the browser (F5).'
        );
      } catch (_) {}
      return;
    }

    _autoRebuildAttempted = true;
    log.warn('WebGL context not restored by the browser — attempting automatic scene rebuild');
    try {
      globalThis.ui?.notifications?.warn?.('Map Shine: WebGL did not recover on its own — rebuilding the scene...');
    } catch (_) {}

    let ok = false;
    try {
      ok = await _requestRebuild('context-restore-timeout');
    } catch (e) {
      log.error('Automatic rebuild after context loss failed', e);
    }
    if (!ok) {
      try {
        globalThis.ui?.notifications?.error?.(
          'Map Shine: Automatic recovery failed. Please refresh the browser (F5).'
        );
      } catch (_) {}
    }
  };

  _restoreWatchdogId = setTimeout(check, RESTORE_WATCHDOG_MS);
}

// ---------------------------------------------------------------------------
// Crash dialog
// ---------------------------------------------------------------------------

function _escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Full diagnostic report (crash record + history + safe-mode marker) as JSON.
 * @param {object} [record]
 * @returns {string}
 */
export function buildReportText(record = _lastCrashRecord) {
  const report = {
    generatedAt: new Date().toISOString(),
    crash: record ?? null,
    diagnosis: record ? diagnoseCrash(record) : [],
    safeMode: _readJson(SAFE_MODE_KEY),
    crashHistory: getCrashHistory(),
  };
  return JSON.stringify(report, null, 2);
}

async function _copyReportToClipboard(record) {
  const text = buildReportText(record);
  try {
    await navigator.clipboard.writeText(text);
    globalThis.ui?.notifications?.info?.('Map Shine: Diagnostic report copied to clipboard.');
    return;
  } catch (_) {
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
    globalThis.ui?.notifications?.info?.('Map Shine: Diagnostic report copied to clipboard.');
  } catch (_) {
    try {
      console.log('Map Shine diagnostic report:\n', text);
      globalThis.ui?.notifications?.warn?.('Map Shine: Clipboard unavailable — report logged to the console instead.');
    } catch (__) {}
  }
}

/**
 * @param {object} record
 * @returns {string}
 */
function _formatTextureAuditLine(record) {
  const counter = record.rendererStats?.textures;
  const audit = record.textureAudit ?? null;
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
    parts.push(audit.primaryLeakId);
  }
  return parts.join(', ');
}

/**
 * @param {object|null|undefined} stream
 * @returns {string|null}
 */
function _streamingDialogSummary(stream) {
  if (!stream) return null;
  if (stream.error) return `unavailable (${stream.error})`;
  const vram = stream.budget
    ? `${stream.budget.usedMB ?? '?'} / ${stream.budget.budgetMB ?? '?'} MB software budget (${stream.budget.usedPct ?? '?'}%)`
    : 'n/a';
  const grids = `${stream.manager?.backgroundGridCount ?? 0} bg, ${stream.manager?.regionGridCount ?? 0} region`;
  const cells = stream.totals
    ? `${stream.totals.residentCells ?? 0} resident, ${stream.totals.inflight ?? 0} inflight`
    : 'n/a';
  const view = stream.view?.visibleCellsInFrustum ?? '?';
  return `${vram}; ${grids}; ${cells}; ${view} textured in view`;
}

function _buildDialogContent(record) {
  const causes = diagnoseCrash(record);
  const restored = record.restored === true;
  const statusLine = restored
    ? `The graphics context recovered automatically${typeof record.restoredAfterMs === 'number' ? ` after ${(record.restoredAfterMs / 1000).toFixed(1)}s` : ''}.`
    : 'The graphics context has not recovered yet — Map Shine will rebuild the scene automatically if it does not come back.';
  const safeModeLine = record.safeModeDowngradeApplied
    ? `Render resolution was temporarily reduced to ${SAFE_MODE_PRESET} to stabilize this session. `
      + 'Full resolution is restored automatically on your next load (or now via Performance &amp; Graphics → Render quality).'
    : null;

  const detailRows = [
    ['Scene', record.scene?.name ?? 'unknown'],
    ['During', record.load?.sceneLoading ? `scene loading (step: ${record.load?.phase ?? 'unknown'})` : 'normal play'],
    ['Tab visible', record.visibility?.hidden === true ? 'No (background tab)' : 'Yes'],
    ['GPU', record.gpu?.renderer ?? 'unknown'],
    ['GPU textures', _formatTextureAuditLine(record)],
    ['JS heap', (record.memory?.usedJSHeapMB != null && record.memory?.jsHeapLimitMB != null)
      ? `${record.memory.usedJSHeapMB} / ${record.memory.jsHeapLimitMB} MB`
      : 'n/a'],
    ['Recent crashes (30 min)', record.crashHistorySummary?.withinLast30Min ?? 0],
  ];

  const streamSummary = _streamingDialogSummary(record.tileStreaming);
  if (streamSummary) {
    detailRows.push(['Tile streaming', streamSummary]);
  }

  const populate = record.populate ?? record.tileStreaming?.populate ?? null;
  if (populate && !populate.error) {
    detailRows.push([
      'Compositor populate',
      populate.populateComplete
        ? `complete (${populate.busTileCount ?? 0} bus tiles)`
        : `in flight=${populate.populateInFlight === true}, bus tiles=${populate.busTileCount ?? 0}, bg jobs=${populate.pendingBackgroundJobs ?? 0}`,
    ]);
  }

  const gov = record.governor;
  const adaptive = record.adaptive;
  if (adaptive && !adaptive.error) {
    const live = adaptive.liveRendererTextures != null ? `${adaptive.liveRendererTextures} live textures` : null;
    const bonus = adaptive.adaptiveBonusMB ? `+${adaptive.adaptiveBonusMB} MB bonus` : 'no bonus';
    const parts = [
      `degradation L${adaptive.degradationLevel ?? 0}`,
      `policy ${adaptive.policyBudgetMB ?? '?'} MB ${bonus}`,
      adaptive.downscaleEngaged ? 'downscale ON' : 'downscale off',
    ];
    if (live) parts.push(live);
    if (adaptive.growthAlert) parts.push('growth alert');
    detailRows.push(['Memory governor', parts.join('; ')]);
  }
  if (gov && !gov.error) {
    const throttle = `throttle L${gov.throttleLevel ?? 0}`;
    const work = `${gov.committedLastFrame ?? 0} committed / ${gov.deferredLastFrame ?? 0} deferred (last frame)`;
    const cooldown = gov.lod0CooldownMs > 0 ? `, LOD-0 cooldown ${Math.round(gov.lod0CooldownMs / 1000)}s` : '';
    detailRows.push(['GPU work pacing', `${throttle}; ${work}${cooldown}`]);
  }

  const streamWarnings = record.tileStreaming?.warnings;
  if (Array.isArray(streamWarnings) && streamWarnings.length) {
    detailRows.push(['Streaming warnings', streamWarnings.slice(0, 3).join(' · ')]);
  }

  return `
    <div class="msa-webgl-crash-dialog">
      <p><strong>The browser reset the WebGL graphics context while Map Shine was running.</strong></p>
      <p>${_escapeHtml(statusLine)}</p>
      ${safeModeLine ? `<p>${safeModeLine}</p>` : ''}
      <p><strong>Most likely cause${causes.length > 1 ? 's' : ''}:</strong></p>
      <ul>
        ${causes.map((c) => `<li>${_escapeHtml(c)}</li>`).join('')}
      </ul>
      <details>
        <summary>System state at crash time</summary>
        <table style="width:100%; font-size: 0.9em;">
          ${detailRows.map(([k, v]) => `<tr><td style="opacity:0.75; white-space:nowrap; padding-right:8px;">${_escapeHtml(k)}</td><td>${_escapeHtml(v)}</td></tr>`).join('')}
        </table>
      </details>
      <p style="margin-top:6px;">Use <em>Copy Report</em> to grab a full diagnostic snapshot for a bug report
      (<a href="https://github.com/Garsondee/map-shine-advanced/issues" target="_blank" rel="noopener noreferrer">GitHub Issues</a>).</p>
    </div>
  `;
}

/**
 * Show the crash dialog for a crash record (defaults to the most recent crash).
 * @param {object} [record]
 */
export function showCrashDialog(record = _lastCrashRecord) {
  if (!record) {
    try {
      globalThis.ui?.notifications?.info?.('Map Shine: No WebGL crash has been recorded this session.');
    } catch (_) {}
    return;
  }

  const content = _buildDialogContent(record);
  const title = 'Map Shine — WebGL Crash Detected';

  const onRebuild = () => {
    if (typeof _requestRebuild !== 'function') return;
    Promise.resolve()
      .then(() => _requestRebuild('user-dialog'))
      .catch((e) => log.error('Manual rebuild from crash dialog failed', e));
  };

  const DialogV2 = globalThis.DialogV2 ?? globalThis.foundry?.applications?.api?.DialogV2;
  if (typeof DialogV2?.wait === 'function') {
    DialogV2.wait({
      window: { title, icon: 'fa-solid fa-triangle-exclamation' },
      content,
      buttons: [
        { action: 'copy', label: 'Copy Report', icon: 'fa-solid fa-copy', callback: () => 'copy' },
        { action: 'rebuild', label: 'Rebuild Scene', icon: 'fa-solid fa-rotate', callback: () => 'rebuild' },
        { action: 'close', label: 'Close', icon: 'fa-solid fa-check', default: true, callback: () => 'close' },
      ],
      rejectClose: false,
    }).then((action) => {
      if (action === 'copy') void _copyReportToClipboard(record);
      else if (action === 'rebuild') onRebuild();
    }).catch(() => {});
    return;
  }

  new Dialog({
    title,
    content,
    buttons: {
      copy: {
        icon: '<i class="fas fa-copy"></i>',
        label: 'Copy Report',
        callback: () => void _copyReportToClipboard(record),
      },
      rebuild: {
        icon: '<i class="fas fa-sync"></i>',
        label: 'Rebuild Scene',
        callback: () => onRebuild(),
      },
      close: {
        icon: '<i class="fas fa-check"></i>',
        label: 'Close',
      },
    },
    default: 'close',
  }).render(true);
}

/** Convenience: show the dialog for the most recent crash (console / UI hook). */
export function showLastCrashDialog() {
  showCrashDialog(_lastCrashRecord);
}

/** @returns {object|null} */
export function getLastCrashRecord() {
  return _lastCrashRecord;
}

export const webglCrashRecovery = {
  configure,
  onContextLost,
  onContextRestored,
  maybeRestoreResolutionBeforeLoad,
  ensureConservativeGraphicsForLoad,
  onLoadSucceeded,
  collectDiagnostics,
  diagnoseCrash,
  buildReportText,
  showCrashDialog,
  showLastCrashDialog,
  getCrashHistory,
  getLastCrashRecord,
};
