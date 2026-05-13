import { EffectBase, RenderLayers } from '../effects/EffectComposer.js';
import { OVERLAY_THREE_LAYER } from '../core/render-layers.js';
import { createLogger } from '../core/log.js';
import { weatherController } from '../core/WeatherController.js';
import { BatchedRenderer } from '../libs/three.quarks.module.js';
import { WeatherParticles } from './WeatherParticles.js';

const log = createLogger('ParticleSystem');

// TEMPORARY GLOBAL KILL-SWITCH:
// When true, completely disables all Quarks-based particle systems (weather, fire, splashes)
// so we can profile map pan/zoom performance without any particle overhead.
// Currently FALSE - particles are re-enabled after vision/fog optimization.
const DISABLE_ALL_PARTICLES = false;

/**
 * GPU-resident particle system effect (Phase 2)
 * Designed for renderer backends that support compute-style simulation and TSL NodeMaterial.
 * Now integrating three.quarks for Phase 3 migration.
 */
export class ParticleSystem extends EffectBase {
  constructor(capacity = 60000) {
    // Temporarily use 'low' tier so the particle system always registers,
    // even on GPUs where advanced compute features are limited.
    super('particles', RenderLayers.PARTICLES, 'low');

    // ParticleSystem manages the shared BatchedRenderer and WeatherParticles
    // simulation. Running per-floor would advance all particle lifetimes and
    // weather emission N times per frame on multi-floor scenes. The BatchedRenderer
    // already forces all quarks batches onto OVERLAY_THREE_LAYER so they render
    // once via _renderOverlayToScreen() regardless of floor count.
    this.floorScope = 'global';

    this.priority = 0;
    this.alwaysRender = false;

    /** @type {BatchedRenderer|null} three.quarks renderer */
    this.batchRenderer = null;
    
    /** @type {WeatherParticles|null} */
    this.weatherParticles = null;

    /** Renderer / scene references */
    this.weatherEmitterId = null;

    /** Renderer / scene references */
    this.renderer = null;
    this.scene = null;
    this.camera = null;

    /** @type {THREE.Points|null} */
    // this.particles = null; // Removed legacy particles

    /** @type {Object} */
    // this.uniforms = ... // Removed legacy uniforms

    this._cullFrustum = null;
    this._cullProjScreenMatrix = null;
    this._cullSphere = null;
    this._cullCenter = null;

    // Cache target mask to avoid bitwise shift every frame
    this._targetLayerMask = 1 << OVERLAY_THREE_LAYER;
  }

  /**
   * Initialize effect (called once on registration)
   * @param {THREE.Renderer} renderer
   * @param {THREE.Scene} scene
   * @param {THREE.Camera} camera
   */
  initialize(renderer, scene, camera) {
    log.info('ParticleSystem.initialize called');

    if (DISABLE_ALL_PARTICLES) {
      log.warn('ParticleSystem disabled by DISABLE_ALL_PARTICLES flag (perf testing).');
      this.enabled = false;
      return;
    }
    this.renderer = renderer;
    this.scene = scene;
    this.camera = camera;

    const THREE = window.THREE;
    if (!THREE) {
      log.error('three.js not available; ParticleSystem not initialized');
      this.enabled = false;
      return;
    }

    try {
      // 1. Initialize three.quarks BatchedRenderer
      this.batchRenderer = new BatchedRenderer();
      // LAYERING CONTRACT:
      // - All quarks SpriteBatches created from this renderer share its
      //   Object3D.renderOrder.
      // - Overhead tiles use renderOrder=10 and depthWrite=false so they do
      //   not dominate the depth buffer.
      // - WeatherParticles configures individual ParticleSystems with
      //   renderOrder=50 and MeshBasicMaterials that have depthWrite=false
      //   and depthTest=false.
      // - With this.batchRenderer.renderOrder=50, the resulting SpriteBatches
      //   render after tiles and, because they ignore depth, appear as an
      //   overlay above overhead geometry.
      this.batchRenderer.renderOrder = 50;
      try {
        if (this.batchRenderer.layers && typeof this.batchRenderer.layers.enable === 'function') {
          this.batchRenderer.layers.enable(OVERLAY_THREE_LAYER);
        }
      } catch (_) {
      }
      this.scene.add(this.batchRenderer);
      log.info('Initialized three.quarks BatchedRenderer');

      // 2. Initialize Weather Particles (Rain/Snow)
      this.weatherParticles = new WeatherParticles(this.batchRenderer, this.scene);

      log.info('ParticleSystem initialized (Quarks: Weather support)');

      // Expose for debugging
      window.MapShineParticles = this;
      log.info('Debug: ParticleSystem exposed as window.MapShineParticles');

    } catch (e) {
      log.error('Failed to initialize ParticleSystem:', e);
      this.enabled = false;
    }
  }

