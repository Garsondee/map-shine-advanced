/**
 * @fileoverview Continuous morph engine for contextual scene grade overlays.
 * Probes set layer targets; each frame exponentially approaches them (no discrete
 * transition restarts). Doorway drama fires once per outdoor-weight threshold cross.
 * @module core/context-grade/context-grade-engine
 */

import {
  addContextGradeOverlays,
  cloneContextGrade,
  computeDramaPulse,
  computeEyeAdaptationWeight,
  createNeutralContextGrade,
  finiteOr,
  isDoorwayDramaAllowed,
  lerpContextGrade,
  lerpContextGradeFast,
  overlayConvergenceProgress,
  overlaysEqual,
} from './context-grade-spec.js';

export class ContextGradeEngine {
  constructor() {
    /** @type {import('./context-grade-spec.js').ContextGradeOverlay} */
    this.applied = createNeutralContextGrade();

    /** @type {import('./context-grade-spec.js').ContextGradeOverlay} */
    this._baseCurrent = createNeutralContextGrade();
    /** @type {import('./context-grade-spec.js').ContextGradeOverlay} */
    this._ambientModCurrent = createNeutralContextGrade();
    /** @type {import('./context-grade-spec.js').ContextGradeOverlay} */
    this._coverModCurrent = createNeutralContextGrade();
    /** @type {import('./context-grade-spec.js').ContextGradeOverlay} */
    this._baseTarget = createNeutralContextGrade();
    /** @type {import('./context-grade-spec.js').ContextGradeOverlay} */
    this._ambientModTarget = createNeutralContextGrade();
    /** @type {import('./context-grade-spec.js').ContextGradeOverlay} */
    this._coverModTarget = createNeutralContextGrade();

    /** @type {'outdoor'|'indoor'|'neutral'} */
    this._targetState = 'neutral';
    /** @type {number} 0..1 last probe outdoor weight */
    this._outdoorWeight = 0.5;

    this._baseAdaptationElapsedMs = 0;
    this._ambientModAdaptationElapsedMs = 0;
    /** @type {number} 0..1 */
    this._baseEyeAdaptationWeight = 1;
    /** @type {number} 0..1 */
    this._modEyeAdaptationWeight = 1;

    /** Cover shadow release — slow eye-adaptation fade when leaving shadow. */
    /** @type {boolean} */
    this._coverReleaseActive = false;
    /** @type {import('./context-grade-spec.js').ContextGradeOverlay} */
    this._coverReleaseSnapshot = createNeutralContextGrade();
    this._coverReleaseAdaptationElapsedMs = 0;
    /** @type {number} 0..1 */
    this._coverReleaseWeight = 1;

    /** @type {number} */
    this._dramaStartMs = 0;
    /** @type {boolean} */
    this._dramaActive = false;
    /** @type {number} */
    this._dramaDurationMs = 3600;
    /** @type {number} */
    this._lastOutdoorWeightForDrama = 0;
    /** @type {boolean} */
    this._dramaOutdoorInitialized = false;
    /** @type {number} */
    this._prevOutdoorWeightForTau = 0.5;
    /** @type {{ dayPhase?: string, calendarDayWeight?: number }} */
    this._dramaEnv = { dayPhase: 'day', calendarDayWeight: 1 };
  }

  getEyeAdaptationWeight() {
    return Math.min(this._baseEyeAdaptationWeight, this._modEyeAdaptationWeight);
  }

  getBaseEyeAdaptationWeight() {
    return this._baseEyeAdaptationWeight;
  }

  getModifierEyeAdaptationWeight() {
    return this._modEyeAdaptationWeight;
  }

  /** @returns {'outdoor'|'indoor'|'neutral'} */
  get resolvedState() {
    return this._targetState;
  }

  /** @returns {'outdoor'|'indoor'|'neutral'} */
  get targetState() {
    return this._targetState;
  }

