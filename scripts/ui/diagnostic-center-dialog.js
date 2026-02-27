/**
 * @fileoverview Diagnostic Center Dialog (Tweakpane)
 *
 * The Diagnostic Center is a user-facing debugging tool intended to surface
 * silent failure points across the rendering pipeline.
 *
 * v1 scope:
 * - Select a tile (or fall back to scene background) and run diagnostics.
 * - Provide a copyable report with PASS/WARN/FAIL/INFO checks.
 *
 * @module ui/diagnostic-center-dialog
 */

import { createLogger } from '../core/log.js';
import { getEffectMaskRegistry, loadAssetBundle, probeMaskFile, clearCache } from '../assets/loader.js';
import { readSceneLevelsFlag, isLevelsEnabledForScene, readTileLevelsFlags, tileHasLevelsRange, readWallHeightFlags, wallHasHeightBounds, readDocLevelsRange, getSceneBackgroundElevation, getSceneWeatherElevation, getSceneLightMasking, getFlagReaderDiagnostics } from '../foundry/levels-scene-flags.js';
import { detectLevelsRuntimeInteropState, getLevelsCompatibilityMode, detectKnownModuleConflicts } from '../foundry/levels-compatibility.js';
import { getPerspectiveElevation } from '../foundry/elevation-context.js';
import { peekSnapshot } from '../core/levels-import/LevelsSnapshotStore.js';

const log = createLogger('DiagnosticCenter');

function _captureConsoleOutput(fn) {
  const captured = {
    error: [],
    warn: [],
    info: [],
    log: []
  };

  const original = {
    error: console.error,
    warn: console.warn,
    info: console.info,
    log: console.log
  };

  const mkWrap = (key) => (...args) => {
    try {
      captured[key].push(args.map((a) => {
        try {
          if (typeof a === 'string') return a;
          if (a && typeof a === 'object') return JSON.stringify(a);
          return String(a);
        } catch (_) {
          return String(a);
        }
      }).join(' '));
    } catch (_) {
    }
    try {
      original[key](...args);
    } catch (_) {
    }
  };

  try {
    console.error = mkWrap('error');
    console.warn = mkWrap('warn');
    console.info = mkWrap('info');
    console.log = mkWrap('log');
    return fn(captured);
  } finally {
    try { console.error = original.error; } catch (_) {}
    try { console.warn = original.warn; } catch (_) {}
    try { console.info = original.info; } catch (_) {}
    try { console.log = original.log; } catch (_) {}
  }
}

function _looksLikeShaderError(line) {
  const s = String(line || '');
  return (
    s.includes('THREE.WebGLProgram') ||
    s.includes('Shader Error') ||
    s.includes('VALIDATE_STATUS') ||
    s.includes('fragment shader') ||
    s.includes('vertex shader')
  );
}

function _summarizeShaderErrors(captured) {
  const all = [];
  for (const key of ['error', 'warn', 'info', 'log']) {
    for (const line of (captured?.[key] || [])) all.push({ level: key, line });
  }
  const shader = all.filter((e) => _looksLikeShaderError(e.line));
  return {
    capturedTotal: all.length,
    shaderLines: shader,
    shaderLineCount: shader.length
  };
}

function _safeGetRendererContextLost(renderer) {
  try {
    const gl = renderer?.getContext?.();
    if (gl && typeof gl.isContextLost === 'function') return gl.isContextLost();
  } catch (_) {
  }
  return null;
}

function _extractBasePath(src) {
  const s = String(src || '').split('?')[0].split('#')[0];
  const lastDot = s.lastIndexOf('.');
  if (lastDot > 0) return s.substring(0, lastDot);
  return s;
}

function _filename(path) {
  try {
    const p = String(path || '');
    const lastSlash = p.lastIndexOf('/');
    return lastSlash >= 0 ? p.slice(lastSlash + 1) : p;
  } catch (_) {
    return '';
  }
}

async function _probeMaskFile(basePath, suffix) {
  try {
    return await probeMaskFile(basePath, suffix, { suppressProbeErrors: true });
  } catch (_) {
    return null;
  }
}

async function _copyTextToClipboard(text, okMessage, failMessage) {
  const toCopy = String(text || '');
  if (!toCopy) return;

  try {
    if (navigator?.clipboard?.writeText) {
      await navigator.clipboard.writeText(toCopy);
      ui?.notifications?.info?.(okMessage || 'Copied to clipboard');
      return;
    }
    throw new Error('Clipboard API not available');
  } catch (error) {
    try {
      const ta = document.createElement('textarea');
      ta.value = toCopy;
      ta.style.position = 'fixed';
      ta.style.left = '-9999px';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
      ui?.notifications?.info?.(okMessage || 'Copied to clipboard');
    } catch (e) {
      ui?.notifications?.warn?.(failMessage || 'Could not copy to clipboard. See console.');
      console.log(toCopy);
    }
  }
}

function _getSelectedTileDoc() {
  try {
    // Foundry convention: controlled tiles live on canvas.tiles.
    const controlled = canvas?.tiles?.controlled;
    if (Array.isArray(controlled) && controlled.length > 0) {
      const t = controlled[0];
      return t?.document || t?.doc || null;
    }
  } catch (_) {
  }
  return null;
}

function _getBackgroundSrc() {
  try {
    const src = canvas?.scene?.background?.src;
    const s = (src && String(src).trim()) ? String(src).trim() : '';
    return s || '';
  } catch (_) {
    return '';
  }
}

function _mkCheck(category, id, status, message, details = null) {
  const entry = { category, id, status, message };
  if (details !== null && details !== undefined) entry.details = details;
  return entry;
}

function _summarizeChecks(checks) {
  const out = { pass: 0, warn: 0, fail: 0, info: 0 };
  for (const c of checks) {
    const s = String(c?.status || '').toUpperCase();
    if (s === 'PASS') out.pass++;
    else if (s === 'WARN') out.warn++;
    else if (s === 'FAIL') out.fail++;
    else out.info++;
  }
  return out;
}

function _parseLevelRangeRecord(item) {
  let bottomRaw;
  let topRaw;

  if (Array.isArray(item)) {
    bottomRaw = item[0];
    topRaw = item[1];
  } else if (item && typeof item === 'object') {
    bottomRaw = item.bottom ?? item.rangeBottom ?? item.min;
    topRaw = item.top ?? item.rangeTop ?? item.max;
  }

  let bottom = Number(bottomRaw);
  let top = Number(topRaw);
  if (!Number.isFinite(bottom) || !Number.isFinite(top)) {
    return { valid: false, swapped: false, bottom: null, top: null };
  }

  let swapped = false;
  if (bottom > top) {
    const t = bottom;
    bottom = top;
    top = t;
    swapped = true;
  }

  return { valid: true, swapped, bottom, top };
}

function _collectSceneLevelFlagDiagnostics(scene) {
  const rawLevels = readSceneLevelsFlag(scene);
  const levelsEnabled = isLevelsEnabledForScene(scene);

  let parsedCount = 0;
  let invalidCount = 0;
  let swappedCount = 0;

  const rawCount = Array.isArray(rawLevels) ? rawLevels.length : 0;
  if (Array.isArray(rawLevels)) {
    for (const item of rawLevels) {
      const parsed = _parseLevelRangeRecord(item);
      if (!parsed.valid) {
        invalidCount += 1;
        continue;
      }
      if (parsed.swapped) swappedCount += 1;
      parsedCount += 1;
    }
  }

  return {
    sceneId: String(scene?.id || ''),
    sceneName: String(scene?.name || '(Unnamed Scene)'),
    levelsEnabled,
    rawCount,
    parsedCount,
    invalidCount,
    swappedCount,
  };
}

