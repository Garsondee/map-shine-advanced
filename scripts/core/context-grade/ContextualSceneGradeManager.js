/**

 * @fileoverview Per-client contextual scene grade runtime manager.

 * @module core/context-grade/ContextualSceneGradeManager

 */



import { environmentControlApi } from '../../ui/environment-control-api.js';

import { ContextEnvResolver } from './context-env-resolver.js';

import { ContextGradeEngine } from './context-grade-engine.js';

import { ContextStateEvaluator } from './context-state-evaluator.js';

import {

  applyCoherenceClamp,

  combineOverlaysWithEnv,

  computeCoherenceScalars,

  estimateDramaPeak,

} from './context-grade-coherence.js';

import { formatContextKey, formatContextKeyMultiline } from './context-dimensions.js';

import {

  resolveEnvModifierOverlay,

  resolveTokenContextOverlay,

  resolveTokenOutdoorBias,

  resolveTreeDappleShaderState,

} from './context-pack-resolver.js';

import {

  createNeutralContextGrade,

  lerpContextGradeFast,

} from './context-grade-spec.js';

import {

  foundryCenterDistance,

  probeTokenContextAtCenter,

  readDefaultMoveGateGridUnits,

  resolveActiveFloorIndexForProbe,

} from './context-probe-service.js';

import {

  canUserUseTokenForContext,

  getSubjectTokenCenterFoundry,

  getTokenPlaceableById,

  noteControlledTokenId,

  resolveSubjectTokenId,

} from './subject-token-resolver.js';



export class ContextualSceneGradeManager {

  /**

   * @param {{ colorCorrectionEffect?: object, tokenManager?: object }} [options]

   */

  constructor(options = {}) {

    this.colorCorrectionEffect = options.colorCorrectionEffect

      ?? window.MapShine?.colorCorrectionEffect

      ?? null;

    this.tokenManager = options.tokenManager ?? window.MapShine?.tokenManager ?? null;



    this._engine = new ContextGradeEngine();

    this._evaluator = new ContextStateEvaluator();

    this._envResolver = new ContextEnvResolver();

    this._resolverState = { lastControlledTokenId: null };



    this._appliedEnvOverlay = createNeutralContextGrade();

    this._targetEnvOverlay = createNeutralContextGrade();



    this._probeTimer = 0;

    this._lastProbeElapsed = 0;

    this._lastProbeCenter = null;

    this._lastFloorIndex = null;

    this._lastProbeReason = '';

    this._lastMaskStatus = '';

    this._lastSkyReachStatus = '';

    this._lastCloudShadowStatus = '';

    this._lastWindowLitStatus = '';

    this._subjectTokenId = null;

    this._wasSubjectAnimating = false;

    this._frozenByExternalDrive = false;

    this._paramsRef = null;

    /** @type {{ elapsed?: number, delta?: number }|null} */

    this._lastTimeInfo = null;



    this.debugState = {

      subjectTokenId: '',

      outdoorsSample: null,

      skyReachSample: null,

      cloudShadowSample: null,

      windowLit: false,

      resolvedState: 'neutral',

      contextKey: '',

      transitionProgress: 1,

      maskStatus: '',

      lastProbeReason: '',

    };

  }



  setParamsRef(params) {

    this._paramsRef = params;

  }



  _params() {

    const live = window.MapShine?.floorCompositorV2?._contextualSceneGradeEffect?.params;

    if (live) this._paramsRef = live;

    return live ?? this._paramsRef ?? null;

  }



  _resolveMoveGate(p) {

    const rawGate = Number(p?.moveGateGrid);

    return Number.isFinite(rawGate) && rawGate > 0

      ? rawGate

      : readDefaultMoveGateGridUnits();

  }



  _isEnabled() {

    const p = this._params();

    return p?.enabled !== false;

  }



  _resolveColorCorrection() {

    return this.colorCorrectionEffect

      ?? window.MapShine?.colorCorrectionEffect

      ?? window.MapShine?.floorCompositorV2?._colorCorrectionEffect

      ?? null;

  }