  /** @returns {import('./context-grade-spec.js').ContextGradeOverlay} */
  getModifierTarget() {
    return addContextGradeOverlays(
      cloneContextGrade(this._ambientModTarget),
      cloneContextGrade(this._coverModTarget),
    );
  }

  /** @returns {import('./context-grade-spec.js').ContextGradeOverlay} */
  getCoverModifierTarget() {
    return cloneContextGrade(this._coverModTarget);
  }

  /** @returns {import('./context-grade-spec.js').ContextGradeOverlay} */
  getCoverAppliedOverlay() {
    return cloneContextGrade(this._resolveCoverForApplied());
  }

  /** 0..1 cover shadow strength during release fade (1 = full shadow grade). */
  getCoverReleaseWeight() {
    return this._coverReleaseWeight;
  }

  /** True while cover shadow is fading out at eye-adaptation rate after leaving shadow. */
  isCoverReleaseActive() {
    return this._coverReleaseActive;
  }

  /** @returns {number} 0..1 smoothed outdoor blend weight from last probe. */
  getOutdoorWeight() {
    return this._outdoorWeight;
  }

  /** Reset doorway-drama crossing tracker (call when subject token changes). */
  resetDramaTracking() {
    this._dramaOutdoorInitialized = false;
    this._lastOutdoorWeightForDrama = 0;
    this._dramaActive = false;
  }

  /** 0..1 doorway dazzle progress (independent of layer convergence). */
  getDramaProgress(nowMs = performance.now()) {
    if (!this._dramaActive) return 0;
    return Math.max(0, Math.min(1, (nowMs - this._dramaStartMs) / Math.max(400, this._dramaDurationMs)));
  }

  /** 0..1 — how close the base layer is to its current target (for UI). */
  getTransitionProgress() {
    return overlayConvergenceProgress(this._baseCurrent, this._baseTarget);
  }

  isTransitioning() {
    return this.getTransitionProgress() < 0.985
      || overlayConvergenceProgress(this._ambientModCurrent, this._ambientModTarget) < 0.985
      || overlayConvergenceProgress(this._coverModCurrent, this._coverModTarget) < 0.985
      || this._coverReleaseActive;
  }

  /**
   * @param {'outdoor'|'indoor'|'neutral'} state
   * @param {Record<string, *>} params
   * @returns {number}
   */
  _resolveBaseTauMs(state, params) {
    const globalIn = Math.max(16, finiteOr(params?.fadeInMs, 3600));
    const globalOut = Math.max(16, finiteOr(params?.fadeOutMs, 7200));
    const w = this._outdoorWeight;
    const prevW = this._prevOutdoorWeightForTau;
    const leavingOutdoor = Number.isFinite(prevW) && w < prevW - 0.0001;

    if (leavingOutdoor || state === 'indoor') {
      const outMs = finiteOr(params?.outdoorFadeOutMs, 0);
      if (outMs > 0) return outMs;
      const inMs = finiteOr(params?.indoorFadeInMs, 0);
      if (inMs > 0) return inMs;
      return globalOut;
    }
    if (state === 'outdoor') {
      const override = finiteOr(params?.outdoorFadeInMs, 0);
      return override > 0 ? override : globalIn;
    }
    return globalOut;
  }

  /** @param {Record<string, *>} params */
  _resolveAmbientModTauMs(params) {
    const globalOut = Math.max(16, finiteOr(params?.fadeOutMs, 7200));
    const w = this._outdoorWeight;
    const prevW = this._prevOutdoorWeightForTau;
    const leavingOutdoor = Number.isFinite(prevW) && w < prevW - 0.0001;
    if (leavingOutdoor) {
      return Math.max(
        16,
        finiteOr(params?.modifierFadeMs, globalOut),
      );
    }
    return Math.max(
      16,
      finiteOr(params?.modifierFadeMs, finiteOr(params?.fadeInMs, 3600)),
    );
  }

  /** @param {Record<string, *>} params */
  _resolveBaseAdaptationDurationMs(params) {
    return Math.max(1000, finiteOr(params?.eyeAdaptationSec, 60) * 1000);
  }

