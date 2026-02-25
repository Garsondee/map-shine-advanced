/**
 * @fileoverview WeatherParticlesV2 — V2 weather particle system adapter.
 *
 * Wraps the V1 WeatherParticles class (rain, snow, ash, foam, splashes) and
 * plugs it into the V2 FloorCompositor pipeline.
 *
 * ## Why a wrapper instead of a full rewrite?
 * WeatherParticles is ~8000 lines of mature, well-tuned particle logic. The V2
 * system's goal is to get weather particles running — not to rewrite them.
 * This wrapper:
 *   1. Creates a shared `BatchedRenderer` and adds it to the FloorRenderBus
 *      scene so particles render in the same pass as albedo tiles.
 *   2. Instantiates `WeatherParticles` pointed at that scene.
 *   3. Exposes `window.MapShineParticles.weatherParticles` so the existing
 *      WaterEffectV2 foam bridge (`_syncLegacyFoamParticles`) keeps working.
 *   4. Drives `WeatherController.update()` each frame so weather state (wind,
 *      precipitation, cloud cover, wetness) evolves correctly in V2.
 *   5. Provides frustum-culling via the FloorRenderBus camera.
 *
 * ## Render pipeline position
 * The BatchedRenderer is added to the FloorRenderBus scene with
 * `renderOrder = 50` and `depthWrite = false`, matching the V1 contract.
 * Particles appear on top of albedo tiles and all effect overlays (specular,
 * window light) because those overlays use `renderOrder` < 50.
 *
 * ## Floor isolation
 * WeatherParticles is inherently global (rain/snow falls everywhere). It reads
 * WeatherController.elevationWeatherSuppressed (set by TileManager) to suppress
 * precipitation when the viewer is below a weatherElevation ceiling.
 * No per-floor isolation is needed — weather is always above the topmost floor.
 *
 * @module compositor-v2/effects/WeatherParticlesV2
 */

import { createLogger } from '../../core/log.js';
import { weatherController } from '../../core/WeatherController.js';
import { WeatherParticles } from '../../particles/WeatherParticles.js';
import { BatchedRenderer } from '../../libs/three.quarks.module.js';

const log = createLogger('WeatherParticlesV2');

// Overlay layer constant — mirrors OVERLAY_THREE_LAYER from EffectComposer.
// Quarks batches are forced onto this layer so they render in the FloorCompositor's
// bus scene pass (which enables all layers including the overlay layer).
const OVERLAY_THREE_LAYER = 31;

// ─── WeatherParticlesV2 ───────────────────────────────────────────────────────

export class WeatherParticlesV2 {
  constructor() {
    /** @type {boolean} */
    this.enabled = true;
    /** @type {boolean} */
    this._initialized = false;

    /** @type {BatchedRenderer|null} three.quarks shared renderer */
    this._batchRenderer = null;
    /** @type {WeatherParticles|null} V1 weather particle simulation */
    this._weatherParticles = null;

    /** @type {THREE.Scene|null} FloorRenderBus scene (shared) */
    this._busScene = null;

    /** @type {THREE.Frustum|null} reused for culling */
    this._cullFrustum = null;
    /** @type {THREE.Matrix4|null} reused for culling */
    this._cullProjScreenMatrix = null;
    /** @type {THREE.Sphere|null} reused for culling */
    this._cullSphere = null;
    /** @type {THREE.Vector3|null} reused for culling */
    this._cullCenter = null;

    /** @type {THREE.Vector4|null} reused scene-bounds vec for WeatherParticles.update() */
    this._sceneBounds = null;

    /** Accumulated time for WeatherController sub-rate throttle */
    this._wcAccum = 0;
  }

  // ── Lifecycle ───────────────────────────────────────────────────────────────

