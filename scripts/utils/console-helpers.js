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
import { worldToReplicaDrawingPx, worldToReplicaMaskPx } from '../compositor-v2/ReplicaOcclusionMaskPass.js';

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

/**
 * V2 FloorRenderBus lives on FloorCompositor, which is attached to the
 * effect composer as `_floorCompositorV2` (not `MapShine.floorCompositor`).
 * @returns {object|null}
 */
function _resolveFloorRenderBus() {
  const ms = globalThis.MapShine ?? {};
  const fc = ms.floorCompositorV2 ?? ms.effectComposer?._floorCompositorV2 ?? null;
  return fc?._renderBus ?? null;
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

  /**
   * A/B steps for background-tab / alt-tab load repro vs strict PIXI–Three sync.
   * Usage: MapShine.debug.reproBackgroundTabStrictSyncHelp()
   */
  reproBackgroundTabStrictSyncHelp() {
    const lines = [
      'Background-tab vs strict-sync A/B:',
      '1) MapShine.debug.setStrictSync(false) → reload world → alt-tab during load → note render.',
      '2) MapShine.debug.setStrictSync(true) → repeat.',
      '3) MapShine.debug.strictSyncStatus() → compare token/hold stats.',
      '4) Before load: MapShine.__loadVisibilityDebug = true → console INFO "[loadVisibilityDebug]" every 2s while loading.',
      '   - loopFrame = rAF ticks (often 0 when tab hidden); loadPumpFrames = compositor draws from hidden-tab pump.',
      '5) After broken load: focus tab — visibility recovery runs resize + pump + warmup retry if intro gate skipped hidden.',
    ];
    console.log(lines.join('\n'));
    return lines;
  },

  /**
   * Diagnose the unified per-floor mask binding system.
   *
   * Returns the latest telemetry snapshot published by
   * MaskBindingController.sync() — one row per consumer, with the bound
   * texture summary per mask slot, and one row per visible floor showing
   * which per-floor masks are currently live. Useful for verifying that
   * every effect is receiving the correct version of every suffixed mask
   * for every floor.
   *
   * Usage: MapShine.debug.diagnoseMaskBindings()
   *
   * @returns {object}
   */
  diagnoseMaskBindings() {
    const ms = window?.MapShine ?? {};
    const controller = ms.__maskBindingController ?? null;
    const snapshot = {
      enabled: ms.maskBindingControllerEnabled === true,
      signature: null,
      activeIndex: null,
      cacheVersion: null,
      floors: [],
      consumers: [],
    };
    if (!controller) {
      snapshot.error = 'controller-not-instantiated';
      try { console.table(snapshot); } catch (_) {}
      return snapshot;
    }
    const tele = controller.diagnose?.() ?? ms.__maskBindings ?? null;
    if (!tele) {
      snapshot.error = 'no-telemetry';
      try { console.table(snapshot); } catch (_) {}
      return snapshot;
    }
    snapshot.signature = tele.signature;
    snapshot.activeIndex = tele.activeIndex;
    snapshot.cacheVersion = tele.cacheVersion;
    snapshot.floors = tele.visibleFloors ?? [];
    snapshot.consumers = tele.consumers ?? [];
    try {
      const floorRows = snapshot.floors.map((f) => ({
        index: f.index,
        floorKey: f.floorKey,
        ...Object.fromEntries(Object.entries(f.masks ?? {}).map(([id, v]) => [id, v ? 'ok' : '—'])),
      }));
      const consumerRows = snapshot.consumers.map((c) => {
        const summary = (c.bindings ?? [])
          .map((b) => `${b.consumes}→${b.maskId}(${b.path}${b.path === 'banded' ? `:${(b.present ?? []).map((p) => p ? '1' : '0').join('')}` : `:${b.present ? '1' : '0'}`})`)
          .join(', ');
        return { id: c.id, path: c.path, present: c.present, bindings: summary };
      });
      console.groupCollapsed(`[maskBindings] sig=${snapshot.signature?.slice(0, 80)}…`);
      console.log(`enabled=${snapshot.enabled} activeIndex=${snapshot.activeIndex} cacheVersion=${snapshot.cacheVersion}`);
      if (floorRows.length) { console.log('floors:'); console.table(floorRows); }
      if (consumerRows.length) { console.log('consumers:'); console.table(consumerRows); }
      console.groupEnd();
    } catch (_) {}
    return snapshot;
  },

  /**
   * Sample the `skyReach` value at a world (x,y) for the given floor index by
   * reading back one pixel from the per-floor skyReach render target.
   *
   * Returns `{ value: 0..1, outdoors, floorAlphaUpper, floorKey, floorIdx }`.
   *
   * Under a bridge on floor 0, where the bridge above is tile-opaque, the
   * expected value is near 0. On the bridge's upper surface (floor 1 if the
   * bridge is the top floor), the value should be near the authored outdoors
   * value at that point.
   *
   * Usage: MapShine.debug.skyReachProbe(x, y, floorIdx)
   *
   * @param {number} x World X.
   * @param {number} y World Y.
   * @param {number} [floorIdx]  Defaults to the active floor.
   * @returns {object}
   */
  skyReachProbe(x, y, floorIdx) {
    const ms = window?.MapShine ?? {};
    const compositor = ms.sceneComposer?._sceneMaskCompositor ?? null;
    const renderer = ms.renderer ?? null;
    const dims = canvas?.dimensions ?? null;
    const sr = dims?.sceneRect ?? null;
    const result = {
      x, y, floorIdx: Number(floorIdx ?? NaN),
      floorKey: null,
      sceneRect: sr ? { x: sr.x, y: sr.y, w: sr.width, h: sr.height } : null,
      value: null,
      outdoors: null,
      error: null,
    };
    if (!compositor || !renderer || !sr) {
      result.error = 'no-compositor-or-renderer';
      return result;
    }
    const floors = ms.floorStack?.getFloors?.() ?? [];
    const idx = Number.isFinite(result.floorIdx)
      ? result.floorIdx
      : Number(ms.floorStack?.getActiveFloor?.()?.index ?? 0);
    result.floorIdx = idx;
    const floor = floors.find((f) => Number(f?.index) === idx) ?? null;
    const floorKey = floor?.compositorKey ?? compositor?._activeFloorKey ?? 'ground';
    result.floorKey = floorKey;

    const skyReachRt = compositor._floorCache?.get(floorKey)?.get('skyReach') ?? null;
    const outdoorsRt = compositor._floorCache?.get(floorKey)?.get('outdoors') ?? null;
    if (!skyReachRt) {
      result.error = 'no-skyReach-rt';
      return result;
    }
    const uvX = (Number(x) - sr.x) / sr.width;
    const uvYFoundry = (Number(y) - sr.y) / sr.height;
    const uvY = 1.0 - uvYFoundry;
    const px = Math.max(0, Math.min(skyReachRt.width - 1, Math.floor(uvX * skyReachRt.width)));
    const py = Math.max(0, Math.min(skyReachRt.height - 1, Math.floor(uvY * skyReachRt.height)));
    const buf = new Uint8Array(4);
    try {
      renderer.readRenderTargetPixels(skyReachRt, px, py, 1, 1, buf);
      result.value = buf[0] / 255.0;
    } catch (e) {
      result.error = 'skyReach-readback-failed:' + (e?.message ?? String(e));
    }
    if (outdoorsRt) {
      try {
        const oPx = Math.max(0, Math.min(outdoorsRt.width - 1, Math.floor(uvX * outdoorsRt.width)));
        const oPy = Math.max(0, Math.min(outdoorsRt.height - 1, Math.floor(uvY * outdoorsRt.height)));
        const obuf = new Uint8Array(4);
        renderer.readRenderTargetPixels(outdoorsRt, oPx, oPy, 1, 1, obuf);
        result.outdoors = obuf[0] / 255.0;
      } catch (_) {}
    }
    try { console.log('[skyReachProbe]', result); } catch (_) {}
    return result;
  },

  /**
   * Why overhead sky-reach shelter can be “always on” but invisible: the shader
   * only runs the branch when `uHasSkyReach` is set (bound non-null `skyReach`
   * texture). Missing RT → skipped. Flat skyReach≈1 everywhere → no shelter.
   *
   * Usage: MapShine.debug.diagnoseSkyReachV2()
   *
   * @returns {object}
   */
  diagnoseSkyReachV2() {
    const ms = window.MapShine ?? {};
    const comp = ms.sceneComposer?._sceneMaskCompositor ?? null;
    const fc = ms.effectComposer?._floorCompositorV2 ?? null;
    const oh = fc?._overheadShadowEffect ?? null;
    const floors = ms.floorStack?.getFloors?.() ?? [];
    const active = ms.floorStack?.getActiveFloor?.() ?? null;

    /** @type {number|null} */
    let uHasSkyReach = null;
    /** @type {number|null} */
    let uSkyReachShadowOpacity = null;
    try {
      const u = oh?.material?.uniforms;
      if (u?.uHasSkyReach) uHasSkyReach = Number(u.uHasSkyReach.value);
      if (u?.uSkyReachShadowOpacity) uSkyReachShadowOpacity = Number(u.uSkyReachShadowOpacity.value);
    } catch (_) {}

    const rows = floors.map((f) => {
      const key =
        f?.compositorKey != null
          ? String(f.compositorKey)
          : `${Number(f?.elevationMin)}:${Number(f?.elevationMax)}`;
      const skyReach = comp?.getFloorTexture?.(key, 'skyReach') ?? null;
      const floorAlpha = comp?.getFloorTexture?.(key, 'floorAlpha') ?? null;
      const outdoors = comp?.getFloorTexture?.(key, 'outdoors') ?? null;
      const w = skyReach?.image?.width ?? skyReach?.source?.data?.width ?? skyReach?.width ?? null;
      const h = skyReach?.image?.height ?? skyReach?.source?.data?.height ?? skyReach?.height ?? null;
      return {
        index: f?.index,
        key,
        outdoors: outdoors ? 'yes' : '—',
        floorAlpha: floorAlpha ? 'yes' : '—',
        skyReachTex: skyReach ? 'yes' : '—',
        size: w && h ? `${w}×${h}` : '—',
      };
    });

    const summary = {
      compositor: !!comp,
      overheadEffect: !!oh,
      overheadParamsEnabled: oh?.params?.enabled !== false,
      overheadOpacity: oh?.params?.opacity,
      skyReachShadowOpacityParam: oh?.params?.skyReachShadowOpacity,
      uHasSkyReach,
      uSkyReachShadowOpacityUniform: uSkyReachShadowOpacity,
      cacheFloorKeys: comp?._floorCache ? [...comp._floorCache.keys()] : [],
      _activeFloorKey: comp?._activeFloorKey ?? null,
    };

    try {
      console.table(rows);
      console.log('[diagnoseSkyReachV2] GPU uniforms / compositor — inspect `summary`:', summary);
    } catch (_) {}

    const activeKey =
      active?.compositorKey != null
        ? String(active.compositorKey)
        : Number.isFinite(Number(active?.elevationMin)) && Number.isFinite(Number(active?.elevationMax))
          ? `${Number(active.elevationMin)}:${Number(active.elevationMax)}`
          : null;

    let activeSky = activeKey && comp?.getFloorTexture ? comp.getFloorTexture(activeKey, 'skyReach') : null;

    if (!activeSky && activeKey && comp?.getFloorTexture) {
      const alt = `${Number(active?.elevationMin)}:${Number(active?.elevationMax)}`;
      if (alt !== activeKey) activeSky = comp.getFloorTexture(alt, 'skyReach');
    }

    if (!activeSky) {
      console.warn(
        '[diagnoseSkyReachV2] Active floor has NO skyReach texture → uHasSkyReach stays 0 → shelter math never runs. Compose masks / visit upper floors so GpuSceneMaskCompositor caches floorAlpha above this band.',
      );
    } else if (uHasSkyReach != null && uHasSkyReach < 0.5) {
      console.warn(
        '[diagnoseSkyReachV2] skyReach RT exists but uHasSkyReach<0.5 — key mismatch vs FloorCompositor bind path or update not run yet.',
      );
    } else {
      console.info(
        '[diagnoseSkyReachV2] Texture bound. If still no darkness under decks: sample MapShine.debug.skyReachProbe(x,y) under a bridge — expect value≈0 there; value≈1 everywhere means upper-floor floorAlpha never occluded this band.',
      );
    }

    return { rows, summary, activeKey, hasActiveSkyReachTex: !!activeSky };
  },

  /**
   * Toggle the unified MaskBindingController rollout flag at runtime.
   * When enabled, FloorCompositor routes per-frame mask fan-out through
   * MaskBindingController (in addition to the legacy outdoors sync) so the
   * controller can validate and publish telemetry. Disable to fall back to
   * the legacy path only.
   *
   * Usage: MapShine.debug.setMaskBindingController(true|false)
   *
   * @param {boolean} enabled
   * @returns {boolean} resolved flag state
   */
  setMaskBindingController(enabled) {
    if (!window.MapShine) window.MapShine = {};
    window.MapShine.maskBindingControllerEnabled = enabled === true;
    try { window.MapShine.__maskBindingController?.invalidate?.(); } catch (_) {}
    console.log(`[maskBindingController] ${enabled === true ? 'ENABLED' : 'DISABLED'}`);
    return window.MapShine.maskBindingControllerEnabled;
  },

  /**
   * Snapshot WaterEffectV2 params vs live shader uniforms and floor routing.
   * Use before/after changing levels; paste the printed object into a bug report.
   *
   * Usage:
   *   MapShine.debug.probeWaterFloorConfig()
   *   MapShine.debug.probeWaterFloorConfig({ watch: true })
   *   MapShine.debug.probeWaterFloorConfig.stop()
   *
   * @param {{ watch?: boolean, intervalMs?: number, log?: boolean }} [opts]
   * @returns {object}
   */
  probeWaterFloorConfig(opts = {}) {
    const ms = window.MapShine ?? {};
    const fc = ms.effectComposer?._floorCompositorV2 ?? ms.floorCompositorV2 ?? null;
    const we = fc?._waterEffect ?? ms.waterEffect ?? null;
    const fs = ms.floorStack ?? null;
    const u = we?._composeMaterial?.uniforms ?? null;

    const texId = (tex) => {
      if (!tex) return null;
      try {
        return tex.uuid ?? tex.image?.src?.slice?.(-48) ?? String(tex);
      } catch (_) {
        return 'tex';
      }
    };

    const texSize = (tex) => {
      if (!tex) return null;
      const img = tex?.image;
      const w = img?.width ?? img?.videoWidth ?? tex?.source?.data?.width ?? null;
      const h = img?.height ?? img?.videoHeight ?? tex?.source?.data?.height ?? null;
      return (w && h) ? { w, h } : null;
    };

    const active = fs?.getActiveFloor?.() ?? null;
    const visible = fs?.getVisibleFloors?.() ?? [];
    const visibleIndices = visible.map((f) => Number(f?.index));
    const sceneFloorCount = floorStack?.getFloors?.()?.length ?? visible.length;
    const usePostMergeWater = sceneFloorCount > 1;

    const paramsUseSdf = we?.params?.useSdfMask;
    const uniformUseSdf = Number(u?.uUseSdfMask?.value);
    const paramsMaskThr = we?.params?.maskThreshold;
    const uniformMaskThr = Number(u?.uWaterRawMaskThreshold?.value);

    const floorWaterKeys = we?._floorWater
      ? [...we._floorWater.keys()].map((k) => Number(k))
      : [];
    const activeWaterFloor = Number.isFinite(Number(we?._activeFloorIndex))
      ? Number(we._activeFloorIndex)
      : null;
    const cachedFloorPack = (activeWaterFloor != null && we?._floorWater?.get)
      ? we._floorWater.get(activeWaterFloor)
      : null;

    const outdoorsRoute = ms.__v2OutdoorsRoute ?? null;
    const waterDebug = ms.__waterDebug ?? null;

    const snap = {
      at: new Date().toISOString(),
      floor: {
        activeIndex: Number.isFinite(Number(active?.index)) ? Number(active.index) : null,
        activeCompositorKey: active?.compositorKey ?? null,
        activeLevelContext: ms.activeLevelContext ?? null,
        visibleIndices,
        visibleCount: visible.length,
        sceneFloorCount: floorStack?.getFloors?.()?.length ?? visible.length,
        usePostMergeWater,
        usePostMergeWaterLegacyVisibleGate: visible.length > 1,
        compositorActiveFloorIndex: Number.isFinite(Number(fc?._activeFloorIndex))
          ? Number(fc._activeFloorIndex)
          : null,
      },
      waterEffect: {
        instanceId: we?._instanceId ?? null,
        initialized: !!we?._initialized,
        realShaderCompiled: !!we?._realShaderCompiled,
        enabled: !!we?.enabled,
        hasAnyWaterData: !!we?._hasAnyWaterData,
        activeFloorIndex: Number.isFinite(Number(we?._activeFloorIndex))
          ? Number(we._activeFloorIndex)
          : null,
        perLevelOverride: Number.isFinite(Number(we?._perLevelOverride))
          ? Number(we._perLevelOverride)
          : -1,
        floorWaterKeys,
        cachedPackSignature: cachedFloorPack?.packSignature ?? null,
        cachedTextures: cachedFloorPack ? {
          tWaterData: texId(cachedFloorPack?.waterData?.texture),
          tWaterRawMask: texId(cachedFloorPack?.rawMask ?? cachedFloorPack?.waterData?.rawMaskTexture),
        } : null,
      },
      settings: {
        params: {
          useSdfMask: paramsUseSdf,
          maskThreshold: paramsMaskThr,
          debugView: we?.params?.debugView ?? 0,
        },
        uniforms: {
          uUseSdfMask: uniformUseSdf,
          uWaterRawMaskThreshold: uniformMaskThr,
          uDebugView: Number(u?.uDebugView?.value),
          uCrossSliceWaterData: Number(u?.uCrossSliceWaterData?.value),
          uWaterEnabled: Number(u?.uWaterEnabled?.value),
        },
      },
      masks: {
        uHasWaterData: Number(u?.uHasWaterData?.value),
        uHasWaterRawMask: Number(u?.uHasWaterRawMask?.value),
        tWaterData: { id: texId(u?.tWaterData?.value), size: texSize(u?.tWaterData?.value) },
        tWaterRawMask: { id: texId(u?.tWaterRawMask?.value), size: texSize(u?.tWaterRawMask?.value) },
        uHasOutdoorsMask: Number(u?.uHasOutdoorsMask?.value),
        tOutdoorsMask: { id: texId(u?.tOutdoorsMask?.value), size: texSize(u?.tOutdoorsMask?.value) },
        uOutdoorsMaskFlipY: Number(u?.uOutdoorsMaskFlipY?.value),
        outdoorsRoute,
        frameWaterSourceDeck: waterDebug?.lastSourceFloorIndex ?? null,
      },
      mismatches: [],
    };

    const sdfOffInParams = paramsUseSdf === false;
    const sdfOffInUniform = uniformUseSdf < 0.5;
    if (sdfOffInParams !== sdfOffInUniform) {
      snap.mismatches.push({
        code: 'SDF_PARAMS_UNIFORM',
        message: `params.useSdfMask=${paramsUseSdf} but uUseSdfMask=${uniformUseSdf}`,
      });
    }
    if (sdfOffInParams && !sdfOffInUniform) {
      snap.mismatches.push({
        code: 'SDF_STUCK_ON',
        message: 'SDF disabled in params but shader uniform still ON',
      });
    }
    if (
      Number.isFinite(paramsMaskThr)
      && Number.isFinite(uniformMaskThr)
      && Math.abs(paramsMaskThr - uniformMaskThr) > 1e-4
    ) {
      snap.mismatches.push({
        code: 'MASK_THRESHOLD_DRIFT',
        message: `params.maskThreshold=${paramsMaskThr} vs uniform=${uniformMaskThr}`,
      });
    }
    if (we?._perLevelOverride >= 0 && usePostMergeWater) {
      snap.mismatches.push({
        code: 'PER_LEVEL_OVERRIDE_DURING_POST_MERGE',
        message: `_perLevelOverride=${we._perLevelOverride} while post-merge water active`,
      });
    }
    const cachedWd = snap.waterEffect.cachedTextures?.tWaterData ?? null;
    const boundWd = snap.masks.tWaterData?.id ?? null;
    if (cachedWd && boundWd && cachedWd !== boundWd) {
      snap.mismatches.push({
        code: 'WATER_TEX_NOT_FROM_CACHE',
        message: `shader tWaterData (${boundWd}) !== cached floor pack (${cachedWd})`,
      });
    }

    snap.ok = snap.mismatches.length === 0;
    snap.summary = snap.ok
      ? 'params and uniforms agree'
      : snap.mismatches.map((m) => m.code).join(', ');

    if (opts.log !== false) {
      try {
        console.groupCollapsed(`[probeWaterFloorConfig] ${snap.summary} | floor ${snap.floor.activeIndex}`);
        console.log(snap);
        if (snap.mismatches.length) console.warn('MISMATCHES:', snap.mismatches);
        console.groupEnd();
      } catch (_) {}
    }

    if (opts.watch === true) {
      const intervalMs = Math.max(100, Number(opts.intervalMs) || 400);
      if (consoleHelpers._waterFloorProbeTimer) {
        clearInterval(consoleHelpers._waterFloorProbeTimer);
      }
      const sigOf = (s) => JSON.stringify({
        fi: s.floor.activeIndex,
        vi: s.floor.visibleIndices,
        post: s.floor.usePostMergeWater,
        wd: s.masks.tWaterData?.id,
        cwd: s.waterEffect.cachedTextures?.tWaterData,
        sdfP: s.settings.params.useSdfMask,
        sdfU: s.settings.uniforms.uUseSdfMask,
        afi: s.waterEffect.activeFloorIndex,
        plo: s.waterEffect.perLevelOverride,
        cross: s.settings.uniforms.uCrossSliceWaterData,
        out: s.masks.tOutdoorsMask?.id,
      });
      let lastSig = sigOf(snap);
      consoleHelpers._waterFloorProbeLast = snap;
      consoleHelpers._waterFloorProbeTimer = setInterval(() => {
        const next = consoleHelpers.probeWaterFloorConfig({ log: false, watch: false });
        const sig = sigOf(next);
        if (sig !== lastSig) {
          lastSig = sig;
          consoleHelpers._waterFloorProbeLast = next;
          console.warn('[probeWaterFloorConfig] CHANGE', next);
        }
      }, intervalMs);
      console.info(
        `[probeWaterFloorConfig] watching every ${intervalMs}ms — change floors, paste CHANGE logs. Stop: MapShine.probeWaterFloorConfig.stop()`,
      );
    }

    return snap;
  },

  probeWaterFloorConfigStop() {
    if (consoleHelpers._waterFloorProbeTimer) {
      clearInterval(consoleHelpers._waterFloorProbeTimer);
      consoleHelpers._waterFloorProbeTimer = null;
    }
    const last = consoleHelpers._waterFloorProbeLast ?? null;
    console.info('[probeWaterFloorConfig] watch stopped', last ? { last } : '');
    return last;
  },

  /**
   * Read back the RGBA of every per-level final RT (plus the water occluder
   * RT if present) at screen pixel (x, y).
   *
   * Validates the multi-floor "sandwich" contract: on the upper floor's RT,
   * the pixel alpha must be 1.0 where that floor has opaque art and 0.0
   * where it is empty (so lower-floor composite shows through). On the
   * ground floor, water regions should read alpha 1.0 after the water pass.
   *
   * If water is not appearing where it should, the usual culprit is the
   * upper-floor RT having alpha = 1 at the "hole" pixel — meaning the
   * authored alpha hole in your upper-bg art isn't actually present in the
   * texture (often because the image was saved as JPEG or flattened on
   * export). Compare the upper-level alpha here vs. the occluder alpha.
   *
   * Coordinates are CSS pixels on the canvas (top-left origin); they are
   * translated to GL viewport space (bottom-left origin) internally.
   *
   * Usage: MapShine.debug.levelAlphaProbe(x, y)
   *
   * @param {number} x Canvas CSS pixel X (0 = left).
   * @param {number} y Canvas CSS pixel Y (0 = top).
   * @returns {object}
   */
  levelAlphaProbe(x, y) {
    const ms = window?.MapShine ?? {};
    const renderer = ms.renderer ?? null;
    const diag = ms.__v2PerLevelDiag ?? null;
    const finalRTs = Array.isArray(diag?.levelFinalRTs) ? diag.levelFinalRTs : [];
    const sceneRTs = Array.isArray(diag?.levelSceneRTs) ? diag.levelSceneRTs : [];
    const visibleFloors = Array.isArray(diag?.visibleFloors) ? diag.visibleFloors : [];
    const result = {
      x: Number(x),
      y: Number(y),
      levelIndices: Array.isArray(diag?.levelIndices) ? [...diag.levelIndices] : [],
      // Each entry carries both:
      //   .scene  — raw sceneRT alpha (authored solidity, pre-post-pass)
      //   .final  — level RT alpha post-rebind (what the composite reads)
      // A mismatch (scene.alpha=0 but final.alpha>0) means a post-pass
      // widened alpha beyond authored content; the rebind pass should
      // prevent that going forward, so expect them to match.
      levels: [],
      occluder: null,
      error: null,
    };
    if (!renderer) { result.error = 'no-renderer'; return result; }
    if (!finalRTs.length) { result.error = 'no-per-level-rts'; return result; }

    const readPixel = (rt) => {
      if (!rt || !Number.isFinite(rt.width) || !Number.isFinite(rt.height)) return null;
      const px = Math.max(0, Math.min(rt.width - 1, Math.floor(Number(x))));
      const pyTop = Math.max(0, Math.min(rt.height - 1, Math.floor(Number(y))));
      const py = (rt.height - 1) - pyTop;
      const buf = new Uint8Array(4);
      try {
        renderer.readRenderTargetPixels(rt, px, py, 1, 1, buf);
        return {
          rgba: [buf[0] / 255, buf[1] / 255, buf[2] / 255, buf[3] / 255],
          alpha: buf[3] / 255,
        };
      } catch (e) {
        return { error: 'readback-failed:' + (e?.message ?? String(e)) };
      }
    };

    for (let i = 0; i < finalRTs.length; i++) {
      const finalRT = finalRTs[i];
      const sceneRT = sceneRTs[i] ?? null;
      const floorIndex = Number.isFinite(visibleFloors[i]) ? visibleFloors[i] : null;
      result.levels.push({
        i,
        levelIndex: result.levelIndices[i] ?? null,
        floorIndex,
        scene: sceneRT ? readPixel(sceneRT) : { error: 'no-scene-rt' },
        final: finalRT ? readPixel(finalRT) : { error: 'no-final-rt' },
      });
    }

    // Water occluder RT: tile-only alpha union of floors above the
    // currently-rendering level. Typically bound when rendering the ground
    // RT, so this reads whatever state it was in at the end of the last
    // frame's per-level loop — useful for comparing with the upper RT's
    // own alpha at the probed pixel.
    const occluderRT = diag?.waterOccluderRT ?? null;
    if (occluderRT) {
      const hit = readPixel(occluderRT);
      result.occluder = hit;
    }

    try { console.log('[levelAlphaProbe]', result); } catch (_) {}
    return result;
  },

  /**
   * Copy every per-level RT (scene AND final), plus the water occluder
   * RT, to offscreen canvases and open each as a PNG data-URL in a new
   * tab. Lets you verify visually whether authored alpha holes are
   * preserved end-to-end.
   *
   * For each level you get TWO tabs:
   *   - `sceneRT[i] floor=N`  — raw draw output of renderFloorRangeTo
   *     (pre-any-pass). Its alpha is the authored solidity mask: if
   *     this tab shows checkerboard where your WebP has authored
   *     alpha=0, draw-time is preserving alpha correctly.
   *   - `finalRT[i] floor=N`  — post-chain, post-rebind output. This
   *     is what LevelCompositePass actually reads. If the alpha-rebind
   *     pass is working, this tab's alpha should match the sceneRT's.
   *
   * If sceneRT shows checkered but finalRT is opaque, a post-pass is
   * widening alpha and the rebind pass isn't taking effect. If both
   * show opaque where your WebP should have holes, the issue is
   * upstream (texture upload, bg vs tile routing, floorIndex mismatch)
   * — in that case the authored alpha isn't reaching the bus.
   *
   * Tabs are labelled by their floor index. If popups are blocked, the
   * data URLs are returned in the result object so they can be opened
   * manually.
   *
   * Usage: MapShine.debug.dumpLevelRTs()
   */
  dumpLevelRTs() {
    const ms = window?.MapShine ?? {};
    const renderer = ms.renderer ?? null;
    const diag = ms.__v2PerLevelDiag ?? null;
    const finalRTs = Array.isArray(diag?.levelFinalRTs) ? diag.levelFinalRTs : [];
    const sceneRTs = Array.isArray(diag?.levelSceneRTs) ? diag.levelSceneRTs : [];
    const visibleFloors = Array.isArray(diag?.visibleFloors) ? diag.visibleFloors : [];
    const result = { dumps: [], error: null };

    if (!renderer) { result.error = 'no-renderer'; return result; }
    if (!finalRTs.length) { result.error = 'no-per-level-rts'; return result; }

    const makeDataUrl = (rt, label) => {
      if (!rt || !(rt.width > 0) || !(rt.height > 0)) {
        return { label, error: 'no-rt' };
      }
      const w = rt.width | 0;
      const h = rt.height | 0;
      const pixels = new Uint8Array(w * h * 4);
      try {
        renderer.readRenderTargetPixels(rt, 0, 0, w, h, pixels);
      } catch (e) {
        return { label, error: 'readback-failed:' + (e?.message ?? String(e)) };
      }
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d');
      if (!ctx) return { label, error: 'no-2d-context' };
      const img = ctx.createImageData(w, h);
      // GL origin is bottom-left; flip rows so the PNG matches the
      // on-screen orientation of the canvas.
      for (let y = 0; y < h; y++) {
        const srcRow = (h - 1 - y) * w * 4;
        const dstRow = y * w * 4;
        img.data.set(pixels.subarray(srcRow, srcRow + w * 4), dstRow);
      }
      ctx.putImageData(img, 0, 0);
      let dataUrl = null;
      try {
        dataUrl = canvas.toDataURL('image/png');
      } catch (e) {
        return { label, error: 'toDataURL-failed:' + (e?.message ?? String(e)) };
      }
      try {
        const win = window.open();
        if (win) {
          win.document.title = label;
          // Checkerboard background so alpha holes are visually obvious.
          win.document.body.style.background = 'repeating-conic-gradient(#555 0% 25%, #777 0% 50%) 50% / 20px 20px';
          win.document.body.style.margin = '0';
          const p = win.document.createElement('p');
          p.textContent = label + '  (' + w + 'x' + h + ')';
          p.style.color = '#fff';
          p.style.font = '14px monospace';
          p.style.padding = '6px';
          p.style.margin = '0';
          p.style.background = 'rgba(0,0,0,0.7)';
          const im = win.document.createElement('img');
          im.src = dataUrl;
          im.style.display = 'block';
          im.style.maxWidth = '100%';
          win.document.body.appendChild(p);
          win.document.body.appendChild(im);
        }
      } catch (_) {}
      return { label, width: w, height: h, dataUrl };
    };

    // Dump sceneRT and finalRT in interleaved order so the tabs pair up
    // visually (floor 0 scene, floor 0 final, floor 1 scene, floor 1
    // final, ...) — makes side-by-side diffing trivial.
    for (let i = 0; i < finalRTs.length; i++) {
      const floorIndex = Number.isFinite(visibleFloors[i]) ? visibleFloors[i] : i;
      const sceneRT = sceneRTs[i] ?? null;
      if (sceneRT) {
        const sceneLabel = 'sceneRT[' + i + ']  floor=' + floorIndex + '  (authored alpha; pre-passes)';
        result.dumps.push(makeDataUrl(sceneRT, sceneLabel));
      }
      const finalLabel = 'finalRT[' + i + ']  floor=' + floorIndex + '  (post-chain + alpha-rebind)';
      result.dumps.push(makeDataUrl(finalRTs[i], finalLabel));
    }
    const occluder = diag?.waterOccluderRT ?? null;
    if (occluder) {
      result.dumps.push(makeDataUrl(occluder, 'waterOccluderRT (tiles above rendering level)'));
    }
    try { console.log('[dumpLevelRTs]', result); } catch (_) {}
    return result;
  },

  /**
   * Tabular listing of every entry in `FloorRenderBus._tiles`. Tells you
   * exactly what is registered on each floor (bg planes, solid fill,
   * regular tiles), including the textureSrc and the material-state
   * flags that determine alpha blending.
   *
   * Use this when the per-level RT dump shows the wrong alpha pattern
   * to identify:
   *   - Is the upper-floor WebP even loaded? (`__bg_image__1` with the
   *     expected `textureSrc`?)
   *   - Is it registered with the right `floorIndex` for the per-level
   *     filter? (`floorIndex` must equal the floor's `index` in
   *     `FloorStack`, otherwise `renderFloorRangeTo` filters it out.)
   *   - Do the materials have the alpha flags we expect? (`alphaTest`,
   *     `transparent`, `premultipliedAlpha`, `opacity`.)
   *
   * Usage: MapShine.debug.busInventory()
   */
  busInventory() {
    const bus = _resolveFloorRenderBus();
    if (!bus) {
      const ms = globalThis.MapShine ?? {};
      const fc = ms.floorCompositorV2 ?? ms.effectComposer?._floorCompositorV2 ?? null;
      return {
        error: 'no-bus',
        hint: fc
          ? 'FloorCompositor exists but _renderBus is missing (not initialized?)'
          : 'No FloorCompositor: expected MapShine.effectComposer._floorCompositorV2 or MapShine.floorCompositorV2',
      };
    }
    const tiles = bus._tiles;
    if (!tiles || typeof tiles.forEach !== 'function') return { error: 'no-tiles-map' };
    const rows = [];
    tiles.forEach((entry, tileId) => {
      const mat = entry?.material ?? null;
      const tex = mat?.map ?? null;
      const img = tex?.image ?? null;
      rows.push({
        tileId,
        floorIndex: entry?.floorIndex,
        visible: (entry?.root ?? entry?.mesh)?.visible === true,
        isBg: typeof tileId === 'string' && tileId.startsWith('__'),
        textureSrc: tex?.userData?.mapShineBackgroundSrc
          ?? (typeof img?.src === 'string' ? img.src : null),
        textureWidth: img?.width ?? img?.naturalWidth ?? null,
        textureHeight: img?.height ?? img?.naturalHeight ?? null,
        alphaTest: mat?.alphaTest,
        transparent: mat?.transparent,
        premultipliedAlpha: mat?.premultipliedAlpha,
        texPremultiplyAlpha: tex?.premultiplyAlpha,
        opacity: mat?.opacity,
        blending: mat?.blending,
        depthTest: mat?.depthTest,
        colorSpace: tex?.colorSpace,
      });
    });
    rows.sort((a, b) => {
      const fa = Number(a.floorIndex); const fb = Number(b.floorIndex);
      if (Number.isFinite(fa) && Number.isFinite(fb) && fa !== fb) return fa - fb;
      return String(a.tileId).localeCompare(String(b.tileId));
    });
    const result = {
      total: rows.length,
      byFloor: rows.reduce((acc, r) => {
        const k = Number.isFinite(Number(r.floorIndex)) ? Number(r.floorIndex) : 'n/a';
        acc[k] = (acc[k] ?? 0) + 1; return acc;
      }, {}),
      rows,
    };
    try {
      console.log('[busInventory]', result);
      if (typeof console.table === 'function') {
        console.table(rows.map((r) => ({
          tileId: r.tileId,
          floor: r.floorIndex,
          vis: r.visible,
          bg: r.isBg,
          texW: r.textureWidth,
          texH: r.textureHeight,
          alphaTest: r.alphaTest,
          transp: r.transparent,
          premulMat: r.premultipliedAlpha,
          premulTex: r.texPremultiplyAlpha,
          opacity: r.opacity,
          src: (typeof r.textureSrc === 'string' ? r.textureSrc.split('/').pop() : r.textureSrc),
        })));
      }
    } catch (_) {}
    return result;
  },

  /**
   * Dump the source image (not the GPU upload) of every `__bg_image__*`
   * entry's texture, rendered to a 2D canvas and opened as a PNG tab
   * over a checkerboard. Lets you visually confirm that the loaded
   * image actually carries the alpha channel you expect — separate
   * from the render pipeline.
   *
   * If a tab shows the full image as opaque where your source WebP
   * should be 45% transparent, the alpha was lost before the render
   * pipeline — i.e. the WebP file itself, the <img> decode, or the
   * load path stripped it. If the tab shows the correct alpha pattern,
   * the problem is downstream (GPU upload flags, material blending,
   * floor routing in `renderFloorRangeTo`).
   *
   * Usage: MapShine.debug.dumpBgTextures()
   */
  dumpBgTextures() {
    const bus = _resolveFloorRenderBus();
    if (!bus) {
      const ms = globalThis.MapShine ?? {};
      const fc = ms.floorCompositorV2 ?? ms.effectComposer?._floorCompositorV2 ?? null;
      return {
        error: 'no-bus',
        hint: fc
          ? 'FloorCompositor exists but _renderBus is missing (not initialized?)'
          : 'No FloorCompositor: expected MapShine.effectComposer._floorCompositorV2 or MapShine.floorCompositorV2',
      };
    }
    const tiles = bus._tiles;
    if (!tiles) return { error: 'no-tiles-map' };

    const dumps = [];

    /**
     * Draw a texture source to a checkerboard tab. Accepts:
     *   - HTMLImageElement / ImageBitmap / HTMLCanvasElement (drawImage path)
     *   - DataTexture-style `{ data: Uint8Array, width, height }` (putImageData
     *     path — the canvas-decoded straight-alpha path used by
     *     `_loadBgImageStraightAlpha`).
     *
     * Either way the output tab shows the authored alpha pattern independent
     * of any GPU upload mutations — so if this tab shows the correct holes
     * and `dumpBgTexturesGpu()` does not, the bug is in WebGL upload, not
     * in the texture source itself.
     */
    const drawImageToTab = (img, label) => {
      const isDataSource = img && img.data && ArrayBuffer.isView(img.data)
        && Number(img.width) > 0 && Number(img.height) > 0;
      const isDrawable = img && (img.naturalWidth > 0 || img.width > 0);
      if (!isDataSource && !isDrawable) {
        dumps.push({ label, error: 'no-image' });
        return;
      }
      const w = isDataSource ? Number(img.width) : (img.naturalWidth || img.width);
      const h = isDataSource ? Number(img.height) : (img.naturalHeight || img.height);
      const cv = document.createElement('canvas');
      cv.width = w; cv.height = h;
      const cx = cv.getContext('2d');
      if (!cx) { dumps.push({ label, error: 'no-2d-context' }); return; }
      try {
        cx.clearRect(0, 0, w, h);
        if (isDataSource) {
          // DataTexture path: the bytes are the authored straight-alpha
          // RGBA from `_loadBgImageStraightAlpha`. `putImageData` preserves
          // alpha exactly — unlike `drawImage`, which would reinterpret
          // premultiplication on canvas writes.
          const id = cx.createImageData(w, h);
          id.data.set(img.data);
          cx.putImageData(id, 0, 0);
        } else {
          cx.drawImage(img, 0, 0);
        }
      } catch (e) {
        dumps.push({ label, error: 'drawImage-failed:' + (e?.message ?? String(e)) });
        return;
      }
      let dataUrl = null;
      try { dataUrl = cv.toDataURL('image/png'); } catch (e) {
        dumps.push({ label, error: 'toDataURL-failed:' + (e?.message ?? String(e)) });
        return;
      }
      try {
        const win = window.open();
        if (win) {
          win.document.title = label;
          win.document.body.style.background = 'repeating-conic-gradient(#555 0% 25%, #777 0% 50%) 50% / 20px 20px';
          win.document.body.style.margin = '0';
          const p = win.document.createElement('p');
          p.textContent = label + '  (' + w + 'x' + h + ')';
          p.style.color = '#fff';
          p.style.font = '14px monospace';
          p.style.padding = '6px';
          p.style.margin = '0';
          p.style.background = 'rgba(0,0,0,0.7)';
          const im = win.document.createElement('img');
          im.src = dataUrl;
          im.style.display = 'block';
          im.style.maxWidth = '100%';
          win.document.body.appendChild(p);
          win.document.body.appendChild(im);
        }
      } catch (_) {}
      dumps.push({ label, width: w, height: h, dataUrl });
    };

    tiles.forEach((entry, tileId) => {
      if (!tileId || typeof tileId !== 'string') return;
      if (!tileId.startsWith('__bg_image__')) return;
      const mat = entry?.material ?? null;
      const tex = mat?.map ?? null;
      const img = tex?.image ?? null;
      const src = tex?.userData?.mapShineBackgroundSrc
        ?? (typeof img?.src === 'string' ? img.src : '(no src)');
      const shortSrc = (typeof src === 'string') ? (src.split('/').pop() ?? src) : '(no src)';
      const label = tileId + '  floor=' + entry?.floorIndex + '  src=' + shortSrc;
      drawImageToTab(img, label);
    });

    const result = { dumps };
    try { console.log('[dumpBgTextures]', result); } catch (_) {}
    return result;
  },

  /**
   * Isolate texture-upload fidelity from the full render pipeline. Renders
   * each `__bg_image__*` mesh by itself into a throwaway RGBA8 render
   * target (same format as per-level RTs) with `clearAlpha: 0`, using
   * identical material/blending to the per-level draw. Then reads the
   * result back and opens it as a PNG on a checkerboard.
   *
   * If these tabs show the AUTHORED alpha pattern (checker everywhere the
   * WebP has alpha=0), the GPU upload and single-mesh draw are fine —
   * the bug is something hiding the mesh or overwriting alpha during
   * the multi-step per-level pipeline.
   *
   * If these tabs show alpha=1 everywhere except the user-cut hole, the
   * GPU upload or three.js blending is losing authored alpha at draw
   * time — independent of any per-level pipeline step.
   *
   * Usage: MapShine.debug.dumpBgTexturesGpu()
   */
  dumpBgTexturesGpu() {
    const ms = globalThis.MapShine ?? {};
    const fc = ms.floorCompositorV2 ?? ms.effectComposer?._floorCompositorV2 ?? null;
    const bus = fc?._renderBus ?? null;
    const renderer = ms.renderer ?? null;
    const camera = fc?.camera ?? null;
    if (!bus || !renderer || !camera) {
      return { error: 'missing-renderer-or-bus-or-camera' };
    }
    const THREE = window.THREE;
    if (!THREE) return { error: 'no-THREE' };

    const dumps = [];
    const tiles = bus._tiles;
    if (!tiles) return { error: 'no-tiles' };

    // 1. Hide every entry, remember what we hid.
    const priorVis = new Map();
    tiles.forEach((entry, tileId) => {
      const node = entry?.root ?? entry?.mesh;
      if (!node) return;
      priorVis.set(tileId, node.visible);
      node.visible = false;
    });

    const prevTarget = renderer.getRenderTarget();
    const prevAutoClear = renderer.autoClear;
    const prevClearColor = renderer.getClearColor(new THREE.Color());
    const prevClearAlpha = renderer.getClearAlpha();
    const prevLayerMask = camera.layers.mask;

    try {
      // Match per-level camera layer setup (layers 0..19 as in
      // FloorRenderBus.renderFloorRangeTo).
      for (let i = 0; i <= 19; i++) camera.layers.enable(i);

      tiles.forEach((entry, tileId) => {
        if (typeof tileId !== 'string' || !tileId.startsWith('__bg_image__')) return;
        const node = entry?.root ?? entry?.mesh;
        const tex = entry?.material?.map ?? null;
        if (!node || !tex) return;

        const w = 512;
        const h = Math.max(1, Math.round(512 * (tex.image?.height ?? 1) / Math.max(1, tex.image?.width ?? 1)));
        const rt = new THREE.WebGLRenderTarget(w, h, {
          format: THREE.RGBAFormat,
          type: THREE.UnsignedByteType,
          depthBuffer: false,
          stencilBuffer: false,
          minFilter: THREE.LinearFilter,
          magFilter: THREE.LinearFilter,
        });

        node.visible = true;
        renderer.setRenderTarget(rt);
        renderer.setClearColor(0x000000, 0);
        renderer.autoClear = true;
        renderer.render(bus._scene, camera);
        node.visible = false;

        const pixels = new Uint8Array(w * h * 4);
        try { renderer.readRenderTargetPixels(rt, 0, 0, w, h, pixels); } catch (_) {}

        const cv = document.createElement('canvas');
        cv.width = w; cv.height = h;
        const cx = cv.getContext('2d');
        const img = cx.createImageData(w, h);
        for (let y = 0; y < h; y++) {
          const src = (h - 1 - y) * w * 4;
          const dst = y * w * 4;
          img.data.set(pixels.subarray(src, src + w * 4), dst);
        }
        cx.putImageData(img, 0, 0);

        let dataUrl = null;
        try { dataUrl = cv.toDataURL('image/png'); } catch (_) {}

        const srcName = (typeof tex.userData?.mapShineBackgroundSrc === 'string')
          ? tex.userData.mapShineBackgroundSrc.split('/').pop() : '(no src)';
        const label = tileId + ' floor=' + entry?.floorIndex + ' GPU-draw src=' + srcName;

        if (dataUrl) {
          try {
            const win = window.open();
            if (win) {
              win.document.title = label;
              win.document.body.style.background = 'repeating-conic-gradient(#555 0% 25%, #777 0% 50%) 50% / 20px 20px';
              win.document.body.style.margin = '0';
              const p = win.document.createElement('p');
              p.textContent = label + '  (' + w + 'x' + h + ')';
              p.style.color = '#fff'; p.style.font = '14px monospace';
              p.style.padding = '6px'; p.style.margin = '0';
              p.style.background = 'rgba(0,0,0,0.7)';
              const im = win.document.createElement('img');
              im.src = dataUrl; im.style.display = 'block'; im.style.maxWidth = '100%';
              win.document.body.appendChild(p);
              win.document.body.appendChild(im);
            }
          } catch (_) {}
        }

        dumps.push({ label, width: w, height: h, dataUrl });

        try { rt.dispose(); } catch (_) {}
      });
    } finally {
      // Restore visibilities and renderer state.
      priorVis.forEach((v, tileId) => {
        const entry = tiles.get(tileId);
        const node = entry?.root ?? entry?.mesh;
        if (node) node.visible = v;
      });
      camera.layers.mask = prevLayerMask;
      renderer.setClearColor(prevClearColor, prevClearAlpha);
      renderer.autoClear = prevAutoClear;
      renderer.setRenderTarget(prevTarget);
    }

    const result = { dumps };
    try { console.log('[dumpBgTexturesGpu]', result); } catch (_) {}
    return result;
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
   * Option B replica occlusion: pass state, Foundry occludable tokens, bus roof uniforms,
   * and one `readRenderTargetPixels` sample at the first token center (after a fresh pass).
   * Usage: `copy(MapShine.debug.probeReplicaOcclusionV2())`
   * @returns {object}
   */
  probeReplicaOcclusionV2() {
    const ms = window.MapShine ?? {};
    const fc = ms.floorCompositorV2 ?? ms.effectComposer?._floorCompositorV2 ?? null;
    const renderer = fc?.renderer ?? null;
    const pass = fc?._replicaOcclusionMaskPass ?? null;
    const bus = fc?._renderBus ?? null;
    const sceneRT = fc?._sceneRT;

    const drawing = { w: 0, h: 0 };
    try {
      if (renderer?.getDrawingBufferSize) {
        const THREE = window.THREE;
        const v = fc?._sizeVec ?? new THREE.Vector2();
        renderer.getDrawingBufferSize(v);
        drawing.w = Math.floor(v.x);
        drawing.h = Math.floor(v.y);
      }
    } catch (_) {
    }

    let tokens = [];
    try {
      const fn = typeof canvas !== 'undefined' ? canvas?.tokens?._getOccludableTokens : null;
      const arr = typeof fn === 'function' ? fn.call(canvas.tokens) : null;
      tokens = Array.isArray(arr) ? arr : [];
    } catch (_) {
    }

    const busWProbe = Number(sceneRT?.width) || drawing.w || 1;
    const busHProbe = Number(sceneRT?.height) || drawing.h || 1;
    const tokenRows = tokens.map((t) => {
      const c = t?.center;
      let r = 0;
      try {
        r = Math.max(r, Number(t?.externalRadius) || 0);
      } catch (_) {
      }
      try {
        const lr = t?.getLightRadius?.(t?.document?.occludable?.radius);
        if (Number.isFinite(lr)) r = Math.max(r, lr);
      } catch (_) {
      }
      let mapElev = null;
      try {
        mapElev = canvas?.masks?.occlusion?.mapElevation?.(t?.document?.elevation ?? 0);
      } catch (_) {
      }
      const cx = c ? Number(c.x) : NaN;
      const cy = c ? Number(c.y) : NaN;
      const THREE = window.THREE;
      const cam = fc?.camera ?? null;
      let replicaPx = null;
      if (Number.isFinite(cx) && Number.isFinite(cy)) {
        if (THREE && cam && (cam.isPerspectiveCamera || cam.isOrthographicCamera)) {
          const id = String(t?.id ?? '');
          const spr = ms.tokenManager?.tokenSprites?.get?.(id)?.sprite;
          if (spr?.getWorldPosition) {
            const wv = new THREE.Vector3();
            spr.updateWorldMatrix?.(true, false);
            spr.getWorldPosition(wv);
            replicaPx = worldToReplicaMaskPx(THREE, cam, wv.x, wv.y, wv.z, busWProbe, busHProbe);
          }
        }
        if (!replicaPx) {
          replicaPx = worldToReplicaDrawingPx(typeof canvas !== 'undefined' ? canvas : null, cx, cy, busWProbe, busHProbe);
        }
      }
      return {
        id: String(t?.id ?? ''),
        visible: !!t?.visible,
        controlled: !!t?.controlled,
        centerWorld: c ? { x: cx, y: cy } : null,
        replicaDrawingPx: replicaPx,
        externalRadius: Number(t?.externalRadius),
        occlusionRadius: Math.max(1, r),
        mapElevation: Number(mapElev),
        docElevation: t?.document?.elevation,
      };
    });

    const radialSamples = [];
    try {
      const tiles = bus?._tiles;
      if (tiles?.forEach) {
        let n = 0;
        for (const [id, entry] of tiles) {
          if (String(id).startsWith('__')) continue;
          const sh = entry?.material?.userData?._msBusRadialOcclusionShader;
          if (!sh?.uniforms) continue;
          const u = sh.uniforms;
          const inv = u.uMsFoundryInvBuf?.value ?? u.uMsFoundryInvMask?.value;
          radialSamples.push({
            tileId: String(id),
            uMsBusFoundryOccl: u.uMsBusFoundryOccl?.value,
            uMsFoundryRadial: u.uMsFoundryRadial?.value,
            uMsFoundryFade: u.uMsFoundryFade?.value,
            uMsFoundryVision: u.uMsFoundryVision?.value,
            uMsFoundrySurface: u.uMsFoundrySurface?.value,
            uMsFoundryOccElev: u.uMsFoundryOccElev?.value,
            uMsFoundryUnoccA: u.uMsFoundryUnoccA?.value,
            uMsFoundryOccA: u.uMsFoundryOccA?.value,
            invBuf: inv ? { x: inv.x, y: inv.y } : null,
            occTexUuid: u.uMsFoundryOccTex?.value?.uuid ?? null,
            uMsRadialEnabled: u.uMsRadialEnabled?.value,
          });
          if (++n >= 8) break;
        }
      }
    } catch (_) {
    }

    const replicaSampleRt = pass && (typeof pass.getSampleRenderTarget === 'function'
      ? pass.getSampleRenderTarget()
      : pass._rt ?? null);

    let readBack = null;
    try {
      const firstTok = tokenRows[0];
      const hasTokPos = !!(firstTok?.centerWorld || firstTok?.replicaDrawingPx);
      if (replicaSampleRt && renderer?.readRenderTargetPixels && hasTokPos) {
        try {
          if (typeof fc._prepareBusOcclusionMaskBeforeBus === 'function') {
            fc._prepareBusOcclusionMaskBeforeBus();
          } else if (typeof pass.update === 'function') {
            pass.update(renderer, fc?.camera ?? null);
          }
        } catch (e0) {
          readBack = { prepareError: String(e0?.message ?? e0) };
        }
        if (!readBack?.prepareError) {
          const pw = Math.max(1, Math.floor(replicaSampleRt.width));
          const ph = Math.max(1, Math.floor(replicaSampleRt.height));
          const rp = tokenRows[0]?.replicaDrawingPx;
          const cx = Math.floor(Number(rp?.x ?? tokenRows[0]?.centerWorld?.x));
          const cy = Math.floor(Number(rp?.y ?? tokenRows[0]?.centerWorld?.y));
          const x = Math.max(0, Math.min(pw - 1, cx));
          const yGl = Math.max(0, Math.min(ph - 1, ph - 1 - cy));
          const buf = new Uint8Array(4);
          renderer.readRenderTargetPixels(replicaSampleRt, x, yGl, 1, 1, buf);
          readBack = {
            note: 'RGBA from replica resolved RT (same pixels as bus `uMsFoundryOccTex`); default clear G=B=A=1, R=0. Radial lowers G; vision lowers B; surface lowers A.',
            sampleDrawingPx: rp ? { x: cx, y: cy } : { x: cx, y: cy, warn: 'fallback_world_if_no_replicaPx' },
            readPixelBottomLeft: { x, y: yGl },
            rgba: [buf[0], buf[1], buf[2], buf[3]],
            gNorm: buf[1] / 255,
            bNorm: buf[2] / 255,
            aNorm: buf[3] / 255,
          };
        }
      } else {
        readBack = {
          skipped: true,
          reason: !replicaSampleRt ? 'no_replica_rt' : (!renderer?.readRenderTargetPixels ? 'no_readRenderTargetPixels' : 'no_token_center'),
        };
      }
    } catch (e) {
      readBack = { error: String(e?.message ?? e) };
    }

    const report = {
      at: new Date().toISOString(),
      hasFloorCompositor: !!fc,
      sceneRT: sceneRT ? { w: sceneRT.width, h: sceneRT.height } : null,
      drawingBuffer: drawing,
      replicaPass: pass
        ? {
          valid: !!pass.valid,
          busBuf: { w: pass._busBufW, h: pass._busBufH },
          rtSize: replicaSampleRt
            ? { w: replicaSampleRt.width, h: replicaSampleRt.height }
            : null,
          getBusInvBufSize: typeof pass.getBusInvBufSize === 'function' ? pass.getBusInvBufSize() : null,
          hasActiveVisionSource: typeof pass.hasActiveVisionSource === 'function' ? !!pass.hasActiveVisionSource() : null,
          hasActiveSurfaceOcclusion: typeof pass.hasActiveSurfaceOcclusion === 'function' ? !!pass.hasActiveSurfaceOcclusion() : null,
        }
        : null,
      canvasTokensOcclusionMode: (() => {
        try {
          return canvas?.tokens?.occlusionMode ?? null;
        } catch (_) {
          return null;
        }
      })(),
      occludableTokenCount: tokenRows.length,
      occludableTokens: tokenRows,
      busRadialUniformSamples: radialSamples,
      readBack,
    };
    try {
      console.log('[probeReplicaOcclusionV2]', report);
    } catch (_) {
    }
    return report;
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
  .diagnoseMaskBindings()   - Per-floor mask fan-out snapshot (MaskBindingController)
  .skyReachProbe(x,y,fIdx)  - Read back skyReach value at world (x,y) for a floor
  .diagnoseSkyReachV2()     - Table: per-floor skyReach/floorAlpha + uHasSkyReach (why shelter is invisible)
  .setMaskBindingController(bool) - Toggle the unified mask binding controller rollout
  .probeWaterFloorConfig()  - Params vs shader uniforms (useSdfMask, outdoors, floor routing); paste for bugs
  .probeWaterFloorConfig({ watch: true }) - Log when water config changes on floor navigation
  .probeWaterFloorConfig.stop() - Stop watch mode
  .levelAlphaProbe(x,y)     - Read scene+final RT alpha per level (+ water occluder) at canvas pixel (x,y)
  .dumpLevelRTs()           - Dump each level's sceneRT (authored) AND finalRT (post-rebind) to PNG tabs
  .busInventory()           - Console.table of every FloorRenderBus entry: floorIndex, textureSrc, alpha flags
  .dumpBgTextures()         - Dump the raw <img> of every __bg_image__* entry to PNG tabs on a checkerboard
  .dumpBgTexturesGpu()      - Render each __bg_image__* alone into a test RT and dump the GPU output
  .alphaIsolationStatus()   - Read active alpha/isolation debug flags
  .alphaIsolationSet(obj)   - Merge alpha/isolation debug flags
  .alphaIsolationPreset(id) - Apply a bisect preset (noLens/noStamp/noWaterOccluder/noWater/noOverhead/noCloud/noBuilding/off)
  .alphaIsolationReset()    - Clear alpha/isolation debug flags
  .probeReplicaOcclusionV2() - JSON: replica RT + occludable tokens + bus roof uniforms + readPixels at token
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
    
    // Water floor / SDF / outdoors config probe (paste output into bug reports).
    const _probeWater = (opts) => consoleHelpers.probeWaterFloorConfig(opts);
    _probeWater.stop = () => consoleHelpers.probeWaterFloorConfigStop();
    window.MapShine.probeWaterFloorConfig = _probeWater;
    consoleHelpers.probeWaterFloorConfig.stop = _probeWater.stop;

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