  _resolveFinalOverlay(p) {

    const base = this._engine.getAppliedOverlay();

    const combined = combineOverlaysWithEnv(base, this._appliedEnvOverlay);

    const rawT = this._engine.getTransitionProgress();

    const dramaPeak = estimateDramaPeak(rawT, p ?? {}, this._engine.targetState);

    return applyCoherenceClamp(combined, p ?? {}, {

      transitionProgress: rawT,

      targetState: this._engine.targetState,

      dramaActive: dramaPeak > 0.35,

    });

  }



  _applyToColorCorrection() {

    const p = this._params() ?? {};

    const cc = this._resolveColorCorrection();

    if (!cc?.params) return;



    const enabled = this._isEnabled() && !!this._subjectTokenId;

    const overlay = this._resolveFinalOverlay(p);

    const outdoorBias = resolveTokenOutdoorBias(

      this._evaluator.dimensions,

      this.debugState.outdoorsSample,

      p,

    );



    const coherence = computeCoherenceScalars(p, this._envResolver, this._evaluator.dimensions);



    cc.params.contextGradeEnabled = enabled;

    cc.params.contextExposure = overlay.exposure;

    cc.params.contextSaturation = overlay.saturation;

    cc.params.contextBrightness = overlay.brightness;

    cc.params.contextContrast = overlay.contrast;

    cc.params.contextVibrance = overlay.vibrance;

    cc.params.contextTemperature = overlay.temperature;

    cc.params.contextTint = overlay.tint;

    cc.params.contextVignetteStrength = overlay.vignetteStrength;

    cc.params.contextMasterGamma = overlay.masterGamma;

    cc.params.contextSpatialEnabled = p.contextSpatialEnabled !== false;

    cc.params.contextSpatialStrength = Number(p.contextSpatialStrength) || 0.72;

    cc.params.contextTokenOutdoorBias = outdoorBias;

    cc.params.contextAtmosphereCoupling = coherence.atmosphereScale;

    const treeDapple = resolveTreeDappleShaderState(this._evaluator.dimensions, p);
    cc.params.contextTreeDappleEnabled = enabled && treeDapple.enabled;
    cc.params.contextTreeDappleStrength = treeDapple.strength;
    cc.params.contextTreeDappleScale = treeDapple.scale;
    cc.params.contextTreeDappleGreenR = treeDapple.green.r;
    cc.params.contextTreeDappleGreenG = treeDapple.green.g;
    cc.params.contextTreeDappleGreenB = treeDapple.green.b;



    const u = cc._composeMaterial?.uniforms;

    if (u && cc._initialized) {

      u.uContextGradeEnabled.value = enabled ? 1.0 : 0.0;

      u.uContextExposure.value = overlay.exposure;

      u.uContextSaturation.value = overlay.saturation;

      u.uContextBrightness.value = overlay.brightness;

      u.uContextContrast.value = overlay.contrast;

      u.uContextVibrance.value = overlay.vibrance;

      u.uContextTemperature.value = overlay.temperature;

      u.uContextTint.value = overlay.tint;

      u.uContextVignetteStrength.value = overlay.vignetteStrength;

      u.uContextMasterGamma.value = overlay.masterGamma;

      if (u.uContextSpatialEnabled) u.uContextSpatialEnabled.value = cc.params.contextSpatialEnabled ? 1.0 : 0.0;

      if (u.uContextSpatialStrength) u.uContextSpatialStrength.value = cc.params.contextSpatialStrength;

      if (u.uTokenOutdoorBias) u.uTokenOutdoorBias.value = outdoorBias;

      if (u.uContextTreeDappleEnabled) u.uContextTreeDappleEnabled.value = cc.params.contextTreeDappleEnabled ? 1.0 : 0.0;
      if (u.uContextTreeDappleStrength) u.uContextTreeDappleStrength.value = cc.params.contextTreeDappleStrength;
      if (u.uContextTreeDappleScale) u.uContextTreeDappleScale.value = cc.params.contextTreeDappleScale;
      if (u.uContextTreeDappleGreen) {
        u.uContextTreeDappleGreen.value.set(
          cc.params.contextTreeDappleGreenR,
          cc.params.contextTreeDappleGreenG,
          cc.params.contextTreeDappleGreenB,
        );
      }

    }



    const dem = window.MapShine?.dynamicExposureManager ?? null;

    if (dem?.params && p.coherenceEnabled !== false) {

      const rawT = this._engine.getTransitionProgress();

      const dramaPeak = estimateDramaPeak(rawT, p, this._engine.targetState);

      dem.params.dazzleContextGradeGate = dramaPeak > 0.35 ? coherence.dazzleGate : 1;

    }

  }



