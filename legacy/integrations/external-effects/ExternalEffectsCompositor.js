/**
 * @fileoverview ExternalEffectsCompositor — orchestrator for third-party
 * module visual integration (Dice So Nice, Sequencer / JB2A, …).
 *
 * Two integration channels:
 *
 *   1. **Sprite mirror (Sequencer / JB2A):** Each Sequencer effect spawns a
 *      `THREE.Mesh` mirror in `FloorRenderBus._scene`. The PIXI container is
 *      hidden (`renderable = false`) and transforms/media are synced in
 *      `FloorCompositor`'s {@link ExternalEffectsCompositor#tickBeforeBusRender}
 *      (every compositor draw). `FrameCoordinator.onPostPixi` only mirrors
 *      sync when legacy `MapShine.__sequencerMirrorLegacyPostPixiSync` is set.
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
 * F12: `MapShine.externalEffects.probeSequencerMirrors()` — Sequencer mirror diagnostics.
 * `MapShine.externalEffects.probeSequencerMirrorsDeep()` — same + 2D DOM samples + WebGL hints.
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

    /**
     * Defer-counter for {@link #_ensureSequencerAdapter()} when the first init
     * attempt failed (exceptions are swallowed elsewhere). Bounded so we don't
     * spin forever while Sequencer hooks are unreachable.
     * @private
     */
    /** @type {number} */
    this._sequencerDeferAttempts = 0;

    /** Max deferred Sequencer wiring attempts (~a few seconds at compositor FPS). */
    /** @private @type {number} */
    this._SEQUENCER_DEFER_MAX = 320;

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
      const ir = this._resolveIntegrationRefs();
      this.sequencer = new SequencerAdapter({
        compositor: this,
        floorRenderBus: ir.floorRenderBus,
        sceneComposer: ir.sceneComposer,
        floorStack: ir.floorStack,
        frameCoordinator: ir.frameCoordinator,
        renderLoop: ir.renderLoop,
      });
      this.sequencer.initialize();
      try { this.sequencer.invalidateFloorRenderBusCache(); } catch (_) {}
      this._sequencerDeferAttempts = 0;
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
    if (this._disposed) return;

    try {
      if (!globalThis.window?.THREE) return;
      if (!this._initialized) {
        void this.initialize();
      }
    } catch (e) {
      log.warn('Deferred ExternalEffectsCompositor.initialize (tickBeforeBusRender) failed:', e);
    }

    if (!this._initialized) return;

    try {
      this._ensureSequencerAdapter();
    } catch (e) {
      log.warn('ensureSequencerAdapter failed:', e);
    }

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
   * Preferred continuous-render FPS while external effects are active.
   * Returning a value lets the main RenderLoop avoid rendering faster than
   * the active adapter can provide new pixels (especially DSN canvas uploads).
   * @returns {number}
   */
  getPreferredContinuousFps() {
    if (!this._initialized || this._disposed) return 0;
    let preferred = 0;
    try {
      if (this.enabled.diceSoNice && this.dsnPass?.enabled) {
        preferred = Math.max(preferred, Number(this.diceSoNice?.getPreferredContinuousFps?.()) || 0);
      }
    } catch (_) {}
    try {
      if (this.enabled.sequencer && this.sequencer?.hasActiveMirrors?.()) {
        preferred = Math.max(preferred, 30);
      }
    } catch (_) {}
    return preferred;
  }

  /**
   * F12: `MapShine.externalEffects.probeSequencerMirrors()` while a Sequencer
   * effect plays — dumps video/texture/material/mesh state per mirror.
   * @param {string} [label]
   * @returns {Array<Record<string, unknown>>}
   */
  probeSequencerMirrors(label) {
    try {
      if (!globalThis.window?.THREE) return [];
      if (!this._disposed && !this._initialized) {
        void this.initialize();
      }
      if (!this._initialized) return [];
      this._ensureSequencerAdapter();
      return this.sequencer?.probeMirrorsToConsole?.(label ?? 'manual') ?? [];
    } catch (e) {
      console.warn('[MSA Sequencer mirror probe] failed:', e);
      return [];
    }
  }

  /**
   * Same as `probeSequencerMirrors` but adds `domVideoSamples` (center pixel via 2D
   * `drawImage`) and `rendererWebgl` hints — for diagnosing black mirrored video.
   * @param {string} [label]
   * @returns {Array<Record<string, unknown>>}
   */
  probeSequencerMirrorsDeep(label) {
    try {
      if (!globalThis.window?.THREE) return [];
      if (!this._disposed && !this._initialized) {
        void this.initialize();
      }
      if (!this._initialized) return [];
      this._ensureSequencerAdapter();
      return this.sequencer?.probeMirrorsDeepToConsole?.(label ?? 'deep-manual') ?? [];
    } catch (e) {
      console.warn('[MSA Sequencer mirror probe DEEP] failed:', e);
      return [];
    }
  }

  /**
   * Apply the Tweakpane "Post" panel state (DSN look + Sequencer mirror knobs)
   * to the live adapters/pass. Safe to call before initialization completes;
   * missing pieces are skipped. Pass a partial config — only present keys are
   * applied.
   *
   * Shape:
   * ```
   * {
   *   dsn:       { enabled, performanceMode, maxPixelRatio, maxUploadFps,
   *                gracePeriodMs, opacity, tint:{r,g,b}, brightness,
   *                saturation, contrast, gamma },
   *   sequencer: { enabled, brightness, tint:{r,g,b}, alongCastPlacementMul,
   *                mirrorScaleMul, alongCastTargetNudgePx, mirrorZBias,
   *                rotateTowardsForwardMul, reverseForwardPivot }
   * }
   * ```
   * @param {Record<string, any>} post
   */
  applyPostSettings(post) {
    if (!post || typeof post !== 'object') return;

    try {
      if (
        globalThis.window?.THREE &&
        !this._disposed &&
        !this._initialized
      ) {
        void this.initialize();
      }
    } catch (e) {
      log.warn('applyPostSettings: deferred initialize failed:', e);
    }

    const dsn = post.dsn ?? null;
    if (dsn && typeof dsn === 'object') {
      try {
        if (typeof dsn.enabled === 'boolean') {
          this.setAdapterEnabled('diceSoNice', dsn.enabled);
        }
        if (typeof dsn.performanceMode === 'string' && this.diceSoNice?.setPerformanceMode) {
          this.diceSoNice.setPerformanceMode(dsn.performanceMode);
        }
        if (this.diceSoNice) {
          if (Number.isFinite(Number(dsn.maxPixelRatio))) this.diceSoNice.setMaxPixelRatio?.(Number(dsn.maxPixelRatio));
          if (Number.isFinite(Number(dsn.maxUploadFps))) this.diceSoNice.setMaxUploadFps?.(Number(dsn.maxUploadFps));
          if (Number.isFinite(Number(dsn.gracePeriodMs))) this.diceSoNice.setGracePeriodMs?.(Number(dsn.gracePeriodMs));
        }
        if (this.dsnPass) {
          if (Number.isFinite(Number(dsn.opacity))) this.dsnPass.setOpacity?.(Number(dsn.opacity));
          if (dsn.tint && typeof dsn.tint === 'object') {
            this.dsnPass.setTint?.(Number(dsn.tint.r), Number(dsn.tint.g), Number(dsn.tint.b));
          }
          if (Number.isFinite(Number(dsn.brightness))) this.dsnPass.setBrightness?.(Number(dsn.brightness));
          if (Number.isFinite(Number(dsn.saturation))) this.dsnPass.setSaturation?.(Number(dsn.saturation));
          if (Number.isFinite(Number(dsn.contrast))) this.dsnPass.setContrast?.(Number(dsn.contrast));
          if (Number.isFinite(Number(dsn.gamma))) this.dsnPass.setGamma?.(Number(dsn.gamma));
        }
      } catch (e) {
        log.warn('applyPostSettings(dsn) failed:', e);
      }
    }

    const seq = post.sequencer ?? null;
    if (seq && typeof seq === 'object') {
      try {
        if (typeof seq.enabled === 'boolean') {
          this.setAdapterEnabled('sequencer', seq.enabled);
        }
        this._ensureSequencerAdapter();
        const adapter = this.sequencer;
        if (adapter) {
          if (Number.isFinite(Number(seq.brightness))) adapter.setExternalDiffuseGain?.(Number(seq.brightness));
          if (seq.tint && typeof seq.tint === 'object') {
            adapter.setExternalTint?.(Number(seq.tint.r), Number(seq.tint.g), Number(seq.tint.b));
          }
          if (Number.isFinite(Number(seq.alongCastPlacementMul))) adapter.setAlongCastPlacementMul?.(Number(seq.alongCastPlacementMul));
          if (Number.isFinite(Number(seq.mirrorScaleMul))) adapter.setMirrorMeshScaleMul?.(Number(seq.mirrorScaleMul));
          if (Number.isFinite(Number(seq.alongCastTargetNudgePx))) adapter.setAlongCastTargetNudgePx?.(Number(seq.alongCastTargetNudgePx));
          if (Number.isFinite(Number(seq.mirrorZBias))) adapter.setMirrorZBias?.(Number(seq.mirrorZBias));
          if (Number.isFinite(Number(seq.rotateTowardsForwardMul))) adapter.setRotateTowardsForwardMul?.(Number(seq.rotateTowardsForwardMul));
          if (typeof seq.reverseForwardPivot === 'boolean') {
            adapter.setRotateTowardsForwardSign?.(seq.reverseForwardPivot ? -1 : 1);
          }
        }
      } catch (e) {
        log.warn('applyPostSettings(sequencer) failed:', e);
      }
    }
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
    this._sequencerDeferAttempts = 0;
    log.info('ExternalEffectsCompositor disposed');
  }

  /**
   * Prefer {@link Window.MapShine}'s live compositor/bus over constructor refs —
   * the FloorRenderBus instance can be stable while long-lived integrations need
   * the current `_renderBus` assigned at scene init / reinit time.
   * @private
   */
  _resolveIntegrationRefs() {
    const ms = globalThis.window?.MapShine ?? {};
    const ec = ms.effectComposer ?? null;
    return {
      floorRenderBus:
        ec?._floorCompositorV2?._renderBus
          ?? ms.floorCompositorV2?._renderBus
          ?? ms.floorRenderBus
          ?? this._refs.floorRenderBus
          ?? null,
      sceneComposer: ms.sceneComposer ?? this._refs.sceneComposer ?? null,
      floorStack: ms.floorStack ?? this._refs.floorStack ?? null,
      frameCoordinator: ms.frameCoordinator ?? this._refs.frameCoordinator ?? null,
      renderLoop: ms.renderLoop ?? this._refs.renderLoop ?? null,
    };
  }

  /**
   * Create the Sequencer adapter if the first initializer pass skipped or threw.
   * Idempotent once `this.sequencer` is assigned.
   *
   * Called from compositor ticks so floor / scene rebuilds regain hooks even when
   * early construction failed transiently.
   *
   * @private
   * @returns {boolean}
   */
  _ensureSequencerAdapter() {
    if (this._disposed || !this._initialized || !this.enabled.sequencer) return false;
    if (this.sequencer) return true;
    const THREE = globalThis.window?.THREE;
    if (!THREE) return false;

    const maxTry = Number(this._SEQUENCER_DEFER_MAX);
    const cap = Number.isFinite(maxTry) && maxTry > 0 ? maxTry : 320;
    if (this._sequencerDeferAttempts >= cap) return false;

    this._sequencerDeferAttempts += 1;

    try {
      const ir = this._resolveIntegrationRefs();
      const adapter = new SequencerAdapter({
        compositor: this,
        floorRenderBus: ir.floorRenderBus,
        sceneComposer: ir.sceneComposer,
        floorStack: ir.floorStack,
        frameCoordinator: ir.frameCoordinator,
        renderLoop: ir.renderLoop,
      });
      adapter.initialize();
      try { adapter.invalidateFloorRenderBusCache(); } catch (_) {}
      this.sequencer = adapter;
      this._sequencerDeferAttempts = 0;
      log.info('Sequencer adapter recovered via deferred wiring', {
        hasBus: !!ir.floorRenderBus,
      });
      return true;
    } catch (e) {
      log.warn(`Deferred SequencerAdapter init attempt ${this._sequencerDeferAttempts}/${cap} failed:`, e);
      this.sequencer = null;
      return false;
    }
  }
}
