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
 * @module integrations/external-effects/SequencerAdapter
 */

import { createLogger } from '../../core/log.js';
import { SequencerEffectMirror } from './SequencerEffectMirror.js';

const log = createLogger('SequencerAdapter');

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
   * Called once per FloorCompositor render before the bus scene is rendered.
   * Currently a no-op — transform sync runs on the PIXI ticker — but reserved
   * for future per-frame validation (e.g. floor-change reroute).
   */
  tickBeforeBusRender() {}

  // ── Hook handlers ──────────────────────────────────────────────────────────

  _onCreate(effect) {
    if (!this._enabled || this._disposed) return;
    const normalized = this._normalizeEffect(effect);
    const key = normalized?.id;
    if (!normalized || !key) return;
    if (this._mirrors.has(key)) return;

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
        return;
      }
    } catch (e) {
      log.warn('SequencerEffectMirror construction failed for effect:', key, e);
      try { mirror?.dispose?.(); } catch (_) {}
      return;
    }

    this._mirrors.set(key, mirror);
    try { this._renderLoop?.requestContinuousRender?.(180); } catch (_) {}
  }

  _onUpdate(effect) {
    if (this._disposed) return;
    const normalized = this._normalizeEffect(effect);
    const key = normalized?.id;
    if (!key) return;
    const mirror = this._mirrors.get(key);
    if (!mirror) return;
    try { mirror.refreshOrder(); } catch (e) {
      log.warn('mirror.refreshOrder failed:', e);
    }
  }

  _onEnd(effect) {
    const normalized = this._normalizeEffect(effect);
    const key = normalized?.id;
    if (!key) return;
    const mirror = this._mirrors.get(key);
    if (!mirror) return;
    this._mirrors.delete(key);
    try { mirror.dispose(); } catch (e) {
      log.warn('mirror.dispose failed:', e);
    }
  }

  _syncAll() {
    if (this._disposed) return;
    if (this._mirrors.size === 0) return;
    for (const mirror of this._mirrors.values()) {
      try { mirror.syncFromPixi(); } catch (e) {
        log.warn('mirror.syncFromPixi failed:', e);
      }
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
    if (!id) return null;
    return { effect, id };
  }

  _bootstrapExistingEffects() {
    if (this._disposed) return;
    try {
      const list = globalThis.Sequencer?.EffectManager?.effects;
      if (!Array.isArray(list) || list.length === 0) return;
      for (const e of list) this._onCreate(e);
    } catch (e) {
      log.debug('bootstrap existing sequencer effects failed:', e);
    }
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

    log.info('SequencerAdapter disposed');
  }
}