export class DiagnosticCenterDialog {
  /**
   * @param {import('./diagnostic-center.js').DiagnosticCenterManager} manager
   */
  constructor(manager) {
    this.manager = manager;

    /** @type {Tweakpane.Pane|null} */
    this.pane = null;

    /** @type {HTMLElement|null} */
    this.container = null;

    /** @type {HTMLElement|null} */
    this._targetBar = null;

    /** @type {HTMLElement|null} */
    this._reportRoot = null;

    /** @type {boolean} */
    this.visible = false;

    this._state = {
      targetKind: 'auto', // auto | tile | background
      targetId: '',
      targetLabel: '—'
    };

    this._lastReport = null;
  }

  async initialize(parentElement = document.body) {
    if (this.pane) return;

    const startTime = Date.now();
    while (typeof Tweakpane === 'undefined' && (Date.now() - startTime) < 5000) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    if (typeof Tweakpane === 'undefined') {
      throw new Error('Tweakpane library not available');
    }

    this.container = document.createElement('div');
    this.container.id = 'map-shine-diagnostic-center';
    this.container.style.position = 'fixed';
    this.container.style.zIndex = '10010';
    this.container.style.left = '50%';
    this.container.style.top = '50%';
    this.container.style.transform = 'translate(-50%, -50%)';
    this.container.style.display = 'none';
    this.container.style.minWidth = '760px';
    this.container.style.maxWidth = '1100px';
    this.container.style.maxHeight = '80vh';
    this.container.style.overflowY = 'auto';
    parentElement.appendChild(this.container);

    // Prevent pointer interaction with the scene behind the panel.
    {
      const stop = (e) => {
        try {
          e.stopPropagation();
        } catch (_) {
        }
      };

      const stopAndPrevent = (e) => {
        try {
          e.preventDefault();
        } catch (_) {
        }
        stop(e);
      };

      const events = ['pointerdown', 'mousedown', 'click', 'dblclick', 'wheel'];
      for (const type of events) {
        if (type === 'wheel') this.container.addEventListener(type, stop, { passive: true });
        else this.container.addEventListener(type, stop);
      }
      this.container.addEventListener('contextmenu', stopAndPrevent);
    }

    this.pane = new Tweakpane.Pane({
      title: 'Diagnostic Center',
      container: this.container,
      expanded: true
    });

    try {
      if (this.pane?.element) {
        this.pane.element.style.maxHeight = '100%';
        this.pane.element.style.overflowY = 'auto';
      }
    } catch (_) {
    }

    const targetFolder = this.pane.addFolder({ title: 'Target', expanded: true });
    this._buildTargetBar(targetFolder);

    const actionsFolder = this.pane.addFolder({ title: 'Actions', expanded: true });

    // Compact 2-column button grid (matches shared UI shell pattern).
    {
      const contentElement = actionsFolder?.element?.querySelector?.('.tp-fldv_c') || actionsFolder?.element;
      if (contentElement) {
        const grid = document.createElement('div');
        grid.style.display = 'grid';
        grid.style.gridTemplateColumns = '1fr 1fr';
        grid.style.gap = '4px';
        grid.style.padding = '4px 6px 6px 6px';

        const addGridButton = (label, onClick, danger = false) => {
          const btn = document.createElement('button');
          btn.textContent = label;
          btn.style.padding = '4px 8px';
          btn.style.borderRadius = '6px';
          btn.style.border = danger ? '1px solid rgba(255,80,80,0.35)' : '1px solid rgba(255,255,255,0.14)';
          btn.style.background = danger ? 'rgba(255,60,60,0.12)' : 'rgba(255,255,255,0.08)';
          btn.style.color = danger ? '#ff9090' : 'inherit';
          btn.style.cursor = 'pointer';
          btn.style.fontSize = '11px';
          btn.style.fontWeight = '500';
          btn.addEventListener('click', onClick);
          grid.appendChild(btn);
        };

        addGridButton('Select Target', async () => {
          await this._autoSelectTarget();
        });

        addGridButton('Run Diagnostics', async () => {
          await this.runDiagnostics();
        });

        addGridButton('Copy Report', async () => {
          if (!this._lastReport) {
            ui?.notifications?.warn?.('Diagnostic Center: no report yet');
            return;
          }
          await _copyTextToClipboard(JSON.stringify(this._lastReport, null, 2), 'Copied diagnostic report');
        });

        addGridButton('Clear Cache', async () => {
          try {
            clearCache();
            ui?.notifications?.info?.('Map Shine: Asset cache cleared');
          } catch (e) {
            ui?.notifications?.warn?.('Map Shine: Failed to clear asset cache (see console)');
            try {
              console.warn('[MapShine] Failed to clear asset cache', e);
            } catch (_) {
            }
          }
        }, true);

        contentElement.appendChild(grid);

        // Scope note — diagnostics are read-only, runtime-only.
        const scopeNote = document.createElement('div');
        scopeNote.textContent = 'Diagnostics are read-only and do not modify scene data.';
        scopeNote.style.fontSize = '10px';
        scopeNote.style.opacity = '0.55';
        scopeNote.style.padding = '4px 6px 2px 6px';
        scopeNote.style.fontStyle = 'italic';
        contentElement.appendChild(scopeNote);
      }
    }

    const reportFolder = this.pane.addFolder({ title: 'Report', expanded: true });
    this._reportRoot = this._getFolderContentEl(reportFolder);

    if (this._reportRoot) {
      const empty = document.createElement('div');
      empty.textContent = 'No report yet. Click “Run Diagnostics”.';
      empty.style.opacity = '0.75';
      empty.style.padding = '6px 6px 10px 6px';
      this._reportRoot.appendChild(empty);
    }

    // Resolve initial target.
    await this._autoSelectTarget();

    // Start hidden.
    this.hide();

    log.info('Diagnostic Center dialog initialized');
  }

  toggle() {
    if (this.visible) this.hide();
    else this.show();
  }

  show() {
    if (!this.container) return;
    this.container.style.display = 'block';
    this.visible = true;

    // Refresh target label when opened.
    void this._autoSelectTarget();
  }

  hide() {
    if (!this.container) return;
    this.container.style.display = 'none';
    this.visible = false;
  }

  /**
   * If a tile is selected, target that. Otherwise, if a scene background image
   * exists, target the background surface.
   *
   * This matches the requested UX.
   * @private
   */
  async _autoSelectTarget() {
    const tileDoc = _getSelectedTileDoc();
    if (tileDoc?.id) {
      this._state.targetKind = 'tile';
      this._state.targetId = String(tileDoc.id);
      this._state.targetLabel = `Tile: ${tileDoc.name || tileDoc.id}`;
      this._refreshTargetBar();
      return;
    }

    const bgSrc = _getBackgroundSrc();
    if (bgSrc) {
      this._state.targetKind = 'background';
      this._state.targetId = 'scene:background';
      this._state.targetLabel = `Background: ${_filename(bgSrc)}`;
      this._refreshTargetBar();
      return;
    }

    this._state.targetKind = 'auto';
    this._state.targetId = '';
    this._state.targetLabel = 'No tile selected and scene has no background image';
    this._refreshTargetBar();
  }