  _updateStatusFields(p) {

    if (!p) return;

    const token = getTokenPlaceableById(this._subjectTokenId);

    p.statusSubject = token?.document?.name ?? token?.name ?? '(none)';



    const elapsed = Number(this._lastTimeInfo?.elapsed) ?? performance.now() / 1000;

    const age = Math.max(0, elapsed - (this._lastProbeElapsed || 0));

    p.statusProbeAge = this._subjectTokenId ? `${age.toFixed(1)}s` : '—';



    if (this.debugState.outdoorsSample != null && Number.isFinite(Number(this.debugState.outdoorsSample))) {

      p.statusOutdoorsSample = Number(this.debugState.outdoorsSample).toFixed(3);

    } else {

      p.statusOutdoorsSample = this._lastMaskStatus && this._lastMaskStatus !== 'ok'

        ? `— (${this._lastMaskStatus})`

        : '—';

    }



    p.statusSkyCondition = this._envResolver.skyCondition;

    p.statusDayPhase = this._envResolver.dayPhase;

    p.statusContextKey = formatContextKeyMultiline(this._evaluator.dimensions, this._envResolver)
      || this.debugState.contextKey
      || '—';

    const cover = this._evaluator.dimensions.coverShadow;
    p.statusCoverShadow = cover === 'unknown' ? '—' : cover;

    const adaptW = this._engine.getEyeAdaptationWeight?.() ?? 1;
    if (p.eyeAdaptationEnabled === false || !this._subjectTokenId) {
      p.statusEyeAdaptation = '—';
    } else if (this._engine.targetState === 'neutral') {
      p.statusEyeAdaptation = 'neutral';
    } else {
      p.statusEyeAdaptation = `${Math.round(adaptW * 100)}% offset`;
    }



    const progress = this._engine.getTransitionProgress();

    const stateLabel = this._engine.targetState === 'neutral'

      ? 'Neutral'

      : (this._engine.targetState === 'indoor' ? 'Indoor' : 'Outdoor');



    if (progress < 0.999 && this._isEnabled() && this._subjectTokenId) {

      p.statusState = `${stateLabel} (${Math.round(progress * 100)}%)`;

    } else if (this._subjectTokenId && this._isEnabled()) {

      p.statusState = this._evaluator.indoorOutdoor === 'unknown'

        ? `${stateLabel} (awaiting probe)`

        : stateLabel;

    } else {

      p.statusState = 'Idle';

    }



    p.statusIndoorOutdoor = this._evaluator.indoorOutdoor === 'unknown'

      ? 'Unknown'

      : (this._evaluator.indoorOutdoor === 'indoor' ? 'Indoor' : 'Outdoor');

    p.statusMaskProbe = this._lastMaskStatus || '—';

    p.statusCcOverlay = this._isEnabled() && this._subjectTokenId ? 'Active' : 'Off';

  }



  _applyTargetFromProbe(p, result) {

    const prevIo = this._evaluator.indoorOutdoor;

    const ioState = this._evaluator.updateIndoorOutdoor(result.outdoors, {

      outdoorHigh: Number(p.outdoorThresholdHigh) || 0.82,

      indoorLow: Number(p.indoorThresholdLow) || 0.18,

    });



    this._evaluator.updateTokenDimensions({

      cloudShadowSample: result.cloudShadow,

      skyReachSample: result.skyReach,

      windowLit: ioState === 'indoor' ? result.windowLit : false,

      envSky: this._envResolver.skyCondition,

      buildingShadowLit: result.buildingShadowLit,

      paintedShadowLit: result.paintedShadowLit,

      treeShadowLit: result.treeShadowLit,

      dayWeight: this._envResolver.calendarDayWeight,

    }, p);



    this.debugState.contextKey = formatContextKey(this._evaluator.dimensions, this._envResolver);

    if (ioState === 'unknown') return;



    const baseState = ioState === 'indoor' ? 'indoor' : 'outdoor';

    const tokenOnlyOverlay = resolveTokenContextOverlay(

      baseState,

      this._evaluator.dimensions,

      p,

    );



    const ioChanged = prevIo !== ioState

      && (prevIo === 'indoor' || prevIo === 'outdoor')

      && (ioState === 'indoor' || ioState === 'outdoor');



    if (ioChanged) {

      this._engine.setTargetOverlay(baseState, tokenOnlyOverlay, p);

    } else {

      this._engine.updateTargetOverlay(baseState, tokenOnlyOverlay, p);

    }

    this.debugState.resolvedState = baseState;

  }



