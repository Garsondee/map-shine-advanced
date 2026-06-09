/**

 * @fileoverview Lerp engine for contextual scene grade overlay packs.

 * @module core/context-grade/context-grade-engine

 */



import {

  addContextGradeOverlays,

  applyContextGradeEasing,

  cloneContextGrade,

  computeDramaPulse,

  computeDramaSettleProgress,

  computeEyeAdaptationWeight,

  createNeutralContextGrade,

  finiteOr,

  lerpContextGrade,

  overlaysEqual,

} from './context-grade-spec.js';



/**

 * @typedef {Object} ContextGradeTransition

 * @property {import('./context-grade-spec.js').ContextGradeOverlay} start

 * @property {import('./context-grade-spec.js').ContextGradeOverlay} end

 * @property {number} startMs

 * @property {number} durationMs

 * @property {string} easingId

 * @property {'outdoor'|'indoor'|'neutral'} targetState

 * @property {boolean} [applyDrama]

 */



export class ContextGradeEngine {

  constructor() {

    /** @type {import('./context-grade-spec.js').ContextGradeOverlay} */

    this.applied = createNeutralContextGrade();

    /** @type {import('./context-grade-spec.js').ContextGradeOverlay} */

    this._lerpApplied = createNeutralContextGrade();

    /** @type {ContextGradeTransition|null} */

    this._transition = null;

    /** @type {'outdoor'|'indoor'|'neutral'} */

    this._resolvedState = 'neutral';

    /** @type {'outdoor'|'indoor'|'neutral'} */

    this._targetState = 'neutral';

    /** @type {import('./context-grade-spec.js').ContextGradeOverlay} */

    this._targetOverlay = createNeutralContextGrade();

    /** @type {number} */
    this._adaptationElapsedMs = 0;

    /** @type {number} 0..1 — 1 = full grade, 0 = eye adapted */
    this._eyeAdaptationWeight = 1;

  }



  /** @returns {number} 0..1 contextual offset remaining after eye adaptation */
  getEyeAdaptationWeight() {
    return this._eyeAdaptationWeight;
  }



  /**
   * @param {import('./context-grade-spec.js').ContextGradeOverlay} graded
   * @param {Record<string, *>} params
   * @param {Partial<ContextGradeOverlay>|null} [dramaPulse]
   */
  _finalizeApplied(graded, params, dramaPulse = null) {
    const adaptationOn = params?.eyeAdaptationEnabled !== false;
    const state = this._targetState;
    let out = cloneContextGrade(graded);

    if (adaptationOn && (state === 'indoor' || state === 'outdoor')) {
      const durationMs = Math.max(1000, finiteOr(params?.eyeAdaptationSec, 60) * 1000);
      const easing = String(params?.eyeAdaptationEasing || 'easeOut');
      this._eyeAdaptationWeight = computeEyeAdaptationWeight(
        this._adaptationElapsedMs,
        durationMs,
        easing,
      );
      out = lerpContextGrade(createNeutralContextGrade(), out, this._eyeAdaptationWeight);
    } else {
      this._eyeAdaptationWeight = 1;
    }

    if (dramaPulse) {
      out = addContextGradeOverlays(out, dramaPulse);
    }

    this.applied = out;
  }



  /**
   * @param {number} dt
   * @param {Record<string, *>} params
   */
  _tickEyeAdaptation(dt, params) {
    if (params?.eyeAdaptationEnabled === false) return;
    if (this._targetState !== 'indoor' && this._targetState !== 'outdoor') return;
    if (this._transition) return;
    this._adaptationElapsedMs += Math.max(0, finiteOr(dt, 0)) * 1000;
  }



  /** @returns {'outdoor'|'indoor'|'neutral'} */

  get resolvedState() {

    return this._resolvedState;

  }



  /** @returns {'outdoor'|'indoor'|'neutral'} */

  get targetState() {

    return this._targetState;

  }



  /**

   * @returns {number} 0..1 transition progress, or 1 when idle at target

   */

  getTransitionProgress(nowMs = performance.now()) {

    const tr = this._transition;

    if (!tr || tr.durationMs <= 0) return 1;

    const t = (nowMs - tr.startMs) / tr.durationMs;

    return Math.max(0, Math.min(1, t));

  }