  _getFolderContentEl(folder) {
    try {
      return folder?.element?.querySelector?.('.tp-fldv_c') || folder?.element || null;
    } catch (_) {
      return null;
    }
  }

  _buildTargetBar(folder) {
    const root = this._getFolderContentEl(folder);
    if (!root) return;

    const bar = document.createElement('div');
    bar.style.display = 'flex';
    bar.style.flexWrap = 'wrap';
    bar.style.gap = '8px';
    bar.style.alignItems = 'center';
    bar.style.margin = '6px 6px 10px 6px';

    const label = document.createElement('div');
    label.style.fontSize = '12px';
    label.style.fontWeight = '650';
    label.style.opacity = '0.95';
    label.textContent = 'Target:';

    const value = document.createElement('div');
    value.className = 'map-shine-diagnostic-target-label';
    value.style.flex = '1 1 auto';
    value.style.minWidth = '240px';
    value.style.padding = '4px 8px';
    value.style.borderRadius = '8px';
    value.style.border = '1px solid rgba(255,255,255,0.12)';
    value.style.background = 'rgba(0,0,0,0.20)';
    value.style.whiteSpace = 'nowrap';
    value.style.overflow = 'hidden';
    value.style.textOverflow = 'ellipsis';

    bar.appendChild(label);
    bar.appendChild(value);
    root.appendChild(bar);

    this._targetBar = bar;
    this._refreshTargetBar();
  }

  _refreshTargetBar() {
    try {
      const el = this._targetBar?.querySelector?.('.map-shine-diagnostic-target-label');
      if (!el) return;
      el.textContent = String(this._state.targetLabel || '—');
    } catch (_) {
    }
  }

  async runDiagnostics() {
    if (!this.pane) return;

    // Ensure we obey the requested fallback behavior.
    if (!this._state.targetId || this._state.targetKind === 'auto') {
      await this._autoSelectTarget();
    }

    const report = await this._buildReport();
    this._lastReport = report;
    this._renderReport(report);
  }

