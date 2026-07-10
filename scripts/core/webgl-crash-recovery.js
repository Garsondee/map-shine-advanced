/**
 * @fileoverview WebGL crash detection, diagnosis and self-recovery.
 *
 * Responsibilities:
 * - Record every WebGL context loss with a full system-state snapshot
 *   (GPU, renderer stats, memory, scene, load phase, tab visibility).
 * - Show a crash dialog that explains what happened, lists the most likely
 *   causes and lets the user copy a diagnostic report or rebuild the scene.
 * - Apply a one-shot "safe mode" downgrade (render resolution + GPU VRAM preset)
 *   when a crash happens, then restore the previous values only after a load
 *   completes successfully. Failed loads no longer bounce back to native resolution.
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
import { getAdaptiveBudgetController } from '../streaming/adaptive-budget-controller.js';
import { getGpuWorkScheduler } from '../streaming/gpu-work-scheduler.js';
import { getTextureLeakProbeReport } from './texture-leak-probe.js';
import { collectTextureAudit, formatTextureAuditLine } from './texture-diagnostics.js';
import {
  getClientGpuVramPreset,
  getGraphicsMemoryPresets,
  resolveEffectiveGpuVramGB,
} from '../streaming/memory-settings.js';
import { shouldUseLoadSlimCompositorInit } from '../compositor-v2/load-slim-compositor.js';
import { getProbedGpuInfo } from './gpu-probe.js';
import {
  getGpuLoadPressure,
  estimateDrawingBufferMP,
  estimateCompositorRtVramMB,
  estimateRtMbPerDrawingBufferMp,
  resolveCompositorRtBudgetMB,
  resolveMaxDrawingBufferMp,
} from '../streaming/texture-budget-policy.js';

const log = createLogger('WebGLCrashRecovery');

/** Must match module.json — Foundry's game.modules version can lag until a hard refresh. */
const MODULE_MANIFEST_VERSION = '0.5.3.10';

const HISTORY_KEY = 'map-shine-advanced.webglCrashLog';
const SAFE_MODE_KEY = 'map-shine-advanced.webglSafeMode';
const SAFE_MODE_PRESET = '1280x720';
const SAFE_MODE_PRESET_FLOOR = '800x450';
const HISTORY_MAX = 20;
/** Crashes within this window count toward "repeated" crash messaging only. */
const REPEAT_CRASH_WINDOW_MS = 30 * 60 * 1000;
/** Repeated-crash notice threshold (does not block auto-restore on next load). */
const REPEAT_CRASH_THRESHOLD = 3;
/** How long to wait for webglcontextrestored before forcing a rebuild. */
const RESTORE_WATCHDOG_MS = 12000;
/** Delay before the crash dialog appears (lets the restore race settle first). */
const CRASH_DIALOG_DELAY_MS = 1500;
/** Recent load-crash count on a scene before we shed all effects ("bare mode"). */
const BARE_MODE_CRASH_THRESHOLD = 4;
/** Recent load-crash count before bypassing Map Shine entirely (Native Foundry PIXI). */
const NATIVE_FALLBACK_CRASH_THRESHOLD = 7;
/** localStorage: GPU renderer strings that have shown repeated load instability. */
const KNOWN_WEAK_GPU_KEY = 'map-shine-advanced.knownWeakGpus';
/** Foundry client setting key that bypasses Map Shine's Three.js renderer. */
const NATIVE_FOUNDRY_RENDERING_SETTING = 'useNativeFoundryRendering';
const MODULE_ID = 'map-shine-advanced';

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
/** @type {{ type: 'restored'|'staying-reduced'|'bare-mode'|'native-fallback', preset?: string }|null} */
let _pendingLoadNotice = null;
let _nativeFallbackTriggered = false;

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
function _buildGraphicsStorageKey(scene = null) {
  try {
    const sceneId = scene?.id ?? canvas?.scene?.id ?? 'no-scene';
    const userId = game?.user?.id || 'no-user';
    return `map-shine-advanced.graphicsOverrides.${sceneId}.${userId}`;
  } catch (_) {
    return 'map-shine-advanced.graphicsOverrides';
  }
}

/** @param {string} sceneId @returns {string} */
function _storageKeyForScene(sceneId) {
  const userId = game?.user?.id || 'no-user';
  return `map-shine-advanced.graphicsOverrides.${sceneId || 'no-scene'}.${userId}`;
}

// ---------------------------------------------------------------------------
// Known-weak GPU hint (persists across scenes so a demonstrably unstable card
// starts conservative even on scenes that have not crashed yet)
// ---------------------------------------------------------------------------

/** @returns {string|null} A short, stable key for the current GPU. */
function _currentGpuKey() {
  try {
    const r = window.MapShine?.gpuProbe?.renderer ?? null;
    return r ? String(r).slice(0, 120) : null;
  } catch (_) {
    return null;
  }
}

/** @returns {object|null} Guarded snapshot of the probed GPU for the crash report. */
function _safeGpuProbeSnapshot() {
  try {
    const p = getProbedGpuInfo();
    if (!p) return null;
    return {
      renderer: p.renderer ?? null,
      vendor: p.vendor ?? null,
      estimatedVramGB: p.estimatedVramGB ?? null,
      confident: p.confident === true,
      source: p.source ?? null,
    };
  } catch (_) {
    return null;
  }
}

/** @returns {object|null} Guarded snapshot of the effective GPU load pressure. */
function _safeGpuLoadPressure() {
  try {
    return getGpuLoadPressure();
  } catch (_) {
    return null;
  }
}

/**
 * Guarded snapshot of the estimated compositor render-target VRAM vs its budget.
 * This is the memory that scales with render resolution and is not tracked by the
 * texture budget — the true cause of `webglcontextlost` at high resolution.
 * @returns {object|null}
 */
function _safeRtVramEstimate() {
  try {
    const drawingBufferMp = estimateDrawingBufferMP();
    const perMp = estimateRtMbPerDrawingBufferMp();
    const estMB = estimateCompositorRtVramMB(drawingBufferMp);
    const budgetMB = resolveCompositorRtBudgetMB(resolveEffectiveGpuVramGB());
    const maxMp = resolveMaxDrawingBufferMp();
    return {
      drawingBufferMp: Number(drawingBufferMp.toFixed(2)),
      mbPerMp: Math.round(perMp),
      estMB: Math.round(estMB),
      budgetMB: Number.isFinite(budgetMB) ? Math.round(budgetMB) : null,
      maxDrawingBufferMp: Number.isFinite(maxMp) ? Number(maxMp.toFixed(2)) : null,
      overBudget: Number.isFinite(budgetMB) ? estMB > budgetMB : false,
    };
  } catch (_) {
    return null;
  }
}

/**
 * Guarded snapshot of Foundry/PIXI-side GPU texture memory.
 *
 * MSA's budgets and probes only see the Three.js side. Foundry's own PIXI
 * renderer holds full-resolution source images (scene background, tiles) in
 * the SAME GPU memory — a 12000x12000 background alone is ~576 MB — and this
 * was a complete blind spot in crash reports: a 2026-07-09 Mansion crash
 * showed only 9 Three.js textures / 0.8 MB tracked while the context was
 * still lost. This section makes the PIXI half visible so "MSA-side is tiny
 * but we crashed anyway" runs can be attributed correctly.
 *
 * @returns {object|null}
 */
