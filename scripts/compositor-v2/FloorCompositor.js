/**
 * @fileoverview FloorCompositor — V2 compositor render orchestrator.
 *
 * Owns the FloorRenderBus and drives the per-frame render loop.
 * The bus scene contains all tile meshes Z-ordered by floor, rendered
 * directly to the screen framebuffer. Effects add overlay meshes to the
 * same bus scene so they benefit from the same floor visibility system.
 *
 * Current effects:
 *   - **SpecularEffectV2**: Per-tile additive overlays driven by _Specular
 *     masks. Overlay meshes sit at a small Z offset above their albedo tile
 *     and use AdditiveBlending for natural specular compositing.
 *   - **FireEffectV2**: Per-floor particle systems (fire + embers + smoke)
 *     driven by _Fire masks. Uses three.quarks BatchedRenderer in the bus
 *     scene. Floor isolation via system swapping on floor change.
 *
 * Remaining effects will be added one at a time. Render targets and
 * post-processing infrastructure will be added only when an effect
 * requires them — not speculatively.
 *
 * Called by EffectComposer.render() when the `useCompositorV2` setting is on.
 *
 * @module compositor-v2/FloorCompositor
 */

import { createLogger } from '../core/log.js';
import { FloorRenderBus } from './FloorRenderBus.js';
import { SpecularEffectV2 } from './effects/SpecularEffectV2.js';
import { FireEffectV2 } from './effects/FireEffectV2.js';

const log = createLogger('FloorCompositor');

// ─── FloorCompositor ─────────────────────────────────────────────────────────

export class FloorCompositor {
  /**
   * @param {THREE.WebGLRenderer} renderer
   * @param {THREE.Scene} scene - The main Three.js scene (not used directly by
   *   the bus — which has its own scene — but kept for future effects that may
   *   need to add objects to the main scene graph).
   * @param {THREE.PerspectiveCamera} camera
   */
  constructor(renderer, scene, camera) {
    /** @type {THREE.WebGLRenderer} */
    this.renderer = renderer;
    /** @type {THREE.Scene} */
    this.scene = scene;
    /** @type {THREE.PerspectiveCamera} */
    this.camera = camera;

    /**
     * FloorRenderBus: owns a single THREE.Scene containing all tile meshes
     * Z-ordered by floor index. Textures loaded independently via
     * THREE.TextureLoader (straight alpha, no canvas 2D corruption).
     * @type {FloorRenderBus}
     */
    this._renderBus = new FloorRenderBus();

    /**
     * V2 Specular Effect: per-tile additive overlays driven by _Specular masks.
     * Overlay meshes live in the bus scene so they benefit from the same floor
     * visibility system as albedo tiles.
     * @type {SpecularEffectV2}
     */
    this._specularEffect = new SpecularEffectV2(this._renderBus);

    /**
     * V2 Fire Effect: per-floor particle systems (fire + embers + smoke)
     * driven by _Fire masks. BatchedRenderer lives in the bus scene.
     * @type {FireEffectV2}
     */
    this._fireEffect = new FireEffectV2(this._renderBus);

    /** @type {boolean} Whether the render bus has been populated this session. */
    this._busPopulated = false;

    /** @type {boolean} Whether initialize() has been called */
    this._initialized = false;

    /** @type {THREE.Vector2} Reusable size vector (avoids per-frame allocation) */
    this._sizeVec = null;

    /** @type {number|null} Foundry hook ID for mapShineLevelContextChanged */
    this._levelHookId = null;

    log.debug('FloorCompositor created');
  }

  // ── Lifecycle ───────────────────────────────────────────────────────────────

  /**
   * Initialize the compositor. Currently just sets up the bus and the
   * floor-change hook. Render targets will be added when effects need them.
   */
  initialize() {
    const THREE = window.THREE;
    if (!THREE || !this.renderer) {
      log.warn('FloorCompositor.initialize: missing THREE or renderer');
      return;
    }

    this._sizeVec = new THREE.Vector2();
    this.renderer.getDrawingBufferSize(this._sizeVec);
    const w = Math.max(1, this._sizeVec.x);
    const h = Math.max(1, this._sizeVec.y);

    this._renderBus.initialize();
    this._specularEffect.initialize();
    this._fireEffect.initialize();

    // Listen for floor/level changes so we can update tile mesh visibility.
    this._levelHookId = Hooks.on('mapShineLevelContextChanged', (payload) => {
      this._onLevelContextChanged(payload);
    });

    this._initialized = true;
    log.info(`FloorCompositor initialized (${w}x${h})`);
  }

  /**
   * Hook for EffectComposer/RenderLoop adaptive FPS.
   * When true, the render loop will prefer the "continuous" FPS cap so
   * time-varying systems (particles) stay smooth.
   *
   * @returns {boolean}
   */
  wantsContinuousRender() {
    try {
      const fire = this._fireEffect;
      if (!fire || !fire.enabled) return false;
      // If any floors are active, we have live particle systems that should
      // animate smoothly (not at idle FPS).
      if (fire._activeFloors && fire._activeFloors.size > 0) return true;
      return false;
    } catch (_) {
      // Fail safe: if anything about the probe throws, treat as active.
      return true;
    }
  }