  async _buildReport() {
    const checks = [];

    const ms = window.MapShine;
    const surfaceReport = ms?.surfaceRegistry?.refresh?.() || ms?.surfaceReport || null;

    const renderer = ms?.renderer || ms?.effectComposer?.renderer || null;
    const effectComposer = ms?.effectComposer || null;
    const threeScene = effectComposer?.scene || ms?.scene || null;
    const threeCamera = effectComposer?.camera || ms?.camera || null;

    const now = Date.now();

    const levelController = ms?.levelNavigationController || null;
    const activeContext = levelController?.getActiveLevelContext?.() || ms?.activeLevelContext || null;
    const availableLevels = levelController?.getAvailableLevels?.() || ms?.availableLevels || [];
    const diagnostics = levelController?.getLevelDiagnostics?.() || ms?.levelNavigationDiagnostics || null;
    const lockMode = levelController?.getLockMode?.() || activeContext?.lockMode || 'manual';
    const gameplayMode = Boolean(ms?.sceneComposer && ms?.isMapMakerMode !== true);
    const levelsInterop = detectLevelsRuntimeInteropState({ gameplayMode });
    const compatibilityMode = getLevelsCompatibilityMode();

    // --- Pipeline mode ---
    try {
      const v2Enabled = Boolean(effectComposer?._checkCompositorV2Enabled?.() && effectComposer?._floorCompositorV2);
      const floorLoopEnabled = Boolean(effectComposer?._checkFloorLoopEnabled?.() && window.MapShine?.floorStack);
      const modeLabel = v2Enabled ? 'V2 compositor' : (floorLoopEnabled ? 'V1 per-floor loop' : 'V1 legacy single-pass');
      checks.push(_mkCheck('Runtime', 'runtime.pipeline.mode', 'INFO', `Pipeline: ${modeLabel}`, {
        v2Enabled,
        floorLoopEnabled,
      }));
    } catch (_) {
      checks.push(_mkCheck('Runtime', 'runtime.pipeline.mode', 'INFO', 'Pipeline: (unknown)'));
    }

    // --- Runtime / Renderer diagnostics ---
    if (renderer) {
      checks.push(_mkCheck('Runtime', 'runtime.renderer.exists', 'PASS', 'Three renderer is available'));
      try {
        const lost = _safeGetRendererContextLost(renderer);
        if (lost === true) {
          checks.push(_mkCheck('Runtime', 'runtime.renderer.contextLost', 'FAIL', 'WebGL context is lost'));
        } else if (lost === false) {
          checks.push(_mkCheck('Runtime', 'runtime.renderer.contextLost', 'PASS', 'WebGL context is not lost'));
        } else {
          checks.push(_mkCheck('Runtime', 'runtime.renderer.contextLost', 'INFO', 'Could not determine context lost state'));
        }
      } catch (e) {
        checks.push(_mkCheck('Runtime', 'runtime.renderer.contextLost', 'WARN', 'Error while checking context lost state', {
          error: String(e?.message || e)
        }));
      }

      try {
        const caps = renderer.capabilities || {};
        const precision = caps.precision || null;
        const isWebGL2 = Boolean(caps.isWebGL2);
        const maxTextures = caps.maxTextures ?? null;
        const maxVertexTextures = caps.maxVertexTextures ?? null;
        const maxTextureSize = caps.maxTextureSize ?? null;
        const maxCubemapSize = caps.maxCubemapSize ?? null;
        checks.push(_mkCheck('Runtime', 'runtime.renderer.capabilities', 'INFO', `Renderer: ${isWebGL2 ? 'WebGL2' : 'WebGL1'} | precision=${precision}`, {
          isWebGL2,
          precision,
          maxTextures,
          maxVertexTextures,
          maxTextureSize,
          maxCubemapSize,
          logarithmicDepthBuffer: Boolean(caps.logarithmicDepthBuffer),
          floatFragmentTextures: Boolean(caps.floatFragmentTextures),
          floatVertexTextures: Boolean(caps.floatVertexTextures),
        }));
      } catch (e) {
        checks.push(_mkCheck('Runtime', 'runtime.renderer.capabilities', 'WARN', 'Failed to read renderer capabilities', {
          error: String(e?.message || e)
        }));
      }
    } else {
      checks.push(_mkCheck('Runtime', 'runtime.renderer.exists', 'FAIL', 'No Three renderer found on window.MapShine'));
    }

    if (effectComposer) {
      const total = effectComposer.effects?.size ?? 0;
      let enabledCount = 0;
      let continuousCount = 0;
      const enabled = [];
      try {
        for (const [key, effect] of (effectComposer.effects?.entries?.() || [])) {
          if (!effect) continue;
          if (effect.enabled) {
            enabledCount++;
            enabled.push(key);
          }
          if (effect.enabled && effect.requiresContinuousRender) continuousCount++;
        }
      } catch (_) {
      }

      checks.push(_mkCheck('Runtime', 'runtime.effects.summary', total > 0 ? 'PASS' : 'WARN', `Effects registered: ${total} (enabled: ${enabledCount})`, {
        total,
        enabledCount,
        continuousCount,
        enabled: enabled.slice(0, 50)
      }));

      // Per-effect health snapshot (instrumented in EffectComposer)
      try {
        const health = typeof effectComposer.getEffectHealthSnapshot === 'function'
          ? effectComposer.getEffectHealthSnapshot()
          : null;

        if (health?.effects?.length) {
          const nowMs = Date.now();
          const enabled = health.effects.filter(e => e.enabled);
          const lazy = health.effects.filter(e => e.lazyInitPending);
          const errored = health.effects.filter(e => e.lastErrorAtMs !== null);
          const neverRan = enabled.filter(e => !e.lastUpdateAtMs && !e.lastRenderAtMs);
          const stalled = enabled.filter(e => {
            const last = Math.max(e.lastUpdateAtMs || 0, e.lastRenderAtMs || 0);
            return last > 0 && (nowMs - last) > 30000;
          });

          const status = (errored.length > 0 || neverRan.length > 0) ? 'WARN' : 'PASS';
          checks.push(_mkCheck('Runtime', 'runtime.effects.health', status,
            `Effect health: enabled=${enabled.length}, lazyInitPending=${lazy.length}, errored=${errored.length}, enabledNeverRan=${neverRan.length}`, {
              generatedAtMs: health.generatedAtMs,
              enabled: enabled.map(e => e.id),
              lazyInitPending: lazy.map(e => e.id),
              errored: errored.slice(0, 20).map(e => ({ id: e.id, lastErrorAtMs: e.lastErrorAtMs, lastErrorMessage: e.lastErrorMessage })),
              enabledNeverRan: neverRan.map(e => e.id),
              enabledStalled30s: stalled.map(e => e.id),
              effects: health.effects,
            }));

          if (neverRan.length > 0) {
            checks.push(_mkCheck('Runtime', 'runtime.effects.enabledNeverRan', 'WARN',
              `Enabled effects that never ran update/render: ${neverRan.slice(0, 12).map(e => e.id).join(', ')}`, {
                ids: neverRan.map(e => e.id)
              }));
          }
          if (lazy.length > 0) {
            checks.push(_mkCheck('Runtime', 'runtime.effects.lazyInitPending', 'INFO',
              `Lazy-init pending effects: ${lazy.slice(0, 12).map(e => e.id).join(', ')}`, {
                ids: lazy.map(e => e.id)
              }));
          }
          if (errored.length > 0) {
            checks.push(_mkCheck('Runtime', 'runtime.effects.errors', 'WARN',
              `Effects with errors: ${errored.slice(0, 12).map(e => e.id).join(', ')}`, {
                effects: errored.map(e => ({ id: e.id, lastErrorAtMs: e.lastErrorAtMs, lastErrorMessage: e.lastErrorMessage }))
              }));
          }
        } else {
          checks.push(_mkCheck('Runtime', 'runtime.effects.health', 'INFO', 'Effect health telemetry not available'));
        }
      } catch (e) {
        checks.push(_mkCheck('Runtime', 'runtime.effects.health', 'WARN', 'Failed to read effect health telemetry', {
          error: String(e?.message || e)
        }));
      }

      // Render target sanity
      try {
        const rts = effectComposer.renderTargets || null;
        const sceneRT = effectComposer.sceneRenderTarget || null;
        checks.push(_mkCheck('Runtime', 'runtime.renderTargets.summary', 'INFO', `Composer RTs: map=${rts?.size ?? 0}, sceneRT=${sceneRT ? `${sceneRT.width}x${sceneRT.height}` : 'null'}`, {
          mapSize: rts?.size ?? 0,
          sceneRenderTarget: sceneRT ? { width: sceneRT.width, height: sceneRT.height, depthBuffer: Boolean(sceneRT.depthBuffer) } : null,
        }));
      } catch (_) {
      }
    } else {
      checks.push(_mkCheck('Runtime', 'runtime.effects.summary', 'WARN', 'EffectComposer not found; effects may not be initialized'));
    }

    checks.push(_mkCheck('Levels', 'levels.compatibility.mode', 'INFO', `Compatibility mode: ${compatibilityMode}`, {
      mode: compatibilityMode,
      gameplayMode,
    }));

    if (gameplayMode) {
      checks.push(_mkCheck(
        'Levels',
        'levels.runtime.authority',
        levelsInterop.hasRuntimeConflict ? 'WARN' : 'PASS',
        levelsInterop.hasRuntimeConflict
          ? 'Levels runtime interop signals detected while gameplay mode is active'
          : 'No Levels runtime interop conflicts detected in gameplay mode',
        {
          levelsModuleActive: levelsInterop.levelsModuleActive,
          wrappersLikelyActive: levelsInterop.wrappersLikelyActive,
          fogManagerTakeover: levelsInterop.fogManagerTakeover,
          canvasFogTakeover: levelsInterop.canvasFogTakeover,
          configuredFogManagerClassName: levelsInterop.configuredFogManagerClassName,
          coreFogManagerClassName: levelsInterop.coreFogManagerClassName,
        }
      ));
    }

    if (levelController) {
      checks.push(_mkCheck('Levels', 'levels.controller.exists', 'PASS', 'Level navigation controller is available'));
    } else {
      checks.push(_mkCheck('Levels', 'levels.controller.exists', 'WARN', 'Level navigation controller is not available'));
    }

    if (activeContext) {
      checks.push(_mkCheck('Levels', 'levels.context.active', 'PASS', 'Active level context is available', {
        levelId: activeContext.levelId,
        label: activeContext.label,
        index: activeContext.index,
        count: activeContext.count,
        bottom: activeContext.bottom,
        top: activeContext.top,
        center: activeContext.center,
        source: activeContext.source,
        lockMode,
      }));
    } else {
      checks.push(_mkCheck('Levels', 'levels.context.active', 'WARN', 'No active level context is available'));
    }

    if (Array.isArray(availableLevels) && availableLevels.length > 0) {
      checks.push(_mkCheck('Levels', 'levels.available', 'PASS', `Available levels: ${availableLevels.length}`));
    } else {
      checks.push(_mkCheck('Levels', 'levels.available', 'WARN', 'No available levels reported by controller'));
    }

    if (diagnostics) {
      const source = String(diagnostics.source || activeContext?.source || 'unknown');
      const rawCount = Number(diagnostics.rawCount || 0);
      const parsedCount = Number(diagnostics.parsedCount || availableLevels.length || 0);
      const invalidCount = Number(diagnostics.invalidCount || 0);
      const swappedCount = Number(diagnostics.swappedCount || 0);
      const inferredCenterCount = Number(diagnostics.inferredCenterCount || 0);

      const sourceStatus = (source === 'sceneLevels' || source === 'inferred') ? 'PASS' : 'WARN';
      checks.push(_mkCheck('Levels', 'levels.source', sourceStatus, `Level source: ${source}`, {
        source,
        rawCount,
        parsedCount,
        invalidCount,
        swappedCount,
        inferredCenterCount,
      }));

      if (invalidCount > 0 || swappedCount > 0) {
        checks.push(_mkCheck('Levels', 'levels.parse.warnings', 'WARN', 'Level parsing reported warning counts', {
          invalidCount,
          swappedCount,
        }));
      } else {
        checks.push(_mkCheck('Levels', 'levels.parse.warnings', 'PASS', 'No level parsing warnings reported'));
      }
    } else {
      checks.push(_mkCheck('Levels', 'levels.diagnostics', 'WARN', 'Level diagnostics payload is unavailable'));
    }

    const worldSceneSummaries = Array.from(game?.scenes?.contents || [])
      .map((scene) => _collectSceneLevelFlagDiagnostics(scene))
      .filter((entry) => entry.levelsEnabled || entry.rawCount > 0);

    const worldLevelTotals = worldSceneSummaries.reduce((acc, entry) => {
      acc.rawCount += entry.rawCount;
      acc.parsedCount += entry.parsedCount;
      acc.invalidCount += entry.invalidCount;
      acc.swappedCount += entry.swappedCount;
      return acc;
    }, { rawCount: 0, parsedCount: 0, invalidCount: 0, swappedCount: 0 });

    if (worldSceneSummaries.length > 0) {
      checks.push(_mkCheck('Levels', 'levels.world.summary', 'PASS', `Scenes with Levels data: ${worldSceneSummaries.length}`, {
        totals: worldLevelTotals,
        scenes: worldSceneSummaries,
      }));
      if (worldLevelTotals.invalidCount > 0 || worldLevelTotals.swappedCount > 0) {
        checks.push(_mkCheck('Levels', 'levels.world.warnings', 'WARN', 'World-level scene flag parsing has warnings', {
          invalidCount: worldLevelTotals.invalidCount,
          swappedCount: worldLevelTotals.swappedCount,
        }));
      } else {
        checks.push(_mkCheck('Levels', 'levels.world.warnings', 'PASS', 'No world-level scene flag parsing warnings'));
      }
    } else {
      checks.push(_mkCheck('Levels', 'levels.world.summary', 'INFO', 'No scenes with Levels flags were detected in this world'));
    }

    const levelsModuleActive = game?.modules?.get?.('levels')?.active === true;
    const activeSceneSummary = _collectSceneLevelFlagDiagnostics(canvas?.scene || null);
    if (!levelsModuleActive && activeSceneSummary.rawCount > 0) {
      checks.push(_mkCheck('Levels', 'levels.importOnly.readiness', 'PASS', 'Levels module is disabled and active scene still has imported level flags', {
        activeScene: activeSceneSummary,
      }));
    } else if (!levelsModuleActive) {
      checks.push(_mkCheck('Levels', 'levels.importOnly.readiness', 'INFO', 'Levels module is disabled; active scene has no imported sceneLevels array'));
    } else {
      checks.push(_mkCheck('Levels', 'levels.importOnly.readiness', 'INFO', 'Levels module is active; import-only readiness check skipped'));
    }

    // --- Extended Levels diagnostics (MS-LVL-110/111) ---

    // Elevation context
    try {
      const perspective = getPerspectiveElevation();
      const bgElev = getSceneBackgroundElevation(canvas?.scene);
      checks.push(_mkCheck('Levels', 'levels.elevation.context', 'PASS', `Perspective: ${perspective.source} (elev=${perspective.elevation}, LOS=${perspective.losHeight})`, {
        ...perspective,
        backgroundElevation: bgElev,
      }));
    } catch (_) {
      checks.push(_mkCheck('Levels', 'levels.elevation.context', 'WARN', 'Failed to read elevation context'));
    }

    // Tile range flag summary for active scene
    try {
      const sceneTiles = canvas?.scene?.tiles;
      if (sceneTiles && sceneTiles.size > 0) {
        let tilesWithRange = 0;
        let basementCount = 0;
        let showIfAboveCount = 0;
        let noCollisionCount = 0;
        let noFogHideCount = 0;
        let allWallBlockSightCount = 0;
        for (const tileDoc of sceneTiles) {
          if (tileHasLevelsRange(tileDoc)) {
            tilesWithRange++;
            const flags = readTileLevelsFlags(tileDoc);
            if (flags.isBasement) basementCount++;
            if (flags.showIfAbove) showIfAboveCount++;
            if (flags.noCollision) noCollisionCount++;
            if (flags.noFogHide) noFogHideCount++;
            if (flags.allWallBlockSight) allWallBlockSightCount++;
          }
        }
        if (tilesWithRange > 0) {
          checks.push(_mkCheck('Levels', 'levels.tiles.rangeFlags', 'PASS', `Tiles with Levels range: ${tilesWithRange}/${sceneTiles.size}`, {
            total: sceneTiles.size,
            withRange: tilesWithRange,
            basement: basementCount,
            showIfAbove: showIfAboveCount,
            noCollision: noCollisionCount,
            noFogHide: noFogHideCount,
            allWallBlockSight: allWallBlockSightCount,
          }));

          if (noCollisionCount > 0) {
            checks.push(_mkCheck('Levels', 'levels.tiles.noCollision', 'PASS', `${noCollisionCount} tile(s) use noCollision — handled by elevation-plane collision (MS-LVL-033)`, {
              noCollisionTiles: noCollisionCount,
            }));
          }
          if (noFogHideCount > 0) {
            checks.push(_mkCheck('Levels', 'levels.tiles.noFogHide', 'PASS', `${noFogHideCount} tile(s) use noFogHide — fog mask suppression active (MS-LVL-034)`, {
              noFogHideTiles: noFogHideCount,
            }));
          }
          if (allWallBlockSightCount > 0) {
            checks.push(_mkCheck('Levels', 'levels.tiles.allWallBlockSight', 'PASS', `${allWallBlockSightCount} tile(s) use allWallBlockSight — vision override active (MS-LVL-035)`, {
              allWallBlockSightTiles: allWallBlockSightCount,
            }));
          }
        } else {
          checks.push(_mkCheck('Levels', 'levels.tiles.rangeFlags', 'INFO', `No tiles with Levels range flags (${sceneTiles.size} tiles total)`));
        }
      }
    } catch (_) {
    }

    // Wall-height flag summary for active scene
    try {
      const walls = canvas?.walls?.placeables;
      if (walls && walls.length > 0) {
        let wallsWithHeight = 0;
        for (const wall of walls) {
          if (wallHasHeightBounds(wall?.document)) wallsWithHeight++;
        }
        if (wallsWithHeight > 0) {
          checks.push(_mkCheck('Levels', 'levels.walls.heightFlags', 'PASS', `Walls with height bounds: ${wallsWithHeight}/${walls.length}`, {
            total: walls.length,
            withHeightBounds: wallsWithHeight,
          }));
        } else {
          checks.push(_mkCheck('Levels', 'levels.walls.heightFlags', 'INFO', `No walls with wall-height flags (${walls.length} walls total)`));
        }
      }
    } catch (_) {
    }

    // Per-scene import readiness score (MS-LVL-111)
    // Enhanced: checks 8 parity domains for comprehensive readiness assessment
    try {
      const scene = canvas?.scene;
      if (scene && isLevelsEnabledForScene(scene)) {
        const domains = [];
        const domainDetails = {};

        // Domain 1: sceneLevels bands
        const sceneLevels = readSceneLevelsFlag(scene);
        if (sceneLevels.length > 0) { domains.push('sceneLevels'); domainDetails.sceneLevelsCount = sceneLevels.length; }

        // Domain 2: backgroundElevation
        const bgElev = getSceneBackgroundElevation(scene);
        if (bgElev !== 0) { domains.push('backgroundElevation'); domainDetails.backgroundElevation = bgElev; }

        // Domain 3: weatherElevation
        const weatherElev = getSceneWeatherElevation(scene);
        if (Number.isFinite(weatherElev)) { domains.push('weatherElevation'); domainDetails.weatherElevation = weatherElev; }

        // Domain 4: lightMasking
        const lightMasking = getSceneLightMasking(scene);
        if (lightMasking !== true) { domains.push('lightMasking'); domainDetails.lightMasking = lightMasking; }

        // Domain 5: tile range flags
        let tilesWithRange = 0;
        for (const tileDoc of (scene.tiles || [])) {
          if (tileHasLevelsRange(tileDoc)) tilesWithRange++;
        }
        if (tilesWithRange > 0) { domains.push('tileRangeFlags'); domainDetails.tilesWithRange = tilesWithRange; }

        // Domain 6: wall-height flags
        let wallsWithHeight = 0;
        const wallPlaceables = canvas?.walls?.placeables || [];
        for (const wall of wallPlaceables) {
          if (wallHasHeightBounds(wall?.document)) wallsWithHeight++;
        }
        if (wallsWithHeight > 0) { domains.push('wallHeightFlags'); domainDetails.wallsWithHeight = wallsWithHeight; }

        // Domain 7: doc elevation ranges (lights/sounds/notes with finite ranges)
        let docsWithRange = 0;
        for (const collection of [scene.lights, scene.sounds, scene.notes]) {
          if (!collection) continue;
          for (const doc of collection) {
            const r = readDocLevelsRange(doc);
            if (Number.isFinite(r.rangeBottom) || Number.isFinite(r.rangeTop)) docsWithRange++;
          }
        }
        if (docsWithRange > 0) { domains.push('docRangeFlags'); domainDetails.docsWithRange = docsWithRange; }

        // Domain 8: legacy drawing stairs
        let drawingStairs = 0;
        for (const drawingDoc of (scene.drawings || [])) {
          const dm = Number(drawingDoc?.flags?.levels?.drawingMode ?? 0);
          if (dm === 2 || dm === 3 || dm === 21 || dm === 22) drawingStairs++;
        }
        if (drawingStairs > 0) { domains.push('legacyDrawingStairs'); domainDetails.drawingStairs = drawingStairs; }

        const score = domains.length;
        const maxScore = 8;
        const status = score >= 3 ? 'PASS' : (score >= 1 ? 'INFO' : 'WARN');
        checks.push(_mkCheck('Levels', 'levels.scene.readiness', status, `Import readiness: ${score}/${maxScore} domains populated`, {
          score,
          maxScore,
          domains,
          ...domainDetails,
        }));

        // Actionable readiness verdict
        const levelsActive = game?.modules?.get?.('levels')?.active === true;
        if (!levelsActive && score >= 3) {
          checks.push(_mkCheck('Levels', 'levels.scene.verdict', 'PASS', 'Scene is ready for import-only mode (Levels runtime not required)'));
        } else if (!levelsActive && score >= 1) {
          checks.push(_mkCheck('Levels', 'levels.scene.verdict', 'INFO', 'Scene has some Levels data; import-only mode should work but coverage is limited'));
        } else if (levelsActive) {
          checks.push(_mkCheck('Levels', 'levels.scene.verdict', 'INFO', 'Levels module is active; readiness check is informational only'));
        }
      }
    } catch (_) {
    }

    // Snapshot store status (MS-LVL-016)
    try {
      const snapshot = peekSnapshot();
      if (snapshot) {
        checks.push(_mkCheck('Levels', 'levels.snapshot.available', 'PASS', 'LevelsImportSnapshot is cached and available', {
          sceneId: snapshot.sceneId,
          sceneLevelsCount: snapshot.sceneLevels?.length ?? 0,
          tileCount: snapshot.tiles?.length ?? 0,
          wallCount: snapshot.walls?.length ?? 0,
          diagnostics: snapshot.diagnostics ?? null,
        }));
      } else {
        checks.push(_mkCheck('Levels', 'levels.snapshot.available', 'INFO', 'No LevelsImportSnapshot cached (scene may not have Levels data)'));
      }
    } catch (_) {
      checks.push(_mkCheck('Levels', 'levels.snapshot.available', 'WARN', 'Failed to read LevelsImportSnapshot'));
    }

    // API facade status (MS-LVL-090)
    try {
      const facadeActive = globalThis.CONFIG?.Levels?.API?._mapShineFacade === true;
      const realLevelsApi = globalThis.CONFIG?.Levels?.API && !globalThis.CONFIG?.Levels?.API?._mapShineFacade;
      if (facadeActive) {
        checks.push(_mkCheck('Levels', 'levels.api.facade', 'PASS', 'Map Shine Levels API facade is active at CONFIG.Levels.API'));
      } else if (realLevelsApi) {
        checks.push(_mkCheck('Levels', 'levels.api.facade', 'INFO', 'Real Levels API is active (facade not needed)'));
      } else {
        checks.push(_mkCheck('Levels', 'levels.api.facade', 'INFO', 'No Levels API facade installed (mode may be off or no callers)'));
      }
    } catch (_) {
    }

    // Flag-reader data-quality diagnostics (MS-LVL-015)
    try {
      const flagDiags = getFlagReaderDiagnostics();
      if (flagDiags.length > 0) {
        checks.push(_mkCheck('Levels', 'levels.flags.invalidValues', 'WARN', `${flagDiags.length} invalid flag value(s) replaced with defaults`, {
          count: flagDiags.length,
          recent: flagDiags.slice(-5).map(d => ({
            reader: d.reader,
            field: d.field,
            rawValue: String(d.rawValue),
            defaultUsed: String(d.defaultUsed),
            docId: d.docId ?? '(unknown)',
          })),
        }));
      } else {
        checks.push(_mkCheck('Levels', 'levels.flags.invalidValues', 'PASS', 'No invalid flag values detected'));
      }
    } catch (_) {
    }

    // Module conflict detection (MS-LVL-114)
    try {
      const conflicts = detectKnownModuleConflicts();
      if (conflicts.length > 0) {
        for (const conflict of conflicts) {
          const status = conflict.severity === 'warn' ? 'WARN' : 'INFO';
          checks.push(_mkCheck('Levels', `levels.conflict.${conflict.id}`, status,
            `${conflict.label}: ${conflict.overlap}`, {
              moduleId: conflict.id,
              severity: conflict.severity,
            }));
        }
      } else {
        checks.push(_mkCheck('Levels', 'levels.conflicts.none', 'PASS', 'No known module conflicts detected'));
      }
    } catch (_) {
    }

    // Resolve target.
    let targetKind = this._state.targetKind;
    let targetId = this._state.targetId;

    let src = '';
    let basePath = '';

    if (targetKind === 'tile') {
      const tileDoc = canvas?.scene?.tiles?.get?.(targetId);
      if (!tileDoc) {
        checks.push(_mkCheck('Tile', 'tile.exists', 'FAIL', `TileDocument not found for id=${targetId}`));
      } else {
        checks.push(_mkCheck('Tile', 'tile.exists', 'PASS', 'TileDocument found'));
        const s = tileDoc?.texture?.src ? String(tileDoc.texture.src).trim() : '';
        src = s;
        basePath = s ? _extractBasePath(s) : '';
        if (src) checks.push(_mkCheck('Tile', 'tile.texture.src', 'PASS', src));
        else checks.push(_mkCheck('Tile', 'tile.texture.src', 'FAIL', 'Tile has no texture src'));

        // Basic bypass flag.
        const moduleId = 'map-shine-advanced';
        const bypass = tileDoc?.getFlag?.(moduleId, 'bypassEffects') ?? tileDoc?.flags?.[moduleId]?.bypassEffects;
        if (bypass) {
          checks.push(_mkCheck('Flags', 'tile.flags.bypassEffects', 'WARN', 'Tile is set to bypass effects', { bypassEffects: true }));
        } else {
          checks.push(_mkCheck('Flags', 'tile.flags.bypassEffects', 'PASS', 'Tile is not bypassing effects', { bypassEffects: false }));
        }

        // Three sprite presence.
        try {
          const tm = ms?.tileManager;
          const sprite = tm?.tileSprites?.get?.(targetId)?.sprite || null;
          if (sprite) checks.push(_mkCheck('Three', 'three.sprite.exists', 'PASS', 'Three sprite exists for tile'));
          else checks.push(_mkCheck('Three', 'three.sprite.exists', 'FAIL', 'No Three sprite found for tile (TileManager may not have synced)'));
        } catch (e) {
          checks.push(_mkCheck('Three', 'three.sprite.exists', 'FAIL', 'Error checking tile Three sprite', { error: String(e?.message || e) }));
        }
      }
    } else if (targetKind === 'background') {
      const bgSrc = _getBackgroundSrc();
      if (!bgSrc) {
        checks.push(_mkCheck('Scene', 'scene.background.src', 'FAIL', 'Scene has no background src'));
      } else {
        src = bgSrc;
        basePath = _extractBasePath(bgSrc);
        checks.push(_mkCheck('Scene', 'scene.background.src', 'PASS', bgSrc));

        const hasBasePlane = !!ms?.sceneComposer?.getBasePlane?.();
        checks.push(_mkCheck('Three', 'three.background.exists', hasBasePlane ? 'PASS' : 'FAIL', hasBasePlane ? 'Base plane exists' : 'Base plane missing'));
      }

      // Surface registry entry.
      if (surfaceReport?.surfaces) {
        const entry = surfaceReport.surfaces.find((s) => s?.surfaceId === 'scene:background');
        if (entry) {
          checks.push(_mkCheck('Surface', 'surface.entry.exists', 'PASS', 'Surface report includes scene:background', entry));
        } else {
          checks.push(_mkCheck('Surface', 'surface.entry.exists', 'WARN', 'Surface report missing scene:background'));
        }
      } else {
        checks.push(_mkCheck('Surface', 'surface.report.exists', 'WARN', 'Surface report not available'));
      }
    }

    // BasePath / mask discovery (common).
    if (src) {
      checks.push(_mkCheck('Assets', 'asset.basePath', basePath ? 'PASS' : 'WARN', basePath || 'No basePath could be derived'));
    }

    const registry = getEffectMaskRegistry();
    const knownMaskIds = Object.keys(registry);

    // --- Shader compilation probe (best-effort) ---
    if (renderer && threeScene && threeCamera) {
      const compileTargets = [];
      compileTargets.push({ label: 'mainScene', scene: threeScene, camera: threeCamera });
      try {
        const effects = effectComposer?.effects;
        if (effects && typeof effects.values === 'function') {
          for (const effect of effects.values()) {
            if (!effect) continue;
            const s = effect.scene || effect._scene || null;
            const c = effect.camera || effect._camera || null;
            if (s && c) compileTargets.push({ label: effect.id || effect.key || effect.name || 'effectScene', scene: s, camera: c });
          }
        }
      } catch (_) {
      }

      let shaderProbeSummary = null;
      try {
        await _captureConsoleOutput(async (captured) => {
          for (const t of compileTargets) {
            try {
              renderer.compile(t.scene, t.camera);
            } catch (e) {
              captured.error.push(`[MapShine Diagnostic] compile(${t.label}) threw: ${String(e?.message || e)}`);
            }
          }
        });

        // Run again to get captured output (capture wrapper returns fn result; we use side-effects)
        shaderProbeSummary = await _captureConsoleOutput(async (captured) => {
          for (const t of compileTargets) {
            try {
              renderer.compile(t.scene, t.camera);
            } catch (e) {
              captured.error.push(`[MapShine Diagnostic] compile(${t.label}) threw: ${String(e?.message || e)}`);
            }
          }
          return _summarizeShaderErrors(captured);
        });
      } catch (e) {
        checks.push(_mkCheck('Shaders', 'shaders.compileProbe', 'WARN', 'Shader compile probe failed to run', {
          error: String(e?.message || e)
        }));
      }

      if (shaderProbeSummary) {
        const status = shaderProbeSummary.shaderLineCount > 0 ? 'FAIL' : 'PASS';
        const msg = shaderProbeSummary.shaderLineCount > 0
          ? `Shader compile/link errors detected (${shaderProbeSummary.shaderLineCount} line(s)). See details.`
          : 'No shader compile/link errors detected during compile sweep';
        checks.push(_mkCheck('Shaders', 'shaders.compileProbe', status, msg, {
          compileTargets: compileTargets.map((t) => t.label).slice(0, 40),
          ...shaderProbeSummary,
          shaderLines: shaderProbeSummary.shaderLines.slice(0, 20)
        }));
      }
    } else {
      checks.push(_mkCheck('Shaders', 'shaders.compileProbe', 'INFO', 'Shader compile probe skipped (renderer/scene/camera not available)'));
    }

    if (basePath) {
      try {
        const res = await loadAssetBundle(basePath, null, {
          skipBaseTexture: true,
          suppressProbeErrors: true,
          bypassCache: true
        });
        const masks = res?.bundle?.masks || [];
        const foundIds = new Set(masks.map((m) => String(m?.id || '')).filter(Boolean));

        if (Array.isArray(res?.warnings) && res.warnings.length) {
          checks.push(_mkCheck('Assets', 'asset.bundle.warnings', 'WARN', `Asset loader warnings: ${res.warnings.length}`, {
            warnings: res.warnings
          }));
        }

        checks.push(_mkCheck('Assets', 'asset.bundle.load', 'PASS', `Loaded mask bundle for ${basePath}`, {
          found: masks.map((m) => ({ id: m?.id, suffix: m?.suffix, path: m?.path }))
        }));

        // Report key masks explicitly.
        // IMPORTANT: loader mask ids are registry keys ('specular', 'water', ...), not suffix strings.
        const keyMaskIds = ['specular', 'roughness', 'normal', 'outdoors', 'fire', 'water'];
        for (const maskId of keyMaskIds) {
          const suffix = registry?.[maskId]?.suffix || '';
          const present = foundIds.has(maskId);
          if (present) {
            const entry = masks.find((m) => m?.id === maskId) || null;
            checks.push(_mkCheck('Assets', `asset.mask.loaded.${maskId}`, 'PASS', `Loaded ${suffix || maskId}`, {
              id: maskId,
              suffix,
              path: entry?.path ?? null
            }));
          } else {
            // Probe expected filenames to detect "exists but not loaded" failure points.
            let probe = null;
            if (suffix) {
              probe = await _probeMaskFile(basePath, suffix);
            }

            if (probe?.path) {
              checks.push(_mkCheck('Assets', `asset.mask.unloaded.${maskId}`, 'FAIL', `Mask file exists but was not loaded: ${suffix}`, {
                id: maskId,
                suffix,
                probedPath: probe.path
              }));
            } else {
              checks.push(_mkCheck('Assets', `asset.mask.missing.${maskId}`, 'INFO', `Missing ${suffix || maskId}`, {
                id: maskId,
                suffix
              }));
            }
          }
        }

        // Also report any unknown-to-registry masks.
        const unknown = Array.from(foundIds).filter((id) => !knownMaskIds.includes(id));
        if (unknown.length) {
          checks.push(_mkCheck('Assets', 'asset.mask.unknown', 'INFO', `Found ${unknown.length} unregistered mask(s)`, { unknown }));
        }
      } catch (e) {
        checks.push(_mkCheck('Assets', 'asset.bundle.load', 'FAIL', `Failed to load mask bundle for ${basePath}` , {
          error: String(e?.message || e)
        }));
      }
    } else if (src) {
      checks.push(_mkCheck('Assets', 'asset.bundle.load', 'SKIP', 'No basePath available; skipping mask bundle discovery'));
    }

    // Surface report existence.
    if (surfaceReport?.surfaces) {
      checks.push(_mkCheck('Surface', 'surface.report.exists', 'PASS', 'Surface report available'));

      if (targetKind === 'tile' && targetId) {
        const entry = surfaceReport.surfaces.find((s) => s?.surfaceId === targetId);
        if (entry) {
          checks.push(_mkCheck('Surface', 'surface.entry.exists', 'PASS', 'Surface report includes tile', entry));
        } else {
          checks.push(_mkCheck('Surface', 'surface.entry.exists', 'WARN', 'Surface report missing tile entry'));
        }
      }
    } else {
      checks.push(_mkCheck('Surface', 'surface.report.exists', 'WARN', 'Surface report not available'));
    }

    const summary = _summarizeChecks(checks);

    return {
      version: 2,
      time: now,
      target: {
        kind: targetKind,
        id: targetId,
        src,
        basePath
      },
      levelNavigation: {
        lockMode,
        activeContext,
        diagnostics,
        availableLevels: Array.isArray(availableLevels) ? availableLevels.length : 0,
      },
      worldLevels: {
        scenesWithFlags: worldSceneSummaries.length,
        totals: worldLevelTotals,
      },
      summary,
      checks
    };
  }

