/**
 * @fileoverview ExternalEffectsCompositor — orchestrator for third-party
 * module visual integration (Dice So Nice, Sequencer / JB2A, …).
 *
 * Two integration channels:
 *
 *   1. **Sprite mirror (Sequencer / JB2A):** Each Sequencer effect spawns a
 *      `THREE.Mesh` mirror in `FloorRenderBus._scene`. The PIXI container is
 *      hidden (`renderable = false`) and the mesh transform is synced from
 *      the PIXI container via `FrameCoordinator.onPostPixi`.
 *
 *   2. **Texture mirror (DSN):** The dice-so-nice `<canvas>` is hidden and
 *      sampled as a `THREE.CanvasTexture`. A fullscreen `ExternalDsnPass`
 *      composites it inside `FloorCompositor.render()` between the per-level
 *      scene composite and the late fog/lens overlays, so dice receive
 *      bloom/color-grade applied by the per-level pipeline yet are not
 *      darkened by night lighting.
 *
 * Lifecycle: constructed once per scene from `canvas-replacement.js` after
 * `FloorCompositor` is initialized. Disposed on `canvasTearDown`.
 *
 * @module integrations/external-effects/ExternalEffectsCompositor
 */

import { createLogger } from '../../core/log.js';
import { SequencerAdapter } from './SequencerAdapter.js';
import { DiceSoNiceAdapter } from './DiceSoNiceAdapter.js';
import { ExternalDsnPass } from './ExternalDsnPass.js';

const log = createLogger('ExternalEffects');

/**
 * @typedef {Object} ExternalEffectsRefs
 * @property {any} renderer      - THREE.WebGLRenderer
 * @property {any} floorRenderBus
 * @property {any} sceneComposer
 * @property {any} floorStack
 * @property {any} frameCoordinator
 * @property {any} renderLoop
 */

export class ExternalEffectsCompositor {
  /**
   * @param {ExternalEffectsRefs} refs
   */
  constructor(refs = {}) {
    /** @type {ExternalEffectsRefs} */
    this._refs = refs;

    /** @type {SequencerAdapter|null} */
    this.sequencer = null;

    /** @type {DiceSoNiceAdapter|null} */
    this.diceSoNice = null;

    /** @type {ExternalDsnPass|null} */
    this.dsnPass = null;

    /** @type {boolean} */
    this._initialized = false;

    /** @type {boolean} */
    this._disposed = false;

    /** Per-adapter enable flags (read by FloorCompositor and Graphics Settings). */
    this.enabled = {
      sequencer: true,
      diceSoNice: true,
    };

    /**
     * Adapter-shaped facades exposed to GraphicsSettingsManager. Each has the
     * effect-instance protocol (`setEnabled(enabled)`, plus `enabled` getter)
     * that {@link GraphicsSettingsManager.applyOverrides} expects.
     */
    this.facades = Object.freeze({
      sequencer: this._buildFacade('sequencer'),
      diceSoNice: this._buildFacade('diceSoNice'),
    });
  }

  /**
   * Build an effect-instance-shaped facade so the Graphics Settings manager
   * can toggle this adapter via its standard `setEnabled` protocol.
   * @param {'sequencer'|'diceSoNice'} adapter
   * @returns {{ setEnabled: (e:boolean)=>void, get enabled(): boolean }}
   * @private
   */
  _buildFacade(adapter) {
    const self = this;
    return {
      get enabled() { return !!self.enabled[adapter]; },
      set enabled(v) { self.setAdapterEnabled(adapter, !!v); },
      setEnabled(v) { self.setAdapterEnabled(adapter, !!v); },
    };
  }