  isTransitioning(nowMs = performance.now()) {

    const tr = this._transition;

    if (!tr) return false;

    return this.getTransitionProgress(nowMs) < 1;

  }



  /**

   * @param {'outdoor'|'indoor'|'neutral'} enteringState

   * @param {Record<string, *>} params

   * @returns {{ durationMs: number, easingId: string }}

   */

  _resolveTransitionMeta(enteringState, params) {

    const globalIn = Math.max(0, finiteOr(params?.fadeInMs, 1200));

    const globalOut = Math.max(0, finiteOr(params?.fadeOutMs, 2400));

    const globalEasingIn = String(params?.easingIn || 'smooth');

    const globalEasingOut = String(params?.easingOut || 'easeOut');



    if (enteringState === 'indoor') {

      const overrideMs = finiteOr(params?.indoorFadeInMs, 0);

      const overrideEasing = String(params?.indoorEasingIn || '').trim();

      return {

        durationMs: overrideMs > 0 ? overrideMs : globalIn,

        easingId: overrideEasing || globalEasingIn,

      };

    }



    if (enteringState === 'outdoor') {

      const overrideMs = finiteOr(params?.outdoorFadeInMs, 0);

      const overrideEasing = String(params?.outdoorEasingIn || '').trim();

      return {

        durationMs: overrideMs > 0 ? overrideMs : globalIn,

        easingId: overrideEasing || globalEasingIn,

      };

    }



    const fromIndoor = this._resolvedState === 'indoor' || this._targetState === 'indoor';

    const overrideOutMs = fromIndoor

      ? finiteOr(params?.indoorFadeOutMs, 0)

      : finiteOr(params?.outdoorFadeOutMs, 0);

    const overrideOutEasing = fromIndoor

      ? String(params?.indoorEasingOut || '').trim()

      : String(params?.outdoorEasingOut || '').trim();



    return {

      durationMs: overrideOutMs > 0 ? overrideOutMs : globalOut,

      easingId: overrideOutEasing || globalEasingOut,

    };

  }



  /**

   * @param {import('./context-grade-spec.js').ContextGradeOverlay} end

   * @param {Record<string, *>} params

   * @param {number} durationMs

   * @param {string} easingId

   * @param {'outdoor'|'indoor'|'neutral'} state

   * @param {boolean} applyDrama

   * @param {number} [nowMs]

   */

  _beginTransition(end, params, durationMs, easingId, state, applyDrama, nowMs = performance.now()) {

    this._transition = {

      start: cloneContextGrade(this._lerpApplied),

      end: cloneContextGrade(end),

      startMs: nowMs,

      durationMs: Math.max(0, durationMs),

      easingId,

      targetState: state,

      applyDrama,

    };



    if (durationMs <= 0) {

      this._lerpApplied = cloneContextGrade(end);

      this._resolvedState = state;

      this._transition = null;

      this._adaptationElapsedMs = 0;

      this._finalizeApplied(this._lerpApplied, params);

    }

  }



  /**

   * Indoor/outdoor state change — full fade with optional doorway drama.

   *

   * @param {'outdoor'|'indoor'|'neutral'} nextState

   * @param {import('./context-grade-spec.js').ContextGradeOverlay} targetOverlay

   * @param {Record<string, *>} params

   * @param {number} [nowMs]

   */

  setTargetOverlay(nextState, targetOverlay, params, nowMs = performance.now()) {

    const state = nextState === 'indoor' || nextState === 'outdoor' ? nextState : 'neutral';

    const end = cloneContextGrade(targetOverlay ?? createNeutralContextGrade());



    const sameState = state === this._targetState;

    const sameOverlay = sameState && !this.isTransitioning(nowMs)

      && overlaysEqual(end, this._targetOverlay);



    this._targetOverlay = end;

    this._targetState = state;



    if (sameOverlay) {

      this._resolvedState = state;

      this._lerpApplied = cloneContextGrade(end);

      this._finalizeApplied(this._lerpApplied, params);

      return;

    }



    const { durationMs, easingId } = this._resolveTransitionMeta(state, params);

    this._adaptationElapsedMs = 0;
    this._eyeAdaptationWeight = 1;

    // Drama (hold + dazzle peak) only when emerging outdoors; indoor uses a straight fade.
    this._beginTransition(end, params, durationMs, easingId, state, state === 'outdoor', nowMs);

  }



