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
 * Precipitation uses **layer 0** and a **floor-band renderOrder** just below
 * `OVERHEAD_OFFSET` (see FloorRenderBus), matching FireEffectV2: drawn in the
 * main `renderTo()` pass **under** overhead roof tiles and tree overlays.
 * Roof/tree **drips** use `emitter.userData.msOverlayLayer` → batch layer 31 →
 * `_renderLateWorldOverlay` (otherwise streaks are occluded by overhead art).
 * **Rain, ash, and ash embers** set `msOverlayLayer=true` so they draw in that
 * late pass above tokens/canopy; snow stays on layer 0 unless changed elsewhere.
 * Foam plumes use the same overlay flag. `WeatherParticlesV2._applyCulling` sets
 * `FloorCompositor._hasOverlayLayerContent` when assigning layer 31 (batches nest under BatchedRenderer).
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

import {
  effectUnderOverheadOrder,
} from '../LayerOrderPolicy.js';

const log = createLogger('WeatherParticlesV2');

// Proves which WeatherParticlesV2 build is active (`window.MapShine._wpV2Stamp`); set once, not per frame.
const WP_V2_STAMP = 'WeatherParticlesV2:reg-verify:2026-02-25a';

// Layer 31 — only for batches that must draw in FloorCompositor._renderLateWorldOverlay.
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

    /** One-time debug guard for registration failures */
    this._msLoggedRegistrationFailureOnce = false;
  }

  _ensureSystemRegistered(sys, label = '') {
    if (!sys || !this._batchRenderer) return;
    const map = this._batchRenderer.systemToBatchIndex;
    if (map && typeof map.has === 'function' && map.has(sys)) return;
    try {
      this._batchRenderer.addSystem(sys);
    } catch (e) {
      const dbg = window.MapShine?.debugWeatherFoamLogs === true;
      if (dbg && !this._msLoggedRegistrationFailureOnce) {
        this._msLoggedRegistrationFailureOnce = true;
        log.warn('[WeatherParticlesV2] addSystem threw', {
          label,
          message: String(e?.message ?? e),
          hasRenderer: !!this._batchRenderer,
          mapSize: this._batchRenderer?.systemToBatchIndex?.size ?? null
        });
      }
      return;
    }

    // Verify it actually registered. This is the same check the user ran manually.
    try {
      const ok = !!(map && typeof map.has === 'function' && map.has(sys));
      if (!ok) {
        const dbg = window.MapShine?.debugWeatherFoamLogs === true;
        if (dbg && !this._msLoggedRegistrationFailureOnce) {
          this._msLoggedRegistrationFailureOnce = true;
          log.warn('[WeatherParticlesV2] addSystem did not register system', {
            label,
            sysCtor: sys?.constructor?.name ?? null,
            emitterUuid: sys?.emitter?.uuid ?? null,
            emission: sys?.emissionOverTime?.value ?? null,
            mapSize: this._batchRenderer?.systemToBatchIndex?.size ?? null,
            batches: this._batchRenderer?.batches?.length ?? null
          });
        }
      }
    } catch (_) {}
  }

  /**
   * Re-attach the BatchedRenderer and all particle emitters to the bus scene
   * if they've been evicted. FloorRenderBus.clear() wipes all scene children
   * (including the BatchedRenderer and every WeatherParticles emitter) on every
   * populate() call (floor change, scene reload). Without this, emitters exist
   * and emit but are never rendered because they have no scene parent.
   * @private
   */
  _ensureSceneAttachment() {
    const scene = this._busScene;
    if (!scene || !this._batchRenderer) return;

    // FAST PATH: renderer still under bus scene → FloorRenderBus.clear() has not evicted children.
    if (this._batchRenderer.parent === scene) return;

    // Re-add BatchedRenderer if it was removed from the scene.
    if (!this._batchRenderer.parent) {
      scene.add(this._batchRenderer);
    }

    // Re-add every particle emitter if it was removed from the scene.
    const wp = this._weatherParticles;
    if (!wp) return;

    const reattach = (sys) => {
      if (sys?.emitter && !sys.emitter.parent) {
        scene.add(sys.emitter);
      }
    };

    reattach(wp.rainSystem);
    reattach(wp.roofDripSystem);
    reattach(wp.snowSystem);
    reattach(wp.ashSystem);
    reattach(wp.ashEmberSystem);
    reattach(wp.splashSystem);
    if (wp.splashSystems) {
      for (const s of wp.splashSystems) reattach(s);
    }
    if (wp._waterHitSplashSystems) {
      for (const entry of wp._waterHitSplashSystems) reattach(entry?.system);
    }
    // Foam/splash particles are now owned by WaterSplashesEffectV2 — no reattach needed.
  }

  _ensureWeatherSystemsRegistered() {
    const wp = this._weatherParticles;
    const br = this._batchRenderer;
    if (!wp || !br) return;

    // FAST PATH: batch index already has expected core systems → skip scans.
    if (br.systemToBatchIndex?.size >= 5) return;

    // Core precipitation systems
    this._ensureSystemRegistered(wp.rainSystem, 'rain');
    this._ensureSystemRegistered(wp.roofDripSystem, 'roofDrip');
    this._ensureSystemRegistered(wp.snowSystem, 'snow');
    this._ensureSystemRegistered(wp.ashSystem, 'ash');
    this._ensureSystemRegistered(wp.ashEmberSystem, 'ashEmber');

    // Splash variants
    this._ensureSystemRegistered(wp.splashSystem, 'splash');
    if (wp.splashSystems && wp.splashSystems.length) {
      let i = 0;
      for (const s of wp.splashSystems) this._ensureSystemRegistered(s, `splash[${i++}]`);
    }
    if (wp._waterHitSplashSystems && wp._waterHitSplashSystems.length) {
      let i = 0;
      for (const entry of wp._waterHitSplashSystems) this._ensureSystemRegistered(entry?.system, `waterHitSplash[${i++}]`);
    }

    // Water foam/splash particles are now handled by WaterSplashesEffectV2.
    // No need to register foam systems here.
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
    // Layer 0 + FLOOR_EFFECTS role: main bus pass draws weather under overhead
    // tiles / TreeEffectV2 (see LayerOrderPolicy + FloorRenderBus.renderTo).
    this._batchRenderer = new BatchedRenderer();
    try {
      if (this._batchRenderer.layers?.set) {
        this._batchRenderer.layers.set(0);
      }
    } catch (_) {}
    this._refreshWeatherBatchRenderOrder();
    busScene.add(this._batchRenderer);

    // Instantiate the V1 WeatherParticles system, pointed at our bus scene.
    this._weatherParticles = new WeatherParticles(this._batchRenderer, busScene);

    // Reusable culling objects (avoid per-frame allocations).
    this._cullFrustum           = new THREE.Frustum();
    this._cullProjScreenMatrix  = new THREE.Matrix4();
    this._cullSphere            = new THREE.Sphere();
    this._cullCenter            = new THREE.Vector3();

    this._initialized = true;
    this._refreshSceneBoundsFromCanvas();
    this._syncWindowDebugBridge();
    log.info('WeatherParticlesV2 initialized (V1 WeatherParticles bridge active)');
  }

  /**
   * Refresh `this._sceneBounds` from Foundry `canvas.dimensions` (call on init + resize).
   * @private
   */
  _refreshSceneBoundsFromCanvas() {
    const THREE = window.THREE;
    const d = typeof canvas !== 'undefined' ? canvas?.dimensions : null;
    if (!THREE || !d) return;
    const rect = d.sceneRect;
    const sx = rect?.x ?? d.sceneX ?? 0;
    const sy = rect?.y ?? d.sceneY ?? 0;
    const sw = rect?.width ?? d.sceneWidth ?? d.width ?? 1000;
    const sh = rect?.height ?? d.sceneHeight ?? d.height ?? 1000;
    const worldH = d.height ?? (sy + sh);
    const syWorld = worldH - (sy + sh);
    if (!this._sceneBounds) this._sceneBounds = new THREE.Vector4(sx, syWorld, sw, sh);
    else this._sceneBounds.set(sx, syWorld, sw, sh);
  }

  /**
   * Expose globals for legacy bridges / console probes; only writes when values or stamp change.
   * @private
   */
  _syncWindowDebugBridge() {
    const ms = window.MapShine;
    if (ms && ms._wpV2Stamp !== WP_V2_STAMP) {
      ms._wpV2Stamp = WP_V2_STAMP;
    }

    const wp = this._weatherParticles;
    const br = this._batchRenderer;

    if (ms && (ms.weatherParticlesV2 !== this || ms.weatherParticles !== wp)) {
      try {
        ms.weatherParticlesV2 = this;
        ms.weatherParticles = wp;
      } catch (_) {}
    }

    if (window.MapShineParticles?.weatherParticles !== wp
      || window.MapShineParticles?.batchRenderer !== br) {
      window.MapShineParticles = window.MapShineParticles || {};
      window.MapShineParticles.weatherParticles = wp;
      window.MapShineParticles.batchRenderer = br;
    }
  }

  // ── Per-frame update ────────────────────────────────────────────────────────

  /**
   * Update weather simulation + particle tick. Called by FloorCompositor.
   * @param {{ elapsed: number, delta: number }} timeInfo
   */
  update(timeInfo) {
    if (!this._initialized || !this.enabled) return;

    const deltaSec = typeof timeInfo?.motionDelta === 'number'
      ? timeInfo.motionDelta
      : (typeof timeInfo?.delta === 'number' ? timeInfo.delta : 0.016);

    // Re-attach BatchedRenderer and emitters if FloorRenderBus.clear() evicted them.
    // This is the ROOT CAUSE fix: clear() wipes all bus scene children (including
    // the BatchedRenderer and every particle emitter) on every populate() call.
    // Without this guard the systems emit but are never rendered (no scene parent).
    this._ensureSceneAttachment();

    this._syncWindowDebugBridge();

    // Always ensure systems are registered before any other logic that might
    // throw/early-exit. If systems aren't in systemToBatchIndex, Quarks will
    // never simulate or render them.
    this._ensureWeatherSystemsRegistered();
    const dbg = window.MapShine?.debugWeatherFoamLogs === true;
    if (dbg && !this._msLoggedRegistrationOnce) {
      this._msLoggedRegistrationOnce = true;
      const br = this._batchRenderer;
      const wp = this._weatherParticles;
      const hasFoam = !!(br && wp && br.systemToBatchIndex?.has?.(wp._foamSystem));
      const hasRain = !!(br && wp && br.systemToBatchIndex?.has?.(wp.rainSystem));
      log.info('[WeatherParticlesV2] registration probe', {
        mapSize: br?.systemToBatchIndex?.size ?? null,
        batches: br?.batches?.length ?? null,
        hasFoam,
        hasRain
      });
    }

    // ── 1. Advance WeatherController state ──────────────────────────────
    // WeatherController has its own sub-rate throttle (15 Hz), so calling
    // update() every frame is fine — it internally skips when not due.
    // Match FireEffectV2: ensure the controller is initialized before update().
    // In V2 mode there is no guarantee some other effect initialized it first.
    if (weatherController?.initialized !== true && typeof weatherController?.initialize === 'function') {
      void weatherController.initialize();
    }
    if (typeof weatherController?.update === 'function') {
      weatherController.update(timeInfo);
    }

    // ── 2. Scene-bounds Vector4 for rain/snow clipping (refreshed on resize / init)
    const boundsVec4 = this._sceneBounds;

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

        // Frustum cull before Quarks sim (matches V1 ParticleSystem.update order).
        // Ensures emitters are paused/visible before batchRenderer.update so work is
        // not spent on systems already marked off-screen this frame.
        this._applyCulling();

        // Advance the BatchedRenderer (quarks core simulation step).
        this._batchRenderer?.update(dt);
      } catch (e) {
        log.warn('WeatherParticlesV2.update: particle tick error', e);
      }
    }
  }

  // ── Floor change ────────────────────────────────────────────────────────────

  /**
   * Called when the active floor changes. No per-floor isolation needed for
   * weather (it's global), but WeatherController.elevationWeatherSuppressed
   * handles suppression below covered ceilings via TileManager.
   */
  onFloorChange(_maxFloorIndex) {
    try { this._refreshWeatherBatchRenderOrder(); } catch (_) {}
    try { this._weatherParticles?.markRoofDripPoolStale?.('floor-change'); } catch (_) {}
  }

  /**
   * @private
   */
  _refreshWeatherBatchRenderOrder() {
    if (!this._batchRenderer) return;
    const fs = window.MapShine?.floorStack;
    const active = fs?.getActiveFloor?.();
    const fi = Number.isFinite(Number(active?.index)) ? Number(active.index) : 0;
    this._batchRenderer.renderOrder = effectUnderOverheadOrder(fi, 100);
  }

  // ── Resize ──────────────────────────────────────────────────────────────────

  /**
   * Resize handler — refresh cached scene bounds for WeatherParticles.update clipping.
   */
  onResize(w, h) {
    void w;
    void h;
    this._refreshSceneBoundsFromCanvas();
  }

  /**
   * V2 integration accessor for downstream systems that need weather particle internals.
   * @returns {WeatherParticles|null}
   */
  getWeatherParticles() {
    return this._weatherParticles;
  }

  /**
   * Clear cached water/foam mask data after tile/water mask edits.
   */
  clearWaterCaches() {
    try { this._weatherParticles?.clearWaterCaches?.(); } catch (_) {}
    try { this._weatherParticles?.markRoofDripPoolStale?.('cache-clear'); } catch (_) {}
  }

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
    try {
      if (window.MapShine) {
        window.MapShine.weatherParticles = null;
        window.MapShine.weatherParticlesV2 = null;
      }
    } catch (_) {}

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

      // Default: layer 0 so precipitation renders in FloorRenderBus.renderTo (under
      // overhead + trees). Foam plume sets msOverlayLayer=true to stay on layer 31.
      try {
        const idx = systemMap.get(ps);
        const batch = (idx !== undefined && batches) ? batches[idx] : null;
        const layer = (ud.msOverlayLayer === true) ? OVERLAY_THREE_LAYER : 0;
        if (batch?.layers?.set) {
          batch.layers.set(layer);
          // FloorCompositor._renderLateWorldOverlay only scanned top-level scene children for
          // layer 31; quarks SpriteBatches live under BatchedRenderer, so without this the late
          // pass could be skipped forever (roof drips + foam would never draw).
          if (layer === OVERLAY_THREE_LAYER) {
            const fc = window.MapShine?.floorCompositorV2 ?? window.MapShine?.effectComposer?._floorCompositorV2;
            if (fc) fc._hasOverlayLayerContent = true;
          }
        }
      } catch (_) {}

      // Allow specific systems (e.g. full-scene foam overlays) to opt out of
      // frustum-based pause/play culling while still being layer-forced above.
      if (ud.msAutoCull === false) return;

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

      let radius = ud._msCachedShapeRadius;
      if (radius === undefined) {
        radius = 500;
        const shape = ps.emitterShape;
        if (shape && typeof shape.width === 'number' && typeof shape.height === 'number') {
          const w = Math.max(0, shape.width);
          const h = Math.max(0, shape.height);
          radius = 0.5 * Math.sqrt(w * w + h * h);
        }
        ud._msCachedShapeRadius = radius;
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
