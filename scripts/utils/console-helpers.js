/**
 * @fileoverview Console debugging helpers
 * Diagnostic tools for troubleshooting effect issues
 * @module utils/console-helpers
 */

import { createLogger } from '../core/log.js';
import { globalProfiler } from '../core/profiler.js';
import { globalLoadingProfiler } from '../core/loading-profiler.js';
import { probeMaskFile } from '../assets/loader.js';
import { tileHasLevelsRange, readTileLevelsFlags } from '../foundry/levels-scene-flags.js';
import { isTileOverhead } from '../scene/tile-manager.js';

const log = createLogger('ConsoleHelpers');

const PERF_LOG_TAG = '[MS-PERF-10S]';
const DEFAULT_PERF_LOG_INTERVAL_MS = 10000;

let _perfLogTimer = null;
let _perfLogIntervalMs = DEFAULT_PERF_LOG_INTERVAL_MS;
let _perfPrevSnapshot = null;

function _toFinite(n, fallback = 0) {
  const v = Number(n);
  return Number.isFinite(v) ? v : fallback;
}

function _pickTopPasses(passTimings, limit = 6) {
  if (!passTimings || typeof passTimings !== 'object') return [];
  return Object.entries(passTimings)
    .map(([name, data]) => ({
      name,
      avg: _toFinite(data?.avg),
      last: _toFinite(data?.last),
      total: _toFinite(data?.total),
      count: _toFinite(data?.count),
    }))
    .sort((a, b) => (b.avg - a.avg) || (b.last - a.last) || (b.total - a.total))
    .slice(0, Math.max(1, limit));
}

function _collectContinuousCandidates(floorCompositor) {
  if (!floorCompositor) return {};
  return {
    fluidOverlays: _toFinite(floorCompositor?._fluidEffect?._overlays?.size),
    iridescenceOverlays: _toFinite(floorCompositor?._iridescenceEffect?._overlays?.size),
    prismOverlays: _toFinite(floorCompositor?._prismEffect?._overlays?.size),
    bushOverlays: _toFinite(floorCompositor?._bushEffect?._overlays?.size),
    treeOverlays: _toFinite(floorCompositor?._treeEffect?._overlays?.size),
    fireActiveFloors: _toFinite(floorCompositor?._fireEffect?._activeFloors?.size),
    dustActiveFloors: _toFinite(floorCompositor?._dustEffect?._activeFloors?.size),
    splashesActiveFloors: _toFinite(floorCompositor?._waterSplashesEffect?._activeFloors?.size),
    fliesSystems: _toFinite(floorCompositor?._smellyFliesEffect?.flySystems?.size),
    candlesFlameSources: _toFinite(floorCompositor?._candleFlamesEffect?._sourceFlameCount),
    candlesGlowBuckets: _toFinite(floorCompositor?._candleFlamesEffect?._glowBuckets?.size),
    playerLightEnabled: !!(floorCompositor?._playerLightEffect?.enabled && floorCompositor?._playerLightEffect?.params?.enabled),
    playerLightTorchActive: floorCompositor?._playerLightEffect?._torchWasActiveLastFrame === true,
    playerLightFlashIntensity: _toFinite(floorCompositor?._playerLightEffect?._flashlightFinalIntensity),
    lensGrainAmount: _toFinite(floorCompositor?._lensEffect?.params?.grainAmount),
    lensGrainSpeed: _toFinite(floorCompositor?._lensEffect?.params?.grainSpeed),
  };
}

/** Same rules as GpuSceneMaskCompositor._isTileInLevelBand (diagnostics only). */
function _isTileInLevelBandDiagnostic(tileDoc, levelContext) {
  const bandBottom = Number(levelContext?.bottom);
  const bandTop = Number(levelContext?.top);
  if (!Number.isFinite(bandBottom) || !Number.isFinite(bandTop)) return true;

  if (tileHasLevelsRange(tileDoc)) {
    const flags = readTileLevelsFlags(tileDoc);
    const tileBottom = Number(flags.rangeBottom);
    const tileTop = Number(flags.rangeTop);
    if (Number.isFinite(tileBottom) && Number.isFinite(tileTop)) {
      return !(tileTop <= bandBottom || tileBottom >= bandTop);
    }
    if (Number.isFinite(tileBottom)) {
      return tileBottom >= bandBottom && tileBottom < bandTop;
    }
  }

  const elev = Number(tileDoc?.elevation);
  if (Number.isFinite(elev)) return elev >= bandBottom && elev < bandTop;
  return true;
}

function _extractBasePathDiagnostic(src) {
  const s = String(src || '').trim();
  const lastDot = s.lastIndexOf('.');
  return lastDot > 0 ? s.substring(0, lastDot) : s;
}

function _texProof(tex) {
  if (!tex) return null;
  return {
    uuid: tex.uuid ?? null,
    flipY: tex.flipY,
    w: tex.image?.width ?? null,
    h: tex.image?.height ?? null,
    name: tex.name ?? null,
  };
}

function _collectTilesForLevelBand(scene, levelContext) {
  const out = [];
  if (!scene) return out;
  let tiles = scene.tiles ?? null;
  if (!tiles) return out;
  const tileIter = Array.isArray(tiles)
    ? tiles
    : (Array.isArray(tiles?.contents) ? tiles.contents : (tiles?.values?.() ?? []));
  const bandBottom = Number(levelContext?.bottom);
  const bandTop = Number(levelContext?.top);
  const hasLevelFilter = Number.isFinite(bandBottom) && Number.isFinite(bandTop);

  for (const tileDoc of tileIter) {
    if (!tileDoc) continue;
    const src = tileDoc?.texture?.src;
    if (typeof src !== 'string' || src.trim().length === 0) continue;
    if (tileDoc.hidden) continue;
    try { if (tileDoc.getFlag?.('map-shine-advanced', 'bypassEffects')) continue; } catch (_) {}
    if (hasLevelFilter) {
      try { if (!_isTileInLevelBandDiagnostic(tileDoc, levelContext)) continue; } catch (_) {}
    } else {
      try { if (isTileOverhead(tileDoc)) continue; } catch (_) {}
    }
    const w = Number.isFinite(tileDoc?.width) ? tileDoc.width : 0;
    const h = Number.isFinite(tileDoc?.height) ? tileDoc.height : 0;
    if (!w || !h) continue;
    out.push(tileDoc);
  }
  return out;
}

function _buildWindowedPassRows(currentRaw, prevRaw) {
  if (!currentRaw || !prevRaw) return [];
  const rows = [];
  for (const [name, nowEntry] of Object.entries(currentRaw)) {
    const prevEntry = prevRaw?.[name] ?? null;
    if (!prevEntry) continue;
    const dTotal = Math.max(0, _toFinite(nowEntry?.total) - _toFinite(prevEntry?.total));
    const dCount = Math.max(0, _toFinite(nowEntry?.count) - _toFinite(prevEntry?.count));
    if (dCount <= 0) continue;
    rows.push({
      name,
      windowAvg: dTotal / dCount,
      windowTotal: dTotal,
      windowCount: dCount,
      last: _toFinite(nowEntry?.last),
    });
  }
  rows.sort((a, b) => (b.windowAvg - a.windowAvg) || (b.windowTotal - a.windowTotal));
  return rows;
}

function _collectPerfSnapshot() {
  const ms = window.MapShine ?? {};
  const rl = ms.renderLoop ?? null;
  const renderer = ms.renderer ?? null;
  const rInfo = renderer?.info ?? null;

  const passTimings = ms.__v2PassTimings ?? null;
  const topPasses = _pickTopPasses(passTimings, 8);
  const passRaw = passTimings && typeof passTimings === 'object'
    ? Object.fromEntries(
      Object.entries(passTimings).map(([k, v]) => [k, {
        total: _toFinite(v?.total),
        count: _toFinite(v?.count),
        avg: _toFinite(v?.avg),
        last: _toFinite(v?.last),
      }])
    )
    : {};

  const distortion = ms.__distortionPerfStats ?? null;
  const bridge = ms.__pixiBridgePerfStats ?? null;
  const bridgeTrigger = ms.__pixiBridgeFrameTrigger ?? null;

  const frameCount = _toFinite(rl?.frameCount);
  const fps = _toFinite(typeof rl?.getFPS === 'function' ? rl.getFPS() : rl?.fps);
  const drawCalls = _toFinite(rInfo?.render?.calls);
  const triangles = _toFinite(rInfo?.render?.triangles);
  const lines = _toFinite(rInfo?.render?.lines);
  const points = _toFinite(rInfo?.render?.points);
  const textures = _toFinite(rInfo?.memory?.textures);
  const geometries = _toFinite(rInfo?.memory?.geometries);
  const programs = Array.isArray(rInfo?.programs) ? rInfo.programs.length : _toFinite(rInfo?.memory?.programs);

  const distFrames = _toFinite(distortion?.frames);
  const distApply = _toFinite(distortion?.fullApplyFrames);
  const distPassThrough = _toFinite(distortion?.earlyPassThrough);
  const distApplyRatio = distFrames > 0 ? (distApply / distFrames) : 0;

  const bridgeFrames = _toFinite(bridge?.frames);
  const bridgeAttempts = _toFinite(bridge?.captureAttempts);
  const bridgeIdle = _toFinite(bridge?.skipIdle);
  const bridgeIdleRatio = bridgeFrames > 0 ? (bridgeIdle / bridgeFrames) : 0;

  const nowPerf = _toFinite(performance?.now?.(), 0);
  const continuousUntilMs = _toFinite(rl?._continuousRenderUntilMs, 0);
  const continuousWindowRemainingMs = Math.max(0, continuousUntilMs - nowPerf);
  const cinematicUntilMs = _toFinite(rl?._cinematicModeUntilMs, 0);
  const cinematicWindowRemainingMs = Math.max(0, cinematicUntilMs - nowPerf);
  const adaptiveEnabled = ms?.renderAdaptiveFpsEnabled !== false;
  const strictSyncEnabled = ms?.renderStrictSyncEnabled === true;
  const floorCompositor = ms.floorCompositorV2 ?? ms.effectComposer?._floorCompositorV2 ?? null;
  const continuousCandidates = _collectContinuousCandidates(floorCompositor);

  // Strict-sync telemetry: PIXI token lockstep + hold-frame counters.
  let strictSyncTokens = null;
  try {
    strictSyncTokens = ms?.frameCoordinator?.getStrictSyncTokenStats?.() ?? null;
  } catch (_) {}
  const strictSyncHold = ms?.__v2StrictHoldInfo ?? null;
  const strictSyncFrames = ms?.__v2StrictFrameStats ?? null;
  const strictRenderCounters = ms?.__renderStrictCounters ?? null;
  const outdoorsRoute = ms?.__v2OutdoorsRoute ?? null;

  return {
    ts: Date.now(),
    fps,
    frameCount,
    drawCalls,
    triangles,
    lines,
    points,
    textures,
    geometries,
    programs,
    continuousReason: ms.__v2ContinuousRenderReason ?? 'unknown',
    passTop: topPasses,
    passRaw,
    renderLoop: {
      forceNextRender: !!rl?._forceNextRender,
      cachedEffectWantsContinuous: !!rl?._cachedEffectWantsContinuous,
      continuousWindowRemainingMs,
      cinematicWindowRemainingMs,
      adaptiveEnabled,
      strictSyncEnabled,
      idleFps: _toFinite(ms?.renderIdleFps, 15),
      activeFps: _toFinite(ms?.renderActiveFps, 60),
      continuousFps: _toFinite(ms?.renderContinuousFps, 30),
    },
    strictSync: {
      enabled: strictSyncEnabled,
      tokens: strictSyncTokens,
      hold: strictSyncHold,
      frames: strictSyncFrames,
      counters: strictRenderCounters,
      outdoorsRoute,
    },
    continuousCandidates,
    distortion: {
      frames: distFrames,
      fullApplyFrames: distApply,
      earlyPassThrough: distPassThrough,
      applyRatio: distApplyRatio,
      last: distortion?.last ?? null,
      waterAuxPassFrames: _toFinite(distortion?.waterAuxPassFrames),
    },
    bridge: {
      frames: bridgeFrames,
      captureAttempts: bridgeAttempts,
      skipIdle: bridgeIdle,
      idleRatio: bridgeIdleRatio,
      lastStatus: bridge?.lastStatus ?? null,
      triggerDirty: !!bridgeTrigger?.dirty,
      triggerLivePreview: !!bridgeTrigger?.hasLivePreview,
      triggerPendingZoom: !!bridgeTrigger?.pendingZoomRecapture,
    },
  };
}