  /**

   * Token modifier update while indoor/outdoor bucket is unchanged — no drama restart.

   *

   * @param {'outdoor'|'indoor'|'neutral'} nextState

   * @param {import('./context-grade-spec.js').ContextGradeOverlay} targetOverlay

   * @param {Record<string, *>} params

   * @param {number} [nowMs]

   */

  updateTargetOverlay(nextState, targetOverlay, params, nowMs = performance.now()) {

    const state = nextState === 'indoor' || nextState === 'outdoor' ? nextState : 'neutral';

    const end = cloneContextGrade(targetOverlay ?? createNeutralContextGrade());

    this._targetOverlay = end;

    this._targetState = state;



    const tr = this._transition;

    if (tr && tr.targetState === state) {

      tr.end = cloneContextGrade(end);

      return;

    }



    if (overlaysEqual(end, this._lerpApplied)) {

      this._lerpApplied = cloneContextGrade(end);

      this._resolvedState = state;

      this._transition = null;

      this._finalizeApplied(this._lerpApplied, params);

      return;

    }



    const modMs = Math.max(0, finiteOr(params?.modifierFadeMs, finiteOr(params?.envModifiersLerpMs, 400)));

    this._beginTransition(end, params, modMs, 'smooth', state, false, nowMs);

  }



  /**

   * @param {'outdoor'|'indoor'|'neutral'} nextState

   * @param {Record<string, *>} params

   * @param {number} [nowMs]

   * @deprecated Prefer setTargetOverlay with resolved pack snapshot.

   */

  setTargetState(nextState, params, nowMs = performance.now()) {

    const end = nextState === 'neutral'

      ? createNeutralContextGrade()

      : cloneContextGrade(this._targetOverlay);

    this.setTargetOverlay(nextState, end, params, nowMs);

  }



  /**

   * @param {number} dt

   * @param {Record<string, *>} params

   * @param {number} [nowMs]

   */

  update(dt, params, nowMs = performance.now()) {

    const tr = this._transition;

    if (!tr) {

      this._lerpApplied = cloneContextGrade(this._targetOverlay);

      this._resolvedState = this._targetState;

      this._tickEyeAdaptation(dt, params);

      this._finalizeApplied(this._lerpApplied, params);

      return;

    }



    const rawT = tr.durationMs <= 0 ? 1 : (nowMs - tr.startMs) / tr.durationMs;

    if (rawT >= 1) {

      this._lerpApplied = cloneContextGrade(tr.end);

      this._resolvedState = tr.targetState;

      this._transition = null;

      this._adaptationElapsedMs = 0;

      this._eyeAdaptationWeight = 1;

      this._finalizeApplied(this._lerpApplied, params);

      return;

    }



    const dramaOn = tr.applyDrama !== false
      && params?.dramaEnabled !== false
      && tr.targetState === 'outdoor';

    const settleT = dramaOn
      ? computeDramaSettleProgress(rawT, params)
      : applyContextGradeEasing(rawT, tr.easingId);

    this._lerpApplied = lerpContextGrade(tr.start, tr.end, settleT);

    const pulse = dramaOn ? computeDramaPulse(rawT, params, tr.targetState) : null;

    this._finalizeApplied(this._lerpApplied, params, pulse);

  }



  /** Immediate reset — no subject token. */

  fadeToNeutral(params, nowMs = performance.now()) {

    this.setTargetOverlay('neutral', createNeutralContextGrade(), params, nowMs);

  }



  /**

   * @returns {import('./context-grade-spec.js').ContextGradeOverlay}

   */

  getAppliedOverlay() {

    return cloneContextGrade(this.applied);

  }



  /**

   * Raw engine overlay before env fast-lerp (for diagnostics).

   * @returns {import('./context-grade-spec.js').ContextGradeOverlay}

   */

  getBaseAppliedOverlay() {

    return cloneContextGrade(this._lerpApplied);

  }

}