  /**
   * Initialize all adapters. Safe to call once; no-op on subsequent calls.
   * @returns {Promise<void>}
   */
  async initialize() {
    if (this._initialized || this._disposed) return;

    const THREE = window.THREE;
    if (!THREE) {
      log.warn('initialize: window.THREE not available, skipping');
      return;
    }

    try {
      this.dsnPass = new ExternalDsnPass(THREE);
      this.dsnPass.initialize();
    } catch (e) {
      log.warn('ExternalDsnPass.initialize failed:', e);
      this.dsnPass = null;
    }

    try {
      this.diceSoNice = new DiceSoNiceAdapter({
        compositor: this,
        dsnPass: this.dsnPass,
        renderLoop: this._refs.renderLoop ?? null,
      });
      this.diceSoNice.initialize();
    } catch (e) {
      log.warn('DiceSoNiceAdapter.initialize failed:', e);
      this.diceSoNice = null;
    }

    try {
      this.sequencer = new SequencerAdapter({
        compositor: this,
        floorRenderBus: this._refs.floorRenderBus ?? null,
        sceneComposer: this._refs.sceneComposer ?? null,
        floorStack: this._refs.floorStack ?? null,
        frameCoordinator: this._refs.frameCoordinator ?? null,
        renderLoop: this._refs.renderLoop ?? null,
      });
      this.sequencer.initialize();
    } catch (e) {
      log.warn('SequencerAdapter.initialize failed:', e);
      this.sequencer = null;
    }

    this._initialized = true;
    log.info('ExternalEffectsCompositor initialized', {
      sequencer: !!this.sequencer,
      diceSoNice: !!this.diceSoNice,
      dsnPass: !!this.dsnPass,
    });
  }

  /**
   * Called once per FloorCompositor frame from
   * `FloorCompositor.render()` immediately before the bus scene is rendered.
   * Adapters use this to sync any state that must be fresh before draw.
   */
  tickBeforeBusRender() {
    if (!this._initialized || this._disposed) return;
    try { this.sequencer?.tickBeforeBusRender?.(); } catch (e) {
      log.warn('sequencer.tickBeforeBusRender failed:', e);
    }
  }

  /**
   * Composite the dice-so-nice canvas onto the given input RT and return
   * the RT that contains the composited result. If DSN is inactive or
   * disabled, returns `inputRT` unchanged.
   *
   * @param {any} renderer  THREE.WebGLRenderer
   * @param {any} inputRT   Source RT containing the scene
   * @param {any} outputRT  Destination RT (must differ from inputRT)
   * @returns {any} The RT containing the final pixels (either inputRT or outputRT)
   */
  renderDsnPass(renderer, inputRT, outputRT) {
    if (!this._initialized || this._disposed) return inputRT;
    if (!this.enabled.diceSoNice) return inputRT;
    if (!this.dsnPass || !this.dsnPass.enabled) return inputRT;
    try {
      const wrote = this.dsnPass.render(renderer, inputRT, outputRT);
      return wrote ? outputRT : inputRT;
    } catch (e) {
      log.warn('renderDsnPass failed:', e);
      return inputRT;
    }
  }

  /**
   * Returns true if any adapter currently needs full-rate rendering
   * (an active dice roll or an active sequencer effect).
   * @returns {boolean}
   */
  requiresContinuousRender() {
    if (!this._initialized || this._disposed) return false;
    if (this.enabled.diceSoNice && this.dsnPass?.enabled) return true;
    if (this.enabled.sequencer && this.sequencer?.hasActiveMirrors?.()) return true;
    return false;
  }

  /**
   * Set adapter enabled state. Disabling causes the adapter to stop spawning
   * new mirrors and (for DSN) restores the DSN canvas to its default DOM
   * visibility. Existing mirrors are left to time out naturally.
   *
   * @param {'sequencer'|'diceSoNice'} adapter
   * @param {boolean} enabled
   */
  setAdapterEnabled(adapter, enabled) {
    const next = !!enabled;
    if (adapter === 'sequencer') {
      if (this.enabled.sequencer === next) return;
      this.enabled.sequencer = next;
      try { this.sequencer?.setEnabled?.(next); } catch (_) {}
    } else if (adapter === 'diceSoNice') {
      if (this.enabled.diceSoNice === next) return;
      this.enabled.diceSoNice = next;
      try { this.diceSoNice?.setEnabled?.(next); } catch (_) {}
    }
  }

  /**
   * Dispose all adapters and free resources. Safe to call multiple times.
   */
  dispose() {
    if (this._disposed) return;
    this._disposed = true;

    try { this.sequencer?.dispose?.(); } catch (e) {
      log.warn('sequencer.dispose failed:', e);
    }
    try { this.diceSoNice?.dispose?.(); } catch (e) {
      log.warn('diceSoNice.dispose failed:', e);
    }
    try { this.dsnPass?.dispose?.(); } catch (e) {
      log.warn('dsnPass.dispose failed:', e);
    }

    this.sequencer = null;
    this.diceSoNice = null;
    this.dsnPass = null;
    this._initialized = false;
    log.info('ExternalEffectsCompositor disposed');
  }
}