  /** @param {Record<string, *>} params */
  _resolveCoverAdaptationDurationMs(params) {
    return Math.max(500, finiteOr(params?.coverShadowEyeAdaptationSec, 3) * 1000);
  }

  /**
   * @param {import('./context-grade-spec.js').ContextGradeOverlay} overlay
   * @returns {boolean}
   */
  _isCoverOverlayActive(overlay) {
    return !overlaysEqual(overlay, createNeutralContextGrade(), 0.012);
  }

  /**
   * Cover shadow applied to the final grade. Full strength while in shadow;
   * eye-adaptation release when leaving (no snap).
   *
   * @param {Record<string, *>} params
   * @returns {import('./context-grade-spec.js').ContextGradeOverlay}
   */
  _resolveCoverForApplied(params = {}) {
    const neutral = createNeutralContextGrade();

    if (this._coverReleaseActive) {
      if (params?.eyeAdaptationEnabled === false) {
        return cloneContextGrade(this._coverModCurrent);
      }
      const weight = computeEyeAdaptationWeight(
        this._coverReleaseAdaptationElapsedMs,
        this._resolveCoverAdaptationDurationMs(params),
        String(params?.eyeAdaptationEasing || 'easeOut'),
      );
      this._coverReleaseWeight = weight;
      if (weight <= 0.001) return neutral;
      return lerpContextGrade(neutral, this._coverReleaseSnapshot, weight);
    }

    this._coverReleaseWeight = this._isCoverOverlayActive(this._coverModCurrent) ? 1 : 0;
    return cloneContextGrade(this._coverModCurrent);
  }

  /** @param {Record<string, *>} params */
  _resolveCoverModTauMs(params) {
    return Math.max(
      16,
      finiteOr(params?.coverShadowFadeMs, finiteOr(params?.coverShadowEyeAdaptationSec, 3) * 1000),
    );
  }

  /**
   * @param {number} dt
   * @param {Record<string, *>} params
   */
  _tickCoverReleaseAdaptation(dt, params) {
    if (!this._coverReleaseActive) return;
    const ms = Math.max(0, finiteOr(dt, 0)) * 1000;
    this._coverReleaseAdaptationElapsedMs += ms;
    const durationMs = this._resolveCoverAdaptationDurationMs(params);
    const weight = params?.eyeAdaptationEnabled === false
      ? 0
      : computeEyeAdaptationWeight(
        this._coverReleaseAdaptationElapsedMs,
        durationMs,
        String(params?.eyeAdaptationEasing || 'easeOut'),
      );
    this._coverReleaseWeight = weight;
    if (weight <= 0.001) {
      this._coverReleaseActive = false;
      this._coverModCurrent = createNeutralContextGrade();
      this._coverReleaseSnapshot = createNeutralContextGrade();
      this._coverReleaseAdaptationElapsedMs = 0;
    }
  }

  /**
   * @param {import('./context-grade-spec.js').ContextGradeOverlay} layerCurrent
   * @param {number} adaptElapsedMs
   * @param {Record<string, *>} params
   * @param {boolean} active
   * @param {import('./context-grade-spec.js').ContextGradeOverlay} layerTarget
   * @returns {import('./context-grade-spec.js').ContextGradeOverlay}
   */
  _applyLayerAdaptation(layerCurrent, adaptElapsedMs, params, active, layerTarget) {
    const settled = overlaysEqual(layerCurrent, layerTarget, 0.012);
    if (!active || !settled || params?.eyeAdaptationEnabled === false) {
      return cloneContextGrade(layerCurrent);
    }
    const durationMs = this._resolveBaseAdaptationDurationMs(params);
    const weight = computeEyeAdaptationWeight(
      adaptElapsedMs,
      durationMs,
      String(params?.eyeAdaptationEasing || 'easeOut'),
    );
    return lerpContextGrade(createNeutralContextGrade(), layerCurrent, weight);
  }