function _safePixiTextureStats() {
  try {
    const pixiRenderer = globalThis.canvas?.app?.renderer ?? null;
    const managed = pixiRenderer?.texture?.managedTextures;
    if (!Array.isArray(managed)) return null;
    let totalBytes = 0;
    let counted = 0;
    const entries = [];
    for (const bt of managed) {
      const w = Number(bt?.realWidth ?? bt?.width) || 0;
      const h = Number(bt?.realHeight ?? bt?.height) || 0;
      if (!(w > 0 && h > 0)) continue;
      // RGBA8 estimate; +33% when mipmaps are enabled.
      let bytes = w * h * 4;
      if (bt?.mipmap != null && Number(bt.mipmap) > 0) bytes = Math.round(bytes * 1.33);
      totalBytes += bytes;
      counted++;
      entries.push({
        mb: Math.round(bytes / 1048576),
        w,
        h,
        src: typeof bt?.resource?.src === 'string' ? bt.resource.src.slice(-96) : null,
      });
    }
    entries.sort((a, b) => b.mb - a.mb);
    return {
      managedCount: managed.length,
      sizedCount: counted,
      estTotalMB: Math.round(totalBytes / 1048576),
      top: entries.slice(0, 10),
    };
  } catch (_) {
    return null;
  }
}

/** @returns {boolean} True when this GPU has previously shown repeated load instability. */
function _isGpuKnownWeak() {
  const key = _currentGpuKey();
  if (!key) return false;
  const map = _readJson(KNOWN_WEAK_GPU_KEY);
  return !!(map && map[key]);
}

/** Record the current GPU as known-weak so future loads start conservative. */
function _markGpuKnownWeak() {
  const key = _currentGpuKey();
  if (!key) return;
  const map = _readJson(KNOWN_WEAK_GPU_KEY) ?? {};
  if (!map[key]) {
    map[key] = { at: Date.now() };
    _writeJson(KNOWN_WEAK_GPU_KEY, map);
    log.warn(`GPU "${key}" marked known-weak — future scene loads will start conservative`);
  }
}

/**
 * Terminal fallback: after repeated unrecoverable load crashes even in bare
 * mode, bypass Map Shine's Three.js renderer entirely and use Foundry's native
 * PIXI canvas. Guarantees the user can see and use the map. Requires a reload.
 */