  /**
   * Attach an emitter manager (Deprecated/Removed)
   * @param {any} manager
   */
  setEmitterManager(manager) {
    // No-op or warn
    log.warn('setEmitterManager is deprecated.');
  }

  /**
   * Update per frame
   * @param {TimeInfo} timeInfo
   */
  update(timeInfo) {
    if (DISABLE_ALL_PARTICLES) return;
    if (!this.enabled) return;
    // 0. Step WeatherController so currentState reflects UI-driven targetState
    if (weatherController) {
      // Initialize once (no-op on subsequent calls)
      if (!weatherController.initialized && typeof weatherController.initialize === 'function') {
        void weatherController.initialize();
      }

      if (typeof weatherController.update === 'function') {
        weatherController.update(timeInfo);
      }
    }

    // 1. Compute scene bounds vector for rain/snow clipping and masking
    let boundsVec4 = null;
    if (typeof canvas !== 'undefined' && canvas.dimensions) {
      const d = canvas.dimensions;
      const rect = d.sceneRect;
      const sx = rect?.x ?? d.sceneX ?? 0;
      const sy = rect?.y ?? d.sceneY ?? 0;
      const sw = rect?.width ?? d.sceneWidth ?? d.width ?? 1000;
      const sh = rect?.height ?? d.sceneHeight ?? d.height ?? 1000;
      const worldH = d.height ?? (sy + sh);
      // Convert Foundry Y-down scene rect into Three.js Y-up bounds.
      // We want uSceneBounds.y to be the *minY in world space*.
      const syWorld = worldH - (sy + sh);
      const THREE = window.THREE;
      if (THREE) {
        if (!this._sceneBounds) {
          this._sceneBounds = new THREE.Vector4(sx, syWorld, sw, sh);
        } else if (
          this._sceneBounds.x !== sx ||
          this._sceneBounds.y !== syWorld ||
          this._sceneBounds.z !== sw ||
          this._sceneBounds.w !== sh
        ) {
          // OPTIMIZATION: Only update vector if changed to prevent reactivity checks
          this._sceneBounds.set(sx, syWorld, sw, sh);
        }
        boundsVec4 = this._sceneBounds;
      }
    }

    // 5. Update Quarks Renderer
    if (this.batchRenderer) {
      // timeInfo.delta is in SECONDS (from TimeManager), not milliseconds.
      // We apply a simulation speed multiplier to control particle animation rate.
      const deltaSec = typeof timeInfo.delta === 'number' ? timeInfo.delta : 0.016;
      
      // CRITICAL: Clamp delta to prevent runaway particle spawning after frame stalls.
      // Without this clamp, a 1-second stall would try to spawn 1 second worth of
      // particles in a single frame, causing a feedback loop where:
      //   large delta → spawn many particles → frame takes longer → larger delta → freeze
      // We cap at 100ms (0.1s) of simulation per frame to break this cycle.
      const clampedDelta = deltaSec > 0.1 ? 0.1 : deltaSec; // Faster Math.min
      
      // Global simulation speed control for Quarks-based systems (weather, fire, etc.).
      // A value of 2.0 with baseScale 750 reproduces the previous 1500x multiplier.
      const simSpeed = (weatherController && typeof weatherController.simulationSpeed === 'number')
        ? weatherController.simulationSpeed
        : 2.0;
      const baseScale = 750;
      // NOTE: The * 0.001 factor was historically used because the code assumed
      // delta was in milliseconds. Since TimeManager provides seconds, this
      // effectively scales simulation time by 0.001 * 750 * 2 = 1.5x real-time.
      // We preserve this for backwards compatibility with tuned particle parameters.
      const dt = clampedDelta * 0.75 * simSpeed; // Combined constants (0.001 * 750)

      const ms = window.MapShine;
      const doTimings = ms?.debugQuarksTimings === true;
      let tStart = 0;
      let tAfterWeather = 0;
      let tAfterCull = 0;
      if (doTimings) tStart = performance.now();

      // Update weather systems (pass dt and scene bounds if available)
      if (this.weatherParticles) {
        this.weatherParticles.update(dt, boundsVec4);
      }

      if (doTimings) tAfterWeather = performance.now();

      this._applyQuarksCulling();

      if (doTimings) tAfterCull = performance.now();

      this.batchRenderer.update(dt); // Quarks expects seconds

      if (doTimings) {
        const tEnd = performance.now();
        const wpMs = tAfterWeather - tStart;
        const cullMs = tAfterCull - tAfterWeather;
        const quarksMs = tEnd - tAfterCull;

        const acc = this._msPerfAcc || (this._msPerfAcc = { frames: 0, wpMs: 0, cullMs: 0, quarksMs: 0, lastLogFrame: 0 });
        acc.frames++;
        acc.wpMs += wpMs;
        acc.cullMs += cullMs;
        acc.quarksMs += quarksMs;

        const logEvery = Number.isFinite(ms?.debugQuarksTimingsEvery) ? Math.max(1, Math.floor(ms.debugQuarksTimingsEvery)) : 60;
        if (acc.frames - acc.lastLogFrame >= logEvery) {
          const denom = Math.max(1, acc.frames - acc.lastLogFrame);
          const avgWp = acc.wpMs / denom;
          const avgCull = acc.cullMs / denom;
          const avgQuarks = acc.quarksMs / denom;

          acc.wpMs = 0;
          acc.cullMs = 0;
          acc.quarksMs = 0;
          acc.lastLogFrame = acc.frames;

          const wp = this.weatherParticles;
          const rainE = wp?.rainSystem?.emissionOverTime?.value;
          const snowE = wp?.snowSystem?.emissionOverTime?.value;

          const payload = {
            avgMs: {
              weatherParticlesUpdate: Number(avgWp.toFixed(3)),
              quarksCulling: Number(avgCull.toFixed(3)),
              batchRendererUpdate: Number(avgQuarks.toFixed(3))
            },
            dt,
            emission: {
              rain: Number.isFinite(rainE) ? Math.round(rainE) : null,
              snow: Number.isFinite(snowE) ? Math.round(snowE) : null
            },
            batches: this.batchRenderer?.batches?.length ?? null
          };

          log.info('[Perf][Quarks]', payload);
          try {
            console.log('[Perf][Quarks]', payload);
          } catch (_) {
          }
        }
      }
    }
  }