  // ── Render ──────────────────────────────────────────────────────────────────

  /**
   * Per-frame render entry point. Called by EffectComposer when V2 is active.
   *
   * Renders the bus scene (albedo tiles + specular overlays) directly to screen.
   * No intermediate render targets or post-processing — additive blending on
   * specular overlays handles compositing in a single pass.
   *
   * @param {object} params
   * @param {object} [params.floorStack]
   * @param {object} [params.timeInfo]
   * @param {boolean} [params.doProfile=false]
   * @param {object} [params.profiler]
   */
  render({
    floorStack,
    timeInfo,
    doProfile = false,
    profiler = null,
  } = {}) {
    if (!this._initialized) {
      log.warn('FloorCompositor.render called before initialize()');
      return;
    }

    // ── Lazy bus population ───────────────────────────────────────────────────
    // Populate on the first render frame. Uses THREE.TextureLoader internally
    // so textures arrive asynchronously — meshes become visible as they load.
    if (!this._busPopulated) {
      this._busPopulated = true;
      const sc = window.MapShine?.sceneComposer ?? null;
      if (sc) {
        this._renderBus.populate(sc);
        // Apply initial floor visibility for albedo tiles (synchronous).
        this._applyCurrentFloorVisibility();
        // Populate specular overlays after bus tiles are built.
        // This is async (mask probing) so we re-apply floor visibility after
        // all overlays have been added — otherwise overlays default to visible
        // and upper-floor specular bleeds onto the ground floor on first load.
        this._specularEffect.populate(sc.foundrySceneData).then(() => {
          this._applyCurrentFloorVisibility();
        }).catch(err => {
          log.error('SpecularEffectV2 populate failed:', err);
        });
        // Populate fire particle systems from _Fire masks.
        this._fireEffect.populate(sc.foundrySceneData).then(() => {
          this._applyCurrentFloorVisibility();
        }).catch(err => {
          log.error('FireEffectV2 populate failed:', err);
        });
      } else {
        log.warn('FloorCompositor.render: no sceneComposer available for populate');
      }
    }

    // ── Update effects (time-varying uniforms) ───────────────────────────────
    if (timeInfo) {
      this._specularEffect.update(timeInfo);
      this._fireEffect.update(timeInfo);
    }

    // ── Bind per-frame textures and camera to effects ────────────────────────
    this._specularEffect.render(this.renderer, this.camera);

    // ── Render bus scene directly to screen ──────────────────────────────────
    // The bus scene now contains both albedo tiles AND specular overlays.
    // Additive blending on the overlays composites specular on top of albedo.
    this._renderBus.renderToScreen(this.renderer, this.camera);
  }

  // ── Floor Visibility ──────────────────────────────────────────────────────

  /**
   * Called when the active floor/level changes via the mapShineLevelContextChanged hook.
   * @param {object} payload - Hook payload from CameraFollower._emitLevelContextChanged
   * @private
   */
  _onLevelContextChanged(payload) {
    if (!this._busPopulated) return;
    this._applyCurrentFloorVisibility();
  }

  /**
   * Read the current active floor index from FloorStack and apply it to the bus.
   * @private
   */
  _applyCurrentFloorVisibility() {
    const floorStack = window.MapShine?.floorStack;
    if (!floorStack) return;

    const activeFloor = floorStack.getActiveFloor();
    const maxFloorIndex = activeFloor?.index ?? Infinity;
    this._renderBus.setVisibleFloors(maxFloorIndex);
    // Notify fire effect of floor change so it can swap active particle systems.
    this._fireEffect.onFloorChange(maxFloorIndex);
    log.debug(`FloorCompositor: visibility set to floors 0–${maxFloorIndex}`);
  }

  // ── Size Management ─────────────────────────────────────────────────────────

  /**
   * External resize handler — call when the viewport size changes.
   * Currently a no-op (no RTs to resize). Will be extended when effects
   * introduce render targets.
   * @param {number} width
   * @param {number} height
   */
  onResize(width, height) {
    // No render targets to resize in Milestone 1.
    // Future: resize effect RTs here.
  }

  // ── Cleanup ─────────────────────────────────────────────────────────────────

  /**
   * Dispose all GPU resources. Call on scene teardown.
   */
  dispose() {
    this._fireEffect.dispose();
    this._specularEffect.dispose();
    this._renderBus.dispose();
    this._busPopulated = false;

    // Unregister the level-change hook.
    if (this._levelHookId !== null) {
      try { Hooks.off('mapShineLevelContextChanged', this._levelHookId); } catch (_) {}
      this._levelHookId = null;
    }

    this._initialized = false;
    log.info('FloorCompositor disposed');
  }
}
