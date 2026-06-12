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
 *   load — unless crashes keep repeating, in which case safe mode sticks and
 *   the user is told why.
 * - Watchdog: if the browser never restores the context, trigger an automatic
 *   scene rebuild (fresh canvas + fresh WebGL context) once per session.
 *
 * All state is per-client (localStorage). Nothing here writes to the scene
 * document or any Foundry world setting.
 *
 * @module core/webgl-crash-recovery
 */

import { createLogger } from './log.js';

const log = createLogger('WebGLCrashRecovery');

const HISTORY_KEY = 'map-shine-advanced.webglCrashLog';
const SAFE_MODE_KEY = 'map-shine-advanced.webglSafeMode';
const SAFE_MODE_PRESET = '1280x720';
const HISTORY_MAX = 20;
/** Crashes within this window count as "repeated" and keep safe mode active. */
const REPEAT_CRASH_WINDOW_MS = 30 * 60 * 1000;
/** How many recent crashes are needed before safe mode persists across loads. */
const REPEAT_CRASH_THRESHOLD = 2;
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
    module: { id: 'map-shine-advanced', version: null },
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
  };

  try {
    record.module.version = game?.modules?.get?.('map-shine-advanced')?.version ?? null;
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
    const heapUsed = record.memory?.usedJSHeapMB ?? 0;
    const heapLimit = record.memory?.jsHeapLimitMB ?? 0;
    const sceneMegapixels = ((record.scene?.width ?? 0) * (record.scene?.height ?? 0)) / 1e6;
    const dpr = record.graphics?.devicePixelRatio ?? 1;
    const preset = record.graphics?.renderResolutionPreset ?? 'native';

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
    if (textures > 200 || sceneMegapixels > 64) {
      causes.push(
        `This scene is GPU-heavy (${textures || '?'} textures, ~${sceneMegapixels.toFixed(0)} MP map). `
        + 'GPU memory exhaustion is a likely contributor — a lower render resolution preset helps.'
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
 * Called at the start of every scene load (before graphics settings are read).
 *
 * If a previous session crashed and auto-downgraded the resolution, restore the
 * original preset so the user gets full quality back without manual action —
 * unless crashes have been repeating recently, in which case safe mode stays
 * and the user is told why (after the load succeeds).
 */
export function maybeRestoreResolutionBeforeLoad() {
  try {
    const marker = _readJson(SAFE_MODE_KEY);
    if (!marker?.active) return;

    // Crash happened in THIS session: keep the reduced resolution until the
    // next full reload so we don't immediately re-trigger the same crash.
    if (marker.sessionId === SESSION_ID) return;

    const now = Date.now();
    const recentCrashes = getCrashHistory()
      .filter((c) => (now - (c?.atMs ?? 0)) < REPEAT_CRASH_WINDOW_MS).length;

    if (recentCrashes >= REPEAT_CRASH_THRESHOLD) {
      _pendingLoadNotice = { type: 'staying-reduced' };
      log.warn(`Safe mode kept active (${recentCrashes} recent WebGL crashes)`);
      return;
    }

    const previousPreset = marker.previousPreset || 'native';
    const stored = _readJson(marker.storageKey);
    if (stored && typeof stored === 'object') {
      stored.renderResolutionPreset = previousPreset;
      _writeJson(marker.storageKey, stored);
    }
    _removeKey(SAFE_MODE_KEY);

    // Only announce the restore when it affects the settings the current
    // client will actually load; restoring another scene's key is silent.
    // The live manager builds its key once at construction, so prefer it.
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
    ['GPU textures', record.rendererStats?.textures ?? 'n/a'],
    ['JS heap', (record.memory?.usedJSHeapMB != null && record.memory?.jsHeapLimitMB != null)
      ? `${record.memory.usedJSHeapMB} / ${record.memory.jsHeapLimitMB} MB`
      : 'n/a'],
    ['Recent crashes (30 min)', record.crashHistorySummary?.withinLast30Min ?? 0],
  ];

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
  onLoadSucceeded,
  collectDiagnostics,
  diagnoseCrash,
  buildReportText,
  showCrashDialog,
  showLastCrashDialog,
  getCrashHistory,
  getLastCrashRecord,
};