  _renderReport(report) {
    const root = this._reportRoot;
    if (!root) return;

    try {
      root.innerHTML = '';
    } catch (_) {
      // If innerHTML fails, we still attempt to append.
    }

    const header = document.createElement('div');
    header.style.display = 'flex';
    header.style.flexWrap = 'wrap';
    header.style.gap = '8px';
    header.style.alignItems = 'center';
    header.style.margin = '6px 6px 10px 6px';

    const mkChip = (text, bg, border) => {
      const chip = document.createElement('span');
      chip.textContent = String(text);
      chip.style.fontSize = '11px';
      chip.style.lineHeight = '1.0';
      chip.style.padding = '4px 8px';
      chip.style.borderRadius = '999px';
      chip.style.border = border || '1px solid rgba(255,255,255,0.12)';
      chip.style.background = bg || 'rgba(0,0,0,0.22)';
      chip.style.whiteSpace = 'nowrap';
      return chip;
    };

    const s = report?.summary || { pass: 0, warn: 0, fail: 0, info: 0 };
    header.appendChild(mkChip(`PASS ${s.pass}`, 'rgba(70, 200, 120, 0.10)', '1px solid rgba(70, 200, 120, 0.25)'));
    header.appendChild(mkChip(`WARN ${s.warn}`, 'rgba(255, 200, 80, 0.10)', '1px solid rgba(255, 200, 80, 0.25)'));
    header.appendChild(mkChip(`FAIL ${s.fail}`, 'rgba(255, 80, 80, 0.10)', '1px solid rgba(255, 80, 80, 0.25)'));
    header.appendChild(mkChip(`INFO ${s.info}`, 'rgba(255,255,255,0.06)'));

    const targetLine = document.createElement('div');
    targetLine.style.flex = '1 1 100%';
    targetLine.style.opacity = '0.85';
    targetLine.style.fontSize = '11px';
    targetLine.style.whiteSpace = 'pre-wrap';
    targetLine.textContent = `Target: ${report?.target?.kind || '—'} | ${report?.target?.id || '—'}\n${report?.target?.src || ''}`;

    root.appendChild(header);
    root.appendChild(targetLine);

    const groups = new Map();
    for (const c of (report?.checks || [])) {
      const cat = String(c?.category || 'Other');
      if (!groups.has(cat)) groups.set(cat, []);
      groups.get(cat).push(c);
    }

    const order = ['Shaders', 'Runtime', 'Levels', 'Tile', 'Scene', 'Flags', 'Three', 'Surface', 'Assets', 'Other'];
    const cats = Array.from(groups.keys());
    cats.sort((a, b) => {
      const ai = order.indexOf(a);
      const bi = order.indexOf(b);
      if (ai !== -1 || bi !== -1) return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi);
      return a.localeCompare(b);
    });

