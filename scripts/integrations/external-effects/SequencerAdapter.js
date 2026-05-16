/**
 * @fileoverview SequencerAdapter — bridges Sequencer's PIXI-based CanvasEffects
 * into MSA's Three.js FloorRenderBus via per-effect SequencerEffectMirror
 * meshes.
 *
 * Lifecycle hooks consumed:
 *   - `sequencerReady`            — confirm Sequencer global is present
 *   - `createSequencerEffect`     — spawn mirror, hide PIXI container
 *   - `updateSequencerEffect`     — refresh renderOrder if elevation/sortLayer changed
 *   - `endedSequencerEffect`      — dispose mirror, unhide PIXI container
 *
 * Transform sync runs once per Foundry PIXI tick via
 * `FrameCoordinator.onPostPixi` so positions track the underlying PIXI
 * containers without per-RAF reflow.
 *
 * Diagnostics: `MapShine.externalEffects.probeSequencerMirrors()` (F12),
 * `MapShine.externalEffects.probeSequencerMirrorsDeep()` for DOM pixel samples + WebGL hints,
 * or `MapShine.__sequencerMirrorProbeIntervalMs = 2000` for periodic dumps
 * (set `MapShine.__sequencerMirrorProbeUseDeep = true` to use the deep snapshot each tick).
 *
 * @module integrations/external-effects/SequencerAdapter
 */

import { createLogger } from '../../core/log.js';
import { SequencerEffectMirror } from './SequencerEffectMirror.js';

const log = createLogger('SequencerAdapter');

const ATTACH_RETRY_DELAY_MS = 100;
const ATTACH_RETRY_MAX_ATTEMPTS = 20;

export class SequencerAdapter {
  /**
   * @param {{
   *   compositor: any,
   *   floorRenderBus: any,
   *   sceneComposer: any,
   *   floorStack: any,
   *   frameCoordinator: any,
   *   renderLoop: any,
   * }} refs
   */
  constructor(refs) {
    this._compositor = refs.compositor;
    this._floorRenderBus = refs.floorRenderBus;
    this._sceneComposer = refs.sceneComposer;
    this._floorStack = refs.floorStack;
    this._frameCoordinator = refs.frameCoordinator;
    this._renderLoop = refs.renderLoop;

    /** @type {Map<string, SequencerEffectMirror>} */
    this._mirrors = new Map();

    /** @type {boolean} */
    this._enabled = true;

    /** @type {boolean} */
    this._initialized = false;

    /** @type {boolean} */
    this._disposed = false;

    /** @type {Array<{name:string,id:number}>} */
    this._hookIds = [];

    /** @type {Function|null} */
    this._postPixiUnsubscribe = null;

    /** @type {WeakMap<object, string>} */
    this._effectIds = new WeakMap();

    /** @type {number} */
    this._nextSyntheticId = 1;

    /** @type {Map<string, {effect: any, attempts: number, timerId: number|null}>} */
    this._pendingAttach = new Map();

    /** @type {number} */
    this._lastMirrorProbeAt = 0;
  }

  /** @returns {boolean} */
  isSequencerAvailable() {
    try {
      return !!(globalThis.Sequencer && (globalThis.Sequence || globalThis.Sequencer.Sequence));
    } catch (_) { return false; }
  }

  /**
   * Wire Foundry hooks. Safe to call once; subsequent calls are no-ops.
   */
  initialize() {
    if (this._initialized || this._disposed) return;
    this._initialized = true;

    const reg = (name, fn) => {
      try {
        const id = Hooks.on(name, fn);
        this._hookIds.push({ name, id });
      } catch (e) {
        log.warn(`Hooks.on(${name}) failed:`, e);
      }
    };

    reg('sequencerReady', () => {
      log.info('Sequencer ready — adapter is active');
      this._bootstrapExistingEffects();
    });
    reg('createSequencerEffect', (effect) => this._onCreate(effect));
    reg('updateSequencerEffect', (effect) => this._onUpdate(effect));
    reg('endedSequencerEffect', (effect) => this._onEnd(effect));

    // Per-frame transform sync.
    try {
      const fc = this._frameCoordinator;
      if (fc && typeof fc.onPostPixi === 'function') {
        this._postPixiUnsubscribe = fc.onPostPixi(() => this._syncAll());
      } else {
        // Fallback: directly attach to PIXI ticker if frame coordinator is missing.
        if (globalThis.canvas?.app?.ticker?.add) {
          const tickFn = () => this._syncAll();
          canvas.app.ticker.add(tickFn);
          this._postPixiUnsubscribe = () => {
            try { canvas.app.ticker.remove(tickFn); } catch (_) {}
          };
        }
      }
    } catch (e) {
      log.warn('frame sync attach failed:', e);
    }

    log.info('SequencerAdapter initialized');
    this._bootstrapExistingEffects();
  }

