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
import { tagQuarkSystem } from '../../core/quark-diagnostics.js';
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

// Grace window for stragglers after weather goes fully idle (precip/ash/emission 0).
// Live particles get this long to die naturally; anything still alive after the
// grace (typically frozen particles on frustum-culled/paused systems) is
// force-cleared so `weather:live-particles` cannot hold continuous presentation forever.
const IDLE_PARTICLE_DRAIN_GRACE_MS = 4000;

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

    /** Timestamp (ms) when weather went idle with live particles remaining; 0 = not draining */
    this._idleDrainStartMs = 0;

    /** One-time debug guard for registration failures */
    this._msLoggedRegistrationFailureOnce = false;

    /** @type {import('../../core/diagnostics/PerformanceRecorder.js').PerformanceRecorder|null} */
    this._activePerfRecorder = null;
  }

  _ensureSystemRegistered(sys, label = '') {
    if (!sys || !this._batchRenderer) return;
    if (label) tagQuarkSystem(sys, 'weather', label);
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

  // ── Performance Recorder ───────────────────────────────────────────────────

  /** @private */
  _bindPerfRecorder() {
    try {
      const recorder = window.MapShine?.performanceRecorder;
      this._activePerfRecorder = recorder?.enabled ? recorder : null;
    } catch (_) {
      this._activePerfRecorder = null;
    }
  }

  /**
   * @param {string} name
   * @param {'update'|'render'} [phase]
   * @param {{ cpuOnly?: boolean, gpuSlot?: { index: number, count: number } }} [options]
   * @private
   */
  _beginPerfSpan(name, phase = 'update', options = { cpuOnly: true }) {
    try {
      const recorder = this._activePerfRecorder;
      if (!recorder?.enabled || typeof recorder.beginEffectCall !== 'function') return null;
      return recorder.beginEffectCall(`weatherParticles.${phase}.${name}`, phase, options);
    } catch (_) {
      return null;
    }
  }

  /** @param {object|null} token @private */
  _endPerfSpan(token) {
    if (!token) return;
    try {
      const recorder = this._activePerfRecorder ?? window.MapShine?.performanceRecorder;
      recorder?.endEffectCall?.(token);
    } catch (_) {}
  }

  /**
   * Live weather particle stats for Performance Recorder exports.
   * @returns {object}
   */
  getPerformanceSnapshot() {
    const wp = this._weatherParticles;
    const br = this._batchRenderer;
    const state = (typeof weatherController?.getCurrentState === 'function')
      ? weatherController.getCurrentState()
      : weatherController?.currentState;
    const target = weatherController?.targetState;

    /** @type {Record<string, { emission: number, visible: boolean, culled: boolean, overlayLayer: boolean }>} */
    const systems = {};
    const track = (key, sys) => {
      if (!sys) return;
      const emitter = sys.emitter;
      const ud = emitter?.userData ?? {};
      systems[key] = {
        emission: Number(sys.emissionOverTime?.value) || 0,
        visible: emitter?.visible !== false,
        culled: ud._msCulled === true,
        overlayLayer: ud.msOverlayLayer === true,
      };
    };
    if (wp) {
      track('rain', wp.rainSystem);
      track('roofDrip', wp.roofDripSystem);
      track('snow', wp.snowSystem);
      track('ash', wp.ashSystem);
      track('ashEmber', wp.ashEmberSystem);
      track('splash', wp.splashSystem);
    }

    let culledCount = 0;
    let activeEmission = 0;
    for (const row of Object.values(systems)) {
      if (row.culled) culledCount += 1;
      activeEmission += row.emission;
    }

    return {
      enabled: this.enabled === true,
      initialized: this._initialized === true,
      weatherControllerEnabled: weatherController?.enabled !== false,
      elevationWeatherSuppressed: weatherController?.elevationWeatherSuppressed === true,
      wantsContinuousRender: this.wantsContinuousRender?.() === true,
      continuousReason: this.getContinuousRenderReason?.() ?? null,
      idleDrainArmed: this._idleDrainStartMs > 0,
      precipitation: Math.max(Number(state?.precipitation) || 0, Number(target?.precipitation) || 0),
      ashIntensity: Math.max(Number(state?.ashIntensity) || 0, Number(target?.ashIntensity) || 0),
      simulationSpeed: Number(weatherController?.simulationSpeed) || 2,
      batchSystems: br?.systemToBatchIndex?.size ?? 0,
      batchCount: br?.batches?.length ?? 0,
      culledSystems: culledCount,
      activeEmissionTotal: activeEmission,
      systems,
    };
  }

  // ── Per-frame update ────────────────────────────────────────────────────────

  /**
   * Update weather simulation + particle tick. Called by FloorCompositor.
   * @param {{ elapsed: number, delta: number }} timeInfo
   */
  update(timeInfo) {
    if (!this._initialized || !this.enabled) return;

    this._bindPerfRecorder();

    const deltaSec = typeof timeInfo?.motionDelta === 'number'
      ? timeInfo.motionDelta
      : (typeof timeInfo?.delta === 'number' ? timeInfo.delta : 0.016);

    let token = this._beginPerfSpan('attach');
    try {
      // Re-attach BatchedRenderer and emitters if FloorRenderBus.clear() evicted them.
      this._ensureSceneAttachment();
      this._syncWindowDebugBridge();
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
    } finally {
      this._endPerfSpan(token);
    }

    this._updateIdleParticleDrain();

    const particleTickNeeded = this._needsParticleSimulationTick();

    token = this._beginPerfSpan('controller');
    try {
      if (weatherController?.initialized !== true && typeof weatherController?.initialize === 'function') {
        void weatherController.initialize();
      }
      if (typeof weatherController?.update === 'function') {
        const wcHz = Number(weatherController?.updateHz);
        const wcStep = Number.isFinite(wcHz) && wcHz > 0 ? (1 / wcHz) : 0;
        this._wcAccum += deltaSec;
        const runController = particleTickNeeded
          || wcStep <= 0
          || this._wcAccum >= wcStep;
        if (runController) {
          if (wcStep > 0) this._wcAccum %= wcStep;
          weatherController.update(timeInfo);
        }
      }
    } finally {
      this._endPerfSpan(token);
    }

    if (!particleTickNeeded || !this._weatherParticles) return;

    const boundsVec4 = this._sceneBounds;

    try {
      const clampedDelta = Math.min(deltaSec, 0.1);
      const simSpeed = (typeof weatherController?.simulationSpeed === 'number')
        ? weatherController.simulationSpeed
        : 2.0;
      const dt = clampedDelta * 0.001 * 750 * simSpeed;

      token = this._beginPerfSpan('particles');
      try {
        this._weatherParticles.update(dt, boundsVec4);
      } finally {
        this._endPerfSpan(token);
      }

      token = this._beginPerfSpan('cull');
      try {
        this._applyCulling();
      } finally {
        this._endPerfSpan(token);
      }

      token = this._beginPerfSpan('quarks');
      try {
        this._batchRenderer?.update(dt);
      } finally {
        this._endPerfSpan(token);
      }
    } catch (e) {
      log.warn('WeatherParticlesV2.update: particle tick error', e);
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
   * Weather Quarks sim + late-overlay draw only run inside FloorCompositor.render().
   * RenderLoop presentation pacing for *weather* only — shared BatchedRenderer
   * consumers (fire, dust, flies) register their own continuous reasons on FloorCompositor.
   * @returns {boolean}
   */
  wantsContinuousRender() {
    return this._weatherNeedsContinuousPresentation();
  }

  /**
   * Granular reason for FloorCompositor continuous-render diagnostics.
   * @returns {string|null}
   */
  getContinuousRenderReason() {
    if (!this._weatherNeedsContinuousPresentation()) return null;
    if (this._hasActivePrecipOrAsh()) return 'weather:precip-or-ash';
    if (this._hasActiveWeatherEmission()) return 'weather:emission-tail';
    if ((this._weatherParticles?._roofDripTailRemainingSec ?? 0) > 0.01) return 'weather:roof-drip-tail';
    if (this._hasLiveWeatherQuarksParticles()) return 'weather:live-particles';
    return 'weather:idle';
  }

  /**
   * True when weather visuals/sim still need full presentation cadence.
   * Does not include external BatchedRenderer consumers — those have their own hooks.
   * @returns {boolean}
   * @private
   */
  _weatherNeedsContinuousPresentation() {
    if (!this._initialized || !this.enabled) return false;
    if (weatherController?.enabled === false) return false;
    if (weatherController?.elevationWeatherSuppressed === true) return false;
    if (this._hasActivePrecipOrAsh()) return true;
    if (this._hasActiveWeatherEmission()) return true;
    if ((this._weatherParticles?._roofDripTailRemainingSec ?? 0) > 0.01) return true;
    return this._hasLiveWeatherQuarksParticles();
  }

  /**
   * @returns {boolean}
   * @private
   */
  _hasActivePrecipOrAsh() {
    const state = (typeof weatherController?.getCurrentState === 'function')
      ? weatherController.getCurrentState()
      : weatherController?.currentState;
    const target = weatherController?.targetState;
    const precip = Math.max(Number(state?.precipitation) || 0, Number(target?.precipitation) || 0);
    const ash = Math.max(Number(state?.ashIntensity) || 0, Number(target?.ashIntensity) || 0);
    return precip > 0.001 || ash > 0.001;
  }

  /**
   * @returns {boolean}
   * @private
   */
  _hasActiveWeatherEmission() {
    const wp = this._weatherParticles;
    const systems = [wp?.rainSystem, wp?.snowSystem, wp?.ashSystem, wp?.ashEmberSystem];
    for (const sys of systems) {
      const e = sys?.emissionOverTime?.value;
      if (typeof e === 'number' && e > 0.5) return true;
    }
    return false;
  }

  /**
   * True when Quarks sim, culling, or roof-drip tail still need per-rAF work.
   * @returns {boolean}
   * @private
   */
  _needsParticleSimulationTick() {
    if (!this._initialized || !this.enabled) return false;
    // Bridge consumers (e.g. SmellyFlies) must keep simulating even when weather is idle/off.
    if (this._hasExternalBatchConsumerWork()) return true;
    if (weatherController?.enabled === false) return false;
    if (weatherController?.elevationWeatherSuppressed === true) return false;
    if (this._hasActivePrecipOrAsh()) return true;
    if (this._hasActiveWeatherEmission()) return true;
    if ((this._weatherParticles?._roofDripTailRemainingSec ?? 0) > 0.01) return true;
    return this._hasLiveWeatherQuarksParticles();
  }

  /**
   * Force-drain stale weather particles once weather has been fully idle for
   * {@link IDLE_PARTICLE_DRAIN_GRACE_MS}. Frustum-culled systems are paused, so
   * their particles never age out — without this, `_hasLiveWeatherQuarksParticles()`
   * keeps `weather:live-particles` continuous presentation locked indefinitely.
   * @private
   */
  _updateIdleParticleDrain() {
    const weatherActive = this._hasActivePrecipOrAsh()
      || this._hasActiveWeatherEmission()
      || (this._weatherParticles?._roofDripTailRemainingSec ?? 0) > 0.01;
    if (weatherActive || !this._hasLiveWeatherQuarksParticles()) {
      this._idleDrainStartMs = 0;
      return;
    }

    const now = (typeof performance !== 'undefined' && typeof performance.now === 'function')
      ? performance.now()
      : Date.now();
    if (this._idleDrainStartMs === 0) {
      this._idleDrainStartMs = now;
      return;
    }
    if (now - this._idleDrainStartMs < IDLE_PARTICLE_DRAIN_GRACE_MS) return;

    const wp = this._weatherParticles;
    let cleared = 0;
    for (const sys of this._getWeatherOwnedSystemSet()) {
      if (!sys || !(typeof sys.particleNum === 'number' && sys.particleNum > 0)) continue;
      try {
        if (typeof wp?._clearParticleSystemLive === 'function') {
          wp._clearParticleSystemLive(sys);
        } else {
          if (sys.particles && typeof sys.particles.length === 'number') sys.particles.length = 0;
          sys.particleNum = 0;
        }
        cleared += 1;
      } catch (_) {}
    }
    this._idleDrainStartMs = 0;
    if (cleared > 0) {
      log.debug(`Idle particle drain: cleared ${cleared} stale weather system(s) after `
        + `${Math.round(IDLE_PARTICLE_DRAIN_GRACE_MS / 1000)}s idle grace`);
    }
  }

  /**
   * Systems owned by WeatherParticles — excluded from external-consumer scans.
   * @returns {Set<object>}
   * @private
   */
  _getWeatherOwnedSystemSet() {
    const wp = this._weatherParticles;
    if (!wp) return new Set();
    const systems = [
      wp.rainSystem,
      wp.snowSystem,
      wp.ashSystem,
      wp.ashEmberSystem,
      wp.roofDripSystem,
      wp.splashSystem,
      wp._foamSystem,
      wp._rainImpactSplashSystem,
      ...(wp.splashSystems ?? []),
      ...(wp._waterHitSplashSystems?.map((entry) => entry?.system) ?? []),
    ];
    return new Set(systems.filter(Boolean));
  }

  /**
   * True when non-weather systems on the shared BatchedRenderer still need sim.
   * @returns {boolean}
   * @private
   */
  _hasExternalBatchConsumerWork() {
    const map = this._batchRenderer?.systemToBatchIndex;
    if (!map || typeof map.entries !== 'function') return false;

    const owned = this._getWeatherOwnedSystemSet();
    for (const [sys] of map.entries()) {
      if (!sys || owned.has(sys)) continue;
      const emission = sys.emissionOverTime?.value;
      if (typeof emission === 'number' && emission > 0) return true;
      const live = sys.particleNum;
      if (typeof live === 'number' && live > 0) return true;
    }
    return false;
  }

  /**
   * Weather-owned Quarks only (excludes fire/dust/flies on the shared batch).
   * @returns {boolean}
   * @private
   */
  _hasLiveWeatherQuarksParticles() {
    const wp = this._weatherParticles;
    if (!wp) return false;
    const systems = [
      wp.rainSystem,
      wp.snowSystem,
      wp.ashSystem,
      wp.ashEmberSystem,
      wp.roofDripSystem,
      wp.splashSystem,
      wp._foamSystem,
      wp._rainImpactSplashSystem,
      ...(wp.splashSystems ?? []),
      ...(wp._waterHitSplashSystems?.map((entry) => entry?.system) ?? []),
    ];
    for (const sys of systems) {
      const n = sys?.particleNum;
      if (typeof n === 'number' && n > 0) return true;
    }
    return false;
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
    if (!systemMap || typeof systemMap.entries !== 'function') return;
    const batches = this._batchRenderer?.batches;

    // Match V1 ParticleSystem._applyQuarksCulling: avoid forcing updateProjectionMatrix
    // every frame (severe CPU/GPU stalls). Camera matrices are synced in the render loop.
    try {
      camera.updateMatrixWorld(false);
      this._cullProjScreenMatrix.multiplyMatrices(
        camera.projectionMatrix,
        camera.matrixWorldInverse
      );
      this._cullFrustum.setFromProjectionMatrix(this._cullProjScreenMatrix);
    } catch (_) { return; }

    const groundZ = window.MapShine?.sceneComposer?.groundZ ?? null;

    for (const [ps, idx] of systemMap.entries()) {
      if (!ps || !ps.emitter) continue;
      const emitter = ps.emitter;
      const ud = emitter.userData || (emitter.userData = {});

      // Default: layer 0 so precipitation renders in FloorRenderBus.renderTo (under
      // overhead + trees). Foam plume sets msOverlayLayer=true to stay on layer 31.
      try {
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
      if (ud.msAutoCull === false) continue;

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
      } else if (!wasCulled) {
        if (typeof ps.pause === 'function') ps.pause();
        ud._msCulled = true;
      }
    }
  }
}