  /**
   * @param {Record<string, *>} params
   * @param {Partial<import('./context-grade-spec.js').ContextGradeOverlay>|null} [dramaPulse]
   */
  _rebuildApplied(params, dramaPulse = null) {
    const neutral = createNeutralContextGrade();
    const ioActive = this._targetState === 'indoor' || this._targetState === 'outdoor';
    const ambientActive = ioActive && !overlaysEqual(this._ambientModCurrent, neutral, 0.012);

    const baseSettled = overlaysEqual(this._baseCurrent, this._baseTarget, 0.012);
    const ambientSettled = overlaysEqual(this._ambientModCurrent, this._ambientModTarget, 0.012);

    this._baseEyeAdaptationWeight = ioActive && baseSettled && params?.eyeAdaptationEnabled !== false
      ? computeEyeAdaptationWeight(
        this._baseAdaptationElapsedMs,
        this._resolveBaseAdaptationDurationMs(params),
        String(params?.eyeAdaptationEasing || 'easeOut'),
      )
      : 1;

    this._modEyeAdaptationWeight = ambientActive && ambientSettled && params?.eyeAdaptationEnabled !== false
      ? computeEyeAdaptationWeight(
        this._ambientModAdaptationElapsedMs,
        this._resolveBaseAdaptationDurationMs(params),
        String(params?.eyeAdaptationEasing || 'easeOut'),
      )
      : 1;

    let base = this._applyLayerAdaptation(
      this._baseCurrent,
      this._baseAdaptationElapsedMs,
      params,
      ioActive,
      this._baseTarget,
    );
    const ambient = this._applyLayerAdaptation(
      this._ambientModCurrent,
      this._ambientModAdaptationElapsedMs,
      params,
      ambientActive,
      this._ambientModTarget,
    );
    // Cover shadow: full strength in shadow; eye-adaptation release when leaving.
    const cover = this._resolveCoverForApplied(params);

    if (dramaPulse) {
      base = addContextGradeOverlays(base, dramaPulse);
    }

    this.applied = addContextGradeOverlays(base, addContextGradeOverlays(ambient, cover));
  }

  /**
   * @param {number} dt
   * @param {Record<string, *>} params
   * @param {'base'|'ambient'} layer
   * @param {import('./context-grade-spec.js').ContextGradeOverlay} layerTarget
   */
  _tickLayerAdaptation(dt, params, layer, layerTarget) {
    if (params?.eyeAdaptationEnabled === false) return;
    if (this._targetState !== 'indoor' && this._targetState !== 'outdoor') return;
    const current = layer === 'base' ? this._baseCurrent : this._ambientModCurrent;
    if (!overlaysEqual(current, layerTarget, 0.012)) return;
    const ms = Math.max(0, finiteOr(dt, 0)) * 1000;
    if (layer === 'base') this._baseAdaptationElapsedMs += ms;
    else this._ambientModAdaptationElapsedMs += ms;
  }

  /**
   * Update intended base-layer target (probe only — never starts a discrete transition).
   *
   * @param {import('./context-grade-spec.js').ContextGradeOverlay} baseOverlay
   * @param {number} outdoorWeight 0..1
   * @param {Record<string, *>} params
   * @param {{ dayPhase?: string, calendarDayWeight?: number|null }} [runtimeEnv]
   */
  setBaseTarget(baseOverlay, outdoorWeight, params, runtimeEnv = {}) {
    const end = cloneContextGrade(baseOverlay ?? createNeutralContextGrade());
    const w = Math.max(0, Math.min(1, finiteOr(outdoorWeight, 0.5)));
    const prevState = this._targetState;

    this._dramaEnv = {
      dayPhase: runtimeEnv?.dayPhase ?? this._dramaEnv.dayPhase ?? 'day',
      calendarDayWeight: finiteOr(runtimeEnv?.calendarDayWeight, this._dramaEnv.calendarDayWeight ?? 1),
    };

    this._baseTarget = end;
    this._outdoorWeight = w;
    this._targetState = w >= 0.55 ? 'outdoor' : (w <= 0.2 ? 'indoor' : prevState === 'neutral' ? 'indoor' : prevState);

    this._maybeTriggerDrama(w, params, this._dramaEnv);

    if (prevState !== this._targetState && this._targetState === 'outdoor') {
      this._baseAdaptationElapsedMs = 0;
    }
  }