  _runProbe(reason = 'manual') {

    const p = this._params();

    if (!p || !this._subjectTokenId) return null;



    const floorIndex = resolveActiveFloorIndexForProbe();

    const center = getSubjectTokenCenterFoundry(this._subjectTokenId);

    const result = probeTokenContextAtCenter(this._subjectTokenId, floorIndex);



    this._lastProbeCenter = center;

    this._lastFloorIndex = floorIndex;

    this._lastProbeElapsed = Number(this._lastTimeInfo?.elapsed) ?? performance.now() / 1000;

    this._lastProbeReason = reason;

    this._lastMaskStatus = result.maskStatus ?? '';

    this._lastSkyReachStatus = result.skyReachStatus ?? '';

    this._lastCloudShadowStatus = result.cloudShadowStatus ?? '';

    this._lastWindowLitStatus = result.windowLitStatus ?? '';

    this._lastBuildingShadowStatus = result.buildingShadowStatus ?? '';

    this._lastPaintedShadowStatus = result.paintedShadowStatus ?? '';

    this._lastTreeShadowStatus = result.treeShadowStatus ?? '';

    this.debugState.lastProbeReason = reason;

    this.debugState.maskStatus = this._lastMaskStatus;

    this.debugState.skyReachSample = result.skyReach;

    this.debugState.cloudShadowSample = result.cloudShadow;

    this.debugState.windowLit = !!result.windowLit;

    this.debugState.buildingShadowLit = result.buildingShadowLit;

    this.debugState.paintedShadowLit = result.paintedShadowLit;

    this.debugState.treeShadowLit = result.treeShadowLit;



    if (result.outdoors == null) {

      this.debugState.outdoorsSample = null;

      return result;

    }



    this.debugState.outdoorsSample = result.outdoors;

    this._applyTargetFromProbe(p, result);

    return result;

  }



  _maybeProbe(p, isAnimating, opts = {}) {

    if (isAnimating && !opts.force) return null;



    const floorIndex = resolveActiveFloorIndexForProbe();

    const center = getSubjectTokenCenterFoundry(this._subjectTokenId);

    const moveGate = this._resolveMoveGate(p);

    const moved = foundryCenterDistance(center, this._lastProbeCenter);

    const floorChanged = this._lastFloorIndex != null && floorIndex !== this._lastFloorIndex;



    if (opts.force) return this._runProbe(opts.reason ?? 'forced');

    if (this._lastProbeCenter == null) return this._runProbe('first-probe');

    if (floorChanged) return this._runProbe('floor-changed');

    if (moved >= moveGate) return this._runProbe('moved');

    if (opts.timerExpired && moved < moveGate) return null;

    if (opts.timerExpired) return this._runProbe('timer');

    return null;

  }