  /** @returns {boolean} */
  hasActiveMirrors() {
    return this._mirrors.size > 0;
  }

  /**
   * Set adapter enabled state. Disabled adapter does not spawn new mirrors
   * but leaves existing mirrors in place until they end naturally.
   * @param {boolean} enabled
   */
  setEnabled(enabled) {
    this._enabled = !!enabled;
  }

  /**
   * Master brightness for mirrored Sequencer / JB2A clips. Backed by
   * `MapShine.__sequencerMirrorExternalDiffuseGain` (clamped 0.03–2 inside
   * the mirror). Passing a non-finite value clears the override and the
   * per-texture-kind defaults take effect again.
   * @param {number} value
   */
  setExternalDiffuseGain(value) {
    const root = (globalThis.window ?? globalThis).MapShine ?? null;
    if (!root) return;
    const v = Number(value);
    if (!Number.isFinite(v) || v <= 0) {
      delete root.__sequencerMirrorExternalDiffuseGain;
      return;
    }
    root.__sequencerMirrorExternalDiffuseGain = Math.min(2, Math.max(0.03, v));
  }

  /**
   * Per-channel multiplier for mirrored clips. Stored as `{r,g,b}` on
   * `MapShine.__sequencerMirrorExternalTint` and read by every mirror.
   * @param {number} r
   * @param {number} g
   * @param {number} b
   */
  setExternalTint(r, g, b) {
    const root = (globalThis.window ?? globalThis).MapShine ?? null;
    if (!root) return;
    const rr = Math.max(0, Number(r));
    const gg = Math.max(0, Number(g));
    const bb = Math.max(0, Number(b));
    if (![rr, gg, bb].every(Number.isFinite)) return;
    root.__sequencerMirrorExternalTint = { r: rr, g: gg, b: bb };
  }

  /**
   * Scale the along-cast component of the combined sprite + pivot delta.
   * <1 retreats toward the caster, >1 pushes further forward.
   * @param {number} value
   */
  setAlongCastPlacementMul(value) {
    const root = (globalThis.window ?? globalThis).MapShine ?? null;
    if (!root) return;
    const v = Number(value);
    if (!Number.isFinite(v) || v <= 0) return;
    root.__sequencerMirrorAlongCastPlacementMul = v;
  }

  /**
   * Uniform scale on mirror mesh width/height after footprint resolution.
   * `MapShine.__sequencerMirrorMeshScaleMul` (default 1).
   * @param {number} value
   */
  setMirrorMeshScaleMul(value) {
    const root = (globalThis.window ?? globalThis).MapShine ?? null;
    if (!root) return;
    const v = Number(value);
    if (!Number.isFinite(v) || v <= 0) return;
    root.__sequencerMirrorMeshScaleMul = v;
  }

  /**
   * Scene-pixel shift along source→target (positive = toward target).
   * `MapShine.__sequencerMirrorAlongCastTargetNudgePx`.
   * @param {number} value
   */
  setAlongCastTargetNudgePx(value) {
    const root = (globalThis.window ?? globalThis).MapShine ?? null;
    if (!root) return;
    const v = Number(value);
    if (!Number.isFinite(v)) return;
    root.__sequencerMirrorAlongCastTargetNudgePx = v;
  }

  /**
   * Extra world-space Z on the mirror mesh (bus scene). `MapShine.__sequencerMirrorZBias`.
   * @param {number} value
   */
  setMirrorZBias(value) {
    const root = (globalThis.window ?? globalThis).MapShine ?? null;
    if (!root) return;
    const v = Number(value);
    if (!Number.isFinite(v)) return;
    root.__sequencerMirrorZBias = v;
  }

  /**
   * Multiplier for the analytic "half-width forward" pivot Sequencer applies
   * to `rotateTowards` effects. Default 1.
   * @param {number} value
   */
  setRotateTowardsForwardMul(value) {
    const root = (globalThis.window ?? globalThis).MapShine ?? null;
    if (!root) return;
    const v = Number(value);
    if (!Number.isFinite(v) || v < 0) return;
    root.__sequencerMirrorRotateTowardsForwardMul = v;
  }

  /**
   * Direction of the forward pivot. ≥0 = forward (1), <0 = back (-1).
   * @param {number} sign
   */
  setRotateTowardsForwardSign(sign) {
    const root = (globalThis.window ?? globalThis).MapShine ?? null;
    if (!root) return;
    const v = Number(sign);
    if (!Number.isFinite(v) || v === 0) return;
    root.__sequencerMirrorRotateTowardsForwardSign = v > 0 ? 1 : -1;
  }