  /**
   * Cloud / canopy / overcast modifier target (eye adaptation applies).
   *
   * @param {import('./context-grade-spec.js').ContextGradeOverlay} modOverlay
   * @param {Record<string, *>} params
   */
  setAmbientModifierTarget(modOverlay, params) {
    this._ambientModTarget = cloneContextGrade(modOverlay ?? createNeutralContextGrade());
  }

  /**
   * Building / painted / tree cover shadow target.
   * Enter: fade in via coverShadowFadeMs. Leave: eye-adaptation release (no snap).
   *
   * @param {import('./context-grade-spec.js').ContextGradeOverlay} modOverlay
   * @param {Record<string, *>} params
   * @param {{ coverShadowChanged?: boolean }} [opts]
   */
  setCoverModifierTarget(modOverlay, params, opts = {}) {
    const neutral = createNeutralContextGrade();
    const next = cloneContextGrade(modOverlay ?? neutral);
    const wasActive = this._isCoverOverlayActive(this._coverModTarget);
    const nextActive = this._isCoverOverlayActive(next);

    if (opts.coverShadowChanged === true) {
      if (nextActive && !wasActive) {
        this._coverReleaseActive = false;
        this._coverModCurrent = neutral;
        this._coverReleaseAdaptationElapsedMs = 0;
      } else if (!nextActive && wasActive) {
        this._coverReleaseSnapshot = this._isCoverOverlayActive(this._coverModCurrent)
          ? cloneContextGrade(this._coverModCurrent)
          : cloneContextGrade(this._coverModTarget);
        if (params?.eyeAdaptationEnabled === false) {
          this._coverReleaseActive = false;
        } else {
          this._coverReleaseActive = true;
          this._coverReleaseAdaptationElapsedMs = 0;
          this._coverReleaseWeight = 1;
        }
      } else if (nextActive && wasActive) {
        this._coverReleaseActive = false;
      }
    } else if (nextActive) {
      this._coverReleaseActive = false;
    }

    this._coverModTarget = next;
  }

  /**
   * @param {import('./context-grade-spec.js').ContextGradeOverlay} modOverlay
   * @param {Record<string, *>} params
   * @param {{ coverShadowChanged?: boolean }} [opts]
   * @deprecated Use setAmbientModifierTarget + setCoverModifierTarget
   */
  setModifierTarget(modOverlay, params, opts = {}) {
    this.setAmbientModifierTarget(modOverlay, params);
  }

  /**
   * Doorway dazzle once when crossing into outdoor-dominant weight, not every probe step.
   *
   * @param {number} outdoorWeight
   * @param {Record<string, *>} params
   * @param {{ dayPhase?: string, calendarDayWeight?: number|null }} [runtimeEnv]
   */
  _maybeTriggerDrama(outdoorWeight, params, runtimeEnv = {}) {
    if (!isDoorwayDramaAllowed(params, runtimeEnv)) {
      this._lastOutdoorWeightForDrama = outdoorWeight;
      return;
    }

    if (!this._dramaOutdoorInitialized) {
      this._lastOutdoorWeightForDrama = outdoorWeight;
      this._dramaOutdoorInitialized = true;
      return;
    }

    const low = 0.42;
    const high = 0.58;
    const prev = this._lastOutdoorWeightForDrama;
    this._lastOutdoorWeightForDrama = outdoorWeight;

    const crossedOut = prev < low && outdoorWeight >= high;
    if (!crossedOut || this._dramaActive) return;

    this._dramaStartMs = performance.now();
    this._dramaDurationMs = Math.max(400, finiteOr(params?.fadeInMs, 3600));
    this._dramaActive = true;
  }