  getDiagnostics() {

    const p = this._params();

    const cc = this._resolveColorCorrection()?.params ?? {};

    const overlay = this._resolveFinalOverlay(p ?? {});

    const token = getTokenPlaceableById(this._subjectTokenId);

    const center = getSubjectTokenCenterFoundry(this._subjectTokenId);

    const moveGate = this._resolveMoveGate(p ?? {});

    const moved = foundryCenterDistance(center, this._lastProbeCenter);

    const elapsed = Number(this._lastTimeInfo?.elapsed) ?? performance.now() / 1000;

    const progress = this._engine.getTransitionProgress();

    const externalDrive = environmentControlApi?.isExternallyDriven?.() === true;

    const tokenManager = this.tokenManager ?? window.MapShine?.tokenManager ?? null;

    const isAnimating = !!(tokenManager?.isTokenAnimating?.(this._subjectTokenId));

    let pathfindingActive = false;

    try {

      pathfindingActive = !!(window.MapShine?.tokenMovementManager?.activeTracks?.has?.(this._subjectTokenId));

    } catch (_) {

    }



    let controlledCount = 0;

    try {

      controlledCount = canvas?.tokens?.controlled?.length ?? 0;

    } catch (_) {

    }



    const blockers = [];

    if (!p) blockers.push('Effect params unavailable (FloorCompositor not ready).');

    if (p && p.enabled === false) blockers.push('Effect disabled in Tweakpane.');

    if (!this._subjectTokenId) blockers.push('No subject token — select a token you own.');

    if (externalDrive) blockers.push('Environment external drive active — probing paused.');

    if (this._lastMaskStatus && this._lastMaskStatus !== 'ok') {

      blockers.push(`Outdoors mask: ${this._lastMaskStatus}`);

    }

    if (this.debugState.outdoorsSample == null && this._subjectTokenId) {

      blockers.push('Outdoors sample missing — CC overlay stays neutral.');

    }

    if (isAnimating) blockers.push('Token movement animation active — probing deferred until stop.');



    const targetLabel = this._engine.targetState;

    let transitionLabel = 'Idle';

    if (progress < 0.999 && this._subjectTokenId && this._isEnabled()) {

      transitionLabel = `Transitioning → ${targetLabel} (${Math.round(progress * 100)}%)`;

    } else if (this._subjectTokenId && this._isEnabled()) {

      transitionLabel = `At ${targetLabel}`;

    }



    return {

      effectEnabled: p?.enabled !== false,

      contextGradeActive: this._isEnabled() && !!this._subjectTokenId,

      externalDrive,

      subjectTokenId: this._subjectTokenId ?? '',

      subjectTokenName: token?.document?.name ?? token?.name ?? '',

      subjectTokenAllowed: token ? canUserUseTokenForContext(token) : false,

      controlledCount,

      tokenAnimating: isAnimating,

      pathfindingActive,

      foundryCenter: center ? `${center.x.toFixed(1)}, ${center.y.toFixed(1)}` : null,

      floorIndex: resolveActiveFloorIndexForProbe(),

      moveSinceProbePx: Number.isFinite(moved) ? moved.toFixed(1) : '—',

      moveGatePx: moveGate.toFixed(1),

      probeTimerSec: (this._probeTimer ?? 0).toFixed(2),

      probeIntervalSec: Number(p?.probeIntervalSec) || 5,

      lastProbeAgeSec: Math.max(0, elapsed - (this._lastProbeElapsed || 0)).toFixed(2),

      lastProbeReason: this._lastProbeReason,

      maskProbeStatus: this._lastMaskStatus || '—',

      skyReachStatus: this._lastSkyReachStatus || '—',

      cloudShadowStatus: this._lastCloudShadowStatus || '—',

      windowLitStatus: this._lastWindowLitStatus || '—',

      buildingShadowStatus: this._lastBuildingShadowStatus || '—',

      paintedShadowStatus: this._lastPaintedShadowStatus || '—',

      treeShadowStatus: this._lastTreeShadowStatus || '—',

      buildingShadowLit: this.debugState.buildingShadowLit,

      paintedShadowLit: this.debugState.paintedShadowLit,

      treeShadowLit: this.debugState.treeShadowLit,

      outdoorsSample: this.debugState.outdoorsSample,

      skyReachSample: this.debugState.skyReachSample,

      cloudShadowSample: this.debugState.cloudShadowSample,

      windowLit: this.debugState.windowLit,

      classifiedState: this._evaluator.indoorOutdoor,

      dimensions: { ...this._evaluator.dimensions },

      envSkyCondition: this._envResolver.skyCondition,

      envDayPhase: this._envResolver.dayPhase,

      envDarknessMood: this._envResolver.darknessMood,

      contextKey: this.debugState.contextKey || formatContextKey(this._evaluator.dimensions, this._envResolver),

      targetState: this._engine.targetState,

      transitionLabel,

      outdoorThresholdHigh: Number(p?.outdoorThresholdHigh) || 0.82,

      indoorThresholdLow: Number(p?.indoorThresholdLow) || 0.18,

      tokenOutdoorBias: resolveTokenOutdoorBias(this._evaluator.dimensions, this.debugState.outdoorsSample, p ?? {}),

      eyeAdaptationWeight: this._engine.getEyeAdaptationWeight?.() ?? 1,

      applied: { ...overlay },

      cc: {

        contextGradeEnabled: !!cc.contextGradeEnabled,

        contextExposure: cc.contextExposure ?? 0,

        contextSaturation: cc.contextSaturation ?? 0,

        contextVignetteStrength: cc.contextVignetteStrength ?? 0,

        contextSpatialEnabled: !!cc.contextSpatialEnabled,

        contextSpatialStrength: cc.contextSpatialStrength ?? 0,

        contextTokenOutdoorBias: cc.contextTokenOutdoorBias ?? 0.5,

        contextTreeDappleEnabled: !!cc.contextTreeDappleEnabled,

        contextTreeDappleStrength: cc.contextTreeDappleStrength ?? 0,

      },

      blockers,

    };

  }