  /**
   * Initialize the particle system.
   * @param {THREE.Scene} busScene - FloorRenderBus scene (bus._scene)
   */
  initialize(busScene) {
    if (this._initialized) return;
    const THREE = window.THREE;
    if (!THREE) {
      log.warn('WeatherParticlesV2.initialize: THREE not available');
      return;
    }
    if (!busScene) {
      log.warn('WeatherParticlesV2.initialize: busScene not provided');
      return;
    }

    this._busScene = busScene;

    // Create shared three.quarks BatchedRenderer and add it to the bus scene.
    // renderOrder=50 places particles above albedo tiles and effect overlays.
    this._batchRenderer = new BatchedRenderer();
    this._batchRenderer.renderOrder = 50;
    // Enable the overlay layer so the bus render pass includes batches.
    try {
      if (this._batchRenderer.layers?.enable) {
        this._batchRenderer.layers.enable(OVERLAY_THREE_LAYER);
      }
    } catch (_) {}
    busScene.add(this._batchRenderer);

    // Instantiate the V1 WeatherParticles system, pointed at our bus scene.
    this._weatherParticles = new WeatherParticles(this._batchRenderer, busScene);

    // Expose on window.MapShineParticles so existing bridges (WaterEffectV2
    // foam sync, UI weather enable toggle, etc.) keep working without changes.
    if (!window.MapShineParticles) window.MapShineParticles = {};
    window.MapShineParticles.weatherParticles = this._weatherParticles;
    // Also expose a minimal ParticleSystem-like shape so callers that check
    // for window.MapShineParticles as a ParticleSystem can still introspect it.
    window.MapShineParticles.batchRenderer = this._batchRenderer;

    // Reusable culling objects (avoid per-frame allocations).
    this._cullFrustum           = new THREE.Frustum();
    this._cullProjScreenMatrix  = new THREE.Matrix4();
    this._cullSphere            = new THREE.Sphere();
    this._cullCenter            = new THREE.Vector3();

    this._initialized = true;
    log.info('WeatherParticlesV2 initialized (V1 WeatherParticles bridge active)');
  }

  // ── Per-frame update ────────────────────────────────────────────────────────

  /**
   * Update weather simulation + particle tick. Called by FloorCompositor.
   * @param {{ elapsed: number, delta: number }} timeInfo
   */
  update(timeInfo) {
    if (!this._initialized || !this.enabled) return;

    const deltaSec = typeof timeInfo?.delta === 'number' ? timeInfo.delta : 0.016;

    // ── 1. Advance WeatherController state ──────────────────────────────
    // WeatherController has its own sub-rate throttle (15 Hz), so calling
    // update() every frame is fine — it internally skips when not due.
    try {
      if (weatherController && typeof weatherController.update === 'function') {
        weatherController.update(timeInfo);
      }
    } catch (_) {}

    // ── 2. Build scene-bounds Vector4 for rain/snow clipping ────────────
    let boundsVec4 = null;
    try {
      const THREE = window.THREE;
      const d = canvas?.dimensions;
      if (THREE && d) {
        const rect = d.sceneRect;
        const sx = rect?.x ?? d.sceneX ?? 0;
        const sy = rect?.y ?? d.sceneY ?? 0;
        const sw = rect?.width  ?? d.sceneWidth  ?? d.width  ?? 1000;
        const sh = rect?.height ?? d.sceneHeight ?? d.height ?? 1000;
        const worldH = d.height ?? (sy + sh);
        // Convert Foundry Y-down into Three.js Y-up (minimum Y in world space).
        const syWorld = worldH - (sy + sh);
        if (!this._sceneBounds) this._sceneBounds = new THREE.Vector4(sx, syWorld, sw, sh);
        this._sceneBounds.set(sx, syWorld, sw, sh);
        boundsVec4 = this._sceneBounds;
      }
    } catch (_) {}

    // ── 3. Tick WeatherParticles (emission rates, masking, sizing) ───────
    if (this._weatherParticles) {
      try {
        // Scale delta to match V1 time convention:
        //   clampedDelta * 0.001 * 750 * simSpeed
        // This produces the same time-step that V1 ParticleSystem.update() used.
        const clampedDelta = Math.min(deltaSec, 0.1);
        const simSpeed = (typeof weatherController?.simulationSpeed === 'number')
          ? weatherController.simulationSpeed
          : 2.0;
        const dt = clampedDelta * 0.001 * 750 * simSpeed;

        this._weatherParticles.update(dt, boundsVec4);

        // Advance the BatchedRenderer (quarks core simulation step).
        if (this._batchRenderer) {
          this._batchRenderer.update(dt);
        }
      } catch (e) {
        log.warn('WeatherParticlesV2.update: particle tick error', e);
      }
    }

    // ── 4. Frustum cull individual particle systems ──────────────────────
    this._applyCulling();
  }

  // ── Floor change ────────────────────────────────────────────────────────────

  /**
   * Called when the active floor changes. No per-floor isolation needed for
   * weather (it's global), but WeatherController.elevationWeatherSuppressed
   * handles suppression below covered ceilings via TileManager.
   */
  onFloorChange(_maxFloorIndex) {
    // No-op: weather is inherently global (rain falls on all visible floors).
  }

  // ── Resize ──────────────────────────────────────────────────────────────────