  /** @deprecated */
  setTargetOverlay(nextState, targetOverlay, params) {
    const w = nextState === 'outdoor' ? 1 : (nextState === 'indoor' ? 0 : 0.5);
    this.setBaseTarget(targetOverlay, w, params);
  }

  /** @deprecated */
  updateTargetOverlay(_nextState, targetOverlay, params) {
    this.setBaseTarget(targetOverlay, this._outdoorWeight, params);
  }

  /** @deprecated */
  updateBaseTarget(baseOverlay, params) {
    this.setBaseTarget(baseOverlay, this._outdoorWeight, params);
  }

  /**
   * @param {number} dt
   * @param {Record<string, *>} params
   * @param {number} [nowMs]
   * @param {{ dayPhase?: string, calendarDayWeight?: number|null }} [runtimeEnv]
   */
  update(dt, params, nowMs = performance.now(), runtimeEnv = {}) {
    if (runtimeEnv?.dayPhase != null || runtimeEnv?.calendarDayWeight != null) {
      this._dramaEnv = {
        dayPhase: runtimeEnv?.dayPhase ?? this._dramaEnv.dayPhase ?? 'day',
        calendarDayWeight: finiteOr(runtimeEnv?.calendarDayWeight, this._dramaEnv.calendarDayWeight ?? 1),
      };
    }
    const baseTau = this._resolveBaseTauMs(this._targetState, params);
    const ambientTau = this._resolveAmbientModTauMs(params);
    const coverTau = this._resolveCoverModTauMs(params);

    this._baseCurrent = lerpContextGradeFast(this._baseCurrent, this._baseTarget, dt, baseTau);
    this._ambientModCurrent = lerpContextGradeFast(this._ambientModCurrent, this._ambientModTarget, dt, ambientTau);

    const coverTargetActive = this._isCoverOverlayActive(this._coverModTarget);
    if (this._coverReleaseActive) {
      this._tickCoverReleaseAdaptation(dt, params);
    } else {
      this._coverModCurrent = lerpContextGradeFast(this._coverModCurrent, this._coverModTarget, dt, coverTau);
    }

    this._tickLayerAdaptation(dt, params, 'base', this._baseTarget);
    this._tickLayerAdaptation(dt, params, 'ambient', this._ambientModTarget);

    let dramaPulse = null;
    if (this._dramaActive && this._targetState === 'outdoor') {
      if (!isDoorwayDramaAllowed(params, this._dramaEnv)) {
        this._dramaActive = false;
      } else {
        const dramaDuration = Math.max(400, this._dramaDurationMs);
        const rawT = (nowMs - this._dramaStartMs) / dramaDuration;
        if (rawT >= 1) {
          this._dramaActive = false;
        } else {
          dramaPulse = computeDramaPulse(rawT, params, 'outdoor', this._dramaEnv);
        }
      }
    }

    this._rebuildApplied(params, dramaPulse);
    this._prevOutdoorWeightForTau = this._outdoorWeight;
  }

  fadeToNeutral(params) {
    this._targetState = 'neutral';
    this._outdoorWeight = 0.5;
    this._baseTarget = createNeutralContextGrade();
    this._ambientModTarget = createNeutralContextGrade();
    this._coverModTarget = createNeutralContextGrade();
    this._coverReleaseActive = false;
    this._coverReleaseAdaptationElapsedMs = 0;
    this._coverReleaseSnapshot = createNeutralContextGrade();
    this._dramaActive = false;
    this._lastOutdoorWeightForDrama = 0;
    this._dramaOutdoorInitialized = false;
    this._prevOutdoorWeightForTau = 0.5;
  }

  getAppliedOverlay() {
    return cloneContextGrade(this.applied);
  }

  getBaseAppliedOverlay() {
    return addContextGradeOverlays(
      cloneContextGrade(this._baseCurrent),
      addContextGradeOverlays(
        cloneContextGrade(this._ambientModCurrent),
        cloneContextGrade(this._coverModCurrent),
      ),
    );
  }
}