function _emitPeriodicPerfLog() {
  const snap = _collectPerfSnapshot();
  const prev = _perfPrevSnapshot;
  _perfPrevSnapshot = snap;

  const dtSec = prev ? Math.max(0.001, (snap.ts - prev.ts) / 1000) : (_perfLogIntervalMs / 1000);
  const dFrames = prev ? Math.max(0, snap.frameCount - prev.frameCount) : 0;
  const frameRateWindow = dFrames / dtSec;

  const dDistApply = prev ? Math.max(0, snap.distortion.fullApplyFrames - prev.distortion.fullApplyFrames) : 0;
  const dDistFrames = prev ? Math.max(0, snap.distortion.frames - prev.distortion.frames) : 0;
  const distWindowRatio = dDistFrames > 0 ? (dDistApply / dDistFrames) : snap.distortion.applyRatio;

  const dBridgeAttempts = prev ? Math.max(0, snap.bridge.captureAttempts - prev.bridge.captureAttempts) : 0;
  const dBridgeFrames = prev ? Math.max(0, snap.bridge.frames - prev.bridge.frames) : 0;

  const windowPassRows = _buildWindowedPassRows(snap.passRaw, prev?.passRaw);
  const topWindow = windowPassRows[0] ?? null;
  const top1 = topWindow?.name ?? (snap.passTop[0]?.name ?? 'none');
  const top1Avg = topWindow?.windowAvg ?? (snap.passTop[0]?.avg ?? 0);
  const top2 = (windowPassRows[1]?.name ?? (snap.passTop[1]?.name ?? 'none'));
  const top2Avg = (windowPassRows[1]?.windowAvg ?? (snap.passTop[1]?.avg ?? 0));

  console.log(
    `${PERF_LOG_TAG} fps=${snap.fps.toFixed(1)} windowFps=${frameRateWindow.toFixed(1)} ` +
    `topPassWin=${top1}:${top1Avg.toFixed(2)}ms top2Win=${top2}:${top2Avg.toFixed(2)}ms ` +
    `distApplyRatio=${(distWindowRatio * 100).toFixed(1)}% bridgeAttempts+${dBridgeAttempts}/${dBridgeFrames}f ` +
    `reason=${snap.continuousReason}`
  );

  const rows = [
    { key: 'fps.current', value: snap.fps.toFixed(2) },
    { key: 'fps.window', value: frameRateWindow.toFixed(2) },
    { key: 'render.drawCalls', value: snap.drawCalls },
    { key: 'render.triangles', value: snap.triangles },
    { key: 'render.lines', value: snap.lines },
    { key: 'render.points', value: snap.points },
    { key: 'gpu.textures', value: snap.textures },
    { key: 'gpu.geometries', value: snap.geometries },
    { key: 'gpu.programs', value: snap.programs },
    { key: 'continuous.reason', value: snap.continuousReason },
    { key: 'renderLoop.forceNextRender', value: snap.renderLoop.forceNextRender },
    { key: 'renderLoop.cachedEffectWantsContinuous', value: snap.renderLoop.cachedEffectWantsContinuous },
    { key: 'renderLoop.continuousWindowRemainingMs', value: Math.round(snap.renderLoop.continuousWindowRemainingMs) },
    { key: 'renderLoop.cinematicWindowRemainingMs', value: Math.round(snap.renderLoop.cinematicWindowRemainingMs) },
    { key: 'renderLoop.adaptiveEnabled', value: snap.renderLoop.adaptiveEnabled },
    { key: 'renderLoop.strictSyncEnabled', value: snap.renderLoop.strictSyncEnabled },
    { key: 'renderLoop.targetFps.idle', value: snap.renderLoop.idleFps },
    { key: 'renderLoop.targetFps.active', value: snap.renderLoop.activeFps },
    { key: 'renderLoop.targetFps.continuous', value: snap.renderLoop.continuousFps },
    { key: 'strictSync.tokens.produced', value: snap.strictSync.tokens?.produced ?? 0 },
    { key: 'strictSync.tokens.consumed', value: snap.strictSync.tokens?.consumed ?? 0 },
    { key: 'strictSync.tokens.missed', value: snap.strictSync.tokens?.missed ?? 0 },
    { key: 'strictSync.tokens.pending', value: snap.strictSync.tokens?.pending ?? 0 },
    { key: 'strictSync.frames.rendered', value: snap.strictSync.frames?.rendered ?? 0 },
    { key: 'strictSync.frames.held', value: snap.strictSync.frames?.held ?? 0 },
    { key: 'strictSync.frames.lastHoldReason', value: snap.strictSync.frames?.lastHoldReason ?? 'none' },
    { key: 'strictSync.outdoorsRoute.main', value: snap.strictSync.outdoorsRoute?.main?.route ?? 'n/a' },
    { key: 'strictSync.outdoorsRoute.water', value: snap.strictSync.outdoorsRoute?.water?.route ?? 'n/a' },
    { key: 'strictSync.outdoorsRoute.sky', value: snap.strictSync.outdoorsRoute?.sky?.route ?? 'n/a' },
    { key: 'strictSync.outdoorsRoute.cloudMode', value: snap.strictSync.outdoorsRoute?.cloud?.mode ?? 'n/a' },
    { key: 'distortion.applyRatio.window', value: `${(distWindowRatio * 100).toFixed(1)}%` },
    { key: 'distortion.applyRatio.total', value: `${(snap.distortion.applyRatio * 100).toFixed(1)}%` },
    { key: 'distortion.earlyPassThrough.total', value: snap.distortion.earlyPassThrough },
    { key: 'distortion.waterAuxPassFrames.total', value: snap.distortion.waterAuxPassFrames },
    { key: 'bridge.captureAttempts.delta', value: dBridgeAttempts },
    { key: 'bridge.captureAttempts.total', value: snap.bridge.captureAttempts },
    { key: 'bridge.idleRatio.total', value: `${(snap.bridge.idleRatio * 100).toFixed(1)}%` },
    { key: 'bridge.lastStatus', value: snap.bridge.lastStatus ?? 'n/a' },
    { key: 'bridge.triggerDirty', value: snap.bridge.triggerDirty },
    { key: 'bridge.triggerLivePreview', value: snap.bridge.triggerLivePreview },
    { key: 'bridge.triggerPendingZoom', value: snap.bridge.triggerPendingZoom },
    { key: 'candidates.bushOverlays', value: snap.continuousCandidates.bushOverlays ?? 0 },
    { key: 'candidates.treeOverlays', value: snap.continuousCandidates.treeOverlays ?? 0 },
    { key: 'candidates.fluidOverlays', value: snap.continuousCandidates.fluidOverlays ?? 0 },
    { key: 'candidates.iridescenceOverlays', value: snap.continuousCandidates.iridescenceOverlays ?? 0 },
    { key: 'candidates.prismOverlays', value: snap.continuousCandidates.prismOverlays ?? 0 },
    { key: 'candidates.fireActiveFloors', value: snap.continuousCandidates.fireActiveFloors ?? 0 },
    { key: 'candidates.dustActiveFloors', value: snap.continuousCandidates.dustActiveFloors ?? 0 },
    { key: 'candidates.splashesActiveFloors', value: snap.continuousCandidates.splashesActiveFloors ?? 0 },
    { key: 'candidates.fliesSystems', value: snap.continuousCandidates.fliesSystems ?? 0 },
    { key: 'candidates.candlesFlameSources', value: snap.continuousCandidates.candlesFlameSources ?? 0 },
    { key: 'candidates.candlesGlowBuckets', value: snap.continuousCandidates.candlesGlowBuckets ?? 0 },
    { key: 'candidates.playerLightEnabled', value: snap.continuousCandidates.playerLightEnabled ?? false },
    { key: 'candidates.playerLightTorchActive', value: snap.continuousCandidates.playerLightTorchActive ?? false },
    { key: 'candidates.playerLightFlashIntensity', value: (snap.continuousCandidates.playerLightFlashIntensity ?? 0).toFixed(4) },
    { key: 'candidates.lensGrainAmount', value: snap.continuousCandidates.lensGrainAmount ?? 0 },
    { key: 'candidates.lensGrainSpeed', value: snap.continuousCandidates.lensGrainSpeed ?? 0 },
  ];

  for (let i = 0; i < Math.min(6, windowPassRows.length); i += 1) {
    const p = windowPassRows[i];
    rows.push({ key: `passWin.${i + 1}.name`, value: p.name });
    rows.push({ key: `passWin.${i + 1}.avgMs`, value: p.windowAvg.toFixed(2) });
    rows.push({ key: `passWin.${i + 1}.lastMs`, value: p.last.toFixed(2) });
  }

  // Fallback when no previous snapshot exists yet.
  if (windowPassRows.length === 0) {
    for (let i = 0; i < Math.min(4, snap.passTop.length); i += 1) {
      const p = snap.passTop[i];
      rows.push({ key: `passCum.${i + 1}.name`, value: p.name });
      rows.push({ key: `passCum.${i + 1}.avgMs`, value: p.avg.toFixed(2) });
      rows.push({ key: `passCum.${i + 1}.lastMs`, value: p.last.toFixed(2) });
    }
  }

  console.table(rows);
}

function startPeriodicPerfLog(options = {}) {
  const intervalMs = Math.max(1000, _toFinite(options.intervalMs, DEFAULT_PERF_LOG_INTERVAL_MS));
  const immediate = options.immediate !== false;

  if (_perfLogTimer) {
    clearInterval(_perfLogTimer);
    _perfLogTimer = null;
  }

  _perfLogIntervalMs = intervalMs;
  _perfPrevSnapshot = null;

  if (immediate) _emitPeriodicPerfLog();
  _perfLogTimer = setInterval(_emitPeriodicPerfLog, _perfLogIntervalMs);

  console.log(`${PERF_LOG_TAG} started interval=${_perfLogIntervalMs}ms`);
  return true;
}

function stopPeriodicPerfLog() {
  if (_perfLogTimer) {
    clearInterval(_perfLogTimer);
    _perfLogTimer = null;
    console.log(`${PERF_LOG_TAG} stopped`);
  }
  return true;
}

function getPeriodicPerfSnapshot() {
  return _collectPerfSnapshot();
}

/**
 * Console helpers for debugging Map Shine Advanced
 * Access via window.MapShine.debug
 */