  _applyQuarksCulling() {
    const THREE = window.THREE;
    if (!THREE) return;
    const sceneComposer = window.MapShine?.sceneComposer;
    const camera = sceneComposer?.camera || this.camera;
    if (!camera) return;
    const systemMap = this.batchRenderer?.systemToBatchIndex;
    if (!systemMap) return;
    const batches = this.batchRenderer?.batches;

    if (!this._cullFrustum) this._cullFrustum = new THREE.Frustum();
    if (!this._cullProjScreenMatrix) this._cullProjScreenMatrix = new THREE.Matrix4();
    if (!this._cullSphere) this._cullSphere = new THREE.Sphere();
    if (!this._cullCenter) this._cullCenter = new THREE.Vector3();

    // OPTIMIZATION: Never force updateProjectionMatrix here. It causes severe GPU/CPU stalls.
    camera.updateMatrixWorld(false);
    this._cullProjScreenMatrix.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this._cullFrustum.setFromProjectionMatrix(this._cullProjScreenMatrix);
    const groundZ = (sceneComposer && typeof sceneComposer.groundZ === 'number') ? sceneComposer.groundZ : null;

    // OPTIMIZATION: Avoid closure allocations (no .forEach)
    for (const [ps, idx] of systemMap.entries()) {
      const emitter = ps?.emitter;
      if (!emitter) continue;

      const ud = emitter.userData || (emitter.userData = {});
      if (ud.msAutoCull === false) continue;

      // OPTIMIZATION: Guard layer set to avoid dirtying Three.js object masks
      if (batches) {
        const batch = batches[idx];
        if (batch?.layers && batch.layers.mask !== this._targetLayerMask) {
          batch.layers.set(OVERLAY_THREE_LAYER);
        }
      }

      const pos = emitter.position;
      const c = ud.msCullCenter;

      // OPTIMIZATION: Duck-typing beats typeof operators
      if (c) {
        if (c.x !== undefined) {
          this._cullCenter.set(c.x, c.y, c.z);
        } else if (c[0] !== undefined) {
          this._cullCenter.set(c[0], c[1], c[2]);
        } else {
          this._cullCenter.copy(pos);
        }
      } else {
        this._cullCenter.copy(pos);
      }

      let radius = 500;
      const shape = ps.emitterShape;

      if (shape && shape.width !== undefined && shape.height !== undefined) {
        const w = shape.width > 0 ? shape.width : 0;
        const h = shape.height > 0 ? shape.height : 0;
        radius = 0.5 * Math.sqrt(w * w + h * h);
      }

      if (groundZ !== null) {
        const dz = this._cullCenter.z - groundZ;
        radius += (dz > 0 ? dz : -dz) * 0.5;
      }

      if (ud.msCullRadius > 0) {
        radius = ud.msCullRadius;
      }

      this._cullSphere.center.copy(this._cullCenter);
      this._cullSphere.radius = radius;

      const visible = this._cullFrustum.intersectsSphere(this._cullSphere);
      ud._msLastCullVisible = visible;
      ud._msLastCullRadius = radius;
      // PERF: Avoid per-frame allocations in culling.
      // This is called once per Quarks system per frame; allocating an object here
      // creates steady GC pressure when many systems exist.
      let lastCenter = ud._msLastCullCenter;
      if (!lastCenter || typeof lastCenter !== 'object') {
        lastCenter = { x: 0, y: 0, z: 0 };
        ud._msLastCullCenter = lastCenter;
      }
      lastCenter.x = this._cullCenter.x;
      lastCenter.y = this._cullCenter.y;
      lastCenter.z = this._cullCenter.z;

      const wasCulled = !!ud._msCulled;

      // OPTIMIZATION: Guard visibility updates
      if (emitter.visible !== visible) {
        emitter.visible = visible;
      }

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
    }
  }

  /**
   * Render pass (standard render handles the scene)
   */
  render(renderer, scene, camera) {
    // No manual render needed; particles are in the scene graph
  }

  /**
   * Cleanup
   */
  dispose() {
    if (this.weatherParticles) {
      this.weatherParticles.dispose();
      this.weatherParticles = null;
    }
    
    if (this.batchRenderer) {
      this.scene.remove(this.batchRenderer);
      // batchRenderer doesn't strictly need dispose() but it helps if implemented
      this.batchRenderer = null;
    }

    log.info('ParticleSystem disposed');
  }
}