async function _enableNativeFoundryRenderingFallback() {
  if (_nativeFallbackTriggered) return;
  _nativeFallbackTriggered = true;
  try {
    const already = globalThis.game?.settings?.get?.(MODULE_ID, NATIVE_FOUNDRY_RENDERING_SETTING) === true;
    if (already) return;
    await globalThis.game?.settings?.set?.(MODULE_ID, NATIVE_FOUNDRY_RENDERING_SETTING, true);
    _markGpuKnownWeak();
    globalThis.ui?.notifications?.error?.(
      'Map Shine: repeated WebGL crashes on this scene — switched this browser to '
      + 'Native Foundry Rendering (no Map Shine effects) so the map remains usable. '
      + 'Reload the page to apply. Re-enable Map Shine in Configure Settings once your '
      + 'GPU driver / VRAM situation is resolved.',
      { permanent: true },
    );
    log.warn('Native Foundry Rendering fallback enabled after repeated load crashes');
  } catch (e) {
    log.warn('Failed to enable Native Foundry Rendering fallback', e);
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
    pixiTexCount: record.pixiTextures?.managedCount ?? null,
    pixiTexMB: record.pixiTextures?.estTotalMB ?? null,
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
    // The loaded module version (from Foundry) is authoritative. The on-disk
    // manifest constant is hand-maintained and intentionally lags, so comparing
    // against it produced false "module outdated" noise — do not flag a mismatch.
    const runtimeVersion = game?.modules?.get?.('map-shine-advanced')?.version ?? null;
    record.module.runtimeVersion = runtimeVersion;
    if (runtimeVersion) record.module.version = runtimeVersion;
    record.module.versionMismatch = false;
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
      // Ground-truth floor/Levels count. Distinct from `tiles` (scene.tiles.size,
      // includes wall art / map points / decorations) and from
      // `populate.busTileCount` (FloorRenderBus mesh count, NOT floors) — do not
      // use either of those as a floor count in diagnosis text. See
      // Docs/planning/Forward+.md §1.1 for why "N floors" claims here were
      // previously conflated with tile/mesh counts and produced misleading
      // multifloor diagnoses.
      let levelsCount = null;
      let visibleFloorsCount = null;
      try {
        const floorStack = window.MapShine?.floorStack ?? null;
        levelsCount = Array.isArray(floorStack?.getFloors?.()) ? floorStack.getFloors().length : null;
        visibleFloorsCount = Array.isArray(floorStack?.getVisibleFloors?.())
          ? floorStack.getVisibleFloors().length
          : null;
      } catch (_) {}
      record.scene = {
        id: scene.id ?? null,
        name: scene.name ?? null,
        width: scene.width ?? null,
        height: scene.height ?? null,
        tiles: scene.tiles?.size ?? null,
        tokens: scene.tokens?.size ?? null,
        lights: scene.lights?.size ?? null,
        walls: scene.walls?.size ?? null,
        levelsCount,
        visibleFloorsCount,
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

  // Foundry/PIXI-side texture memory — shares the GPU with the Three renderer
  // but is invisible to every MSA budget/probe (see _safePixiTextureStats).
  try {
    record.pixiTextures = _safePixiTextureStats();
  } catch (_) {
    record.pixiTextures = null;
  }

  try {
    const gs = ms.graphicsSettings ?? null;
    record.graphics = {
      renderResolutionPreset: gs?.getRenderResolutionPreset?.() ?? null,
      performanceProfile: gs?.state?.performanceProfile ?? null,
      devicePixelRatio: (typeof window !== 'undefined') ? (window.devicePixelRatio ?? null) : null,
      viewport: (typeof window !== 'undefined')
        ? { width: window.innerWidth ?? null, height: window.innerHeight ?? null }
        : null,
      gpuVramPreset: getGraphicsMemoryPresets().gpuVramPreset ?? null,
      clientGpuVramPreset: getClientGpuVramPreset() ?? null,
      effectiveGpuVramGB: resolveEffectiveGpuVramGB(),
      // Actual GPU (renderer string) + estimated dedicated VRAM. This is the
      // signal the corrected auto budget uses instead of inferring from RAM.
      gpuProbe: _safeGpuProbeSnapshot(),
      gpuLoadPressure: _safeGpuLoadPressure(),
      globalDisableAll: gs?.state?.globalDisableAll === true,
      knownWeakGpu: _isGpuKnownWeak(),
      drawingBuffer: {
        width: renderer?.domElement?.width ?? null,
        height: renderer?.domElement?.height ?? null,
      },
      outdoorsMaskBakeEstimate: _estimateOutdoorsMaskBakeSize(),
      // True total-VRAM accounting: the compositor render-target stack is the
      // dominant *uncounted* consumer (the texture budget only tracks masks/tiles).
      // These fields make the real budget adherence visible in the report.
      rtVramEstimate: _safeRtVramEstimate(),
      loadSlimCompositorActive: ms.__msaLoadSlimCompositor === true
        || ms.floorCompositorV2?._loadSlimInitActive === true,
      loadSlimPolicyWouldApply: shouldUseLoadSlimCompositorInit(),
      loadSlimDeferredCount: Array.isArray(ms.floorCompositorV2?._loadSlimDeferredSteps)
        ? ms.floorCompositorV2._loadSlimDeferredSteps.length
        : null,
      loadSlimPendingEffects: ms.floorCompositorV2?._loadSlimPendingEffects?.size ?? null,
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
    const shaderErrs = globalThis.__msaRecentShaderErrors;
    if (Array.isArray(shaderErrs)) record.shaderErrors = shaderErrs.slice(-8);
  } catch (_) {}

  // What loaded, at what size, and when — correlate loadMs against the crash
  // time and longTasks to attribute deterministic load-phase context losses.
  try {
    const loads = globalThis.__msaRecentTextureLoads;
    if (Array.isArray(loads)) record.recentTextureLoads = loads.slice(-16);
  } catch (_) {}
  try {
    const lt = globalThis.__msaLongTasks;
    if (Array.isArray(lt)) record.longTasks = lt.slice(-24);
  } catch (_) {}
  try {
    const ops = globalThis.__msaBigCanvasOps;
    if (Array.isArray(ops)) record.bigCanvasOps = ops.slice(-12);
  } catch (_) {}
  try {
    const gl = globalThis.__msaSlowGlOps;
    if (Array.isArray(gl)) record.slowGlOps = gl.slice(-16);
  } catch (_) {}
  try {
    const secs = globalThis.__msaSlowSections;
    if (Array.isArray(secs)) record.slowSections = secs.slice(-16);
  } catch (_) {}
  try {
    const trail = globalThis.__msaSectionTrail;
    if (Array.isArray(trail)) record.sectionTrail = trail.slice(-48);
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
    record.textureAudit = collectTextureAudit(renderer, record.tileStreaming);
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

    // Primary modern cause: compositor render-target VRAM (scales with render
    // resolution, NOT counted by the texture budget). Surface it first.
    const rt = record.graphics?.rtVramEstimate ?? null;
    if (rt && rt.estMB > 0) {
      const budgetTxt = rt.budgetMB != null ? `${rt.budgetMB} MB budget` : 'uncapped';
      if (rt.overBudget) {
        causes.push(
          `Compositor render targets are estimated at ~${rt.estMB} MB at the current render `
          + `resolution (${rt.drawingBufferMp} MP drawing buffer × ~${rt.mbPerMp} MB/MP), which EXCEEDS the `
          + `${budgetTxt} for this GPU. These full-screen targets (lighting, bloom, overhead, shadows, `
          + `per-floor buffers) are NOT part of the texture budget and are the dominant VRAM consumer at `
          + `high resolution — the render resolution is now auto-capped to ~${rt.maxDrawingBufferMp} MP so they fit. `
          + `Lower the Render Resolution preset for extra headroom if crashes persist.`,
        );
      } else {
        causes.push(
          `Compositor render targets estimated at ~${rt.estMB} MB (${rt.drawingBufferMp} MP × ~${rt.mbPerMp} MB/MP), `
          + `within the ${budgetTxt}. These are uncounted by the texture budget but bounded by the render-resolution cap.`,
        );
      }
    }
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

    if (Array.isArray(record.shaderErrors) && record.shaderErrors.length > 0) {
      const last = record.shaderErrors[record.shaderErrors.length - 1]?.msg ?? 'Shader Error';
      causes.push(
        `Recent WebGL shader validation failure(s) (${record.shaderErrors.length}) — `
        + `${last.slice(0, 140)}. This often happens when GPU mask baking runs on a context that was `
        + 'just lost/restored (RawShaderMaterial in GpuSceneMaskCompositor).',
      );
    }

    const maskEst = record.graphics?.outdoorsMaskBakeEstimate;
    const realFloorCount = record.scene?.visibleFloorsCount ?? record.scene?.levelsCount ?? null;
    if (loading && maskEst?.estMb >= 16 && (populate?.busTileCount ?? 0) >= 2) {
      // NOTE: `_Outdoors` is only ONE of ~15 authored per-floor masks MSA bakes
      // (_Specular, _Water, _Fire, _Tree, _Bush, _Normal, _Roughness, etc. are
      // comparably sized). This estimate is a floor, not the total mask VRAM —
      // do not treat "_Outdoors mask" as the sole or primary suspect. See
      // Docs/planning/Forward+.md §2.1/§4.1.
      const floorTxt = Number.isFinite(realFloorCount)
        ? `${realFloorCount} floor(s) visible`
        : `${populate?.busTileCount ?? '?'} tile mesh(es) queued on the render bus (NOT a floor count)`;
      causes.push(
        `Per-floor mask baking (_Outdoors alone estimated at ~${maskEst.estMb} MB per floor; `
        + `${maskEst.outW}×${maskEst.outH} from ${maskEst.sceneW}×${maskEst.sceneH} scene) — MSA bakes up to 15 `
        + `comparably-sized authored masks per floor (_Specular, _Water, _Fire, _Tree, _Bush, etc.), so real `
        + `per-floor mask VRAM is likely several times this figure. ${floorTxt} during load can spike VRAM `
        + 'before streaming mounts.',
      );
    }

    const phase = String(record.load?.phase ?? '');
    if (loading && phase.includes('cinematicCamera')) {
      causes.push(
        'Crash during camera-follower init: FloorCompositor may run outdoors mask repair for every '
        + 'visible floor band. On 144 MP multifloor scenes this is a common second crash after compositor init.',
      );
    }

    if (loading && record.graphics?.loadSlimPolicyWouldApply && !record.graphics?.loadSlimCompositorActive) {
      causes.push(
        'Load-slim compositor policy applies to this scene but was not active at crash time — '
        + 'Bloom/OverheadStamp/BuildingShadows RTs may have allocated during init. Hard-refresh (Ctrl+F5) '
        + 'after deploying the latest module build.',
      );
    } else if (loading && (record.graphics?.loadSlimPendingEffects ?? 0) > 0) {
      causes.push(
        `Load-slim had ${record.graphics.loadSlimPendingEffects} effect(s) still pending GPU init — `
        + 'FloorCompositor.onResize may have allocated their RT stacks early (OverheadStamp / BuildingShadows). '
        + 'Deploy the onResize guard fix if this persists.',
      );
    } else if (loading && record.graphics?.loadSlimCompositorActive) {
      const deferred = record.graphics?.loadSlimDeferredCount;
      causes.push(
        `Load-slim compositor was active${Number.isFinite(deferred) ? ` (${deferred} effect(s) deferred)` : ''} — `
        + 'if this still crashed, the remaining core RT stack or mask uploads exceeded GPU headroom.',
      );
    }

    if (phase.includes('fadeIn') && (record.rendererStats?.textures ?? 0) >= 128) {
      causes.push(
        `Crash during scene reveal with ${record.rendererStats.textures} live renderer textures — `
        + 'streaming pyramid mount likely burst-uploaded too many cells at once on 8 GB VRAM.',
      );
    }

    const probe = record.graphics?.gpuProbe ?? null;
    if (record.graphics?.gpuVramPreset === 'auto' && record.graphics?.effectiveGpuVramGB >= 16) {
      causes.push(
        'GPU VRAM preset is Auto and the effective budget resolved to 16 GB. If your GPU has less VRAM '
        + `${probe?.renderer ? `(detected "${probe.renderer}")` : ''}, pin the matching size under `
        + 'Configure Settings → Map Shine.',
      );
    }
    if (probe?.renderer && probe.estimatedVramGB != null && probe.estimatedVramGB <= 8) {
      causes.push(
        `GPU identified as "${probe.renderer}" (~${probe.estimatedVramGB} GB VRAM). The auto budget and load `
        + 'guardrails are now sized to this card; if crashes persist the base map should still load in bare mode.',
      );
    } else if (!probe?.renderer) {
      causes.push(
        'GPU could not be identified from the WebGL renderer string, so the auto VRAM budget was capped '
        + 'conservatively at 8 GB. Pin your actual VRAM under Configure Settings → Map Shine for best quality.',
      );
    }

    // Attribute the VRAM: if one subsystem dominates the budget, name it. Scene
    // masks and streaming tiles are the usual suspects on constrained GPUs.
    const sourceBytesMB = stream?.budget?.sourceBytesMB ?? null;
    if (sourceBytesMB && typeof sourceBytesMB === 'object') {
      const rows = Object.entries(sourceBytesMB).sort((a, b) => b[1] - a[1]);
      const total = rows.reduce((s, [, mb]) => s + Number(mb || 0), 0);
      if (rows.length && total > 0) {
        const [topSrc, topMb] = rows[0];
        const pct = Math.round((topMb / total) * 100);
        if (pct >= 45) {
          const maskScale = stream.budget.stableMaskResolutionScale ?? stream.budget.maskResolutionScale;
          const maskHint = (topSrc === 'sceneMask' || topSrc === 'tileMask')
            ? ` Scene-space masks scale with the map size; the mask resolution is now VRAM-capped (scale ${maskScale ?? '?'}).`
            : '';
          causes.push(
            `VRAM is dominated by "${topSrc}" (${topMb} MB, ${pct}% of ${Math.round(total)} MB tracked).${maskHint}`,
          );
        }
      }
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
    // NOTE: intentionally no "module outdated / hard refresh" diagnosis — the
    // on-disk manifest version is hand-maintained and lags the runtime, so it is
    // not a reliable staleness signal and only produced misleading noise.

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
        const probe = audit.textureLeakProbe ?? record.textureLeakProbe ?? null;
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
    } else if (textures > 200 || (sceneMegapixels > 64 && textures >= 32)) {
      const sceneTex = audit?.sceneGraphTextures;
      const counterNote = Number.isFinite(sceneTex)
        ? ` (${textures} Three.js counter, ~${sceneTex} in scene graph)`
        : ` (${textures} Three.js counter)`;
      causes.push(
        `This scene is GPU-heavy${counterNote}, ~${sceneMegapixels.toFixed(0)} MP map). `
        + 'GPU memory exhaustion is a likely contributor — a lower render resolution preset helps.',
      );
    }

    // PIXI-side VRAM: shares the GPU but is invisible to MSA's budgets. Surface
    // it whenever it is a large absolute consumer.
    const pixi = record.pixiTextures ?? null;
    if (pixi && pixi.estTotalMB >= 512) {
      const top = pixi.top?.[0];
      causes.push(
        `Foundry/PIXI-side textures estimated at ~${pixi.estTotalMB} MB across ${pixi.sizedCount} textures `
        + `(largest: ${top ? `${top.mb} MB ${top.w}x${top.h}${top.src ? ` ${top.src}` : ''}` : 'n/a'}). `
        + 'This memory shares the GPU with Map Shine but is NOT counted by any MSA budget — full-resolution '
        + 'source images held by Foundry\'s own renderer are a major hidden VRAM consumer on large maps.',
      );
    }

    // Attribution honesty: when MSA-side allocations were near-zero at crash
    // time, say so explicitly instead of letting size-based heuristics imply
    // an MSA texture cause that the numbers do not support.
    const msaSideTinyAtCrash = (textures < 32)
      && ((stream?.budget?.usedPct ?? 0) < 5)
      && !(audit?.likelyStreamingLeak || audit?.likelyUntrackedLeak);
    if (msaSideTinyAtCrash) {
      causes.push(
        `MSA-side GPU allocations were near-zero at crash time (${textures} Three.js textures, `
        + `${stream?.budget?.usedMB ?? '?'} MB tracked). The context loss likely originated OUTSIDE Map Shine's `
        + 'tracked allocations: Foundry/PIXI-side texture memory (see pixiTextures in this report'
        + `${pixi ? `: ~${pixi.estTotalMB} MB` : ''}), another GPU-heavy tab/application, or a GPU driver `
        + 'reset/watchdog timeout (TDR) during shader compilation. Do NOT tune MSA texture budgets based on '
        + 'this crash — the tracked numbers do not support an MSA-texture cause.',
      );
    }
    // Huge source decodes immediately before the crash: decoded bitmaps live
    // in the browser's image/GPU-transfer memory — counted by NEITHER the JS
    // heap NOR GL texture counters. Name them explicitly.
    try {
      const loads = Array.isArray(record.recentTextureLoads) ? record.recentTextureLoads : [];
      const crashPerfMs = Number(record.load?.msSinceLoadStart);
      const huge = loads.filter((l) => Math.max(l?.srcW ?? 0, l?.srcH ?? 0) >= 8192);
      if (huge.length) {
        const tail = huge.slice(-3).map((l) =>
          `${l.srcW}x${l.srcH} (~${l.srcMB} MB decoded${l.outW < l.srcW ? `, downscaled to ${l.outW}x${l.outH}` : ', NOT downscaled'}) ${l.url}`,
        ).join('; ');
        causes.push(
          `${huge.length} texture load(s) with huge sources in the recent-load log: ${tail}. `
          + 'Full-resolution decodes occupy browser image/transfer memory invisible to all other counters '
          + `here${Number.isFinite(crashPerfMs) ? ` — compare loadMs values against the crash at ~${crashPerfMs} ms` : ''}. `
          + 'Sources marked NOT downscaled indicate an uncapped load path (see Forward+ S13.3).',
        );
      }
    } catch (_) {}

    // Big CPU-side canvas readbacks: each is a huge heap allocation AND a
    // GPU-raster stall. Name the sites directly when present.
    try {
      const ops = Array.isArray(record.bigCanvasOps) ? record.bigCanvasOps : [];
      const heavy = ops.filter((o) => (o?.mb ?? 0) >= 128 || (o?.durMs ?? 0) >= 500);
      if (heavy.length) {
        const top = heavy.slice(-3).map((o) =>
          `${o.w}x${o.h} (~${o.mb} MB, ${o.durMs} ms) at ${o.site ?? 'unknown site'}`,
        ).join('; ');
        causes.push(
          `${heavy.length} large canvas getImageData readback(s) recorded this load: ${top}. `
          + 'World-resolution CPU mask sampling allocates GB-scale heap and stalls the GPU raster process — '
          + 'compare atMs values with longTasks and the crash time. These sites should sample at capped/mask '
          + 'resolution, not source resolution (Forward+ S13.4).',
        );
      }
    } catch (_) {}

    // Slow synchronous GL ops: a multi-second block starves Chrome's GPU
    // channel and is a classic watchdog-reset (TDR) trigger.
    try {
      const glOps = Array.isArray(record.slowGlOps) ? record.slowGlOps : [];
      if (glOps.length) {
        const worst = glOps.slice().sort((a, b) => (b.durMs ?? 0) - (a.durMs ?? 0))[0];
        const total = glOps.reduce((s, o) => s + (o.durMs ?? 0), 0);
        causes.push(
          `${glOps.length} slow synchronous WebGL op(s) recorded, totalling ~${total} ms. `
          + `Worst: ${worst.op} took ${worst.durMs} ms`
          + `${worst.srcLen ? ` (shader source ${worst.srcLen} chars: ${String(worst.srcHead ?? '').slice(0, 60)})` : ''}`
          + `${worst.w ? ` (${worst.w}x${worst.h})` : ''}. `
          + 'Multi-second GL calls block the main thread AND starve the GPU process — the classic driver '
          + 'watchdog (TDR) reset path. Compare atMs against longTasks and the crash time.',
        );
      }
    } catch (_) {}

    // Named load sections that blocked the main thread. When a multi-second
    // stall contains no slow GL op, the block is CPU-side JS — this names it.
    try {
      const secs = Array.isArray(record.slowSections) ? record.slowSections : [];
      if (secs.length) {
        const worst = secs.slice().sort((a, b) => (b.durMs ?? 0) - (a.durMs ?? 0)).slice(0, 3);
        causes.push(
          `${secs.length} labelled load section(s) blocked the main thread ≥250 ms. Worst: `
          + worst.map((s) => `"${s.context}" ${s.durMs} ms @${s.atMs} ms`).join('; ')
          + '. Cross-reference atMs with longTasks: a multi-second section with no matching slowGlOps '
          + 'entry is CPU-side work that must be chunked/yielded to avoid a GPU watchdog reset.',
        );
      }
    } catch (_) {}

    // Long main-thread stalls immediately preceding the crash are themselves a
    // strong TDR signal even when no single GL op is named.
    try {
      const lts = Array.isArray(record.longTasks) ? record.longTasks : [];
      const crashMs = Number(record.load?.msSinceLoadStart);
      const worst = lts.slice().sort((a, b) => (b.durMs ?? 0) - (a.durMs ?? 0))[0];
      if (worst && worst.durMs >= 2000) {
        const endMs = (worst.startMs ?? 0) + (worst.durMs ?? 0);
        const gap = Number.isFinite(crashMs) ? Math.round(crashMs - endMs) : null;
        // Which labelled sections were running when the stall began? The last
        // section started at-or-before startMs is the strongest suspect.
        let culprit = '';
        try {
          const trail = Array.isArray(record.sectionTrail) ? record.sectionTrail : [];
          const before = trail.filter((t) => (t.startMs ?? 0) <= (worst.startMs ?? 0));
          const last = before[before.length - 1];
          if (last) {
            culprit = ` Last labelled section started before the stall: "${last.context}" @${last.startMs} ms.`;
          }
        } catch (_) {}
        causes.push(
          `Longest main-thread stall was ${worst.durMs} ms (ending ~${endMs} ms)`
          + `${gap != null ? `, and the context was lost ~${gap} ms after it ended` : ''}.${culprit} `
          + 'A synchronous block of this length during loading is consistent with a GPU driver watchdog '
          + 'reset (TDR), not memory exhaustion. Cross-reference sectionTrail / slowSections / slowGlOps.',
        );
      }
    } catch (_) {}

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
 * Next safe-mode render preset below the current one.
 * @param {string|null|undefined} currentPreset
 * @returns {string|null}
 */
function _resolveSafeModeTargetPreset(currentPreset) {
  const cur = currentPreset || 'native';
  if (!_presetAtOrBelow(cur, SAFE_MODE_PRESET)) return SAFE_MODE_PRESET;
  if (!_presetAtOrBelow(cur, SAFE_MODE_PRESET_FLOOR)) return SAFE_MODE_PRESET_FLOOR;
  return null;
}

/**
 * Capture Three.js shader validation warnings for crash reports.
 */
export function installWebGLShaderDiagnostics() {
  try {
    if (globalThis.__msaShaderDiagInstalled === true) return;
    globalThis.__msaShaderDiagInstalled = true;
    globalThis.__msaRecentShaderErrors = [];
    const origWarn = console.warn;
    console.warn = function msaPatchedConsoleWarn(...args) {
      try {
        const msg = args.map((a) => String(a ?? '')).join(' ');
        if (msg.includes('WebGLProgram') && msg.includes('Shader Error')) {
          globalThis.__msaRecentShaderErrors.push({
            msg: msg.slice(0, 600),
            at: Date.now(),
          });
          if (globalThis.__msaRecentShaderErrors.length > 12) {
            globalThis.__msaRecentShaderErrors.shift();
          }
        }
      } catch (_) {
      }
      return origWarn.apply(this, args);
    };
  } catch (_) {
  }
  _installLongTaskDiagnostics();
  _installBigCanvasOpDiagnostics();
  _installSlowGlOpDiagnostics();
}

/**
 * Time synchronous WebGL operations that can block the main thread for seconds
 * and starve Chrome's GPU channel into a watchdog reset.
 *
 * The 2026-07-10 run refuted both earlier suspects (bigCanvasOps was empty;
 * heap was normal at 224 MB) yet the context died **111 ms after the end of a
 * 6,618 ms long task** (a 3,824 ms one preceded it). Something synchronous
 * blocks for seconds during `binding_effects`. The prime candidates are all
 * GL-side:
 *  - `getProgramParameter(LINK_STATUS)` / `getShaderParameter(COMPILE_STATUS)`:
 *    force a blocking wait for the driver to finish compiling. On ANGLE/D3D11 a
 *    large shader can take seconds, and MSA has ~48 effects with big shaders.
 *  - `texImage2D` / `generateMipmap`: large uploads stall the driver.
 *  - `readPixels` / `finish`: full pipeline flushes.
 *
 * Ops slower than 100 ms are recorded (op, duration, timestamp, and for shader
 * ops the source length + a marker snippet) into `slowGlOps` in crash reports.
 * Fast ops take one comparison of overhead.
 */
function _installSlowGlOpDiagnostics() {
  try {
    if (globalThis.__msaGlOpDiagInstalled === true) return;
    globalThis.__msaGlOpDiagInstalled = true;
    globalThis.__msaSlowGlOps = [];
    const SLOW_MS = 100;

    const record = (op, durMs, extra) => {
      try {
        globalThis.__msaSlowGlOps.push({
          op,
          durMs: Math.round(durMs),
          atMs: Math.round(performance.now() - durMs),
          ...extra,
        });
        if (globalThis.__msaSlowGlOps.length > 24) globalThis.__msaSlowGlOps.shift();
      } catch (_) {}
    };

    const timeWrap = (proto, name, describe) => {
      const orig = proto?.[name];
      if (typeof orig !== 'function') return;
      proto[name] = function msaTimedGlOp(...args) {
        const t0 = performance.now();
        const out = orig.apply(this, args);
        const dur = performance.now() - t0;
        if (dur >= SLOW_MS) {
          let extra = {};
          try { extra = describe ? describe.call(this, args, out) : {}; } catch (_) {}
          record(name, dur, extra);
        }
        return out;
      };
    };

    for (const ctor of [globalThis.WebGL2RenderingContext, globalThis.WebGLRenderingContext]) {
      const p = ctor?.prototype;
      if (!p) continue;

      // Stash shader sources so slow compiles/links can be attributed.
      const origShaderSource = p.shaderSource;
      if (typeof origShaderSource === 'function') {
        p.shaderSource = function msaShaderSource(shader, src) {
          try {
            if (shader) shader.__msaSrcLen = String(src ?? '').length;
            if (shader) shader.__msaSrcHead = String(src ?? '').slice(0, 120);
          } catch (_) {}
          return origShaderSource.call(this, shader, src);
        };
      }

      timeWrap(p, 'compileShader', (args) => ({
        srcLen: args?.[0]?.__msaSrcLen ?? null,
        srcHead: args?.[0]?.__msaSrcHead ?? null,
      }));
      // The real blocking wait usually lands on the *status query*, not the
      // compile/link call itself (drivers compile asynchronously until asked).
      timeWrap(p, 'getShaderParameter', (args) => ({
        srcLen: args?.[0]?.__msaSrcLen ?? null,
        srcHead: args?.[0]?.__msaSrcHead ?? null,
      }));
      timeWrap(p, 'linkProgram');
      timeWrap(p, 'getProgramParameter');
      // Capture the caller for large uploads: a 6408x5121 texImage2D appeared
      // in reports with no obvious owner (it is NOT the tile path — tile
      // textures are created ~15 s later). Naming the site beats guessing.
      const captureSite = () => {
        try {
          return String(new Error().stack ?? '')
            .split('\n').slice(3, 7).map((s) => s.trim()).join(' <- ').slice(0, 260);
        } catch (_) { return null; }
      };
      timeWrap(p, 'texImage2D', (args) => ({
        w: args?.[3] ?? null,
        h: args?.[4] ?? null,
        site: captureSite(),
      }));
      timeWrap(p, 'texSubImage2D', () => ({ site: captureSite() }));
      timeWrap(p, 'generateMipmap', () => ({ site: captureSite() }));
      // readPixels is a hard GPU->CPU sync point: a 3000x3000 readback measured
      // 508 ms in the 2026-07-10 report with no attribution. Capture its caller.
      timeWrap(p, 'readPixels', (args) => ({
        w: args?.[2] ?? null,
        h: args?.[3] ?? null,
        site: captureSite(),
      }));
      timeWrap(p, 'finish', () => ({ site: captureSite() }));
    }
  } catch (_) {
  }
}

/**
 * Record large getImageData calls (>=16.7 MP) with measured duration and
 * caller site. CPU-side mask sampling of world-resolution canvases allocates
 * GB-scale heap (a 12000^2 readback is a ~549 MB array) and stalls both the
 * main thread AND Chrome's GPU raster process (2D canvas is GPU-accelerated) —
 * the 2026-07-10 instrumented run showed 1.3-5.8 s longTasks + 1.9 GB heap
 * during binding_effects with ~22 getImageData sites in the codebase. This
 * wrapper names the exact site/size/duration in the crash report.
 */
function _installBigCanvasOpDiagnostics() {
  try {
    if (globalThis.__msaCanvasOpDiagInstalled === true) return;
    globalThis.__msaCanvasOpDiagInstalled = true;
    globalThis.__msaBigCanvasOps = [];
    const AREA_GATE = 16777216; // 4096x4096 px; ops below this are untouched
    const wrap = (proto, label) => {
      const orig = proto?.getImageData;
      if (typeof orig !== 'function') return;
      proto.getImageData = function msaWrappedGetImageData(sx, sy, sw, sh, ...rest) {
        const area = Math.abs(Number(sw) * Number(sh)) || 0;
        if (area < AREA_GATE) return orig.call(this, sx, sy, sw, sh, ...rest);
        const t0 = performance.now();
        const result = orig.call(this, sx, sy, sw, sh, ...rest);
        try {
          let site = null;
          try {
            site = String(new Error().stack ?? '')
              .split('\n').slice(2, 5).map((s) => s.trim()).join(' <- ').slice(0, 220);
          } catch (_) {}
          globalThis.__msaBigCanvasOps.push({
            op: `${label}.getImageData`,
            w: Math.round(Number(sw)),
            h: Math.round(Number(sh)),
            mb: Math.round((area * 4) / 1048576),
            durMs: Math.round(performance.now() - t0),
            atMs: Math.round(t0),
            site,
          });
          if (globalThis.__msaBigCanvasOps.length > 16) globalThis.__msaBigCanvasOps.shift();
        } catch (_) {}
        return result;
      };
    };
    wrap(globalThis.CanvasRenderingContext2D?.prototype, 'canvas2d');
    wrap(globalThis.OffscreenCanvasRenderingContext2D?.prototype, 'offscreen2d');
  } catch (_) {
  }
}

/**
 * Record main-thread long tasks (>=200 ms) in a ring buffer for crash reports.
 * A synchronous decode/upload of a huge image (e.g. drawImage of a 12000^2
 * source, or texImage2D of the result) blocks the main thread for seconds —
 * correlating longTasks timestamps with recentTextureLoads timestamps and the
 * crash time exposes exactly which operation preceded a context loss / TDR.
 */
function _installLongTaskDiagnostics() {
  try {
    if (globalThis.__msaLongTaskDiagInstalled === true) return;
    globalThis.__msaLongTaskDiagInstalled = true;
    globalThis.__msaLongTasks = [];
    if (typeof PerformanceObserver === 'undefined') return;
    const obs = new PerformanceObserver((list) => {
      try {
        for (const entry of list.getEntries()) {
          if (entry.duration < 200) continue;
          globalThis.__msaLongTasks.push({
            startMs: Math.round(entry.startTime),
            durMs: Math.round(entry.duration),
          });
          if (globalThis.__msaLongTasks.length > 40) globalThis.__msaLongTasks.shift();
        }
      } catch (_) {}
    });
    obs.observe({ entryTypes: ['longtask'] });
  } catch (_) {
  }
}

/** Authored per-floor mask suffixes MSA bakes in world space (mask-catalog.js), used
 *  only to caveat the single-mask estimate below — kept as a literal count here
 *  rather than importing the catalog, since this module must survive a lost/broken
 *  render context. Update if MASK_CATALOG's authored suffix count changes. */
const APPROX_AUTHORED_MASK_COUNT = 15;

/**
 * Estimate outdoors mask bake RT size for crash diagnostics.
 *
 * IMPORTANT: `_Outdoors` is only ONE of ~{@link APPROX_AUTHORED_MASK_COUNT} authored
 * per-floor masks MSA bakes (see `scripts/masks/mask-catalog.js` MASK_CATALOG —
 * _Specular, _Water, _Fire, _Windows, _Tree, _Bush, _Normal, _Roughness, etc. are
 * comparably sized). Do not treat this single-mask estimate as the total per-floor
 * mask VRAM cost, and do not treat "_Outdoors mask" as the sole suspect when
 * diagnosing mask-driven VRAM pressure — it is a representative sample, not the
 * whole picture. See Docs/planning/Forward+.md §2.1/§4.1 for the full mask
 * inventory and why this was historically undercounted in crash diagnosis.
 *
 * @returns {{ sceneW: number, sceneH: number, outW: number, outH: number, estMb: number, note: string }|null}
 */
function _estimateOutdoorsMaskBakeSize() {
  try {
    const sr = globalThis.canvas?.dimensions?.sceneRect;
    const sceneW = Number(sr?.width) || 0;
    const sceneH = Number(sr?.height) || 0;
    if (!(sceneW > 0 && sceneH > 0)) return null;
    const tracker = getTextureBudgetTracker();
    const scale = Math.max(0.18, Number(tracker.getStableMaskResolutionScale?.()) || 0.3);
    const hdMax = Math.max(256, Math.round(8192 * scale));
    const maxTex = window.MapShine?.renderer?.capabilities?.maxTextureSize ?? 8192;
    const fit = Math.min(
      1.0,
      hdMax / sceneW,
      hdMax / sceneH,
      maxTex / sceneW,
      maxTex / sceneH,
    );
    const outW = Math.max(1, Math.round(sceneW * fit));
    const outH = Math.max(1, Math.round(sceneH * fit));
    const estMb = Math.round((outW * outH * 4) / (1024 * 1024));
    return {
      sceneW, sceneH, outW, outH, estMb,
      note: `This is 1 of up to ${APPROX_AUTHORED_MASK_COUNT} comparably-sized authored per-floor masks `
        + '(_Specular, _Water, _Fire, _Tree, _Bush, etc. — see mask-catalog.js). Real per-floor mask VRAM '
        + 'is likely several times this single-mask figure, NOT this figure alone.',
    };
  } catch (_) {
    return null;
  }
}

function _applySafeModeMemoryDowngrade(ctx, storageKey, stored) {
  const gs = ctx?.graphicsSettings ?? null;
  const currentGpu = gs?.getGpuVramPreset?.()
    ?? stored?.gpuVramPreset
    ?? 'auto';

  let targetGpu = null;
  if (currentGpu === 'auto') {
    // Auto infers VRAM from system RAM (16 GB RAM → 16 GB VRAM). Pin 8 GB on crash.
    targetGpu = '8';
  } else if (Number(currentGpu) > 8 && Number.isFinite(Number(currentGpu))) {
    targetGpu = '8';
  }
  if (!targetGpu) return null;

  if (gs && typeof gs.setGpuVramPreset === 'function') {
    gs.setGpuVramPreset(targetGpu);
    gs.saveState?.();
  } else {
    const next = stored ?? _readJson(storageKey) ?? {};
    next.gpuVramPreset = targetGpu;
    _writeJson(storageKey, next);
  }
  return currentGpu;
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
    const stored = _readJson(storageKey) ?? {};
    const currentPreset = gs?.getRenderResolutionPreset?.()
      ?? stored.renderResolutionPreset
      ?? 'native';
    const currentGpu = gs?.getGpuVramPreset?.()
      ?? stored.gpuVramPreset
      ?? 'auto';

    const targetPreset = _resolveSafeModeTargetPreset(currentPreset);
    const resolutionChanged = targetPreset != null && targetPreset !== currentPreset;
    const previousGpuVramPreset = _applySafeModeMemoryDowngrade(ctx, storageKey, stored);

    if (!resolutionChanged && previousGpuVramPreset == null) return false;

    if (resolutionChanged) {
      if (gs && typeof gs.setRenderResolutionPreset === 'function') {
        gs.setRenderResolutionPreset(targetPreset);
        gs.saveState?.();
      } else {
        stored.renderResolutionPreset = targetPreset;
        _writeJson(storageKey, stored);
      }
    }

    _writeJson(SAFE_MODE_KEY, {
      active: true,
      previousPreset: currentPreset,
      previousGpuVramPreset: previousGpuVramPreset ?? currentGpu,
      storageKey,
      at: Date.now(),
      sessionId: SESSION_ID,
    });
    log.warn(
      `Safe mode: render resolution ${resolutionChanged ? `reduced to ${targetPreset} (was ${currentPreset})` : 'unchanged'}`
      + `${previousGpuVramPreset != null ? `; GPU VRAM preset pinned to 8 GB (was ${previousGpuVramPreset})` : ''}`,
    );
    return true;
  } catch (e) {
    log.warn('Safe mode downgrade failed', e);
    return false;
  }
}

/**
 * After a successful scene load, restore pre-crash graphics overrides for the
 * *next* load when safe mode was a one-off recovery (not a repeated failure).
 *
 * @returns {boolean}
 */
function _restoreGraphicsAfterSuccessfulLoad() {
  try {
    const marker = _readJson(SAFE_MODE_KEY);
    if (!marker?.active) return false;

    const sceneId = canvas?.scene?.id ?? null;
    const recentLoadCrashes = getCrashHistory().filter((c) =>
      c.sceneId === sceneId
      && c.loading === true
      && (Date.now() - (c.atMs ?? 0)) < REPEAT_CRASH_WINDOW_MS,
    );

    if (recentLoadCrashes.length >= 2) {
      _removeKey(SAFE_MODE_KEY);
      _pendingLoadNotice = { type: 'staying-reduced' };
      log.info('Skipping graphics restore — repeated WebGL load crashes on this scene');
      return false;
    }

    const storageKey = marker.storageKey ?? _buildGraphicsStorageKey();
    const stored = _readJson(storageKey) ?? {};

    if (marker.previousPreset) {
      stored.renderResolutionPreset = marker.previousPreset;
    }
    if (marker.previousGpuVramPreset != null) {
      stored.gpuVramPreset = marker.previousGpuVramPreset;
    }
    _writeJson(storageKey, stored);
    _removeKey(SAFE_MODE_KEY);

    const activeKey = window.MapShine?.graphicsSettings?._storageKey ?? _buildGraphicsStorageKey();
    if (marker.storageKey === activeKey) {
      _pendingLoadNotice = { type: 'restored', preset: marker.previousPreset || 'native' };
    }
    log.info(
      `Safe mode cleared after successful load; next load will use `
      + `"${marker.previousPreset || 'native'}" render resolution`,
    );
    return true;
  } catch (e) {
    log.warn('_restoreGraphicsAfterSuccessfulLoad failed', e);
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
 * Pin conservative render resolution + GPU VRAM before compositor init when this
 * scene recently crashed during loading (breaks the native-resolution crash loop).
 *
 * @param {{ id?: string|null }|null} [scene]
 * @returns {boolean} True when persisted overrides were updated.
 */
export function ensureConservativeGraphicsForLoad(scene = null) {
  try {
    const sceneId = scene?.id ?? canvas?.scene?.id ?? null;
    if (!sceneId) return false;

    const now = Date.now();
    const recentLoadCrashes = getCrashHistory().filter((c) =>
      c.sceneId === sceneId
      && c.loading === true
      && (now - (c.atMs ?? 0)) < REPEAT_CRASH_WINDOW_MS,
    );
    const crashes = recentLoadCrashes.length;
    const gpuWeak = _isGpuKnownWeak();

    // Nothing crashed here and the card has no track record → leave quality high.
    if (crashes < 1 && !gpuWeak) return false;

    const storageKey = _storageKeyForScene(sceneId);
    const stored = _readJson(storageKey) ?? {};
    let changed = false;

    // Tier 0 (any recent crash OR known-weak GPU): pin GPU VRAM to 8 GB so the
    // budget/guardrails size to a discrete 8 GB card rather than system RAM.
    const gpu = stored.gpuVramPreset ?? 'auto';
    if (gpu === 'auto' || (Number(gpu) > 8 && Number.isFinite(Number(gpu)))) {
      stored.gpuVramPreset = '8';
      changed = true;
    }

    // Tier 1 (>=1 recent load crash on this scene): drop the render resolution.
    if (crashes >= 1) {
      const targetPreset = _resolveSafeModeTargetPreset(stored.renderResolutionPreset ?? 'native');
      if (targetPreset && stored.renderResolutionPreset !== targetPreset) {
        stored.renderResolutionPreset = targetPreset;
        changed = true;
      }
    }

    // Tier 2 ("bare mode"): resolution cuts alone have not helped — shed the
    // entire effect stack (the compositor RTs that survive resolution drops) and
    // pin the resolution floor. Base map + tokens still render.
    let escalatedToBareMode = false;
    if (crashes >= BARE_MODE_CRASH_THRESHOLD && stored.globalDisableAll !== true) {
      stored.globalDisableAll = true;
      stored.renderResolutionPreset = SAFE_MODE_PRESET_FLOOR;
      changed = true;
      escalatedToBareMode = true;
      _markGpuKnownWeak();
    }

    // Tier 3 (terminal): still crashing even with no effects → bypass Map Shine.
    if (crashes >= NATIVE_FALLBACK_CRASH_THRESHOLD && stored.globalDisableAll === true) {
      void _enableNativeFoundryRenderingFallback();
      _pendingLoadNotice = { type: 'native-fallback' };
    }

    if (crashes >= 2) _markGpuKnownWeak();

    if (!changed) return false;

    _writeJson(storageKey, stored);
    if (escalatedToBareMode) {
      _pendingLoadNotice = { type: 'bare-mode' };
    } else if (_pendingLoadNotice?.type !== 'native-fallback') {
      _pendingLoadNotice = { type: 'staying-reduced' };
    }
    log.warn(
      `Conservative graphics pinned for scene ${sceneId} after ${crashes} recent load `
      + `crash(es)${gpuWeak ? ' (GPU flagged known-weak)' : ''}`
      + `${escalatedToBareMode ? ' — bare mode (all effects disabled)' : ''}`,
    );
    return true;
  } catch (e) {
    log.warn('ensureConservativeGraphicsForLoad failed', e);
    return false;
  }
}

/**
 * Called at the start of every scene load (before graphics settings are read).
 *
 * Resolution/memory restore was moved to {@link onLoadSucceeded} so failed loads
 * stay at the safe-mode preset instead of bouncing back to native and crashing again.
 */
export function maybeRestoreResolutionBeforeLoad() {
  // Intentionally no-op — see onLoadSucceeded().
}

/**
 * Called after a scene load completes successfully. Surfaces any pending
 * safe-mode messaging so the user understands why the scene looks the way it does.
 */
export function onLoadSucceeded() {
  try {
    _restoreGraphicsAfterSuccessfulLoad();

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
        'Map Shine: Running at reduced render quality because WebGL crashed while loading this scene. '
        + 'Set GPU VRAM under Configure Settings → Map Shine → Performance & Graphics (no scene load required), '
        + 'or raise quality after a successful load via Performance & Graphics → Render quality.'
      );
    } else if (notice.type === 'bare-mode') {
      globalThis.ui?.notifications?.warn?.(
        'Map Shine: Effects were disabled ("bare mode") because WebGL kept crashing while loading this scene. '
        + 'The base map still renders. Re-enable effects via Performance & Graphics once your GPU driver / VRAM situation is resolved.'
      );
    } else if (notice.type === 'native-fallback') {
      globalThis.ui?.notifications?.error?.(
        'Map Shine: Switched to Native Foundry Rendering after repeated WebGL crashes. Reload the page to apply.'
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

  // Flag the GPU as known-weak after repeated load crashes so *other* scenes
  // also start conservative (pin 8 GB) rather than re-learning per scene.
  try {
    if (record.load?.sceneLoading && (record.crashHistorySummary?.withinLast30Min ?? 0) >= 2) {
      _markGpuKnownWeak();
    }
  } catch (_) {}

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
  return formatTextureAuditLine(record.textureAudit ?? { rendererCounter: record.rendererStats?.textures });
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
    ? `Render resolution was reduced to ${SAFE_MODE_PRESET} and GPU VRAM was pinned to 8 GB (when Auto) to stabilize loading. `
      + 'These stay in effect until this scene loads successfully. '
      + 'You can also set GPU VRAM beforehand via Configure Settings → Map Shine → Performance &amp; Graphics.'
    : null;

  const probe = record.graphics?.gpuProbe ?? null;
  const gpuName = record.gpu?.renderer ?? probe?.renderer ?? 'unknown';
  const gpuVramLine = probe?.estimatedVramGB != null
    ? `~${probe.estimatedVramGB} GB${probe.confident ? '' : '?'} est.`
    : null;
  const effVram = record.graphics?.effectiveGpuVramGB;
  const gpuValue = [
    gpuName,
    gpuVramLine,
    effVram != null ? `budget tier ${effVram} GB` : null,
    record.graphics?.knownWeakGpu ? 'flagged known-weak' : null,
  ].filter(Boolean).join(' · ');

  const guardrailValue = [
    record.graphics?.loadSlimCompositorActive ? 'load-slim ON' : (record.graphics?.loadSlimPolicyWouldApply ? 'load-slim would apply' : 'load-slim off'),
    record.graphics?.globalDisableAll ? 'bare mode (effects off)' : null,
    record.graphics?.gpuLoadPressure?.highLoad ? 'high load' : null,
  ].filter(Boolean).join('; ');

  const detailRows = [
    ['Scene', record.scene?.name ?? 'unknown'],
    ['During', record.load?.sceneLoading ? `scene loading (step: ${record.load?.phase ?? 'unknown'})` : 'normal play'],
    ['Tab visible', record.visibility?.hidden === true ? 'No (background tab)' : 'Yes'],
    ['GPU', gpuValue || 'unknown'],
    ['Guardrails', guardrailValue || 'none engaged'],
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

  const rt = record.graphics?.rtVramEstimate ?? null;
  if (rt && rt.estMB > 0) {
    const budgetTxt = rt.budgetMB != null ? `/ ${rt.budgetMB} MB budget` : '(uncapped)';
    detailRows.push([
      'Compositor RT VRAM',
      `~${rt.estMB} MB ${budgetTxt} @ ${rt.drawingBufferMp} MP${rt.overBudget ? ' — OVER (resolution capped)' : ''}`,
    ]);
  }

  const srcBytes = record.tileStreaming?.budget?.sourceBytesMB ?? null;
  if (srcBytes && typeof srcBytes === 'object') {
    const rows = Object.entries(srcBytes).filter(([, mb]) => Number(mb) > 0).slice(0, 4);
    if (rows.length) {
      const maskScale = record.tileStreaming?.budget?.stableMaskResolutionScale
        ?? record.tileStreaming?.budget?.maskResolutionScale;
      const breakdown = rows.map(([src, mb]) => `${src} ${mb} MB`).join(', ');
      detailRows.push([
        'VRAM by source',
        maskScale != null ? `${breakdown} (mask scale ${maskScale})` : breakdown,
      ]);
    }
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
    if (adaptive.growthAlert) {
      const diag = adaptive.growthDiagnosis;
      parts.push(diag?.label ? `growth: ${diag.label}` : 'growth alert');
    }
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
  installWebGLShaderDiagnostics,
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