export const consoleHelpers = {
  /**
   * Diagnose current specular effect state
   * Checks for common issues that break the effect
   */
  async diagnoseSpecular() {
    console.group('[DIAG] Map Shine Specular Diagnostics');
    
    const effect = window.MapShine?.specularEffect;
    if (!effect) {
      console.error('[ERROR] Specular effect not found');
      console.groupEnd();
      return;
    }

    console.log('[OK] Specular effect found');
    
    // Check enabled state
    console.log(`Enabled: ${effect.enabled}`);
    
    // Check effective state
    const { getSpecularEffectiveState } = await import('../ui/parameter-validator.js');
    const effectiveState = getSpecularEffectiveState(effect.params);
    if (!effectiveState.effective) {
      console.warn('[WARN] Effect is ineffective:', effectiveState.reasons);
    } else {
      console.log('[OK] Effect is active and functional');
    }
    
    // Check material
    if (!effect.material) {
      console.error('[ERROR] Material is null');
      console.groupEnd();
      return;
    }
    console.log('[OK] Material exists');
    
    // Check validation status
    const validation = effect.getValidationStatus();
    if (!validation.valid) {
      console.error('[ERROR] Validation failed:', validation.errors);
    } else {
      console.log('[OK] Validation passed');
    }
    
    // Check parameters
    console.group('Parameters');
    for (const [key, value] of Object.entries(effect.params)) {
      const isValid = typeof value === 'number' ? Number.isFinite(value) : true;
      const icon = isValid ? '[OK]' : '[ERROR]';
      console.log(`${icon} ${key}: ${value}`);
    }
    console.groupEnd();
    
    // Check uniforms
    console.group('Shader Uniforms (critical)');
    const criticalUniforms = [
      'uSpecularIntensity',
      'uRoughness',
      'uMetallic',
      'uStripeEnabled',
      'uStripe1Frequency',
      'uStripe1Width',
      'uStripe1Intensity'
    ];
    
    for (const name of criticalUniforms) {
      const uniform = effect.material.uniforms[name];
      if (!uniform) {
        console.error(`[ERROR] ${name}: MISSING`);
        continue;
      }
      
      const value = uniform.value;
      const isValid = typeof value === 'number' ? Number.isFinite(value) : value !== null;
      const icon = isValid ? '[OK]' : '[ERROR]';
      console.log(`${icon} ${name}: ${value}`);
    }
    console.groupEnd();
    
    // Check for common issues
    console.group('Common Issues');
    const issues = [];
    
    if (effect.params.stripeEnabled && effect.params.stripe1Frequency === 0) {
      issues.push('[WARN] Stripe 1 frequency is 0 (will cause NaN)');
    }
    
    if (effect.params.stripe1Width < 0.01) {
      issues.push('[WARN] Stripe 1 width very small (may cause aliasing)');
    }
    
    const totalIntensity = 
      (effect.params.stripe1Enabled ? effect.params.stripe1Intensity : 0) +
      (effect.params.stripe2Enabled ? effect.params.stripe2Intensity : 0) +
      (effect.params.stripe3Enabled ? effect.params.stripe3Intensity : 0);
    
    if (totalIntensity > 3.0) {
      issues.push(`[WARN] Total stripe intensity very high (${totalIntensity.toFixed(2)})`);
    }
    
    if (issues.length === 0) {
      console.log('[OK] No obvious issues detected');
    } else {
      issues.forEach(issue => console.warn(issue));
    }
    console.groupEnd();
    
    // Suggestions
    console.group('[TIPS] Suggestions');
    if (!validation.valid || issues.length > 0) {
      console.log('Try resetting to defaults:');
      console.log('  MapShine.debug.resetSpecular()');
      console.log('Or check specific parameters that look wrong above');
    } else {
      console.log('Effect looks healthy. If still not rendering:');
      console.log('1. Check if specular mask texture loaded');
      console.log('2. Verify WebGL context is active');
      console.log('3. Check browser console for GL errors');
    }
    console.groupEnd();
    
    console.groupEnd();
  },

  /**
   * Reset specular effect to defaults
   */
  resetSpecular() {
    const uiManager = window.MapShine?.uiManager;
    if (!uiManager) {
      console.error('UI Manager not found');
      return;
    }
    
    console.log('[ACTION] Resetting specular effect to defaults...');
    uiManager.resetEffectToDefaults('specular');
    console.log('[OK] Reset complete');
  },

  /**
   * Export current parameters as JSON
   */
  exportParameters() {
    const effect = window.MapShine?.specularEffect;
    if (!effect) {
      console.error('Specular effect not found');
      return;
    }
    
    const json = JSON.stringify(effect.params, null, 2);
    console.log('Current parameters:');
    console.log(json);
    
    // Copy to clipboard if available
    if (navigator.clipboard) {
      navigator.clipboard.writeText(json);
      console.log('[OK] Copied to clipboard');
    }
    
    return effect.params;
  },

  /**
   * Import parameters from object
   * @param {Object} params - Parameters to apply
   */
  importParameters(params) {
    const effect = window.MapShine?.specularEffect;
    const uiManager = window.MapShine?.uiManager;
    
    if (!effect || !uiManager) {
      console.error('Effect or UI Manager not found');
      return;
    }
    
    console.log('[ACTION] Importing parameters...');
    
    for (const [key, value] of Object.entries(params)) {
      if (effect.params[key] !== undefined) {
        effect.params[key] = value;
        console.log(`Set ${key} = ${value}`);
      }
    }
    
    // Refresh UI
    const effectData = uiManager.effectFolders['specular'];
    if (effectData) {
      for (const [key, binding] of Object.entries(effectData.bindings)) {
        effectData.params[key] = effect.params[key];
        binding.refresh();
      }
    }
    
    console.log('[OK] Import complete');
  },

  /**
   * Show validation report for all effects
   */
  async validateAll() {
    console.group('[DIAG] Validation Report');
    
    const uiManager = window.MapShine?.uiManager;
    if (!uiManager) {
      console.error('UI Manager not found');
      console.groupEnd();
      return;
    }
    
    const { globalValidator } = await import('./parameter-validator.js');
    
    for (const [effectId, effectData] of Object.entries(uiManager.effectFolders)) {
      const validation = globalValidator.validateAllParameters(
        effectId,
        effectData.params,
        effectData.schema
      );
      
      const icon = validation.valid ? '[OK]' : '[ERROR]';
      console.log(`${icon} ${effectId}`);
      
      if (!validation.valid) {
        console.group('Errors');
        validation.errors.forEach(e => console.error(e));
        console.groupEnd();
      }
      
      if (validation.warnings.length > 0) {
        console.group('Warnings');
        validation.warnings.forEach(w => console.warn(w));
        console.groupEnd();
      }
    }
    
    console.groupEnd();
  },

  /**
   * Monitor shader for errors
   * @param {number} duration - How long to monitor (ms)
   */
  async monitorShader(duration = 5000) {
    const effect = window.MapShine?.specularEffect;
    if (!effect || !effect.material) {
      console.error('Effect or material not found');
      return;
    }
    
    console.log(`[DIAG] Monitoring shader for ${duration}ms...`);
    
    const { ShaderValidator } = await import('../core/shader-validator.js');
    
    let errorCount = 0;
    let checkCount = 0;
    
    const interval = setInterval(() => {
      checkCount++;
      const result = ShaderValidator.validateMaterialUniforms(effect.material);
      
      if (!result.valid) {
        errorCount++;
        console.error(`Check ${checkCount}: FAILED`, result.errors);
      }
    }, 100);
    
    setTimeout(() => {
      clearInterval(interval);
      console.log(`[OK] Monitoring complete: ${checkCount} checks, ${errorCount} errors`);
      
      if (errorCount > 0) {
        console.warn('Shader has validation errors - try resetting to defaults');
      }
    }, duration);
  },

  /**
   * Comprehensive per-floor rendering system diagnostic.
   * Reports FloorStack, compositor _floorMeta, effect mask bindings, registry
   * state, scene tiles, and highlights mismatches that cause cross-floor bleed.
   *
   * Usage: await MapShine.debug.diagnoseFloorRendering()
   */
  async diagnoseFloorRendering() {
    const ms = window.MapShine;
    const sep = '-'.repeat(60);

    console.group('[DIAG] MapShine Floor Rendering Diagnostics');
    console.log(sep);

    // ->->->-> 1. Floor loop gate ->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->
    console.group('1. Floor Loop Gate');
    const floorStack = ms?.floorStack ?? null;
    const composer   = ms?.sceneComposer ?? null;
    const compositor = composer?._sceneMaskCompositor ?? null;
    const effectComp = ms?.effectComposer ?? null;

    let loopEnabled = false;
    try {
      loopEnabled = game?.settings?.get?.('map-shine-advanced', 'experimentalFloorRendering') ?? false;
    } catch (_) {}

    console.log(`experimentalFloorRendering setting : ${loopEnabled ? '[OK] true' : '[ERROR] false'}`);
    console.log(`FloorStack available               : ${floorStack  ? '[OK]' : '[ERROR] null'}`);
    console.log(`GpuSceneMaskCompositor available   : ${compositor  ? '[OK]' : '[ERROR] null'}`);
    console.log(`EffectComposer available            : ${effectComp  ? '[OK]' : '[ERROR] null'}`);
    console.log(`Floor loop would run               : ${(loopEnabled && !!floorStack) ? '[OK] YES' : '[ERROR] NO'}`);
    console.groupEnd();
    console.log(sep);

    // ->->->-> 2. FloorStack ->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->
    console.group('2. FloorStack');
    if (!floorStack) {
      console.warn('[WARN] FloorStack not available -- floor loop cannot run');
    } else {
      const allFloors     = floorStack.getFloors?.() ?? [];
      const visibleFloors = floorStack.getVisibleFloors?.() ?? [];
      const activeFloor   = floorStack.getActiveFloor?.() ?? null;

      console.log(`Total floors   : ${allFloors.length}`);
      console.log(`Active floor   : ${activeFloor ? `index=${activeFloor.index}  [${activeFloor.elevationMin}-${activeFloor.elevationMax}]  compositorKey="${activeFloor.compositorKey}"` : 'null'}`);
      console.log(`Visible floors : ${visibleFloors.length}  (rendered this frame)`);
      console.group('All floor bands');
      for (const f of allFloors) {
        const isActive  = f.isActive ? ' <- ACTIVE' : '';
        const isVisible = visibleFloors.some(v => v.index === f.index) ? ' (visible)' : '';
        console.log(`  [${f.index}] elev ${f.elevationMin}-${f.elevationMax}  key="${f.key}"  compositorKey="${f.compositorKey}"${isActive}${isVisible}`);
      }
      console.groupEnd();
    }
    console.groupEnd();
    console.log(sep);

    // ->->->-> 3. GpuSceneMaskCompositor _floorMeta ->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->
    console.group('3. GpuSceneMaskCompositor _floorMeta Cache');
    if (!compositor) {
      console.warn('[WARN] Compositor not available');
    } else {
      const floorMeta = compositor._floorMeta;
      console.log(`_floorMeta entries : ${floorMeta?.size ?? 0}`);
      console.log(`_activeFloorKey    : "${compositor._activeFloorKey ?? 'null'}"`);
      console.log(`_belowFloorKey     : "${compositor._belowFloorKey  ?? 'null'}"`);
      console.log(`_activeFloorBasePath: "${compositor._activeFloorBasePath ?? 'null'}"`);

      if (floorMeta?.size > 0) {
        console.group('Cached floor bundles');
        for (const [key, meta] of floorMeta.entries()) {
          const types = (meta?.masks ?? []).map(m => m?.type || m?.id || '?').join(', ');
          const bp    = meta?.basePath ?? 'null';
          console.log(`  "${key}" -> masks: [${types}]   basePath: "${bp}"`);
        }
        console.groupEnd();
      } else {
        console.warn('  [WARN] _floorMeta is EMPTY -- all bindFloorMasks() calls will receive null bundles');
      }

      // Test compositorKey alignment against FloorStack
      if (floorStack) {
        console.group('compositorKey <-> _floorMeta alignment (critical)');
        const allFloors = floorStack.getFloors?.() ?? [];
        for (const f of allFloors) {
          const found = floorMeta?.get(f.compositorKey);
          if (found) {
            const types = (found.masks ?? []).map(m => m?.type || m?.id || '?').join(', ');
            console.log(`  [OK] floor[${f.index}] compositorKey="${f.compositorKey}" -> FOUND  [${types}]`);
          } else {
            console.error(`  [ERROR] floor[${f.index}] compositorKey="${f.compositorKey}" -> NOT IN _floorMeta -- effects will receive null bundle!`);
          }
        }
        console.groupEnd();
      }
    }
    console.groupEnd();
    console.log(sep);

    // ->->->-> 4. Scene background & tiles ->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->
    console.group('4. Scene Tiles & Background');
    const scene = canvas?.scene;
    const bgSrc = scene?.background?.src || scene?.img || null;
    const extractBase = (src) => {
      if (!src) return null;
      const lastDot = src.lastIndexOf('.');
      const lastSlash = Math.max(src.lastIndexOf('/'), src.lastIndexOf('\\'));
      const noExt  = lastDot > lastSlash ? src.slice(0, lastDot) : src;
      // Strip known mask suffixes
      return noExt.replace(/_?(Water|Fire|Specular|Roughness|Normal|Windows|Structural|Outdoors|Prism|Iridescence|Fluid|Ash|Dust|FloorAlpha)$/i, '');
    };
    console.log(`Scene background src      : "${bgSrc ?? 'none'}"`);
    console.log(`Scene background basePath : "${extractBase(bgSrc) ?? 'none'}"`);
    console.log(`SceneComposer _lastMaskBasePath: "${composer?._lastMaskBasePath ?? 'null'}"`);

    const tilesCollection = scene?.tiles;
    const tilesArr = tilesCollection
      ? (Array.isArray(tilesCollection) ? tilesCollection
        : (Array.isArray(tilesCollection.contents) ? tilesCollection.contents
          : [...(tilesCollection.values?.() ?? [])]))
      : [];
    console.log(`Total scene tiles : ${tilesArr.length}`);
    if (tilesArr.length > 0) {
      console.group('Tiles (sorted by elevation)');
      const sorted = [...tilesArr].sort((a, b) => Number(a.elevation ?? 0) - Number(b.elevation ?? 0));
      for (const t of sorted) {
        const src  = t?.texture?.src ?? '(no src)';
        const elev = t?.elevation ?? 'undefined';
        let levelsInfo = 'no Levels range';
        try {
          const { tileHasLevelsRange, readTileLevelsFlags } = await import('../foundry/levels-scene-flags.js');
          if (tileHasLevelsRange(t)) {
            const flags = readTileLevelsFlags(t);
            levelsInfo = `rangeBottom=${flags.rangeBottom} rangeTop=${flags.rangeTop}`;
          }
        } catch (_) {}
        const w = t?.width ?? '?';
        const h = t?.height ?? '?';
        const hidden = t?.hidden ? ' [hidden]' : '';
        console.log(`  elev=${elev}  ${w}x${h}  ${levelsInfo}${hidden}  "${src}"`);
      }
      console.groupEnd();
    }
    console.groupEnd();
    console.log(sep);

    // ->->->-> 5. Effect registry masks ->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->
    console.group('5. EffectMaskRegistry (active floor masks)');
    const registry = ms?.effectMaskRegistry ?? null;
    if (!registry) {
      console.warn('[WARN] effectMaskRegistry not available');
    } else {
      // Registry stores slots: Map<type, MaskSlot{texture, floorKey, source}>
      const slots = registry._slots ?? null;
      const activeCompKey = compositor?._activeFloorKey ?? null;
      const emrPolicies = registry._policies ?? registry._defaultPolicies ?? null;
      const getPolicy = (type) => {
        if (typeof registry.getPolicy === 'function') return registry.getPolicy(type);
        return emrPolicies?.[type] ?? null;
      };
      if (slots instanceof Map) {
        console.log(`Registered mask slots : ${slots.size}  (active compositor floor: "${activeCompKey ?? 'unknown'}")`);
        let crossFloorCount = 0;
        for (const [type, slot] of slots.entries()) {
          const tex    = slot?.texture ?? null;
          const hasTex = !!tex;
          const size   = (tex?.image?.width && tex?.image?.height) ? `${tex.image.width}x${tex.image.height}` : 'no image';
          const fk     = slot?.floorKey ?? 'null';
          const src    = slot?.source   ?? '?';
          const policy = getPolicy(type);
          const preserve = policy?.preserveAcrossFloors === true;
          // Flag when a preserved mask belongs to a DIFFERENT floor than the active one.
          const crossFloor = preserve && hasTex && activeCompKey && fk && fk !== 'null' && fk !== activeCompKey;
          if (crossFloor) crossFloorCount++;
          const crossTag = crossFloor ? '  [WARN] CROSS-FLOOR (preserved from floor "' + fk + '")' : '';
          const preserveTag = preserve ? '  [preserveAcrossFloors]' : '';
          console.log(`  ${hasTex ? '[OK]' : '[ERROR]'} ${type.padEnd(20)} texture=${hasTex ? size : 'null'}  floorKey="${fk}"  source=${src}${preserveTag}${crossTag}`);
        }
        if (crossFloorCount > 0) {
          console.warn(`  [WARN] ${crossFloorCount} mask(s) are PRESERVED from a different floor. This is intentional for water (post-FX)`);
          console.warn(`     but a bug for specular/roughness/normal (should clear per-floor). Check preserveAcrossFloors policies.`);
        }
      } else {
        console.log('  (_slots not accessible -- registry:', registry, ')');
      }
    }
    console.groupEnd();
    console.log(sep);

    // ->->->-> 6. Floor-scoped effects ->-> current mask bindings ->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->
    console.group('6. Floor-scoped Effects -- Current Mask Bindings');
    const ec = effectComp;
    if (!ec) {
      console.warn('[WARN] EffectComposer not available');
    } else {
      // EffectComposer stores effects in this.effects (Map<id, EffectBase>)
      const effectsMap = ec.effects instanceof Map ? ec.effects : null;
      const allEffects = effectsMap ? [...effectsMap.values()] : [];

      const floorEffects  = allEffects.filter(e => e.floorScope !== 'global');
      const globalEffects = allEffects.filter(e => e.floorScope === 'global');

      console.log(`Floor-scoped effects (run per-floor) : ${floorEffects.length}`);
      console.log(`Global-scoped effects (run once)     : ${globalEffects.length}`);

      // Key masks we care about
      const maskFields = ['waterMask','specularMask','roughnessMask','normalMap',
                          'windowMask','outdoorsMask','fireMask','dustMask',
                          'structuralMask','iridescenceMask','prismMask','treeMask'];

      console.group('Floor-scoped effect mask state');
      for (const eff of floorEffects) {
        const hasBind = typeof eff.bindFloorMasks === 'function';
        const enabled = eff.enabled ?? eff._enabled ?? '?';
        const bound   = maskFields.filter(f => eff[f] !== undefined).map(f => {
          const tex = eff[f];
          if (!tex) return `${f}=null`;
          const sz  = (tex?.image?.width && tex?.image?.height) ? `${tex.image.width}x${tex.image.height}` : 'loaded';
          return `${f}=${sz}`;
        });
        const floorStates = eff._floorStates?.size !== undefined ? `  _floorStates.size=${eff._floorStates.size}` : '';
        console.log(`  ${hasBind ? '[OK]' : '[WARN]'} ${eff.id.padEnd(28)} enabled=${String(enabled).padEnd(5)} ${bound.join('  ')}${floorStates}`);
      }
      console.groupEnd();

      console.group('Global-scoped effects');
      for (const eff of globalEffects) {
        console.log(`  [OK] ${eff.id}`);
      }
      console.groupEnd();
    }
    console.groupEnd();
    console.log(sep);

    // ->->->-> 7. Visible floor bundle test ->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->
    const CORE_MASK_TYPES = ['water','fire','specular','roughness','normal',
                             'windows','structural','outdoors','dust','ash',
                             'iridescence','prism','tree','bush','fluid'];
    console.group('7. Per-Floor Bundle Test (what the render loop would get)');
    if (!floorStack || !compositor) {
      console.warn('[WARN] FloorStack or compositor not available');
    } else {
      const visible = floorStack.getVisibleFloors?.() ?? [];
      if (visible.length === 0) console.warn('[WARN] No visible floors');
      for (const f of visible) {
        const bundle = compositor._floorMeta?.get(f.compositorKey) ?? null;
        if (bundle) {
          const types = (bundle.masks ?? []).map(m => m?.type || m?.id || '?');
          const missing = CORE_MASK_TYPES.filter(t => !types.includes(t));
          console.log(`  [OK] floor[${f.index}] key="${f.compositorKey}" -> [${types.join(', ')}]` +
            (missing.length ? `  |  absent: [${missing.join(', ')}]` : '  (all core masks present)'));
        } else {
          console.error(`  [ERROR] floor[${f.index}] key="${f.compositorKey}" -> bundle is NULL`);
          console.error(`     -> preloadAllFloors() hasn't cached this floor yet, or composeFloor() returned null.`);
          console.error(`     -> Effects will keep the previous floor's masks -- likely rendering the wrong content.`);
        }
      }
    }
    console.groupEnd();
    console.log(sep);

    // ->->->-> 7b. Per-effect _floorStates cache contents ->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->
    console.group('7b. Per-Effect _floorStates Cache (what each effect has seen per floor)');
    if (effectComp?.effects instanceof Map) {
      const allEffects = [...effectComp.effects.values()];
      const floorEffects = allEffects.filter(e => e._floorStates instanceof Map && e._floorStates.size > 0);
      if (floorEffects.length === 0) {
        console.warn('[WARN] No effects have populated _floorStates -- bindFloorMasks may not be running (check experimentalFloorRendering setting)');
      }
      for (const eff of floorEffects) {
        const entries = [...eff._floorStates.entries()];
        const lines = entries.map(([k, v]) => {
          const maskSummary = Object.entries(v)
            .map(([field, val]) => {
              if (val === null) return `${field}=null`;
              if (val && typeof val === 'object' && val.image) return `${field}=${val.image.width}x${val.image.height}`;
              return `${field}=${String(val).substring(0, 20)}`;
            }).join(', ');
          return `      "${k}": {${maskSummary}}`;
        }).join('\n');
        console.log(`  ${eff.id} (${entries.length} floor(s) cached):\n${lines}`);
      }
    }
    console.groupEnd();
    console.log(sep);

    // ->->->-> 8. Summary ->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->
    console.group('8. Summary / Likely Issues');
    if (compositor && floorStack) {
      const visible    = floorStack.getVisibleFloors?.() ?? [];
      const nullFloors = visible.filter(f => !compositor._floorMeta?.get(f.compositorKey));
      let issueCount = 0;

      if (nullFloors.length > 0) {
        issueCount++;
        console.error(`[ERROR] ${nullFloors.length} visible floor(s) have no cached bundle:`);
        for (const f of nullFloors) {
          console.error(`   floor[${f.index}] "${f.compositorKey}" -- effects will render with stale cross-floor masks.`);
        }
        console.error('   -> Run preloadAllFloors() or wait for it to complete after scene load.');
      }

      // Check for effects with empty _floorStates (bind loop may not be running).
      // Post-processing effects are intentionally excluded from the floor loop's
      // bindFloorMasks calls ->-> they use connectToRegistry() instead ->-> so having
      // _floorStates.size=0 is CORRECT for them (water, lighting, etc.).
      if (effectComp?.effects instanceof Map) {
        let postProcessingOrder = Infinity;
        try {
          const { RenderLayers } = await import('../effects/EffectComposer.js');
          postProcessingOrder = RenderLayers?.POST_PROCESSING?.order ?? Infinity;
        } catch (_) {}
        const bindable = [...effectComp.effects.values()].filter(e => {
          if (typeof e.bindFloorMasks !== 'function') return false;
          // Exclude post-processing effects ->-> they use connectToRegistry, not bindFloorMasks.
          const layerOrder = e.layer?.order ?? -Infinity;
          return layerOrder < postProcessingOrder;
        });
        const neverBound = bindable.filter(e => e._floorStates instanceof Map && e._floorStates.size === 0);
        if (neverBound.length > 0) {
          issueCount++;
          console.warn(`  ${neverBound.length} scene-layer bindable effect(s) have empty _floorStates:`);
          console.warn('   ' + neverBound.map(e => e.id).join(', '));
          console.warn('   ->-> Check experimentalFloorRendering setting and that preloadAllFloors completed.');
        }
      }

      // Report which masks are absent from each floor's bundle
      for (const f of visible) {
        const bundle = compositor._floorMeta?.get(f.compositorKey);
        if (!bundle) continue;
        const types = (bundle.masks ?? []).map(m => m?.type || m?.id || '?');
        const criticalAbsent = ['specular','windows','water','fire'].filter(t => !types.includes(t));
        if (criticalAbsent.length > 0) {
          console.info(`->  floor[${f.index}] "${f.compositorKey}" is missing: [${criticalAbsent.join(', ')}]`);
          console.info(`   ->-> These effects will be disabled/null for this floor's render pass (expected if the map has no such mask files).`);
        }
      }

      // ->->->-> Foam floor-key guard status ->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->
      // WeatherParticles suppresses water-driven foam when the registry's water
      // floorKey doesn't match the active compositor floor.
      try {
        const reg = ms?.effectMaskRegistry;
        const activeKey = compositor?._activeFloorKey ?? null;
        const waterSlot = reg?.getSlot?.('water');
        const waterFloorKey = waterSlot?.floorKey ?? null;
        const waterTex = waterSlot?.texture ?? null;
        if (activeKey && waterTex) {
          if (waterFloorKey && waterFloorKey !== activeKey) {
            console.warn(`  FOAM GUARD ACTIVE: water mask is from floor "${waterFloorKey}" but active floor is "${activeKey}"`);
            console.warn(`   ->-> WeatherParticles foam/splash suppressed on this floor (correct ->-> avoids cross-floor spawn positions).`);
            console.warn(`   ->-> The 2D water post-FX shader still runs (preserveAcrossFloors=true for water is intentional for post-FX).`);
            issueCount++; // not an error, but worth highlighting
          } else {
            console.log(`-> Foam floor-key guard: water floorKey="${waterFloorKey}" matches active floor "${activeKey}" ->-> foam active.`);
          }
        } else if (activeKey && !waterTex) {
          console.log(`->  Foam: no water mask on active floor "${activeKey}" ->-> foam/splash disabled (correct).`);
        }
      } catch (_) {}

      // ->->->-> Fire GPU readback Y-flip check ->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->
      // When fire mask comes from the GPU compositor (RT texture, no .src),
      // _generatePoints uses the GPU path with gpuFlipY=true to correct the
      // bottom-to-top WebGL readPixels row order.
      try {
        const fireSparks = ms?.effectComposer?.effects?.get?.('fire-sparks');
        if (fireSparks) {
          const floorState = fireSparks._floorStates;
          let fireFloorKey = null;
          if (floorState instanceof Map) {
            for (const [k, v] of floorState.entries()) {
              if (v?.fireMask) { fireFloorKey = k; break; }
            }
          }
          if (fireFloorKey) {
            const bundle = compositor._floorMeta?.get(fireFloorKey);
            const fireEntry = bundle?.masks?.find(m => m.type === 'fire' || m.id === 'fire');
            const fireTex = fireEntry?.texture ?? null;
            const isRT = fireTex?.image != null && !fireTex?.image?.src;
            console.log(`->  Fire mask source for floor "${fireFloorKey}": ${isRT ? 'GPU compositor RT (gpuFlipY=true applied)' : 'bundle/image file (no flip needed)'}`);
          }
        }
      } catch (_) {}

      if (issueCount === 0) {
        console.log(`-> All ${visible.length} visible floor(s) have cached bundles. Check 7b for per-effect state.`);
      }
    }
    console.groupEnd();

    console.log(sep);
    console.groupEnd();
  },

  /**
   * Deep-dive floor rendering diagnostic.
   * Exposes: _floorCache GPU RT state, floor loop simulation per pass,
   * actual SpecularEffect material uniform values, tile overlay specular
   * bindings, base plane mesh state, and TileManager _tileEffectMasks.
   * Usage: await MapShine.debug.diagnoseFloorDeepdive()
   */
  async diagnoseFloorDeepdive() {
    const ms  = window.MapShine;
    const sep = '->->'.repeat(60);
    const ftx = (tex) => {
      if (!tex) return ' null';
      if (tex.image?.width) return `-> ${tex.image.width}--${tex.image.height}`;
      return '-> loaded(no dims)';
    };
    const compositor = ms?.sceneComposer?._sceneMaskCompositor ?? null;
    const effectComp = ms?.effectComposer ?? null;
    const floorStack = ms?.floorStack ?? null;
    const composer   = ms?.sceneComposer ?? null;
    const specEff    = ms?.specularEffect ?? effectComp?.effects?.get?.('specular') ?? null;
    const tm         = ms?.tileManager ?? null;

    console.group('-> MapShine Floor Deep-Dive Diagnostics');
    console.log(sep);

    // ->->->-> A. _floorCache GPU RTs vs _floorMeta bundle handles ->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->
    // _floorMeta  = bundle metadata (file textures OR RT handles from compose())
    // _floorCache = WebGLRenderTargets produced ONLY by compose() GPU path
    // getBelowFloorTexture() ONLY reads _floorCache ->-> NOT _floorMeta.
    // If ground floor specular came from the file-based fallback (loadAssetBundle),
    // _floorCache["0:10"] never has specular ->-> getBelowFloorTexture returns null.
    console.group('A. _floorCache GPU RTs vs _floorMeta Bundles');
    if (!compositor) {
      console.warn('  compositor not available');
    } else {
      const fc    = compositor._floorCache ?? new Map();
      const fmeta = compositor._floorMeta  ?? new Map();
      console.log(`_floorMeta entries  : ${fmeta.size}  (file-based OR GPU RT handles)`);
      console.log(`_floorCache entries : ${fc.size}  (GPU RTs only ->-> getBelowFloorTexture reads here)`);
      console.log(`_activeFloorKey     : "${compositor._activeFloorKey ?? 'null'}"`);
      console.log(`_belowFloorKey      : "${compositor._belowFloorKey  ?? 'null'}"`);
      const belowSpec = compositor.getBelowFloorTexture?.('specular') ?? null;
      console.log(`getBelowFloorTexture('specular') : ${ftx(belowSpec)}`);
      if (!belowSpec) console.warn('    null ->-> ground-floor specular NOT visible through first-floor gaps (tBelowSpecularMap=null)');
      for (const [fk, meta] of fmeta.entries()) {
        const rtMap        = fc.get(fk);
        const rtTypes      = rtMap ? [...rtMap.keys()].join(', ') : '(no GPU RTs)';
        const bundleTypes  = (meta?.masks ?? []).map(m => m.id || m.type).join(', ');
        const specInBundle = (meta?.masks ?? []).some(m => m.id === 'specular' || m.type === 'specular');
        const specInCache  = !!rtMap?.has('specular');
        const specTag = specInBundle
          ? (specInCache ? '-> spec in both' : '  spec in _floorMeta ONLY ->-> getBelowFloor=null!')
          : '---> no specular';
        console.log(`  "${fk}"  bundle:[${bundleTypes}]  |  RT:[${rtTypes}]  |  ${specTag}`);
      }
    }
    console.groupEnd();
    console.log(sep);

    // ->->->-> B. Floor loop simulation ->-> per-pass bandBottom guard prediction ->->->->->->->->->->->->->->->->
    console.group('B. Floor Loop Simulation (what bindFloorMasks sets per pass)');
    if (!floorStack || !compositor) {
      console.warn('  FloorStack or compositor not available');
    } else {
      const visible = floorStack.getVisibleFloors?.() ?? [];
      console.log(`Visible floors in loop: ${visible.length}`);
      for (const f of visible) {
        const bundle      = compositor._floorMeta?.get(f.compositorKey) ?? null;
        const bandBottom  = Number(String(f.compositorKey ?? '').split(':')[0]);
        const isBase      = Number.isFinite(bandBottom) && bandBottom <= 0;
        console.group(`floor[${f.index}]  key="${f.compositorKey}"  isBaseMeshFloor=${isBase}`);
        if (!bundle) {
          console.error('   bundle NULL ->-> stale masks used');
          console.groupEnd(); continue;
        }
        const se = bundle.masks?.find(m => m.id === 'specular'  || m.type === 'specular');
        const re = bundle.masks?.find(m => m.id === 'roughness' || m.type === 'roughness');
        const ne = bundle.masks?.find(m => m.id === 'normal'    || m.type === 'normal');
        console.log(`  bundle: [${(bundle.masks ?? []).map(m => m.id || m.type).join(', ')}]`);
        console.log(`  bundleSpecular=${ftx(se?.texture)}  bundleRoughness=${ftx(re?.texture)}`);
        console.log(`  ->-> this.material.uSpecularMap  -> ${isBase ? ftx(se?.texture) + (se?.texture ? '' : ' (fallback_black)') : 'fallback_black [upper-floor guard]'}`);
        console.log(`  ->-> this.material.uRoughnessMap -> ${isBase ? ftx(re?.texture) + (re?.texture ? '' : ' (fallback_black)') : 'fallback_black [upper-floor guard]'}`);
        const cached = specEff?._floorStates?.get(f.compositorKey);
        console.log(`  _floorStates: ${cached ? 'HIT spec=' + ftx(cached.specularMask) : 'MISS (will re-search bundle)'}`);
        console.groupEnd();
      }
    }
    console.groupEnd();
    console.log(sep);

    // ->->->-> C. SpecularEffect material uniforms RIGHT NOW ->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->
    console.group('C. SpecularEffect Uniform Snapshot (current state after last floor pass)');
    if (!specEff) {
      console.warn('  specularEffect not found');
    } else {
      const mat = specEff.material;
      if (!mat?.uniforms) {
        console.error(' specEff.material or uniforms missing');
      } else {
        const u = mat.uniforms;
        console.log(`uSpecularMap         : ${ftx(u.uSpecularMap?.value)}`);
        console.log(`uRoughnessMap        : ${ftx(u.uRoughnessMap?.value)}`);
        console.log(`uNormalMap           : ${ftx(u.uNormalMap?.value)}`);
        console.log(`tBelowSpecularMap    : ${ftx(u.tBelowSpecularMap?.value)}`);
        console.log(`uHasBelowSpecularMap : ${u.uHasBelowSpecularMap?.value}`);
        console.log(`uEffectEnabled       : ${u.uEffectEnabled?.value}`);
        const fb = specEff._fallbackBlack;
        if (u.uSpecularMap?.value && fb && u.uSpecularMap.value === fb) {
          console.log('  (uSpecularMap = fallback_black ->-> no specular for last bound floor, correct for upper-floor guard)');
        }
      }
      // _floorStates cache
      const fs = specEff._floorStates ?? new Map();
      console.log(`_floorStates: ${fs.size} cached`);
      for (const [k, v] of fs.entries()) {
        console.log(`  "${k}": spec=${ftx(v.specularMask)}  rough=${ftx(v.roughnessMask)}  normal=${ftx(v.normalMap)}`);
      }
      // Tile overlays
      const overlays = specEff._tileOverlays ?? new Map();
      console.log(`_tileOverlays: ${overlays.size}`);
      if (overlays.size > 0) {
        for (const [tid, ent] of overlays.entries()) {
          const cm    = ent.colorMesh;
          const cSpec = cm?.material?.uniforms?.uSpecularMap?.value ?? null;
          console.log(`  ->${tid.slice(-8)}: colorMesh.vis=${cm?.visible ?? '?'}  occluder.vis=${ent.occluderMesh?.visible ?? '?'}  specular=${ftx(cSpec)}`);
        }
      } else {
        console.warn('    No tile overlays ->-> upper floor tiles have no per-tile specular mesh!');
      }
      // Is basePlaneMesh using the PBR shader?
      const bp = composer?.basePlaneMesh ?? null;
      if (bp) {
        const same = bp.material === specEff.material;
        console.log(`basePlaneMesh.material === specEff.material : ${same}`);
        if (!same) console.error('   PBR shader is NOT on the ground plane! Ground floor specular completely broken.');
        console.log(`basePlaneMesh.visible : ${bp.visible}`);
        if (bp.material?.uniforms) {
          const bu = bp.material.uniforms;
          console.log(`basePlane.uSpecularMap      : ${ftx(bu.uSpecularMap?.value)}`);
          console.log(`basePlane.tBelowSpecularMap : ${ftx(bu.tBelowSpecularMap?.value)}`);
        }
      }
    }
    console.groupEnd();
    console.log(sep);

    // ->->->-> D. TileManager _tileEffectMasks (compositor per-tile source data) ->->->->->->->->->->->->
    // Empty map (size=0) = "empty-cache poison" bug: first probe cached no masks,
    // so preloadAllFloors skips the tile permanently ->-> upper floor masks missing.
    console.group('D. TileManager _tileEffectMasks (per-tile cached effect masks)');
    if (!tm) {
      console.warn('  tileManager not available');
    } else {
      const tem = tm._tileEffectMasks;
      if (!(tem instanceof Map)) {
        console.log('  _tileEffectMasks: not a Map');
      } else {
        console.log(`  ${tem.size} tile(s) have effect mask cache entries`);
        let emptyCount = 0;
        for (const [tileId, mm] of tem.entries()) {
          if (!(mm instanceof Map)) continue;
          if (mm.size === 0) {
            emptyCount++;
            console.warn(`    tile[->${tileId.slice(-8)}]: EMPTY (0 masks) ->-> compositor skips this tile!`);
          } else {
            const types = [...mm.entries()].map(([k, v]) => {
              const w = v?.texture?.image?.width ?? '?';
              const h = v?.texture?.image?.height ?? '?';
              return `${k}(${w}--${h})`;
            }).join(', ');
            console.log(`  -> tile[->${tileId.slice(-8)}]: [${types}]`);
          }
        }
        if (emptyCount > 0) {
          console.error(`   ${emptyCount} tile(s) have empty mask caches ->-> run preloadAllFloors() again or reload scene`);
        }
      }
      // _tileSpecularMaskCache for SpecularEffect.loadTileMask path
      const tsc = tm._tileSpecularMaskCache;
      if (tsc instanceof Map) {
        console.log(`  _tileSpecularMaskCache: ${tsc.size} tile(s)`);
        for (const [k, v] of tsc.entries()) {
          console.log(`    ->${k.slice(-8)}: ${ftx(v)}`);
        }
      }
    }
    console.groupEnd();
    console.log(sep);

    // ->->->-> E. FloorStack object visibility ->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->
    console.group('E. FloorStack floor object counts');
    if (!floorStack) {
      console.warn('  FloorStack not available');
    } else {
      const floors  = floorStack.getFloors?.() ?? [];
      const visible = floorStack.getVisibleFloors?.() ?? [];
      for (const f of floors) {
        const objCount = f.objects?.size ?? f.objects?.length ?? f._objects?.size ?? f._objects?.length ?? '?';
        const isVis    = visible.some(v => v.index === f.index);
        const isActive = f.isActive ? ' -> ACTIVE' : '';
        console.log(`  floor[${f.index}]  [${f.elevationMin}->->${f.elevationMax}]  objects=${objCount}${isActive}${isVis ? ' (visible in loop)' : ''}`);
      }
      // Count scene objects with levelsHidden userData
      let levelsHiddenN = 0, levelsTaggedN = 0;
      try {
        ms?.sceneComposer?.scene?.traverse?.((o) => {
          if (o.userData?.levelsHidden === true) levelsHiddenN++;
          if (o.userData?.levelsFloor !== undefined) levelsTaggedN++;
        });
      } catch (_) {}
      console.log(`  Scene objects currently levelsHidden=true : ${levelsHiddenN}`);
      console.log(`  Scene objects with levelsFloor userData   : ${levelsTaggedN}`);
    }
    console.groupEnd();
    console.log(sep);

    // ->->->-> F. Upper floor load summary ->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->
    console.group('F. Upper Floor Load Diagnosis');
    if (!compositor) {
      console.warn('  compositor not available');
    } else {
      const fc    = compositor._floorCache ?? new Map();
      const fmeta = compositor._floorMeta  ?? new Map();
      const lru   = compositor._lruOrder   ?? [];
      const allBands = floorStack ? (floorStack.getFloors?.() ?? []).map(f => f.compositorKey) : [];
      const missing  = allBands.filter(k => !fmeta.has(k));
      console.log(`Expected floor bands : ${allBands.join(', ') || '(unknown)'}`);
      console.log(`_floorMeta populated : ${fmeta.size} / ${allBands.length}  ${missing.length ? '  missing: ' + missing.join(', ') : '-> all cached'}`);
      console.log(`_floorCache RTs      : ${fc.size} floor(s) have GPU RTs`);
      console.log(`LRU eviction order   : [${lru.join(', ')}]`);
      // Identify which floors have _floorMeta but NO _floorCache
      const metaOnlyFloors = [...fmeta.keys()].filter(k => !fc.has(k));
      if (metaOnlyFloors.length > 0) {
        console.warn(`    Floors in _floorMeta but NO GPU RTs: [${metaOnlyFloors.join(', ')}]`);
        console.warn(`     ->-> These floors came from file-based fallback, not GPU compose().`);
        console.warn(`     ->-> getBelowFloorTexture() returns null for these floors.`);
        console.warn(`     ->-> Fix: getBelowFloorTexture() must also read _floorMeta bundle textures.`);
      }
      // Tile count per floor band
      const sc = canvas?.scene;
      if (sc && floorStack) {
        const { tileHasLevelsRange, readTileLevelsFlags } = await import('../foundry/levels-scene-flags.js').catch(() => ({}));
        if (tileHasLevelsRange) {
          const allTiles = (() => {
            const t = sc.tiles;
            return Array.isArray(t) ? t : (Array.isArray(t?.contents) ? t.contents : [...(t?.values?.() ?? [])]);
          })();
          for (const f of (floorStack.getFloors?.() ?? [])) {
            const band = allTiles.filter(t => {
              if (!tileHasLevelsRange(t)) return false;
              const flags = readTileLevelsFlags(t);
              return Number(flags.rangeBottom) === Number(f.elevationMin);
            });
            console.log(`  floor[${f.index}] tiles: ${band.length}  (each needs mask probing on first load)`);
          }
        }
      }
    }
    console.groupEnd();
    console.log(sep);

    console.log('Deep-dive complete. Key question: is Section A showing spec-in-_floorMeta-only?');
    console.log('If yes, getBelowFloorTexture always returns null ->-> ground specular invisible through gaps.');
    console.groupEnd();
  },

  /**
   * Proof-oriented report: disk probe vs TileManager cache vs GpuSceneMaskCompositor
   * for `_Outdoors` (and specular) on each level band. Copy the logged JSON.
   *
   * Usage:
   *   await MapShine.debug.diagnoseUpperFloorOutdoorsProof()
   *   copy(await MapShine.debug.diagnoseUpperFloorOutdoorsProof()) // DevTools
   *
   * @returns {Promise<object>}
   */
  async diagnoseUpperFloorOutdoorsProof() {
    const ms = window.MapShine;
    const scene = typeof canvas !== 'undefined' ? canvas?.scene : null;
    const compositor = ms?.sceneComposer?._sceneMaskCompositor ?? null;
    const tm = ms?.tileManager ?? null;
    const reg = ms?.effectMaskRegistry ?? null;
    const specEff = ms?.specularEffect ?? ms?.effectComposer?.effects?.get?.('specular') ?? null;
    const floorStack = ms?.floorStack ?? null;
    const floors = floorStack?.getFloors?.() ?? [];

    const report = {
      capturedAt: new Date().toISOString(),
      sceneId: scene?.id ?? null,
      activeLevelContext: ms?.activeLevelContext ?? null,
      sceneComposer_lastMaskBasePath: ms?.sceneComposer?._lastMaskBasePath ?? null,
      compositor_activeFloorKey: compositor?._activeFloorKey ?? null,
      compositor_activeFloorBasePath: compositor?._activeFloorBasePath ?? null,
      tileManager_vramMb: tm
        ? (tm._tileEffectMaskVramBytes ?? 0) / (1024 * 1024)
        : null,
      tileManager_vramBudgetMb: tm?.effectMaskVramBudget != null
        ? tm.effectMaskVramBudget / (1024 * 1024)
        : null,
      registry_outdoorsSlot: null,
      specularEffect: {
        outdoorsMask: _texProof(specEff?.outdoorsMask),
        specularMask: _texProof(specEff?.specularMask),
        uSpecularMap: _texProof(specEff?.material?.uniforms?.uSpecularMap?.value),
      },
      bands: {},
    };

    try {
      const slot = reg?.getSlot?.('outdoors');
      if (slot) {
        report.registry_outdoorsSlot = {
          floorKey: slot.floorKey ?? null,
          source: slot.source ?? null,
          texture: _texProof(slot.texture),
        };
      }
    } catch (_) {}

    for (const f of floors) {
      const key = f?.compositorKey != null ? String(f.compositorKey) : null;
      if (!key) continue;
      const parts = key.split(':').map(Number);
      const bottom = parts[0];
      const top = parts[1];
      const ctx = { bottom, top };
      const bandBottom = Number(bottom);
      const isUpper = Number.isFinite(bandBottom) && bandBottom > 0;

      const meta = compositor?._floorMeta?.get(key) ?? null;
      const masks = meta?.masks ?? [];
      const outdoorsEntry = masks.find((m) => (m?.id ?? m?.type) === 'outdoors');
      const specularEntry = masks.find((m) => (m?.id ?? m?.type) === 'specular');
      const rtMap = compositor?._floorCache?.get(key);
      const rtTypes = rtMap ? [...rtMap.keys()] : [];

      const bandReport = {
        floorIndex: f.index,
        elevationMin: f.elevationMin,
        elevationMax: f.elevationMax,
        isUpperBand: isUpper,
        compositor_getFloorTexture: {
          outdoors: _texProof(compositor?.getFloorTexture?.(key, 'outdoors')),
          specular: _texProof(compositor?.getFloorTexture?.(key, 'specular')),
        },
        compositor_floorCache_maskTypes: rtTypes,
        compositor_floorMeta_maskTypes: masks.map((m) => m?.id ?? m?.type).filter(Boolean),
        compositor_floorMeta_outdoors: {
          hasMetaEntry: !!outdoorsEntry,
          texture: _texProof(outdoorsEntry?.texture),
        },
        compositor_floorMeta_specular: {
          hasMetaEntry: !!specularEntry,
          texture: _texProof(specularEntry?.texture),
        },
        tiles: [],
      };

      const tileDocs = _collectTilesForLevelBand(scene, ctx);
      for (const tileDoc of tileDocs) {
        const tid = tileDoc?.id ?? '';
        const src = typeof tileDoc?.texture?.src === 'string' ? tileDoc.texture.src.trim() : '';
        const basePath = _extractBasePathDiagnostic(src);
        const cached = tm?._tileEffectMasks?.get(tid);
        let cacheKeys = null;
        let cacheNote = null;
        if (cached instanceof Map) {
          if (cached.size === 0) cacheNote = 'EMPTY_MAP_poison';
          cacheKeys = [...cached.keys()];
        } else if (tm && tid) {
          cacheNote = 'not_in_cache_yet';
        }

        let loaded = null;
        let loadError = null;
        if (tm?.loadAllTileMasks) {
          try {
            loaded = await tm.loadAllTileMasks(tileDoc);
          } catch (e) {
            loadError = String(e?.message || e);
          }
        }
        const afterKeys = loaded instanceof Map ? [...loaded.keys()] : null;
        const outdoorsLoaded = loaded?.get?.('outdoors') ?? null;
        const specLoaded = loaded?.get?.('specular') ?? null;

        let probeOutdoors = null;
        let probeSpecular = null;
        if (basePath) {
          try {
            probeOutdoors = await probeMaskFile(basePath, '_Outdoors', { suppressProbeErrors: true });
          } catch (_) { probeOutdoors = null; }
          try {
            probeSpecular = await probeMaskFile(basePath, '_Specular', { suppressProbeErrors: true });
          } catch (_) { probeSpecular = null; }
        }

        bandReport.tiles.push({
          tileIdSuffix: tid.length > 8 ? tid.slice(-8) : tid,
          textureSrc: src || null,
          basePath: basePath || null,
          cacheBeforeLoad_keys: cacheKeys,
          cacheBeforeLoad_note: cacheNote,
          afterLoadAllTileMasks_keys: afterKeys,
          loadAllTileMasks_error: loadError,
          loaded_outdoors_url: outdoorsLoaded?.url ?? null,
          loaded_outdoors_texture: _texProof(outdoorsLoaded?.texture),
          loaded_specular_url: specLoaded?.url ?? null,
          loaded_specular_texture: _texProof(specLoaded?.texture),
          probeMaskFile_diskPath_outdoors: probeOutdoors?.path ?? null,
          probeMaskFile_diskPath_specular: probeSpecular?.path ?? null,
          interpretation_outdoors: (() => {
            const diskO = !!probeOutdoors?.path;
            const gotO = !!(outdoorsLoaded?.texture);
            if (diskO && !gotO) return 'FILE_LISTED_BUT_loadAllTileMasks_DID_NOT_LOAD_outdoors';
            if (!diskO && !gotO) return 'no_outdoors_file_found_for_basePath';
            if (!diskO && gotO) return 'loaded_without_probe_hit_unusual';
            return 'outdoors_ok';
          })(),
          interpretation_specular: (() => {
            const diskS = !!probeSpecular?.path;
            const gotS = !!(specLoaded?.texture);
            if (diskS && !gotS) return 'FILE_LISTED_BUT_loadAllTileMasks_DID_NOT_LOAD_specular';
            if (!diskS && !gotS) return 'no_specular_file_found_for_basePath';
            if (!diskS && gotS) return 'loaded_without_probe_hit_unusual';
            return 'specular_ok';
          })(),
        });
      }

      report.bands[key] = bandReport;
    }

    const json = JSON.stringify(report, null, 2);
    console.group('MapShine diagnoseUpperFloorOutdoorsProof (copy JSON below)');
    console.log(json);
    console.groupEnd();
    return report;
  },

  /**
   * Quick mask binding snapshot ->-> shows what texture each floor-scoped
   * effect currently has bound for each mask type.
   * Usage: MapShine.debug.diagnoseFloorMasks()
   */
  diagnoseFloorMasks() {
    const ec = window.MapShine?.effectComposer;
    if (!ec) { console.error('EffectComposer not available'); return; }

    const effectsMap = ec.effects instanceof Map ? ec.effects : null;
    if (!effectsMap) { console.error('ec.effects Map not accessible'); return; }

    const maskFields = ['waterMask','specularMask','roughnessMask','normalMap',
                        'windowMask','outdoorsMask','fireMask','dustMask',
                        'structuralMask','iridescenceMask','prismMask','treeMask'];

    console.group('--  Floor-Scoped Effect Mask Bindings');
    for (const eff of effectsMap.values()) {
      if (eff.floorScope === 'global') continue;
      const present = maskFields.filter(f => eff[f] !== undefined);
      if (present.length === 0) continue;

      console.group(`${eff.id} (enabled=${eff.enabled ?? eff._enabled})`);
      for (const f of present) {
        const tex = eff[f];
        const info = !tex ? ' null'
          : (tex.image?.width ? `-> ${tex.image.width}--${tex.image.height}` : '-> (no image dims)');
        console.log(`  ${f.padEnd(22)} ${info}`);
      }
      if (eff._floorStates?.size !== undefined) {
        console.log(`  _floorStates cached : ${eff._floorStates.size} floor(s)`);
      }
      console.groupEnd();
    }
    console.groupEnd();
  },

  /**
   * Alpha/isolation bisect toggles (runtime, no reload required).
   * Usage:
   *   MapShine.debug.alphaIsolationSet({ skipLensPass: true })
   *   MapShine.debug.alphaIsolationReset()
   */
  /**
   * Strict render sync diagnostics snapshot.
   * Shows PIXI token production/consumption, frame hold counts, and the
   * current _Outdoors binding route per consumer. Use this to verify that
   * strict sync is honoring the invariant that every PIXI token produces
   * exactly one compositor render and that all consumers have a valid
   * (non-stale) outdoors mask binding.
   *
   * Usage: MapShine.debug.strictSyncStatus()
   *
   * @returns {object}
   */
  strictSyncStatus() {
    const ms = window?.MapShine ?? {};
    const fc = ms.frameCoordinator ?? null;
    const tokens = (() => {
      try { return fc?.getStrictSyncTokenStats?.() ?? null; } catch (_) { return null; }
    })();
    const snapshot = {
      enabled: ms.renderStrictSyncEnabled === true,
      tokens,
      frames: ms.__v2StrictFrameStats ?? null,
      hold: ms.__v2StrictHoldInfo ?? null,
      renderCounters: ms.__renderStrictCounters ?? null,
      outdoorsRoute: ms.__v2OutdoorsRoute ?? null,
      holdFlag: ms.renderStrictHoldFrame ?? null,
      maskCacheVersion: (() => {
        try {
          return Number(ms.sceneComposer?._sceneMaskCompositor?.getFloorCacheVersion?.() ?? 0);
        } catch (_) { return null; }
      })(),
    };
    try { console.table(snapshot); } catch (_) {}
    return snapshot;
  },

  /**
   * Toggle strict render sync at runtime.
   * Usage: MapShine.debug.setStrictSync(true|false)
   *
   * @param {boolean} enabled
   */
  setStrictSync(enabled) {
    const gsm = window.MapShine?.graphicsSettings ?? window.MapShine?.graphicsSettingsManager ?? null;
    if (gsm?.setRenderStrictSyncEnabled) {
      gsm.setRenderStrictSyncEnabled(enabled === true);
      console.log(`[strict sync] now ${enabled === true ? 'ENABLED' : 'DISABLED'} via GraphicsSettingsManager`);
      return gsm.getRenderStrictSyncEnabled();
    }
    // Fallback: write directly to the runtime flag.
    if (!window.MapShine) window.MapShine = {};
    window.MapShine.renderStrictSyncEnabled = enabled === true;
    console.log(`[strict sync] runtime flag set to ${enabled === true} (GraphicsSettingsManager unavailable)`);
    return window.MapShine.renderStrictSyncEnabled;
  },

  alphaIsolationStatus() {
    return { ...(window.MapShine?.__alphaIsolationDebug ?? {}) };
  },

  alphaIsolationSet(flags = {}) {
    if (!window.MapShine) window.MapShine = {};
    const prev = window.MapShine.__alphaIsolationDebug ?? {};
    window.MapShine.__alphaIsolationDebug = { ...prev, ...flags };
    return { ...window.MapShine.__alphaIsolationDebug };
  },

  alphaIsolationReset() {
    if (window.MapShine) delete window.MapShine.__alphaIsolationDebug;
    return true;
  },

  alphaIsolationPreset(name = 'off') {
    const n = String(name || 'off').toLowerCase();
    if (!window.MapShine) window.MapShine = {};
    if (n === 'off' || n === 'reset') {
      delete window.MapShine.__alphaIsolationDebug;
      return {};
    }
    const presets = {
      noLens: { skipLensPass: true },
      noStamp: { skipFinalAlphaStamp: true },
      noWaterOccluder: { disableWaterOccluder: true },
      noWater: { skipWaterPass: true },
      noOverhead: { skipOverheadShadowPass: true, disableOverheadInLighting: true, disableRoofInLighting: true },
      noCloud: { skipCloudPass: true },
      noBuilding: { skipBuildingShadowPass: true },
    };
    const chosen = presets[n];
    if (!chosen) {
      return {
        error: `Unknown preset '${name}'`,
        available: Object.keys(presets),
      };
    }
    window.MapShine.__alphaIsolationDebug = { ...(window.MapShine.__alphaIsolationDebug ?? {}), ...chosen };
    return { ...window.MapShine.__alphaIsolationDebug };
  },

  /**
   * Show help
   */
  help() {
    console.log(`
->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->--
->->   Map Shine Advanced - Debug Helpers      ->->
->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->

Available commands (access via MapShine.debug):

  .diagnoseFloorRendering() - Comprehensive floor rendering report
  .diagnoseFloorDeepdive()  - Deep-dive: _floorCache RTs, uniform snapshot, tile overlays, _tileEffectMasks
  .diagnoseUpperFloorOutdoorsProof() - JSON: disk probe vs tile mask load vs compositor (async)
  .diagnoseFloorMasks()     - Quick snapshot of per-effect mask bindings
  .strictSyncStatus()       - Strict render sync counters + outdoors binding routes
  .setStrictSync(bool)      - Enable/disable strict render sync at runtime
  .alphaIsolationStatus()   - Read active alpha/isolation debug flags
  .alphaIsolationSet(obj)   - Merge alpha/isolation debug flags
  .alphaIsolationPreset(id) - Apply a bisect preset (noLens/noStamp/noWaterOccluder/noWater/noOverhead/noCloud/noBuilding/off)
  .alphaIsolationReset()    - Clear alpha/isolation debug flags
  .diagnoseSpecular()       - Check specular effect health
  .resetSpecular()          - Reset to defaults
  .exportParameters()       - Export current params as JSON
  .importParameters(obj)    - Import params from object
  .validateAll()            - Validate all effects
  .monitorShader(ms)        - Monitor shader for errors
  .help()                   - Show this help

Floor debugging examples:

  // Full floor rendering report (async)
  await MapShine.debug.diagnoseFloorRendering()

  // Quick mask binding snapshot
  MapShine.debug.diagnoseFloorMasks()

  // Upper-floor _Outdoors / specular load proof (paste JSON to devs)
  copy(await MapShine.debug.diagnoseUpperFloorOutdoorsProof())

Other examples:

  // Diagnose specular
  MapShine.debug.diagnoseSpecular()

  // Export current settings
  const params = MapShine.debug.exportParameters()
    `);
  }
};