    const mkRow = (check) => {
      const row = document.createElement('div');
      row.style.margin = '6px 6px';
      row.style.padding = '6px 8px';
      row.style.borderRadius = '10px';
      row.style.border = '1px solid rgba(255,255,255,0.10)';
      row.style.background = 'rgba(255,255,255,0.03)';

      const st = String(check?.status || 'INFO').toUpperCase();
      if (st === 'FAIL') {
        row.style.border = '1px solid rgba(255,80,80,0.30)';
        row.style.background = 'rgba(255,80,80,0.06)';
      } else if (st === 'WARN') {
        row.style.border = '1px solid rgba(255,200,80,0.28)';
        row.style.background = 'rgba(255,200,80,0.05)';
      } else if (st === 'PASS') {
        row.style.border = '1px solid rgba(70,200,120,0.20)';
        row.style.background = 'rgba(70,200,120,0.04)';
      }

      const top = document.createElement('div');
      top.style.display = 'flex';
      top.style.gap = '8px';
      top.style.alignItems = 'baseline';

      const badge = document.createElement('span');
      badge.textContent = st;
      badge.style.fontSize = '10px';
      badge.style.fontWeight = '700';
      badge.style.opacity = '0.9';
      badge.style.padding = '2px 6px';
      badge.style.borderRadius = '999px';
      badge.style.border = '1px solid rgba(255,255,255,0.14)';
      badge.style.background = 'rgba(0,0,0,0.18)';

      const id = document.createElement('span');
      id.textContent = String(check?.id || '');
      id.style.fontSize = '11px';
      id.style.opacity = '0.85';

      top.appendChild(badge);
      top.appendChild(id);

      const msg = document.createElement('div');
      msg.textContent = String(check?.message || '');
      msg.style.fontSize = '12px';
      msg.style.opacity = '0.95';
      msg.style.marginTop = '4px';
      msg.style.whiteSpace = 'pre-wrap';

      row.appendChild(top);
      row.appendChild(msg);

      if (check?.details !== undefined) {
        const details = document.createElement('pre');
        details.textContent = JSON.stringify(check.details, null, 2);
        details.style.margin = '6px 0 0 0';
        details.style.padding = '6px 8px';
        details.style.borderRadius = '8px';
        details.style.border = '1px solid rgba(255,255,255,0.08)';
        details.style.background = 'rgba(0,0,0,0.18)';
        details.style.fontSize = '10px';
        details.style.opacity = '0.85';
        details.style.maxHeight = '140px';
        details.style.overflow = 'auto';
        row.appendChild(details);
      }

      return row;
    };

    for (const cat of cats) {
      const catHeader = document.createElement('div');
      catHeader.textContent = cat;
      catHeader.style.margin = '14px 6px 6px 6px';
      catHeader.style.fontSize = '12px';
      catHeader.style.fontWeight = '700';
      catHeader.style.opacity = '0.9';
      root.appendChild(catHeader);

      const list = groups.get(cat) || [];
      for (const c of list) root.appendChild(mkRow(c));
    }
  }
}
