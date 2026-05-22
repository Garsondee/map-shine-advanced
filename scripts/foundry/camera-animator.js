/**
 * @fileoverview Frame-synced camera animator for cinematic pan/zoom sequences.
 *
 * Advances via EffectComposer camera pipeline (same clock as PixiInputBridge
 * smoothing and CameraFollower) rather than a private requestAnimationFrame loop.
 *
 * @module foundry/camera-animator
 */
import { createLogger } from '../core/log.js';
import { scalePlaybackWallDurationMs } from './camera-path-types.js';

const log = createLogger('CameraAnimator');

/** @typedef {'trapezoidal'|'easeInOutCosine'} CameraEasingId */

function asNumber(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * @param {number} ms
 * @param {() => boolean} [shouldCancel]
 * @returns {Promise<void>}
 */
async function sleep(ms, shouldCancel = null) {
  const duration = Math.max(0, Number(ms) || 0);
  if (duration <= 0) return;

  const start = performance.now();
  while (performance.now() - start < duration) {
    if (shouldCancel?.()) return;
    const remaining = duration - (performance.now() - start);
    await new Promise((resolve) => setTimeout(resolve, Math.min(50, remaining)));
  }
}

/**
 * Trapezoidal ramp: fixed accel/decel window (max 3s each side), linear middle.
 * Ported from the coordinate-path macro.
 *
 * @param {number} elapsed
 * @param {number} duration
 * @returns {number}
 */
export function trapezoidalEase(elapsed, duration) {
  if (duration <= 0) return 1;
  const R = Math.min(3000, duration / 2);
  if (R <= 0) return elapsed / duration;

  const T = duration;
  const t = Math.min(elapsed, T);
  const Vmax = 1 / (T - R);

  if (t <= R) {
    return (Vmax / (2 * R)) * t * t;
  }
  if (t <= T - R) {
    return (Vmax * R / 2) + Vmax * (t - R);
  }
  const timeRemaining = T - t;
  return 1 - (Vmax / (2 * R)) * timeRemaining * timeRemaining;
}

/**
 * @param {number} t
 * @returns {number}
 */
export function easeInOutCosine(t) {
  return (1 - Math.cos(Math.PI * t)) / 2;
}

/**
 * @param {CameraEasingId} easingId
 * @param {number} elapsedMs
 * @param {number} durationMs
 * @returns {number}
 */
export function applyEasing(easingId, elapsedMs, durationMs) {
  const t = durationMs > 0 ? Math.min(1, elapsedMs / durationMs) : 1;
  if (easingId === 'trapezoidal') {
    return trapezoidalEase(elapsedMs, durationMs);
  }
  return easeInOutCosine(t);
}

/**
 * @typedef {Object} CameraView
 * @property {number} x
 * @property {number} y
 * @property {number} scale
 */

/**
 * @typedef {Object} CameraPathSegment
 * @property {CameraView} from
 * @property {CameraView} to
 * @property {number} durationMs
 */

export class CameraAnimator {
  constructor() {
    /** @type {boolean} */
    this._active = false;

    /** @type {boolean} */
    this._cancelled = false;

    /** @type {(() => void)|null} */
    this._escapeListener = null;

    /** @type {(() => void)|null} */
    this._animateResolve = null;

    /**
     * In-flight pan/zoom advanced on the compositor camera pipeline.
     * @type {object|null}
     * @private
     */
    this._pendingAnim = null;

    /** EffectComposer camera pipeline (after input bridge, before cinematic follow). */
    this.updatePhase = 'camera';
    this.cameraPipelineOrder = 1;

    /** @private Wall-clock fallback when presentation gate skips sim delta. */
    this._lastAnimWallMs = 0;
  }

  /** @returns {boolean} */
  get isActive() {
    return this._active;
  }

  /** @returns {boolean} */
  get wasCancelled() {
    return this._cancelled;
  }

  /** Resolve any in-flight animation waiters. @private */
  _finishAnimateWait() {
    if (this._animateResolve) {
      const resolve = this._animateResolve;
      this._animateResolve = null;
      resolve();
    }
  }

  /** @private */
  _clearPendingAnim() {
    this._pendingAnim = null;
    this._finishAnimateWait();
  }

  /** Request cancellation of the current animation sequence. */
  cancel() {
    this._cancelled = true;
    this._clearPendingAnim();
  }

  /** Clear cancellation state so a new playback can start cleanly. */
  resetCancellationState() {
    this._cancelled = false;
  }

  /** @private @param {object} timeInfo @returns {number} */
  _animDeltaMs(timeInfo) {
    const simMs = Math.max(0, Number(timeInfo?.delta) || 0) * 1000;
    let pathPlaying = false;
    try {
      if (window.MapShine?.environmentControlApi?.isExternallyDriven?.()) pathPlaying = true;
      const cps = window.MapShine?.cameraPathService;
      if (cps?.isPlaying === true || cps?.animator?.isActive === true) pathPlaying = true;
    } catch (_) {}
    if (!pathPlaying) {
      this._lastAnimWallMs = performance.now();
      return simMs;
    }

    const now = performance.now();
    if (!this._lastAnimWallMs) this._lastAnimWallMs = now;
    const wallMs = Math.max(0, now - this._lastAnimWallMs);
    this._lastAnimWallMs = now;

    const tm = window.MapShine?.effectComposer?.getTimeManager?.();
    let scale = Number(timeInfo?.scale);
    if (!Number.isFinite(scale) || scale <= 0) {
      scale = Number(tm?.getEffectiveScale?.() ?? tm?.scale) || 1;
    }
    const wallSimMs = (wallMs / 1000) * scale * 1000;
    return Math.max(simMs, wallSimMs);
  }

  /**
   * Per-frame animation tick (EffectComposer camera pipeline).
   * @param {object} timeInfo
   */
  update(timeInfo) {
    const anim = this._pendingAnim;
    if (!anim) return;

    if (this._cancelled || anim.getIsCancelled?.()) {
      this._clearPendingAnim();
      return;
    }

    const dtMs = this._animDeltaMs(timeInfo);
    anim.elapsedMs += dtMs;

    const te = applyEasing(anim.easing, anim.elapsedMs, anim.durationMs);
    const cx = anim.startView.x + (anim.target.x - anim.startView.x) * te;
    const cy = anim.startView.y + (anim.target.y - anim.startView.y) * te;
    const cs = anim.startView.scale + (anim.target.scale - anim.startView.scale) * te;

    try { canvas.pan({ x: cx, y: cy, scale: cs }); } catch (_) {}

    if (anim.elapsedMs >= anim.durationMs) {
      this.instantPan(anim.target);
      this._clearPendingAnim();
    }
  }

  /**
   * @param {CameraView} view
   */
  instantPan(view) {
    try {
      canvas?.pan?.({ x: view.x, y: view.y, scale: view.scale, duration: 0 });
    } catch (err) {
      log.warn('instantPan failed', err);
    }
  }

  /**
   * @returns {CameraView|null}
   */
  captureCurrentView() {
    const x = asNumber(canvas?.stage?.pivot?.x, NaN);
    const y = asNumber(canvas?.stage?.pivot?.y, NaN);
    const scale = asNumber(canvas?.stage?.scale?.x, NaN);
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(scale)) return null;
    return { x, y, scale };
  }

  /**
   * @param {object} options
   * @param {number} options.x
   * @param {number} options.y
   * @param {number} options.scale
   * @param {number} options.durationMs
   * @param {CameraEasingId} [options.easing='trapezoidal']
   * @param {() => boolean} [options.getIsCancelled]
   * @returns {Promise<void>}
   */
  async animateTo({
    x,
    y,
    scale,
    durationMs,
    easing = 'trapezoidal',
    getIsCancelled = null,
  }) {
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(scale)) {
      throw new Error('Invalid camera target');
    }

    const dur = Math.max(0, asNumber(durationMs, 0));
    if (dur <= 0) {
      this.instantPan({ x, y, scale });
      return;
    }

    const startView = this.captureCurrentView() || { x, y, scale };

    if (this._pendingAnim) {
      this._clearPendingAnim();
    }

    try {
      const renderLoop = window.MapShine?.renderLoop;
      const wallMs = scalePlaybackWallDurationMs(dur + 500);
      if (typeof renderLoop?.extendCinematicMode === 'function') {
        renderLoop.extendCinematicMode(wallMs);
      } else {
        renderLoop?.startCinematicMode?.(wallMs);
      }
      renderLoop?.requestContinuousRender?.(wallMs);
    } catch (_) {}

    await new Promise((resolve) => {
      this._animateResolve = resolve;
      this._pendingAnim = {
        startView,
        target: { x, y, scale },
        durationMs: dur,
        elapsedMs: 0,
        easing,
        getIsCancelled,
      };
    });
  }

  /**
   * Run a multi-segment camera path with shared lifecycle hooks.
   *
   * @param {CameraPathSegment[]} segments
   * @param {object} [options]
   * @param {CameraEasingId} [options.easing='trapezoidal']
   * @param {number} [options.segmentHoldMs=800]
   * @param {number} [options.preHoldMs=800]
   * @param {boolean} [options.skipInitialPan=false]
   * @param {(index: number, segment: CameraPathSegment) => void|Promise<void>} [options.onSegmentStart]
   * @param {() => boolean} [options.getIsCancelled]
   * @param {() => void} [options.onCancel]
   * @returns {Promise<void>}
   */
  async animatePath(segments, options = {}) {
    const {
      easing = 'trapezoidal',
      segmentHoldMs = 800,
      preHoldMs = 800,
      skipInitialPan = false,
      onSegmentStart = null,
      getIsCancelled = null,
      onCancel = null,
    } = options;

    if (!Array.isArray(segments) || !segments.length) return;

    const isCancelled = () => this._cancelled || getIsCancelled?.() === true;

    const totalMs = segments.reduce((sum, seg) => sum + Math.max(0, seg.durationMs || 0), 0)
      + preHoldMs
      + Math.max(0, segments.length - 1) * segmentHoldMs;

    this._active = true;
    this._cancelled = false;
    this._installEscapeListener(onCancel);

    const pixiInputBridge = window.MapShine?.pixiInputBridge;
    const cinematicCameraManager = window.MapShine?.cinematicCameraManager;
    const renderLoop = window.MapShine?.renderLoop;

    try {
      cinematicCameraManager?.suspendTemporaryRuntimeControl?.();
      try {
        pixiInputBridge?.setInputBlocker?.(() => true);
      } catch (_) {}
      try {
        renderLoop?.startCinematicMode?.(totalMs + 1500);
      } catch (_) {}

      if (!skipInitialPan) {
        const first = segments[0];
        this.instantPan(first.from);
      }
      if (preHoldMs > 0) await sleep(preHoldMs, isCancelled);
      if (isCancelled()) return;

      for (let i = 0; i < segments.length; i++) {
        if (isCancelled()) break;

        const segment = segments[i];
        if (typeof onSegmentStart === 'function') {
          await onSegmentStart(i, segment);
        }
        if (isCancelled()) break;

        if (i > 0 && segmentHoldMs > 0) {
          this.instantPan(segment.from);
          await sleep(segmentHoldMs, isCancelled);
          if (isCancelled()) break;
        }

        await this.animateTo({
          x: segment.to.x,
          y: segment.to.y,
          scale: segment.to.scale,
          durationMs: segment.durationMs,
          easing,
          getIsCancelled: isCancelled,
        });
      }
    } finally {
      this._active = false;
      this._removeEscapeListener();

      try { renderLoop?.stopCinematicMode?.(); } catch (_) {}
      try {
        pixiInputBridge?.setInputBlocker?.(null);
        cinematicCameraManager?._bindInputBridge?.();
      } catch (_) {}
      cinematicCameraManager?.resumeTemporaryRuntimeControl?.();
    }
  }

  /**
   * Run a resolved timeline (sweeps, significant-location holds, transitions).
   *
   * @param {import('./camera-path-types.js').CameraTimelineClip[]} clips
   * @param {object} [options]
   * @param {CameraEasingId} [options.easing='trapezoidal']
   * @param {number} [options.segmentHoldMs=800]
   * @param {number} [options.preHoldMs=800]
   * @param {boolean} [options.skipInitialPan=false]
   * @param {() => boolean} [options.getIsCancelled]
   * @param {() => void} [options.onCancel]
   * @param {(view: import('./camera-path-types.js').CameraView, fadeMs: number, getIsCancelled: () => boolean) => Promise<void>} [options.runFadeCutTransition]
   * @param {boolean} [options.manageCinematicMode=true]
   * @returns {Promise<void>}
   */
  async animateTimeline(clips, options = {}) {
    const {
      easing = 'trapezoidal',
      segmentHoldMs = 800,
      preHoldMs = 800,
      skipInitialPan = false,
      getIsCancelled = null,
      onCancel = null,
      runFadeCutTransition = null,
      manageCinematicMode = true,
    } = options;

    if (!Array.isArray(clips) || !clips.length) return;

    const isCancelled = () => this._cancelled || getIsCancelled?.() === true;

    const totalMs = clips.reduce((sum, clip) => sum + Math.max(0, clip.durationMs || 0), 0)
      + preHoldMs
      + segmentHoldMs * Math.max(0, clips.filter((c) => c.type === 'sweep').length - 1);

    this._active = true;
    this._cancelled = false;
    this._installEscapeListener(onCancel);

    const pixiInputBridge = window.MapShine?.pixiInputBridge;
    const cinematicCameraManager = window.MapShine?.cinematicCameraManager;
    const renderLoop = window.MapShine?.renderLoop;

    /** @type {import('./camera-path-types.js').CameraTimelineClip|null} */
    let prevClip = null;

    try {
      cinematicCameraManager?.suspendTemporaryRuntimeControl?.();
      try {
        pixiInputBridge?.setInputBlocker?.(() => true);
      } catch (_) {}
      if (manageCinematicMode) {
        try {
          const cinematicWallMs = scalePlaybackWallDurationMs(totalMs + 1500);
          renderLoop?.startCinematicMode?.(cinematicWallMs);
        } catch (_) {}
      }

      const first = clips[0];
      if (!skipInitialPan) {
        if (first.type === 'sweep' && first.from) {
          this.instantPan(first.from);
        } else if (first.type === 'sigHold' && first.view) {
          this.instantPan(first.view);
        } else if (first.type === 'transition' && first.from) {
          this.instantPan(first.from);
        }
      } else if (first.type === 'sweep' && first.from) {
        this.instantPan(first.from);
      }

      if (preHoldMs > 0) await sleep(preHoldMs, isCancelled);
      if (isCancelled()) return;

      for (let i = 0; i < clips.length; i += 1) {
        if (isCancelled()) break;

        const clip = clips[i];

        if (
          clip.type === 'sweep'
          && prevClip?.type === 'sweep'
          && prevClip.sweepPair
          && clip.sweepPair
          && prevClip.sweepPair !== clip.sweepPair
          && segmentHoldMs > 0
        ) {
          if (clip.from) this.instantPan(clip.from);
          await sleep(segmentHoldMs, isCancelled);
          if (isCancelled()) break;
        }

        if (clip.type === 'sweep' && clip.from && clip.to) {
          await this.animateTo({
            x: clip.to.x,
            y: clip.to.y,
            scale: clip.to.scale,
            durationMs: clip.durationMs,
            easing,
            getIsCancelled: isCancelled,
          });
        } else if (clip.type === 'sigHold' && clip.view) {
          this.instantPan(clip.view);
          await sleep(clip.durationMs, isCancelled);
        } else if (clip.type === 'transition' && clip.to) {
          if (clip.transitionStyle === 'fade' && runFadeCutTransition) {
            const fadeHalfMs = Math.max(250, Math.round(clip.durationMs / 2));
            await runFadeCutTransition(clip.to, fadeHalfMs, isCancelled);
          } else {
            await this.animateTo({
              x: clip.to.x,
              y: clip.to.y,
              scale: clip.to.scale,
              durationMs: clip.durationMs,
              easing,
              getIsCancelled: isCancelled,
            });
          }
        }

        prevClip = clip;
      }
    } finally {
      this._active = false;
      this._removeEscapeListener();

      if (manageCinematicMode) {
        try { renderLoop?.stopCinematicMode?.(); } catch (_) {}
      }
      try {
        pixiInputBridge?.setInputBlocker?.(null);
        cinematicCameraManager?._bindInputBridge?.();
      } catch (_) {}
      cinematicCameraManager?.resumeTemporaryRuntimeControl?.();
    }
  }

  /**
   * @param {(() => void)|null} [onCancel]
   * @private
   */
  _installEscapeListener(onCancel = null) {
    this._removeEscapeListener();
    this._escapeListener = (event) => {
      if (event.key !== 'Escape') return;
      this.cancel();
      try { onCancel?.(); } catch (_) {}
    };
    document.addEventListener('keydown', this._escapeListener);
  }

  /** @private */
  _removeEscapeListener() {
    if (this._escapeListener) {
      document.removeEventListener('keydown', this._escapeListener);
      this._escapeListener = null;
    }
  }

  dispose() {
    this.cancel();
    this._active = false;
  }
}