  /**
   * Called once per FloorCompositor render before the bus scene is rendered.
   * Currently a no-op — transform sync runs on the PIXI ticker — but reserved
   * for future per-frame validation (e.g. floor-change reroute).
   */
  tickBeforeBusRender() {
    if (this._disposed || this._mirrors.size === 0) return;
    const bus = this._resolveFloorRenderBus();
    for (const mirror of this._mirrors.values()) {
      try {
        mirror.ensureAttached?.(bus);
        mirror.syncFromPixi?.();
      } catch (e) {
        log.warn('mirror pre-bus validation failed:', e);
      }
    }
  }

  /**
   * Log every active Sequencer mirror snapshot to the browser console.
   * Call from F12 while an effect plays: `MapShine.externalEffects.probeSequencerMirrors()`
   * Deep (DOM `drawImage` luminance + GL extensions):
   * `MapShine.externalEffects.probeSequencerMirrorsDeep()`
   *
   * Optional periodic dumps: `MapShine.__sequencerMirrorProbeIntervalMs = 2000`
   * (throttled; min 500 ms). Use `MapShine.__sequencerMirrorProbeUseDeep = true` so each
   * interval uses the deep snapshot.
   *
   * @param {string} [label]
   * @param {{ deep?: boolean }} [opts]
   * @returns {Array<Record<string, unknown>>}
   */
  probeMirrorsToConsole(label = 'manual', opts = undefined) {
    if (this._mirrors.size === 0) {
      console.warn(`[MSA Sequencer mirror probe:${label}] no active mirrors`);
      return [];
    }
    const deep = !!opts?.deep;
    const rows = [];
    for (const [key, mirror] of this._mirrors) {
      try {
        const snap = mirror.getDebugSnapshot?.(deep ? { deep: true } : undefined)
          ?? { error: 'no getDebugSnapshot' };
        rows.push({ key, ...snap });
      } catch (e) {
        rows.push({ key, error: String(e?.message ?? e) });
      }
    }
    console.warn(`[MSA Sequencer mirror probe:${label}${deep ? ' DEEP' : ''}]`, rows);
    return rows;
  }

  /**
   * Like `probeMirrorsToConsole` but always runs the deep path (2D canvas center
   * pixel on each bound video branch + WebGL extension names).
   * @param {string} [label]
   * @returns {Array<Record<string, unknown>>}
   */
  probeMirrorsDeepToConsole(label = 'deep') {
    return this.probeMirrorsToConsole(label, { deep: true });
  }

  // ── Hook handlers ──────────────────────────────────────────────────────────

  _onCreate(effect) {
    if (!this._enabled || this._disposed) return;
    const normalized = this._normalizeEffect(effect);
    const key = normalized?.id;
    if (!normalized || !key) return;
    if (this._mirrors.has(key)) return;
    if (this._pendingAttach.has(key)) return;

    let mirror = null;
    try {
      mirror = new SequencerEffectMirror({
        effect: normalized.effect,
        floorRenderBus: this._resolveFloorRenderBus(),
        sceneComposer: this._sceneComposer,
        floorStack: this._floorStack,
      });
      if (!mirror.attach()) {
        try { mirror.dispose(); } catch (_) {}
        this._scheduleAttachRetry(normalized.effect, key, 1);
        return;
      }
    } catch (e) {
      log.warn('SequencerEffectMirror construction failed for effect:', key, e);
      try { mirror?.dispose?.(); } catch (_) {}
      return;
    }

    this._mirrors.set(key, mirror);
    this._pendingAttach.delete(key);
    try { this._renderLoop?.requestContinuousRender?.(180); } catch (_) {}
  }

  _onUpdate(effect) {
    if (this._disposed) return;
    const normalized = this._normalizeEffect(effect);
    const key = normalized?.id;
    if (!key) return;
    const mirror = this._mirrors.get(key);
    if (!mirror) {
      this._scheduleAttachRetry(normalized.effect, key, 1);
      return;
    }
    try { mirror.refreshOrder(); } catch (e) {
      log.warn('mirror.refreshOrder failed:', e);
    }
  }

  _onEnd(effect) {
    const normalized = this._normalizeEffect(effect);
    const key = normalized?.id;
    if (!key) return;
    const mirror = this._mirrors.get(key);
    const pending = this._pendingAttach.get(key);
    if (pending?.timerId != null) {
      try { clearTimeout(pending.timerId); } catch (_) {}
    }
    this._pendingAttach.delete(key);
    if (!mirror) return;
    this._mirrors.delete(key);
    try { mirror.dispose(); } catch (e) {
      log.warn('mirror.dispose failed:', e);
    }
  }