  update(timeInfo) {

    const p = this._params();

    const dt = Math.min(0.25, Math.max(0, Number(timeInfo?.delta) || 0));

    const nowMs = performance.now();

    this._lastTimeInfo = timeInfo;



    const externalDrive = environmentControlApi?.isExternallyDriven?.() === true;



    if (!p || !this._isEnabled()) {

      this._subjectTokenId = null;

      this._engine.fadeToNeutral(p ?? {});

      this._engine.update(dt, p ?? {}, nowMs);

      this._targetEnvOverlay = createNeutralContextGrade();

      this._appliedEnvOverlay = lerpContextGradeFast(this._appliedEnvOverlay, this._targetEnvOverlay, dt, 250);

      const demOff = window.MapShine?.dynamicExposureManager ?? null;
      if (demOff?.params) demOff.params.dazzleContextGradeGate = 1;

      this._applyToColorCorrection();

      this._updateStatusFields(p);

      return;

    }



    this._envResolver.update(p, { frozen: externalDrive });

    this._targetEnvOverlay = resolveEnvModifierOverlay(this._envResolver, p);

    const envTau = Math.max(50, Number(p.envModifiersLerpMs) || 250);

    this._appliedEnvOverlay = lerpContextGradeFast(this._appliedEnvOverlay, this._targetEnvOverlay, dt, envTau);



    if (externalDrive) {

      this._frozenByExternalDrive = true;

      this._engine.update(dt, p, nowMs);

      this._applyToColorCorrection();

      this._updateStatusFields(p);

      return;

    }

    if (this._frozenByExternalDrive) {

      this._frozenByExternalDrive = false;

      this._probeTimer = 0;

    }



    const prevId = this._subjectTokenId;

    this._subjectTokenId = resolveSubjectTokenId(this._resolverState);

    if (this._subjectTokenId) noteControlledTokenId(this._resolverState, this._subjectTokenId);



    this.debugState.subjectTokenId = this._subjectTokenId || '';



    const tokenManager = this.tokenManager ?? window.MapShine?.tokenManager ?? null;

    const isAnimating = !!(tokenManager?.isTokenAnimating?.(this._subjectTokenId));



    if (!this._subjectTokenId) {

      this._evaluator.reset();

      this._engine.fadeToNeutral(p, nowMs);

      this._engine.update(dt, p, nowMs);

      this._applyToColorCorrection();

      this._updateStatusFields(p);

      return;

    }



    if (prevId !== this._subjectTokenId) {

      this._probeTimer = 0;

      this._lastProbeCenter = null;

      this._maybeProbe(p, isAnimating, { force: true, reason: 'token-changed' });

    }



    if (this._wasSubjectAnimating && !isAnimating) {

      this._probeTimer = 0;

      this._maybeProbe(p, false, { force: true, reason: 'move-ended' });

    }

    this._wasSubjectAnimating = isAnimating;



    let timerExpired = false;

    if (!isAnimating) {

      this._probeTimer += dt;

      const interval = Math.max(0.5, Number(p.probeIntervalSec) || 5);

      if (this._probeTimer >= interval) {

        this._probeTimer = 0;

        timerExpired = true;

      }

    }



    this._maybeProbe(p, isAnimating, { timerExpired, reason: 'timer' });



    this._engine.update(dt, p, nowMs);

    this._applyToColorCorrection();



    this.debugState.transitionProgress = this._engine.getTransitionProgress(nowMs);

    this.debugState.resolvedState = this._engine.targetState;

    this.debugState.contextKey = formatContextKey(this._evaluator.dimensions, this._envResolver);

    this._updateStatusFields(p);

  }



  dispose() {

    this._paramsRef = null;

    this._subjectTokenId = null;

    this._applyToColorCorrection();

  }

}


