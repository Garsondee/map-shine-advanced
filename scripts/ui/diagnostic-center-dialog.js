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

        addGridButton('Rebuild Floor Masks', async () => {
          try {
            const compositor = window.MapShine?.maskCompositor;
            if (compositor && typeof compositor.rebuildMasksForActiveLevel === 'function') {
              await compositor.rebuildMasksForActiveLevel();
              ui?.notifications?.info?.('Map Shine: Floor masks rebuilt');
            } else {
              ui?.notifications?.warn?.('Map Shine: Compositor not available');
            }
          } catch (e) {
            ui?.notifications?.warn?.('Map Shine: Failed to rebuild floor masks (see console)');
            console.warn('[MapShine] Failed to rebuild floor masks', e);
          }
        });

        addGridButton('Force Render', async () => {
          try {
            const renderLoop = window.MapShine?.renderLoop;
            if (renderLoop && typeof renderLoop.requestContinuousRender === 'function') {
              renderLoop.requestContinuousRender(100);
              ui?.notifications?.info?.('Map Shine: Render refresh triggered');
            } else {
              ui?.notifications?.warn?.('Map Shine: RenderLoop not available');
            }
          } catch (e) {
            ui?.notifications?.warn?.('Map Shine: Failed to force render (see console)');
            console.warn('[MapShine] Failed to force render', e);
          }
        });

        addGridButton('Clear Movement Locks', async () => {
          try {
            const movementManager = window.MapShine?.tokenMovementManager;
            if (movementManager) {
              movementManager._tokenMoveLocks?.clear?.();
              movementManager._groupMoveLocks?.clear?.();
              ui?.notifications?.info?.('Map Shine: Movement locks cleared');
            } else {
              ui?.notifications?.warn?.('Map Shine: Movement manager not available');
            }
          } catch (e) {
            ui?.notifications?.warn?.('Map Shine: Failed to clear movement locks (see console)');
            console.warn('[MapShine] Failed to clear movement locks', e);
          }
        }, true);

        addGridButton('Export Markdown', async () => {
          if (!this._lastReport) {
            ui?.notifications?.warn?.('Diagnostic Center: no report yet');
            return;
          }
          const markdown = this._exportAsMarkdown(this._lastReport);
          await _copyTextToClipboard(markdown, 'Markdown report copied to clipboard');
        });

        addGridButton('Export HTML', async () => {
          if (!this._lastReport) {
            ui?.notifications?.warn?.('Diagnostic Center: no report yet');
            return;
          }
          const html = this._exportAsHTML(this._lastReport);
          await _copyTextToClipboard(html, 'HTML report copied to clipboard');
        });

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
    const floorStack = ms?.floorStack || null;
    const floorLayerManager = ms?.floorLayerManager || null;
    const floorRenderBus = ms?.floorRenderBus || null;
    const activeContext = levelController?.getActiveLevelContext?.() || ms?.activeLevelContext || null;
    const availableLevels = levelController?.getAvailableLevels?.() || ms?.availableLevels || [];
    const diagnostics = levelController?.getLevelDiagnostics?.() || ms?.levelNavigationDiagnostics || null;
    const lockMode = levelController?.getLockMode?.() || activeContext?.lockMode || 'manual';
    const gameplayMode = Boolean(ms?.sceneComposer && ms?.isMapMakerMode !== true);
    const levelsInterop = detectLevelsRuntimeInteropState({ gameplayMode });
    const compatibilityMode = getLevelsCompatibilityMode();

    // --- Performance & Frame Timing ---
    try {
      const renderLoop = ms?.renderLoop;
      if (renderLoop) {
        const fps = renderLoop.fps ?? 0;
        const frameCount = renderLoop.frameCount ?? 0;
        const lastFrameTime = renderLoop.lastFrameTime ?? 0;
        const timeSinceLastFrame = now - lastFrameTime;
        const isRunning = renderLoop.isRunning ?? false;
        
        const fpsStatus = fps < 20 ? 'WARN' : (fps < 40 ? 'INFO' : 'PASS');
        checks.push(_mkCheck('Performance', 'perf.fps', fpsStatus, `FPS: ${fps.toFixed(1)} (${frameCount} frames)`, {
          fps,
          frameCount,
          timeSinceLastFrame: timeSinceLastFrame.toFixed(1),
          isRunning,
        }));

        // Render mode detection
        const continuousUntil = renderLoop._continuousRenderUntilMs ?? 0;
        const isContinuous = continuousUntil > now;
        const mode = isContinuous ? 'continuous' : 'adaptive';
        checks.push(_mkCheck('Performance', 'perf.renderMode', 'INFO', `Render mode: ${mode}`, {
          mode,
          continuousUntilMs: continuousUntil > now ? continuousUntil : null,
        }));
      } else {
        checks.push(_mkCheck('Performance', 'perf.fps', 'WARN', 'RenderLoop not available'));
      }
    } catch (e) {
      checks.push(_mkCheck('Performance', 'perf.fps', 'WARN', 'Failed to read performance metrics', {
        error: String(e?.message || e)
      }));
    }

    // Adaptive decimation state
    try {
      if (effectComposer) {
        const decimationActive = effectComposer._decimationActive ?? false;
        const avgFrameTime = effectComposer._avgFrameTimeMs ?? 0;
        const status = decimationActive ? 'WARN' : 'PASS';
        checks.push(_mkCheck('Performance', 'perf.decimation', status, 
          decimationActive ? `Adaptive decimation ACTIVE (avg frame: ${avgFrameTime.toFixed(1)}ms)` : 'Adaptive decimation inactive',
          {
            active: decimationActive,
            avgFrameTimeMs: avgFrameTime,
            enterThresholdMs: effectComposer._decimationEnterMs ?? 20,
            exitThresholdMs: effectComposer._decimationExitMs ?? 14,
          }));
      }
    } catch (_) {}

    // --- Pipeline mode ---
    try {
      const v2Enabled = Boolean(effectComposer?._floorCompositorV2);
      const floorLoopEnabled = false;
      const modeLabel = 'V2 compositor';
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

      // Render target health
      try {
        const rts = effectComposer.renderTargets || null;
        const sceneRT = effectComposer.sceneRenderTarget || null;
        const viewportWidth = renderer?.domElement?.width ?? 0;
        const viewportHeight = renderer?.domElement?.height ?? 0;
        
        let totalRTMemory = 0;
        let rtDetails = [];
        if (rts && typeof rts.forEach === 'function') {
          rts.forEach((rt, key) => {
            if (!rt) return;
            const w = rt.width ?? 0;
            const h = rt.height ?? 0;
            const hasDepth = Boolean(rt.depthBuffer);
            const bytes = w * h * (hasDepth ? 8 : 4); // Rough estimate
            totalRTMemory += bytes;
            rtDetails.push({ key, width: w, height: h, depthBuffer: hasDepth, bytes });
          });
        }
        
        if (sceneRT) {
          const w = sceneRT.width ?? 0;
          const h = sceneRT.height ?? 0;
          const hasDepth = Boolean(sceneRT.depthBuffer);
          const bytes = w * h * (hasDepth ? 8 : 4);
          totalRTMemory += bytes;
        }
        
        const sizeMismatch = sceneRT && (sceneRT.width !== viewportWidth || sceneRT.height !== viewportHeight);
        const status = sizeMismatch ? 'WARN' : 'PASS';
        
        checks.push(_mkCheck('Runtime', 'runtime.renderTargets.summary', status, 
          `Composer RTs: ${rts?.size ?? 0} (${(totalRTMemory / 1024 / 1024).toFixed(1)} MB)`, {
          mapSize: rts?.size ?? 0,
          totalMemoryMB: (totalRTMemory / 1024 / 1024).toFixed(2),
          sceneRenderTarget: sceneRT ? { 
            width: sceneRT.width, 
            height: sceneRT.height, 
            depthBuffer: Boolean(sceneRT.depthBuffer),
            matchesViewport: !sizeMismatch,
          } : null,
          viewportSize: { width: viewportWidth, height: viewportHeight },
          topRTs: rtDetails.sort((a, b) => b.bytes - a.bytes).slice(0, 10),
        }));
        
        if (sizeMismatch) {
          checks.push(_mkCheck('Runtime', 'runtime.renderTargets.sizeMismatch', 'WARN', 
            `Scene RT size mismatch: ${sceneRT.width}x${sceneRT.height} vs viewport ${viewportWidth}x${viewportHeight}`));
        }
      } catch (_) {
      }
    } else {
      checks.push(_mkCheck('Runtime', 'runtime.effects.summary', 'WARN', 'EffectComposer not found; effects may not be initialized'));
    }

    // --- Asset Cache Statistics ---
    try {
      const cacheStats = typeof getAssetCacheStats === 'function' ? getAssetCacheStats() : null;
      if (cacheStats) {
        const totalTextures = cacheStats.textureCount ?? 0;
        const totalBytes = cacheStats.totalBytes ?? 0;
        const hitRate = cacheStats.hitRate ?? 0;
        
        checks.push(_mkCheck('Assets', 'assets.cache.stats', 'PASS', 
          `Cache: ${totalTextures} textures (${(totalBytes / 1024 / 1024).toFixed(1)} MB, ${(hitRate * 100).toFixed(1)}% hit rate)`, {
          textureCount: totalTextures,
          totalMB: (totalBytes / 1024 / 1024).toFixed(2),
          hitRate: (hitRate * 100).toFixed(1),
          hits: cacheStats.hits ?? 0,
          misses: cacheStats.misses ?? 0,
          evictions: cacheStats.evictions ?? 0,
        }));
      } else {
        checks.push(_mkCheck('Assets', 'assets.cache.stats', 'INFO', 'Asset cache statistics not available'));
      }
    } catch (e) {
      checks.push(_mkCheck('Assets', 'assets.cache.stats', 'WARN', 'Failed to read asset cache stats', {
        error: String(e?.message || e)
      }));
    }

    // Texture budget tracking
    try {
      const budgetTracker = ms?.textureBudgetTracker;
      if (budgetTracker && typeof budgetTracker.getBudgetState === 'function') {
        const budget = budgetTracker.getBudgetState();
        const status = budget.overBudget ? 'WARN' : 'PASS';
        checks.push(_mkCheck('Assets', 'assets.budget', status, 
          `VRAM budget: ${(budget.usedBytes / 1024 / 1024).toFixed(1)} / ${(budget.budgetBytes / 1024 / 1024).toFixed(0)} MB (${(budget.usedFraction * 100).toFixed(1)}%)`, {
          usedMB: (budget.usedBytes / 1024 / 1024).toFixed(2),
          budgetMB: (budget.budgetBytes / 1024 / 1024).toFixed(0),
          usedFraction: (budget.usedFraction * 100).toFixed(1),
          overBudget: budget.overBudget,
          entryCount: budget.entryCount,
          topEntries: budget.topEntries?.slice(0, 5),
        }));
      }
    } catch (_) {}

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

    try {
      if (levelController) {
        const hasGetAvailable = typeof levelController.getAvailableLevels === 'function';
        const hasGetActive = typeof levelController.getActiveLevelContext === 'function';
        const hasGetDiagnostics = typeof levelController.getLevelDiagnostics === 'function';
        const hasSetActive = typeof levelController.setActiveLevel === 'function';
        const hasStep = typeof levelController.stepLevel === 'function';
        const hasSetLock = typeof levelController.setLockMode === 'function';
        const hasRefresh = typeof levelController.refreshLevelBands === 'function';
        const status = (hasGetAvailable && hasGetActive && hasGetDiagnostics && hasSetActive && hasStep && hasSetLock && hasRefresh)
          ? 'PASS'
          : 'WARN';
        checks.push(_mkCheck('Levels', 'levels.controller.api', status, 'Level controller API surface', {
          hasGetAvailable,
          hasGetActive,
          hasGetDiagnostics,
          hasSetActive,
          hasStep,
          hasSetLock,
          hasRefresh,
        }));
      }
    } catch (_) {
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

    try {
      if (Array.isArray(availableLevels) && availableLevels.length > 0) {
        const invalidLevels = [];
        const duplicateIds = new Set();
        const seenIds = new Set();
        for (let i = 0; i < availableLevels.length; i += 1) {
          const lvl = availableLevels[i] || {};
          const bottom = Number(lvl.bottom);
          const top = Number(lvl.top);
          const center = Number(lvl.center);
          const levelId = String(lvl.levelId || `idx-${i}`);
          if (!Number.isFinite(bottom) || !Number.isFinite(top) || !Number.isFinite(center) || bottom > top) {
            invalidLevels.push({ i, levelId, bottom: lvl.bottom, top: lvl.top, center: lvl.center });
          }
          if (seenIds.has(levelId)) duplicateIds.add(levelId);
          seenIds.add(levelId);
        }
        const status = (invalidLevels.length > 0 || duplicateIds.size > 0) ? 'WARN' : 'PASS';
        checks.push(_mkCheck('Levels', 'levels.available.quality', status,
          `Level list quality: ${availableLevels.length - invalidLevels.length}/${availableLevels.length} valid`, {
            count: availableLevels.length,
            invalidLevels,
            duplicateIds: Array.from(duplicateIds),
          }));
      }
    } catch (_) {
    }

    try {
      if (activeContext && Array.isArray(availableLevels) && availableLevels.length > 0) {
        const ctxIndex = Number(activeContext.index);
        const indexInRange = Number.isInteger(ctxIndex) && ctxIndex >= 0 && ctxIndex < availableLevels.length;
        const levelByIndex = indexInRange ? availableLevels[ctxIndex] : null;
        const idMatches = Boolean(levelByIndex && String(levelByIndex.levelId || '') === String(activeContext.levelId || ''));
        const status = (indexInRange && idMatches) ? 'PASS' : 'WARN';
        checks.push(_mkCheck('Levels', 'levels.context.consistency', status, 'Active context consistency against level list', {
          contextIndex: activeContext.index,
          contextLevelId: activeContext.levelId,
          levelCount: availableLevels.length,
          indexInRange,
          idMatches,
          indexedLevel: levelByIndex || null,
        }));
      }
    } catch (_) {
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

    // Generic doc range summary (lights/sounds/notes/drawings/templates)
    try {
      const scene = canvas?.scene;
      if (scene) {
        const collectionEntries = [
          ['lights', scene.lights],
          ['sounds', scene.sounds],
          ['notes', scene.notes],
          ['drawings', scene.drawings],
          ['templates', scene.templates],
        ];
        const byCollection = {};
        let rangedTotal = 0;
        let docsTotal = 0;
        for (const [name, collection] of collectionEntries) {
          let total = 0;
          let ranged = 0;
          if (collection) {
            for (const doc of collection) {
              total += 1;
              const r = readDocLevelsRange(doc);
              if (Number.isFinite(r.rangeBottom) || Number.isFinite(r.rangeTop)) {
                ranged += 1;
              }
            }
          }
          byCollection[name] = { total, ranged };
          docsTotal += total;
          rangedTotal += ranged;
        }
        const status = rangedTotal > 0 ? 'PASS' : 'INFO';
        checks.push(_mkCheck('Levels', 'levels.docs.rangeFlags', status,
          `Documents with Levels ranges: ${rangedTotal}/${docsTotal}`, {
            total: docsTotal,
            ranged: rangedTotal,
            byCollection,
          }));
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

    // --- Floor Rendering Pipeline ---
    try {
      const registry = ms?.effectMaskRegistry;
      const compositor = ms?.maskCompositor;
      
      if (floorStack) {
        const floors = floorStack._floors ?? [];
        const activeFloor = floorStack._activeFloorIndex ?? 0;
        const visibleFloors = floorStack.getVisibleFloors?.() ?? [];
        const activeBand = floorStack.getActiveFloor?.() || null;
        
        checks.push(_mkCheck('Floor', 'floor.stack', 'PASS', `Floors: ${floors.length} (active: ${activeFloor}, visible: ${visibleFloors.length})`, {
          totalFloors: floors.length,
          activeFloorIndex: activeFloor,
          visibleFloorCount: visibleFloors.length,
          activeBand,
          floors: floors.map((f, i) => ({
            index: i,
            elevationMin: f.elevationMin,
            elevationMax: f.elevationMax,
            compositorKey: f.compositorKey,
            isActive: f.isActive ?? false,
          })),
        }));

        if (activeContext && activeBand) {
          const matchesBand = Number(activeContext.bottom) === Number(activeBand.elevationMin)
            && Number(activeContext.top) === Number(activeBand.elevationMax);
          checks.push(_mkCheck('Floor', 'floor.stack.contextAlignment', matchesBand ? 'PASS' : 'WARN',
            matchesBand
              ? 'FloorStack active band matches active level context'
              : 'FloorStack active band differs from active level context', {
                activeContext: {
                  bottom: activeContext.bottom,
                  top: activeContext.top,
                  index: activeContext.index,
                },
                activeBand,
              }));
        }
      } else {
        checks.push(_mkCheck('Floor', 'floor.stack', 'INFO', 'FloorStack not available (single-level scene or V2 mode)'));
      }

      if (floorLayerManager) {
        const trackedSprites = floorLayerManager._spriteFloorMap?.size ?? 0;
        const hasFloorStack = Boolean(floorLayerManager._floorStack);
        checks.push(_mkCheck('Floor', 'floor.layerManager', trackedSprites > 0 ? 'PASS' : 'INFO',
          `FloorLayerManager tracking ${trackedSprites} sprite(s)`, {
            trackedSprites,
            hasFloorStack,
          }));
      }

      if (floorRenderBus) {
        const tileEntries = floorRenderBus._tiles;
        const sceneRef = floorRenderBus._scene;
        if (tileEntries && typeof tileEntries.forEach === 'function') {
          const perFloor = {};
          let total = 0;
          let overhead = 0;
          tileEntries.forEach((entry, key) => {
            if (String(key).startsWith('__')) return;
            total += 1;
            const fi = Number(entry?.floorIndex ?? 0);
            perFloor[fi] = (perFloor[fi] ?? 0) + 1;
            if (entry?.mesh?.userData?.isOverhead === true) overhead += 1;
          });
          checks.push(_mkCheck('Floor', 'floor.renderBus', total > 0 ? 'PASS' : 'INFO',
            `FloorRenderBus tiles: ${total} (overhead: ${overhead})`, {
              initialized: Boolean(floorRenderBus._initialized),
              total,
              overhead,
              perFloor,
              sceneChildren: sceneRef?.children?.length ?? 0,
            }));
        }
      }

      if (effectComposer?._floorCompositorV2) {
        const v2 = effectComposer._floorCompositorV2;
        const flm = v2._floorLayerManager || null;
        const frb = v2._renderBus || null;
        const status = (flm && frb) ? 'PASS' : 'WARN';
        checks.push(_mkCheck('Floor', 'floor.v2.pipeline', status, 'V2 floor compositor wiring', {
          hasFloorLayerManager: Boolean(flm),
          hasRenderBus: Boolean(frb),
          hasFloorStack: Boolean(v2._floorStack),
          hasSceneComposer: Boolean(v2._sceneComposer),
        }));
      }
      
      if (registry) {
        const metrics = typeof registry.getMetrics === 'function' ? registry.getMetrics() : null;
        if (metrics) {
          const occupiedSlots = metrics.occupiedSlots ?? 0;
          const totalSlots = metrics.totalSlots ?? 0;
          const transitionLocked = metrics.transitionLocked ?? false;
          
          checks.push(_mkCheck('Floor', 'floor.registry', transitionLocked ? 'WARN' : 'PASS', 
            `Mask registry: ${occupiedSlots}/${totalSlots} slots occupied`, {
            occupiedSlots,
            totalSlots,
            transitionLocked,
            activeMaskTypes: metrics.activeMaskTypes ?? [],
            transitionCount: metrics.transitionCount ?? 0,
          }));
          
          if (transitionLocked) {
            checks.push(_mkCheck('Floor', 'floor.registry.locked', 'WARN', 'Mask registry is locked (floor transition in progress)'));
          }
        }
      }
      
      if (compositor) {
        const activeFloorKey = compositor._activeFloorKey ?? null;
        const cacheSize = compositor._floorMaskCache?.size ?? 0;
        const floorMetaSize = compositor._floorMeta?.size ?? 0;
        const cpuCacheSize = compositor._cpuPixelCache?.size ?? 0;
        const belowFloorKey = compositor._belowFloorKey ?? null;
        
        checks.push(_mkCheck('Floor', 'floor.compositor', 'INFO', `Compositor: active floor "${activeFloorKey}", ${cacheSize} cached floors`, {
          activeFloorKey,
          cacheSize,
          floorMetaSize,
          cpuCacheSize,
          belowFloorKey,
        }));
      }
    } catch (e) {
      checks.push(_mkCheck('Floor', 'floor.pipeline', 'WARN', 'Failed to read floor pipeline state', {
        error: String(e?.message || e)
      }));
    }

    // Placeable elevation distribution across available levels (active scene)
    try {
      if (Array.isArray(availableLevels) && availableLevels.length > 0) {
        const bucketCounts = availableLevels.map((lvl, idx) => ({
          index: idx,
          levelId: lvl.levelId,
          label: lvl.label,
          tokenCount: 0,
          tileCount: 0,
        }));

        const findLevelIndex = (elev) => {
          const n = Number(elev);
          if (!Number.isFinite(n)) return -1;
          for (let i = 0; i < availableLevels.length; i += 1) {
            const lvl = availableLevels[i] || {};
            const bottom = Number(lvl.bottom);
            const top = Number(lvl.top);
            if (!Number.isFinite(bottom) || !Number.isFinite(top)) continue;
            if (n >= bottom && n <= top) return i;
          }
          return -1;
        };

        let unmatchedTokens = 0;
        for (const tokenDoc of (canvas?.scene?.tokens || [])) {
          const idx = findLevelIndex(tokenDoc?.elevation);
          if (idx >= 0) bucketCounts[idx].tokenCount += 1;
          else unmatchedTokens += 1;
        }

        let unmatchedTiles = 0;
        for (const tileDoc of (canvas?.scene?.tiles || [])) {
          const flags = readTileLevelsFlags(tileDoc);
          const sourceElevation = Number.isFinite(Number(flags.rangeBottom)) ? Number(flags.rangeBottom) : Number(tileDoc?.elevation ?? 0);
          const idx = findLevelIndex(sourceElevation);
          if (idx >= 0) bucketCounts[idx].tileCount += 1;
          else unmatchedTiles += 1;
        }

        const status = (unmatchedTokens === 0 && unmatchedTiles === 0) ? 'PASS' : 'INFO';
        checks.push(_mkCheck('Levels', 'levels.scene.distribution', status,
          `Scene placeable distribution mapped across ${availableLevels.length} level(s)`, {
            levels: bucketCounts,
            unmatchedTokens,
            unmatchedTiles,
          }));
      }
    } catch (_) {
    }

    // --- Scene Topology ---
    try {
      const scene = canvas?.scene;
      if (scene) {
        const tokens = scene.tokens?.size ?? 0;
        const tiles = scene.tiles?.size ?? 0;
        const walls = scene.walls?.size ?? 0;
        const lights = scene.lights?.size ?? 0;
        const sounds = scene.sounds?.size ?? 0;
        const drawings = scene.drawings?.size ?? 0;
        const templates = scene.templates?.size ?? 0;
        const notes = scene.notes?.size ?? 0;
        
        checks.push(_mkCheck('Scene', 'scene.topology', 'INFO', 
          `Scene objects: ${tokens + tiles + walls + lights + sounds + drawings + templates + notes} total`, {
          tokens,
          tiles,
          walls,
          lights,
          sounds,
          drawings,
          templates,
          notes,
        }));
      }
      
      // Three.js scene graph
      if (threeScene) {
        let meshCount = 0;
        let spriteCount = 0;
        let lightCount = 0;
        let totalChildren = 0;
        
        threeScene.traverse((obj) => {
          totalChildren++;
          if (obj.isMesh) meshCount++;
          if (obj.isSprite) spriteCount++;
          if (obj.isLight) lightCount++;
        });
        
        checks.push(_mkCheck('Scene', 'scene.threeGraph', 'INFO', 
          `Three.js graph: ${totalChildren} objects (${meshCount} meshes, ${spriteCount} sprites, ${lightCount} lights)`, {
          totalChildren,
          meshCount,
          spriteCount,
          lightCount,
        }));
      }
    } catch (e) {
      checks.push(_mkCheck('Scene', 'scene.topology', 'WARN', 'Failed to read scene topology', {
        error: String(e?.message || e)
      }));
    }

    // --- Time of Day & Weather ---
    try {
      const weatherController = ms?.weatherController;
      const stateApplier = ms?.stateApplier;
      
      if (weatherController) {
        const weather = weatherController.getWeatherState?.() ?? {};
        const precipitation = weather.precipitation ?? 0;
        const windSpeed = weather.windSpeed ?? 0;
        const cloudCoverage = weather.cloudCoverage ?? 0;
        
        checks.push(_mkCheck('Environment', 'env.weather', 'INFO', 
          `Weather: ${(precipitation * 100).toFixed(0)}% precip, ${(windSpeed * 100).toFixed(0)}% wind, ${(cloudCoverage * 100).toFixed(0)}% clouds`, {
          precipitation,
          windSpeed,
          cloudCoverage,
          windDirection: weather.windDirection ?? 0,
        }));
      }
      
      if (stateApplier) {
        const timeState = stateApplier.getTimeState?.() ?? {};
        const hour = timeState.hour ?? 12;
        const darkness = canvas?.scene?.darkness ?? 0;
        const linkedToFoundry = timeState.linkedToFoundry ?? false;
        
        checks.push(_mkCheck('Environment', 'env.time', 'INFO', 
          `Time: ${hour.toFixed(1)}h (darkness: ${(darkness * 100).toFixed(0)}%, Foundry link: ${linkedToFoundry ? 'ON' : 'OFF'})`, {
          hour,
          darkness,
          linkedToFoundry,
        }));
      }
    } catch (e) {
      checks.push(_mkCheck('Environment', 'env.state', 'WARN', 'Failed to read environment state', {
        error: String(e?.message || e)
      }));
    }

    // --- Pathfinding & Movement ---
    try {
      const movementManager = ms?.tokenMovementManager;
      if (movementManager) {
        const navGraphCache = movementManager._sceneNavGraphCache;
        const doorStateRevision = movementManager._doorStateRevision ?? 0;
        const activeTokenLocks = movementManager._tokenMoveLocks?.size ?? 0;
        const activeGroupLocks = movementManager._groupMoveLocks?.size ?? 0;
        
        checks.push(_mkCheck('Movement', 'movement.pathfinding', 'INFO', 
          `Pathfinding: ${navGraphCache?.size ?? 0} cached graphs, door rev ${doorStateRevision}`, {
          cachedGraphs: navGraphCache?.size ?? 0,
          doorStateRevision,
          activeTokenLocks,
          activeGroupLocks,
        }));
        
        if (activeTokenLocks > 0 || activeGroupLocks > 0) {
          checks.push(_mkCheck('Movement', 'movement.locks', 'WARN', 
            `Active movement locks: ${activeTokenLocks} tokens, ${activeGroupLocks} groups (may indicate stuck movements)`, {
            tokenLocks: activeTokenLocks,
            groupLocks: activeGroupLocks,
          }));
        }
      }
    } catch (e) {
      checks.push(_mkCheck('Movement', 'movement.state', 'WARN', 'Failed to read movement state', {
        error: String(e?.message || e)
      }));
    }

    // --- Input & Interaction ---
    try {
      const inputRouter = ms?.inputRouter;
      const interactionManager = ms?.interactionManager;
      
      if (inputRouter) {
        const mode = inputRouter._mode ?? 'unknown';
        checks.push(_mkCheck('Input', 'input.router', 'INFO', `Input mode: ${mode}`, {
          mode,
        }));
      }
      
      if (interactionManager) {
        const dragState = interactionManager._dragState ?? {};
        const isDragging = dragState.active ?? false;
        
        if (isDragging) {
          checks.push(_mkCheck('Input', 'input.drag', 'INFO', 'Drag operation in progress', {
            dragType: dragState.type ?? 'unknown',
            dragStartTime: dragState.startTime ?? null,
          }));
        }
      }
      
      // Active tool/layer
      const activeTool = ui?.controls?.activeControl ?? 'unknown';
      const activeLayer = canvas?.activeLayer?.constructor?.name ?? 'unknown';
      
      checks.push(_mkCheck('Input', 'input.context', 'INFO', `Active: ${activeTool} tool, ${activeLayer} layer`, {
        activeTool,
        activeLayer,
      }));
    } catch (e) {
      checks.push(_mkCheck('Input', 'input.state', 'WARN', 'Failed to read input state', {
        error: String(e?.message || e)
      }));
    }

    // --- Memory Leak Detection ---
    try {
      let disposedTextureRefs = 0;
      let orphanedRTs = 0;
      
      // Check for disposed textures still referenced
      if (effectComposer?.renderTargets) {
        effectComposer.renderTargets.forEach((rt) => {
          if (rt?.texture?.image === null || rt?.texture?.image === undefined) {
            disposedTextureRefs++;
          }
        });
      }
      
      if (disposedTextureRefs > 0) {
        checks.push(_mkCheck('Memory', 'memory.disposedTextures', 'WARN', 
          `${disposedTextureRefs} render target(s) may reference disposed textures`, {
          count: disposedTextureRefs,
        }));
      } else {
        checks.push(_mkCheck('Memory', 'memory.disposedTextures', 'PASS', 'No disposed texture references detected'));
      }
    } catch (e) {
      checks.push(_mkCheck('Memory', 'memory.leaks', 'WARN', 'Failed to check for memory leaks', {
        error: String(e?.message || e)
      }));
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

    const order = ['Performance', 'Runtime', 'Shaders', 'Assets', 'Floor', 'Scene', 'Environment', 'Movement', 'Input', 'Memory', 'Levels', 'Tile', 'Flags', 'Three', 'Surface', 'Other'];
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

  /**
   * Export report as Markdown
   * @private
   */
  _exportAsMarkdown(report) {
    const lines = [];
    const s = report?.summary || { pass: 0, warn: 0, fail: 0, info: 0 };
    
    lines.push('# Map Shine Diagnostic Report');
    lines.push('');
    lines.push(`**Generated:** ${new Date(report.time).toISOString()}`);
    lines.push(`**Target:** ${report?.target?.kind || '—'} | ${report?.target?.id || '—'}`);
    if (report?.target?.src) {
      lines.push(`**Source:** ${report.target.src}`);
    }
    lines.push('');
    lines.push('## Summary');
    lines.push('');
    lines.push(`- ✅ PASS: ${s.pass}`);
    lines.push(`- ⚠️ WARN: ${s.warn}`);
    lines.push(`- ❌ FAIL: ${s.fail}`);
    lines.push(`- ℹ️ INFO: ${s.info}`);
    lines.push('');
    
    const groups = new Map();
    for (const c of (report?.checks || [])) {
      const cat = String(c?.category || 'Other');
      if (!groups.has(cat)) groups.set(cat, []);
      groups.get(cat).push(c);
    }
    
    const order = ['Performance', 'Runtime', 'Shaders', 'Assets', 'Floor', 'Scene', 'Environment', 'Movement', 'Input', 'Memory', 'Levels', 'Tile', 'Flags', 'Three', 'Surface', 'Other'];
    const cats = Array.from(groups.keys());
    cats.sort((a, b) => {
      const ai = order.indexOf(a);
      const bi = order.indexOf(b);
      if (ai !== -1 || bi !== -1) return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi);
      return a.localeCompare(b);
    });
    
    for (const cat of cats) {
      lines.push(`## ${cat}`);
      lines.push('');
      
      const list = groups.get(cat) || [];
      for (const c of list) {
        const status = String(c?.status || 'INFO').toUpperCase();
        const emoji = status === 'PASS' ? '✅' : status === 'WARN' ? '⚠️' : status === 'FAIL' ? '❌' : 'ℹ️';
        lines.push(`### ${emoji} ${c.id}`);
        lines.push('');
        lines.push(`**Status:** ${status}`);
        lines.push(`**Message:** ${c.message || ''}`);
        
        if (c?.details !== undefined) {
          lines.push('');
          lines.push('**Details:**');
          lines.push('```json');
          lines.push(JSON.stringify(c.details, null, 2));
          lines.push('```');
        }
        lines.push('');
      }
    }
    
    return lines.join('\n');
  }

  /**
   * Export report as HTML
   * @private
   */
  _exportAsHTML(report) {
    const s = report?.summary || { pass: 0, warn: 0, fail: 0, info: 0 };
    const html = [];
    
    html.push('<!DOCTYPE html>');
    html.push('<html lang="en">');
    html.push('<head>');
    html.push('<meta charset="UTF-8">');
    html.push('<meta name="viewport" content="width=device-width, initial-scale=1.0">');
    html.push('<title>Map Shine Diagnostic Report</title>');
    html.push('<style>');
    html.push('body { font-family: system-ui, -apple-system, sans-serif; max-width: 1200px; margin: 0 auto; padding: 20px; background: #1a1a1a; color: #e0e0e0; }');
    html.push('h1 { color: #fff; border-bottom: 2px solid #444; padding-bottom: 10px; }');
    html.push('h2 { color: #fff; margin-top: 30px; border-bottom: 1px solid #333; padding-bottom: 8px; }');
    html.push('h3 { color: #ccc; margin-top: 20px; }');
    html.push('.summary { display: flex; gap: 15px; margin: 20px 0; }');
    html.push('.chip { padding: 8px 16px; border-radius: 20px; font-weight: 600; }');
    html.push('.chip.pass { background: rgba(70, 200, 120, 0.15); border: 1px solid rgba(70, 200, 120, 0.3); color: #46c878; }');
    html.push('.chip.warn { background: rgba(255, 200, 80, 0.15); border: 1px solid rgba(255, 200, 80, 0.3); color: #ffc850; }');
    html.push('.chip.fail { background: rgba(255, 80, 80, 0.15); border: 1px solid rgba(255, 80, 80, 0.3); color: #ff5050; }');
    html.push('.chip.info { background: rgba(255, 255, 255, 0.08); border: 1px solid rgba(255, 255, 255, 0.15); color: #aaa; }');
    html.push('.check { margin: 15px 0; padding: 15px; border-radius: 10px; border: 1px solid #333; background: rgba(255,255,255,0.03); }');
    html.push('.check.pass { border-color: rgba(70, 200, 120, 0.25); background: rgba(70, 200, 120, 0.05); }');
    html.push('.check.warn { border-color: rgba(255, 200, 80, 0.3); background: rgba(255, 200, 80, 0.06); }');
    html.push('.check.fail { border-color: rgba(255, 80, 80, 0.35); background: rgba(255, 80, 80, 0.08); }');
    html.push('.status-badge { display: inline-block; padding: 3px 10px; border-radius: 12px; font-size: 11px; font-weight: 700; background: rgba(0,0,0,0.3); border: 1px solid rgba(255,255,255,0.2); margin-right: 8px; }');
    html.push('.details { margin-top: 10px; padding: 10px; background: rgba(0,0,0,0.3); border: 1px solid rgba(255,255,255,0.1); border-radius: 8px; font-family: monospace; font-size: 12px; overflow-x: auto; }');
    html.push('pre { margin: 0; white-space: pre-wrap; }');
    html.push('.meta { color: #888; font-size: 14px; margin: 10px 0; }');
    html.push('</style>');
    html.push('</head>');
    html.push('<body>');
    
    html.push('<h1>Map Shine Diagnostic Report</h1>');
    html.push(`<div class="meta"><strong>Generated:</strong> ${new Date(report.time).toLocaleString()}</div>`);
    html.push(`<div class="meta"><strong>Target:</strong> ${report?.target?.kind || '—'} | ${report?.target?.id || '—'}</div>`);
    if (report?.target?.src) {
      html.push(`<div class="meta"><strong>Source:</strong> ${this._escapeHtml(report.target.src)}</div>`);
    }
    
    html.push('<div class="summary">');
    html.push(`<div class="chip pass">✅ PASS ${s.pass}</div>`);
    html.push(`<div class="chip warn">⚠️ WARN ${s.warn}</div>`);
    html.push(`<div class="chip fail">❌ FAIL ${s.fail}</div>`);
    html.push(`<div class="chip info">ℹ️ INFO ${s.info}</div>`);
    html.push('</div>');
    
    const groups = new Map();
    for (const c of (report?.checks || [])) {
      const cat = String(c?.category || 'Other');
      if (!groups.has(cat)) groups.set(cat, []);
      groups.get(cat).push(c);
    }
    
    const order = ['Performance', 'Runtime', 'Shaders', 'Assets', 'Floor', 'Scene', 'Environment', 'Movement', 'Input', 'Memory', 'Levels', 'Tile', 'Flags', 'Three', 'Surface', 'Other'];
    const cats = Array.from(groups.keys());
    cats.sort((a, b) => {
      const ai = order.indexOf(a);
      const bi = order.indexOf(b);
      if (ai !== -1 || bi !== -1) return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi);
      return a.localeCompare(b);
    });
    
    for (const cat of cats) {
      html.push(`<h2>${this._escapeHtml(cat)}</h2>`);
      
      const list = groups.get(cat) || [];
      for (const c of list) {
        const status = String(c?.status || 'INFO').toUpperCase();
        const statusClass = status.toLowerCase();
        const emoji = status === 'PASS' ? '✅' : status === 'WARN' ? '⚠️' : status === 'FAIL' ? '❌' : 'ℹ️';
        
        html.push(`<div class="check ${statusClass}">`);
        html.push(`<h3>${emoji} ${this._escapeHtml(c.id || '')}</h3>`);
        html.push(`<div><span class="status-badge">${status}</span>${this._escapeHtml(c.message || '')}</div>`);
        
        if (c?.details !== undefined) {
          html.push('<div class="details">');
          html.push('<pre>' + this._escapeHtml(JSON.stringify(c.details, null, 2)) + '</pre>');
          html.push('</div>');
        }
        
        html.push('</div>');
      }
    }
    
    html.push('</body>');
    html.push('</html>');
    
    return html.join('\n');
  }

  /**
   * Escape HTML special characters
   * @private
   */
  _escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }
}