/**
 * Install console helpers globally
 */
export function installConsoleHelpers() {
  if (typeof window !== 'undefined') {
    if (!window.MapShine) window.MapShine = {};
    window.MapShine.debug = consoleHelpers;

    // Door-click jank bisect: toggle flags, open a door, observe frame time.
    // MapShine.debugDoorJank.tryAll() enables all mitigations; .reset() clears.
    window.MapShine.debugDoorJank = {
      skipFogPerceptionOnWall: (v = true) => {
        window.MapShine.__debugSkipForcePerceptionOnWall = !!v;
        return window.MapShine.__debugSkipForcePerceptionOnWall;
      },
      skipBridgeDirtyOnWall: (v = true) => {
        window.MapShine.__debugSkipBridgeDirtyOnWall = !!v;
        return window.MapShine.__debugSkipBridgeDirtyOnWall;
      },
      skipWallManagerHookLightingRefresh: (v = true) => {
        window.MapShine.__debugSkipWallManagerHookLightingRefresh = !!v;
        return window.MapShine.__debugSkipWallManagerHookLightingRefresh;
      },
      skipWallManagerUpdateLightingRefresh: (v = true) => {
        window.MapShine.__debugSkipWallManagerUpdateLightingRefresh = !!v;
        return window.MapShine.__debugSkipWallManagerUpdateLightingRefresh;
      },
      tryAll: () => {
        window.MapShine.__debugSkipForcePerceptionOnWall = true;
        window.MapShine.__debugSkipBridgeDirtyOnWall = true;
        window.MapShine.__debugSkipWallManagerHookLightingRefresh = true;
        window.MapShine.__debugSkipWallManagerUpdateLightingRefresh = true;
        return {
          __debugSkipForcePerceptionOnWall: true,
          __debugSkipBridgeDirtyOnWall: true,
          __debugSkipWallManagerHookLightingRefresh: true,
          __debugSkipWallManagerUpdateLightingRefresh: true,
        };
      },
      reset: () => {
        delete window.MapShine.__debugSkipForcePerceptionOnWall;
        delete window.MapShine.__debugSkipBridgeDirtyOnWall;
        delete window.MapShine.__debugSkipWallManagerHookLightingRefresh;
        delete window.MapShine.__debugSkipWallManagerUpdateLightingRefresh;
        return true;
      },
      status: () => ({
        __debugSkipForcePerceptionOnWall: !!window.MapShine.__debugSkipForcePerceptionOnWall,
        __debugSkipBridgeDirtyOnWall: !!window.MapShine.__debugSkipBridgeDirtyOnWall,
        __debugSkipWallManagerHookLightingRefresh: !!window.MapShine.__debugSkipWallManagerHookLightingRefresh,
        __debugSkipWallManagerUpdateLightingRefresh: !!window.MapShine.__debugSkipWallManagerUpdateLightingRefresh,
      }),
    };

    window.MapShine.perf = {
      start: (options = {}) => {
        globalProfiler.start(options);
        return globalProfiler;
      },
      stop: () => {
        globalProfiler.stop();
        return true;
      },
      clear: () => {
        globalProfiler.clear();
        return true;
      },
      summary: () => {
        return globalProfiler.getSummary();
      },
      top: (kind = 'updatables', n = 10) => {
        return globalProfiler.getTopContributors(kind, n);
      },
      exportJson: () => {
        return globalProfiler.exportJson();
      },
      exportCsv: () => {
        return globalProfiler.exportCsv();
      },
      exportAllJson: () => {
        return {
          perf: globalProfiler.exportJson(),
          loading: globalLoadingProfiler.exportJson()
        };
      },
      loading: {
        start: () => {
          globalLoadingProfiler.start();
          return globalLoadingProfiler;
        },
        stop: () => {
          globalLoadingProfiler.stop();
          return true;
        },
        clear: () => {
          globalLoadingProfiler.clear();
          return true;
        },
        report: () => {
          return globalLoadingProfiler.getReport();
        },
        summary: () => {
          return globalLoadingProfiler.getSummary();
        },
        top: (n = 20, prefix = 'effect:') => {
          return globalLoadingProfiler.getTopSpans(n, prefix);
        },
        exportJson: () => {
          return globalLoadingProfiler.exportJson();
        },
        exportCsv: () => {
          return globalLoadingProfiler.exportCsv();
        }
      },
      periodic: {
        start: (options = {}) => startPeriodicPerfLog(options),
        stop: () => stopPeriodicPerfLog(),
        snapshot: () => getPeriodicPerfSnapshot(),
      }
    };
    
    // Water occluder diagnostic ->-> call MapShine.debugWaterOccluder() in the browser console
    // to dump the actual runtime state of all blocker meshes and the occluder RT.
    window.MapShine.debugWaterOccluder = () => {
      const tm = window.MapShine?.tileManager;
      const dm = window.MapShine?.distortionManager;
      if (!tm || !dm) { console.warn('tileManager or distortionManager not ready'); return; }

      const occScene = dm.waterOccluderScene;
      const occTarget = dm.waterOccluderTarget;
      console.log('distortionManager.waterOccluderScene:', occScene);
      console.log('distortionManager.waterOccluderTarget:', occTarget);
      console.log('waterOccluderScene child count:', occScene?.children?.length ?? 'N/A');

      let blockerCount = 0, blockerVisible = 0, blockerInWrongScene = 0;
      let occluderCount = 0, occluderVisible = 0;
      const rows = [];

      for (const [id, { sprite, tileDoc }] of (tm.tileSprites ?? new Map())) {
        if (!sprite) continue;
        const ud = sprite.userData;
        const blocker = ud.aboveFloorBlockerMesh;
        const occluder = ud.waterOccluderMesh;

        if (blocker) {
          blockerCount++;
          if (blocker.visible) blockerVisible++;
          // Check if blocker is in the correct scene
          const inOccScene = occScene?.children?.includes(blocker);
          if (!inOccScene) blockerInWrongScene++;
          rows.push({
            tileId: id,
            name: tileDoc?.name ?? tileDoc?.texture?.src?.split('/').pop() ?? '?',
            isOverhead: ud.isOverhead,
            levelsAbove: ud.levelsAbove,
            levelsHidden: ud.levelsHidden,
            shouldBlock: ud.isOverhead || ud.levelsAbove,
            blockerVisible: blocker.visible,
            blockerInOccScene: inOccScene,
            occluderVisible: occluder?.visible ?? null,
            spriteVisible: sprite.visible,
            opacity: sprite.material?.opacity?.toFixed(2) ?? '?'
          });
        }

        if (occluder) {
          occluderCount++;
          if (occluder.visible) occluderVisible++;
        }
      }

      console.log(`Blocker meshes: ${blockerCount} total, ${blockerVisible} visible, ${blockerInWrongScene} in WRONG scene`);
      console.log(`Occluder meshes: ${occluderCount} total, ${occluderVisible} visible`);
      console.table(rows.filter(r => r.isOverhead || r.levelsAbove || r.blockerVisible));
      console.log('Full rows (all tiles with blockers):', rows);

      // Also check if WaterEffectV2 has the occluder texture bound
      const we = window.MapShine?.waterEffect;
      if (we) {
        const u = we._material?.uniforms;
        console.log('WaterEffectV2 tWaterOccluderAlpha:', u?.tWaterOccluderAlpha?.value);
        console.log('WaterEffectV2 uHasWaterOccluderAlpha:', u?.uHasWaterOccluderAlpha?.value);
      }

      return rows;
    };

    // ->->->-> Water flooding root-cause diagnostic ->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->
    // Call MapShine.diagWater() in the browser console while the flooding is
    // visible. It reads the actual runtime state of every system involved in
    // cross-floor water suppression and prints a clear pass/fail for each one.
    window.MapShine.diagWater = () => {
      const ms   = window.MapShine;
      const we   = ms?.waterEffect;
      const dm   = ms?.distortionManager;
      const comp = ms?.sceneComposer?._sceneMaskCompositor;
      const fs   = ms?.floorStack;

      console.group('=== Water Flooding Diagnostic ===');

      // ->->->-> 1. Floor stack ->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->
      console.group('1. Floor stack');
      const activeFloor = fs?.getActiveFloor?.() ?? null;
      const allFloors   = fs?.getAllFloors?.()   ?? [];
      console.log('floorStack:', fs ?? 'NULL ->-> floorStack not on window.MapShine');
      console.log('activeFloor:', activeFloor);
      console.log('activeFloor.index:', activeFloor?.index ?? 'N/A');
      console.log('activeFloor.compositorKey:', activeFloor?.compositorKey ?? 'N/A');
      console.log('all floors:', allFloors.map(f => `index=${f.index} key=${f.compositorKey}`));
      console.groupEnd();

      // ->->->-> 2. Floor ID texture ->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->
      console.group('2. Floor ID texture (compositor.floorIdTarget)');
      const floorIdTarget = comp?.floorIdTarget ?? null;
      console.log('compositor:', comp ?? 'NULL');
      console.log('floorIdTarget:', floorIdTarget);
      console.log('floorIdTarget.texture:', floorIdTarget?.texture ?? 'NULL');
      if (floorIdTarget) {
        console.log('  size:', floorIdTarget.width, 'x', floorIdTarget.height);
        // GPU readback ->-> sample a 4x4 grid to see what values are actually in the texture
        try {
          const renderer = ms?.renderer;
          if (renderer) {
            const w = floorIdTarget.width, h = floorIdTarget.height;
            const buf = new Uint8Array(4);
            const prev = renderer.getRenderTarget();
            renderer.setRenderTarget(floorIdTarget);
            // Sample center pixel
            renderer.readRenderTargetPixels(floorIdTarget, Math.floor(w/2), Math.floor(h/2), 1, 1, buf);
            renderer.setRenderTarget(prev);
            console.log('  center pixel RGBA:', buf[0], buf[1], buf[2], buf[3],
              '->-> floor index =', Math.round(buf[0] / 255 * 255));
          }
        } catch (e) { console.warn('  readback failed:', e); }
      } else {
        console.warn('  floorIdTarget is NULL ->-> floor ID gate is DISABLED (uHasFloorIdTex=0)');
      }
      console.groupEnd();

      // ->->->-> 3. WaterEffectV2 uniforms ->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->
      console.group('3. WaterEffectV2 uniforms');
      const wu = we?._material?.uniforms;
      if (!wu) {
        console.warn('WaterEffectV2 material not ready');
      } else {
        console.log('uHasFloorIdTex:', wu.uHasFloorIdTex?.value, wu.uHasFloorIdTex?.value > 0.5 ? '->' : ' GATE DISABLED');
        console.log('uActiveFloorIndex:', wu.uActiveFloorIndex?.value, '->-> floor index =', Math.round((wu.uActiveFloorIndex?.value ?? 0) * 255));
        console.log('tFloorIdTex:', wu.tFloorIdTex?.value ?? 'NULL');
        console.log('uHasWaterData:', wu.uHasWaterData?.value);
        console.log('uHasWaterOccluderAlpha:', wu.uHasWaterOccluderAlpha?.value);
        console.log('uWaterEnabled:', wu.uWaterEnabled?.value);
        console.log('uDebugView:', wu.uDebugView?.value);
      }
      console.groupEnd();

      // ->->->-> 4. DistortionManager apply uniforms ->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->
      console.group('4. DistortionManager apply uniforms');
      const au = dm?.applyMaterial?.uniforms;
      if (!au) {
        console.warn('DistortionManager applyMaterial not ready');
      } else {
        console.log('uHasFloorIdTex:', au.uHasFloorIdTex?.value, au.uHasFloorIdTex?.value > 0.5 ? '->' : ' GATE DISABLED');
        console.log('uActiveFloorIndex:', au.uActiveFloorIndex?.value, '->-> floor index =', Math.round((au.uActiveFloorIndex?.value ?? 0) * 255));
        console.log('tFloorIdTex:', au.tFloorIdTex?.value ?? 'NULL');
        console.log('uHasWaterOccluderAlpha:', au.uHasWaterOccluderAlpha?.value);
      }
      console.groupEnd();

      // ->->->-> 5. Compositor floor cache ->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->
      console.group('5. Compositor floor cache');
      if (!comp) {
        console.warn('compositor not found at sceneComposer._sceneMaskCompositor');
      } else {
        console.log('_activeFloorKey:', comp._activeFloorKey);
        console.log('_floorCache keys:', [...(comp._floorCache?.keys() ?? [])]);
        console.log('_floorMeta keys:', [...(comp._floorMeta?.keys() ?? [])]);
        for (const [key, targets] of (comp._floorCache ?? new Map())) {
          const maskTypes = [...targets.keys()];
          console.log(`  floor "${key}": masks = [${maskTypes.join(', ')}]`);
        }
      }
      console.groupEnd();

      // ->->->-> 6. activeLevelContext ->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->->
      console.group('6. activeLevelContext');
      console.log('window.MapShine.activeLevelContext:', ms?.activeLevelContext);
      console.groupEnd();

      console.groupEnd();
      console.log('->-> Copy the above and paste it into the issue tracker.');
    };

    // Shortcut to visualize the water occluder RT in WaterEffectV2 (debug view 8 = waterOccluder)
    window.MapShine.showOccluderDebug = (view = 8) => {
      const we = window.MapShine?.waterEffect;
      if (!we?._material?.uniforms?.uDebugView) { console.warn('WaterEffectV2 not ready or no uDebugView uniform'); return; }
      we._material.uniforms.uDebugView.value = view;
      console.log(`WaterEffectV2 debug view set to ${view}. Call MapShine.showOccluderDebug(0) to reset.`);
    };

    log.info('Console helpers installed: MapShine.debug');
    if (window?.MapShine?.__enablePeriodicPerfLog === true) {
      startPeriodicPerfLog({ intervalMs: DEFAULT_PERF_LOG_INTERVAL_MS, immediate: false });
    } else {
      stopPeriodicPerfLog();
    }
    console.log('-> Type MapShine.debug.help() for debugging commands');
    console.log('-> Type MapShine.showOccluderDebug(8) to visualize tWaterOccluderAlpha');
    console.log(`-> Filter console by ${PERF_LOG_TAG} for recurring 10s perf logs`);
  }
}