  _syncAll() {
    if (this._disposed) return;
    if (this._mirrors.size === 0) return;
    const probeMs = Number(globalThis.window?.MapShine?.__sequencerMirrorProbeIntervalMs);
    const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
    let doProbe = false;
    if (Number.isFinite(probeMs) && probeMs >= 500) {
      if (now - (this._lastMirrorProbeAt ?? 0) >= probeMs) {
        this._lastMirrorProbeAt = now;
        doProbe = true;
      }
    }
    for (const mirror of this._mirrors.values()) {
      try { mirror.syncFromPixi(); } catch (e) {
        log.warn('mirror.syncFromPixi failed:', e);
      }
    }
    if (doProbe) {
      try {
        const deep = !!globalThis.window?.MapShine?.__sequencerMirrorProbeUseDeep;
        this.probeMirrorsToConsole('[MapShine.__sequencerMirrorProbeIntervalMs]', deep ? { deep: true } : undefined);
      } catch (_) {}
    }
  }

  _resolveFloorRenderBus() {
    const bus = this._floorRenderBus
      ?? globalThis.window?.MapShine?.floorCompositorV2?._renderBus
      ?? globalThis.window?.MapShine?.floorRenderBus
      ?? null;
    return bus;
  }

  _normalizeEffect(effectish) {
    if (!effectish) return null;
    // Hook payloads can be either the effect directly, or an object wrapping
    // the effect (depending on Sequencer / hook signature variants).
    const effect = effectish.effect ?? effectish.document ?? effectish;
    if (!effect) return null;
    const id = String(
      effect.id
      ?? effect._id
      ?? effect.uuid
      ?? effect.objectId
      ?? effect._objectId
      ?? effect.sequenceId
      ?? ''
    ).trim();
    if (id) return { effect, id };
    if (typeof effect === 'object') {
      let synthetic = this._effectIds.get(effect);
      if (!synthetic) {
        synthetic = `synthetic-${this._nextSyntheticId++}`;
        this._effectIds.set(effect, synthetic);
      }
      return { effect, id: synthetic };
    }
    return null;
  }

  _bootstrapExistingEffects() {
    if (this._disposed) return;
    try {
      const manager = globalThis.Sequencer?.EffectManager ?? null;
      const raw = manager?.effects ?? manager?._effects ?? null;
      const list = Array.isArray(raw)
        ? raw
        : (raw instanceof Map ? Array.from(raw.values()) : []);
      if (list.length === 0 && typeof manager?.getEffects === 'function') {
        try {
          const queried = manager.getEffects({});
          if (Array.isArray(queried)) list.push(...queried);
        } catch (_) {}
      }
      if (list.length === 0) return;
      for (const e of list) this._onCreate(e);
    } catch (e) {
      log.debug('bootstrap existing sequencer effects failed:', e);
    }
  }

  _scheduleAttachRetry(effect, key, attempts) {
    if (this._disposed || !this._enabled || !effect || !key) return;
    if (this._mirrors.has(key)) return;
    if (attempts > ATTACH_RETRY_MAX_ATTEMPTS) {
      log.warn(`Sequencer mirror attach gave up for ${key} after ${ATTACH_RETRY_MAX_ATTEMPTS} attempts`);
      this._pendingAttach.delete(key);
      return;
    }

    const existing = this._pendingAttach.get(key);
    if (existing?.timerId != null) return;

    const timerId = setTimeout(() => {
      this._pendingAttach.delete(key);
      if (this._disposed || this._mirrors.has(key)) return;

      let mirror = null;
      try {
        mirror = new SequencerEffectMirror({
          effect,
          floorRenderBus: this._resolveFloorRenderBus(),
          sceneComposer: this._sceneComposer,
          floorStack: this._floorStack,
        });
        if (mirror.attach()) {
          this._mirrors.set(key, mirror);
          try { this._renderLoop?.requestContinuousRender?.(500); } catch (_) {}
          return;
        }
      } catch (e) {
        log.debug(`Sequencer mirror retry ${attempts} failed for ${key}:`, e);
      }
      try { mirror?.dispose?.(); } catch (_) {}
      this._scheduleAttachRetry(effect, key, attempts + 1);
    }, ATTACH_RETRY_DELAY_MS);

    this._pendingAttach.set(key, { effect, attempts, timerId });
  }

  /**
   * Dispose all mirrors and unhook lifecycle hooks.
   */
  dispose() {
    if (this._disposed) return;
    this._disposed = true;

    for (const { name, id } of this._hookIds) {
      try { Hooks.off(name, id); } catch (_) {}
    }
    this._hookIds.length = 0;

    if (typeof this._postPixiUnsubscribe === 'function') {
      try { this._postPixiUnsubscribe(); } catch (_) {}
      this._postPixiUnsubscribe = null;
    }

    for (const mirror of this._mirrors.values()) {
      try { mirror.dispose(); } catch (_) {}
    }
    this._mirrors.clear();
    for (const pending of this._pendingAttach.values()) {
      if (pending?.timerId != null) {
        try { clearTimeout(pending.timerId); } catch (_) {}
      }
    }
    this._pendingAttach.clear();

    log.info('SequencerAdapter disposed');
  }
}