  /**
   * Resize handler — particle emitters reread canvas.dimensions each frame
   * so no explicit resize logic is needed here.
   */
  onResize(_w, _h) {}

  // ── Dispose ─────────────────────────────────────────────────────────────────

  /**
   * Dispose all GPU resources. Call on scene teardown.
   */
  dispose() {
    if (this._weatherParticles) {
      try { this._weatherParticles.dispose(); } catch (_) {}
      this._weatherParticles = null;
    }

    if (this._batchRenderer && this._busScene) {
      try { this._busScene.remove(this._batchRenderer); } catch (_) {}
      this._batchRenderer = null;
    }

    // Clear the global bridge reference so stale callers don't hold live objects.
    if (window.MapShineParticles) {
      window.MapShineParticles.weatherParticles = null;
      window.MapShineParticles.batchRenderer = null;
    }

    this._busScene = null;
    this._sceneBounds = null;
    this._initialized = false;
    log.info('WeatherParticlesV2 disposed');
  }

  // ── Private helpers ─────────────────────────────────────────────────────────

  /**
   * Frustum-cull quarks particle systems. Mirrors V1 ParticleSystem._applyQuarksCulling()
   * but reads the camera from sceneComposer (the V2 perspective camera).
   * @private
   */
  _applyCulling() {
    const THREE = window.THREE;
    if (!THREE) return;
    const camera = window.MapShine?.sceneComposer?.camera;
    if (!camera) return;
    const systemMap = this._batchRenderer?.systemToBatchIndex;
    if (!systemMap || typeof systemMap.forEach !== 'function') return;
    const batches = this._batchRenderer?.batches;

    // Build frustum from current camera matrices.
    try {
      if (typeof camera.updateProjectionMatrix === 'function') camera.updateProjectionMatrix();
      camera.updateMatrixWorld(true);
      this._cullProjScreenMatrix.multiplyMatrices(
        camera.projectionMatrix,
        camera.matrixWorldInverse
      );
      this._cullFrustum.setFromProjectionMatrix(this._cullProjScreenMatrix);
    } catch (_) { return; }

    const groundZ = window.MapShine?.sceneComposer?.groundZ ?? null;

    systemMap.forEach((_, ps) => {
      if (!ps || !ps.emitter) return;
      const emitter = ps.emitter;
      const ud = emitter.userData || (emitter.userData = {});
      if (ud.msAutoCull === false) return;

      // Force all quarks batches onto the overlay layer so the bus render
      // pass includes them (it enables all layers including OVERLAY_THREE_LAYER).
      try {
        const idx = systemMap.get(ps);
        const batch = (idx !== undefined && batches) ? batches[idx] : null;
        if (batch?.layers?.set) batch.layers.set(OVERLAY_THREE_LAYER);
      } catch (_) {}

      // Compute a bounding sphere radius for this emitter.
      const pos = emitter.position;
      const c = ud.msCullCenter;
      if (c && typeof c === 'object') {
        if (typeof c.x === 'number') {
          this._cullCenter.set(c.x, c.y, c.z);
        } else if (Array.isArray(c) && c.length >= 3) {
          this._cullCenter.set(c[0], c[1], c[2]);
        } else {
          this._cullCenter.set(pos.x, pos.y, pos.z);
        }
      } else {
        this._cullCenter.set(pos.x, pos.y, pos.z);
      }

      let radius = 500;
      const shape = ps.emitterShape;
      if (shape && typeof shape.width === 'number' && typeof shape.height === 'number') {
        const w = Math.max(0, shape.width);
        const h = Math.max(0, shape.height);
        radius = 0.5 * Math.sqrt(w * w + h * h);
      }
      if (groundZ !== null) {
        radius += Math.max(0, Math.abs(this._cullCenter.z - groundZ)) * 0.5;
      }
      if (typeof ud.msCullRadius === 'number' && Number.isFinite(ud.msCullRadius) && ud.msCullRadius > 0) {
        radius = ud.msCullRadius;
      }

      this._cullSphere.center.copy(this._cullCenter);
      this._cullSphere.radius = radius;

      const visible = this._cullFrustum.intersectsSphere(this._cullSphere);
      const wasCulled = !!ud._msCulled;
      emitter.visible = visible;
      if (visible) {
        if (wasCulled) {
          if (typeof ps.play === 'function') ps.play();
          ud._msCulled = false;
        }
      } else {
        if (!wasCulled) {
          if (typeof ps.pause === 'function') ps.pause();
          ud._msCulled = true;
        }
      }
    });
  }
}
