/**
 * @fileoverview V2 Fire Sparks Effect — per-floor particle systems from _Fire masks.
 *
 * Architecture:
 *   Owns a three.quarks BatchedRenderer added to the FloorRenderBus scene.
 *   For each tile with a `_Fire` mask, scans the mask on the CPU to build spawn
 *   point lists, then creates fire + ember + smoke particle systems. Systems are
 *   grouped by floor index. Floor isolation is achieved by swapping active
 *   systems in/out of the BatchedRenderer on floor change.
 *
 * V1 → V2 cleanup:
 *   - No EffectMaskRegistry / GpuSceneMaskCompositor (masks loaded per tile)
 *   - No MapPointsManager integration (mask-only fire sources)
 *   - No V1 EffectBase / RenderLayers dependency
 *   - Clean floor isolation via system swapping (no floor-presence gate)
 *   - Behaviors extracted into fire-behaviors.js for reuse
 *
 * @module compositor-v2/effects/FireEffectV2
 */

import { createLogger } from '../../core/log.js';
import { weatherController } from '../../core/WeatherController.js';
import { probeMaskFile } from '../../assets/loader.js';
import { tileHasLevelsRange, readTileLevelsFlags } from '../../foundry/levels-scene-flags.js';
import { SmartWindBehavior } from '../../particles/SmartWindBehavior.js';
import { OVERLAY_THREE_LAYER } from '../../effects/EffectComposer.js';
import {
  FireMaskShape,
  FlameLifecycleBehavior,
  EmberLifecycleBehavior,
  SmokeLifecycleBehavior,
  FireSpinBehavior,
  ParticleTimeScaledBehavior,
  generateFirePoints,
} from './fire-behaviors.js';
import {
  ParticleSystem as QuarksParticleSystem,
  BatchedRenderer,
  IntervalValue,
  ColorRange,
  Vector4,
  RenderMode,
  ApplyForce,
  ConstantValue,
  SizeOverLife,
  PiecewiseBezier,
  Bezier,
  CurlNoiseField,
} from '../../libs/three.quarks.module.js';

const log = createLogger('FireEffectV2');

// Ground Z for the bus scene (matches FloorRenderBus GROUND_Z).
const GROUND_Z = 1000;

// Spatial bucket size for splitting large fire masks into smaller emitters (px).
const BUCKET_SIZE = 2000;

// ─── FireEffectV2 ────────────────────────────────────────────────────────────

export class FireEffectV2 {
  /**
   * @param {import('../FloorRenderBus.js').FloorRenderBus} renderBus
   */
  constructor(renderBus) {
    this._renderBus = renderBus;
    this._enabled = true;
    this._initialized = false;

    /** @type {BatchedRenderer|null} three.quarks batch renderer */
    this._batchRenderer = null;

    /**
     * Per-floor cached system sets. Key: floorIndex.
     * Value: { systems: QuarksParticleSystem[], emberSystems: [], smokeSystems: [] }
     * @type {Map<number, object>}
     */
    this._floorStates = new Map();

    /**
     * Set of floor indices whose systems are currently in the BatchedRenderer.
     * The bus shows all floors <= maxFloorIndex, so fire must do the same.
     * @type {Set<number>}
     */
    this._activeFloors = new Set();

    /** @type {THREE.Texture|null} Fire sprite texture */
    this._fireTexture = null;
    /** @type {THREE.Texture|null} Ember/smoke sprite texture */
    this._emberTexture = null;
    /** @type {Promise<void>|null} Resolves when sprite textures are loaded */
    this._texturesReady = null;

    // Effect parameters — same defaults as V1 for visual parity.
    this.params = {
      enabled: true,
      globalFireRate: 5.2,
      fireHeight: 10.0,
      fireSize: 18.0,
      emberRate: 3.1,
      windInfluence: 4.5,
      fireSizeMin: 19,
      fireSizeMax: 170,
      fireLifeMin: 1.35,
      fireLifeMax: 6,
      fireSpinEnabled: true,
      fireSpinSpeedMin: 0.2,
      fireSpinSpeedMax: 0.7,
      fireTemperature: 0.5,
      emberSizeMin: 5,
      emberSizeMax: 17,
      emberLifeMin: 6.6,
      emberLifeMax: 12,
      fireUpdraft: 0.3,
      emberUpdraft: 3.3,
      fireCurlStrength: 0.7,
      emberCurlStrength: 0.3,
      weatherPrecipKill: 0.5,
      weatherWindKill: 0.5,
      timeScale: 3.0,
      indoorLifeScale: 0.7,
      indoorTimeScale: 0.2,
      flamePeakOpacity: 0.9,
      coreEmission: 0.7,
      emberEmission: 2.0,
      emberPeakOpacity: 0.9,
      smokeEnabled: true,
      smokeRatio: 0.5,
      smokeOpacity: 0.2,
      smokeColorWarmth: 0.59,
      smokeColorBrightness: 0.9,
      smokeDarknessResponse: 0.8,
      smokeSizeMin: 183,
      smokeSizeMax: 400,
      smokeSizeGrowth: 10,
      smokeLifeMin: 7,
      smokeLifeMax: 15,
      smokeUpdraft: 8.8,
      smokeTurbulence: 0.05,
      smokeWindInfluence: 3.1,
      smokeAlphaStart: 0.7,
      smokeAlphaPeak: 0.8,
      smokeAlphaEnd: 1,
    };

    log.debug('FireEffectV2 created');
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  get enabled() { return this._enabled; }
  set enabled(v) {
    this._enabled = !!v;
    if (this.params && Object.prototype.hasOwnProperty.call(this.params, 'enabled')) {
      this.params.enabled = this._enabled;
    }
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  initialize() {
    if (this._initialized) return;
    const THREE = window.THREE;
    if (!THREE) { log.warn('initialize: THREE not available'); return; }

    // Create a dedicated BatchedRenderer for V2 fire particles.
    this._batchRenderer = new BatchedRenderer();
    this._batchRenderer.renderOrder = 50;
    this._batchRenderer.frustumCulled = false;
    try {
      if (this._batchRenderer.layers && typeof this._batchRenderer.layers.enable === 'function') {
        this._batchRenderer.layers.enable(OVERLAY_THREE_LAYER);
      }
    } catch (_) {
    }

    // Start loading sprite textures (populate() will await this).
    this._texturesReady = this._loadTextures();

    this._initialized = true;
    log.info('FireEffectV2 initialized');
  }

  /**
   * Populate fire systems for all tiles with _Fire masks.
   * Groups spawn points by floor index. Call after FloorRenderBus.populate().
   *
   * @param {object} foundrySceneData - Scene geometry data
   */
  async populate(foundrySceneData) {
    if (!this._initialized) { log.warn('populate: not initialized'); return; }
    this.clear();

    // Wait for fire/ember sprite textures to load before creating systems.
    if (this._texturesReady) await this._texturesReady;

    const tileDocs = canvas?.scene?.tiles?.contents ?? [];
    if (tileDocs.length === 0) { log.info('populate: no tiles'); return; }

    const floors = window.MapShine?.floorStack?.getFloors() ?? [];
    const d = canvas?.dimensions;
    if (!d) { log.warn('populate: no canvas dimensions'); return; }

    const sceneWidth = d.sceneWidth || d.width;
    const sceneHeight = d.sceneHeight || d.height;
    // Foundry scene origin (top-left, Y-down) — used for tile UV → scene UV conversion.
    const foundrySceneX = d.sceneX || 0;
    const foundrySceneY = d.sceneY || 0;
    // Three.js scene origin (Y-up) — used by FireMaskShape to position particles.
    const sceneX = foundrySceneX;
    const sceneY = (d.height || sceneHeight) - foundrySceneY - sceneHeight;

    // Collect fire points per floor from all tiles.
    // Key: floorIndex, Value: {points: Float32Array[]}
    const floorFireData = new Map();

    for (const tileDoc of tileDocs) {
      const src = tileDoc?.texture?.src ?? tileDoc?.img ?? '';
      if (!src) continue;

      const tileId = tileDoc.id ?? tileDoc._id;
      if (!tileId) continue;

      const dotIdx = src.lastIndexOf('.');
      const basePath = dotIdx > 0 ? src.substring(0, dotIdx) : src;

      // Probe for _Fire mask.
      const fireResult = await probeMaskFile(basePath, '_Fire');
      if (!fireResult?.path) continue;

      // Load the fire mask image to scan for spawn points.
      const image = await this._loadImage(fireResult.path);
      if (!image) continue;

      const tileLocalPoints = generateFirePoints(image, 0.1);
      if (!tileLocalPoints || tileLocalPoints.length === 0) continue;

      // Convert tile-local UVs → scene-global UVs.
      // generateFirePoints returns (u, v, brightness) in tile image space [0..1].
      // We remap to scene-global UV using the tile's Foundry position and size.
      const tileX = Number(tileDoc.x) || 0;
      const tileY = Number(tileDoc.y) || 0;
      const tileW = Number(tileDoc.width) || 1;
      const tileH = Number(tileDoc.height) || 1;

      const sceneGlobalPoints = new Float32Array(tileLocalPoints.length);
      for (let i = 0; i < tileLocalPoints.length; i += 3) {
        // Tile-local UV → Foundry world pixel → scene-global UV.
        const foundryPx = tileX + tileLocalPoints[i] * tileW;
        const foundryPy = tileY + tileLocalPoints[i + 1] * tileH;
        sceneGlobalPoints[i]     = (foundryPx - foundrySceneX) / sceneWidth;
        sceneGlobalPoints[i + 1] = (foundryPy - foundrySceneY) / sceneHeight;
        sceneGlobalPoints[i + 2] = tileLocalPoints[i + 2]; // brightness unchanged
      }

      // Resolve floor index.
      const floorIndex = this._resolveFloorIndex(tileDoc, floors);
      if (!floorFireData.has(floorIndex)) {
        floorFireData.set(floorIndex, { pointArrays: [] });
      }
      floorFireData.get(floorIndex).pointArrays.push(sceneGlobalPoints);
      log.info(`  tile '${tileId}' → floor ${floorIndex}, ${sceneGlobalPoints.length / 3} fire points (tile ${tileW}x${tileH} at ${tileX},${tileY})`);
    }

    // Build particle systems per floor.
    let totalSystems = 0;
    for (const [floorIndex, { pointArrays }] of floorFireData) {
      // Merge all point arrays for this floor into one.
      const totalLen = pointArrays.reduce((sum, arr) => sum + arr.length, 0);
      const merged = new Float32Array(totalLen);
      let offset = 0;
      for (const arr of pointArrays) {
        merged.set(arr, offset);
        offset += arr.length;
      }

      const state = this._buildFloorSystems(
        merged, sceneWidth, sceneHeight, sceneX, sceneY, floorIndex
      );
      this._floorStates.set(floorIndex, state);
      totalSystems += state.systems.length + state.emberSystems.length + state.smokeSystems.length;
    }

    // Add the BatchedRenderer to the bus scene so it renders in the same pass.
    // We add it directly to the bus's internal scene via the overlay API.
    // The batch renderer is a single mesh — we register it at floor 0 but
    // manage its content (active systems) ourselves on floor change.
    if (this._batchRenderer) {
      this._renderBus.addEffectOverlay('__fire_batch__', this._batchRenderer, 0);
    }

    // Activate the current floor's systems.
    this._activateCurrentFloor();

    log.info(`FireEffectV2 populated: ${floorFireData.size} floor(s), ${totalSystems} system(s), floorStates keys=[${[...this._floorStates.keys()]}]`);
  }

  /**
   * Per-frame update. Steps the BatchedRenderer simulation.
   * @param {{ elapsed: number, delta: number }} timeInfo
   */
  update(timeInfo) {
    if (!this._initialized || !this._batchRenderer || !this._enabled) return;

    // Step WeatherController so weather state is current.
    try {
      if (weatherController && !weatherController.initialized && typeof weatherController.initialize === 'function') {
        void weatherController.initialize();
      }
      if (weatherController && typeof weatherController.update === 'function') {
        weatherController.update(timeInfo);
      }
    } catch (_) {}

    // Compute dt for three.quarks (matches V1 time scaling).
    const deltaSec = typeof timeInfo.delta === 'number' ? timeInfo.delta : 0.016;
    const clampedDelta = Math.min(deltaSec, 0.1);
    const simSpeed = (weatherController && typeof weatherController.simulationSpeed === 'number')
      ? weatherController.simulationSpeed : 2.0;
    const dt = clampedDelta * 0.001 * 750 * simSpeed;

    // Update per-frame emission rates based on params.
    this._updateSystemParams();

    // Step the BatchedRenderer.
    try {
      this._batchRenderer.update(dt);
    } catch (err) {
      log.warn('FireEffectV2: BatchedRenderer.update threw, skipping frame:', err);
    }
  }

  /**
   * Called when the visible floor range changes. Activates all floors up to
   * maxFloorIndex (matching the bus's setVisibleFloors behaviour).
   * @param {number} maxFloorIndex
   */
  onFloorChange(maxFloorIndex) {
    if (!this._initialized) return;

    // Determine which floors should be active.
    const desired = new Set();
    for (const idx of this._floorStates.keys()) {
      if (idx <= maxFloorIndex) desired.add(idx);
    }

    // Deactivate floors that should no longer be visible.
    for (const idx of this._activeFloors) {
      if (!desired.has(idx)) this._deactivateFloor(idx);
    }
    // Activate floors that are newly visible.
    for (const idx of desired) {
      if (!this._activeFloors.has(idx)) this._activateFloor(idx);
    }

    log.info(`onFloorChange(${maxFloorIndex}): desired=[${[...desired]}] prev=[${[...this._activeFloors]}] states=[${[...this._floorStates.keys()]}]`);
    this._activeFloors = desired;
  }

  // ── Cleanup ────────────────────────────────────────────────────────────────

  clear() {
    // Deactivate all active floors.
    for (const idx of this._activeFloors) {
      this._deactivateFloor(idx);
    }
    this._activeFloors.clear();

    // Dispose all floor states.
    for (const [, state] of this._floorStates) {
      this._disposeFloorState(state);
    }
    this._floorStates.clear();

    // Remove batch renderer from bus.
    this._renderBus.removeEffectOverlay('__fire_batch__');
  }

  dispose() {
    this.clear();
    this._fireTexture?.dispose();
    this._emberTexture?.dispose();
    this._fireTexture = null;
    this._emberTexture = null;
    this._batchRenderer = null;
    this._initialized = false;
    log.info('FireEffectV2 disposed');
  }

  // ── Private: System building ───────────────────────────────────────────────

  /**
   * Build fire + ember + smoke systems from merged points for a single floor.
   * Points are spatially bucketed for culling efficiency.
   * @private
   */
  _buildFloorSystems(points, sceneW, sceneH, sceneX, sceneY, floorIndex) {
    const state = { systems: [], emberSystems: [], smokeSystems: [] };
    const totalCount = points.length / 3;
    if (totalCount === 0) return state;

    // Spatial bucketing.
    const buckets = new Map();
    for (let i = 0; i < points.length; i += 3) {
      const u = points[i];
      const v = points[i + 1];
      const b = points[i + 2];
      if (!Number.isFinite(u) || !Number.isFinite(v) || !Number.isFinite(b) || b <= 0) continue;
      const worldX = sceneX + u * sceneW;
      const worldY = sceneY + (1.0 - v) * sceneH;
      const bx = Math.floor(worldX / BUCKET_SIZE);
      const by = Math.floor(worldY / BUCKET_SIZE);
      const key = `${bx},${by}`;
      let arr = buckets.get(key);
      if (!arr) { arr = []; buckets.set(key, arr); }
      arr.push(u, v, b);
    }

    for (const [, arr] of buckets) {
      if (arr.length < 3) continue;
      const bucketPoints = new Float32Array(arr);
      const weight = totalCount > 0 ? (bucketPoints.length / 3 / totalCount) : 1.0;
      // V2 bus layering contract:
      // - Tiles are placed at Z = GROUND_Z + floorIndex
      // - Effects should follow the same scheme to avoid clipping / depth issues.
      // Use a small offset above the floor plane so particles aren't Z-fighting.
      const shape = new FireMaskShape(
        bucketPoints, sceneW, sceneH, sceneX, sceneY,
        this, GROUND_Z + (Number(floorIndex) || 0), 0.55
      );

      // Fire system.
      const fireSys = this._createFireSystem(shape, weight);
      if (fireSys) state.systems.push(fireSys);

      // Ember system.
      const emberSys = this._createEmberSystem(shape, weight);
      if (emberSys) state.emberSystems.push(emberSys);

      // Smoke system.
      if (this.params.smokeEnabled) {
        const smokeSys = this._createSmokeSystem(shape, weight);
        if (smokeSys) state.smokeSystems.push(smokeSys);
      }
    }

    return state;
  }

  /** @private */
  _createFireSystem(shape, weight) {
    const THREE = window.THREE;
    if (!THREE) return null;

    const material = new THREE.MeshBasicMaterial({
      map: this._fireTexture,
      transparent: true,
      depthWrite: false,
      depthTest: false,
      blending: THREE.AdditiveBlending,
      color: 0xffffff,
      side: THREE.DoubleSide,
    });
    material.toneMapped = false;

    const p = this.params;
    const timeScale = Math.max(0.1, p.timeScale ?? 1.0);
    const lifeMin = Math.max(0.01, (p.fireLifeMin ?? 0.6) / timeScale);
    const lifeMax = Math.max(lifeMin, (p.fireLifeMax ?? 1.2) / timeScale);
    const sizeMin = Math.max(0.1, p.fireSizeMin ?? 19);
    const sizeMax = Math.max(sizeMin, p.fireSizeMax ?? 170);

    const flameLifecycle = new FlameLifecycleBehavior(this);
    const sizeOverLife = new SizeOverLife(new PiecewiseBezier([
      [new Bezier(0.3, 0.9, 1.0, 1.1), 0],
      [new Bezier(1.1, 1.0, 0.7, 0.4), 0.5],
    ]));
    const buoyancy = new ApplyForce(new THREE.Vector3(0, 0, 1), new ConstantValue(p.fireHeight * 0.125));
    const windForce = new SmartWindBehavior();
    const turbulence = new CurlNoiseField(
      new THREE.Vector3(150, 150, 50),
      new THREE.Vector3(80, 80, 30),
      1.5
    );

    const system = new QuarksParticleSystem({
      duration: 1,
      looping: true,
      startLife: new IntervalValue(lifeMin, lifeMax),
      startSpeed: new ConstantValue(0),
      startSize: new IntervalValue(sizeMin, sizeMax),
      startColor: new ColorRange(new Vector4(1, 1, 1, 1), new Vector4(1, 1, 1, 1)),
      worldSpace: true,
      maxParticles: 10000,
      emissionOverTime: new IntervalValue(10.0 * weight, 20.0 * weight),
      shape,
      material,
      renderMode: RenderMode.BillBoard,
      renderOrder: 50,
      uTileCount: 1,
      vTileCount: 1,
      startTileIndex: new ConstantValue(0),
      startRotation: new IntervalValue(0, Math.PI * 2),
      behaviors: [windForce, buoyancy, turbulence, new FireSpinBehavior(), sizeOverLife, flameLifecycle],
    });

    system.userData = {
      windForce,
      ownerEffect: this,
      updraftForce: buoyancy,
      baseUpdraftMag: p.fireHeight * 0.125,
      turbulence,
      baseCurlStrength: new THREE.Vector3(80, 80, 30),
      _msEmissionScale: weight,
    };

    return system;
  }

  /** @private */
  _createEmberSystem(shape, weight) {
    const THREE = window.THREE;
    if (!THREE) return null;

    const material = new THREE.MeshBasicMaterial({
      map: this._emberTexture,
      transparent: true,
      blending: THREE.AdditiveBlending,
      color: 0xffffff,
      depthWrite: false,
      depthTest: false,
    });
    material.toneMapped = false;

    const p = this.params;
    const timeScale = Math.max(0.1, p.timeScale ?? 1.0);
    const lifeMin = Math.max(0.01, (p.emberLifeMin ?? 1.5) / timeScale);
    const lifeMax = Math.max(lifeMin, (p.emberLifeMax ?? 3.0) / timeScale);
    const sizeMin = Math.max(0.1, p.emberSizeMin ?? 5);
    const sizeMax = Math.max(sizeMin, p.emberSizeMax ?? 17);

    const emberLifecycle = new EmberLifecycleBehavior(this);
    const buoyancy = new ApplyForce(new THREE.Vector3(0, 0, 1), new ConstantValue(p.fireHeight * 0.4));
    const windForce = new SmartWindBehavior();
    const emberCurlStrength = new THREE.Vector3(150, 150, 50);
    const turbulence = new CurlNoiseField(new THREE.Vector3(30, 30, 30), emberCurlStrength.clone(), 4.0);
    const emberSizeOverLife = new SizeOverLife(new PiecewiseBezier([
      [new Bezier(1.0, 0.85, 0.5, 0.2), 0],
    ]));

    const system = new QuarksParticleSystem({
      duration: 1,
      looping: true,
      startLife: new IntervalValue(lifeMin, lifeMax),
      startSpeed: new ConstantValue(0),
      startSize: new IntervalValue(sizeMin, sizeMax),
      startColor: new ColorRange(new Vector4(1, 1, 1, 1), new Vector4(1, 1, 1, 1)),
      worldSpace: true,
      maxParticles: 2000,
      emissionOverTime: new IntervalValue(
        (5.0 * p.emberRate) * weight,
        (10.0 * p.emberRate) * weight
      ),
      shape,
      material,
      renderMode: RenderMode.BillBoard,
      renderOrder: 51,
      behaviors: [
        new ParticleTimeScaledBehavior(buoyancy),
        windForce,
        new ParticleTimeScaledBehavior(turbulence),
        emberSizeOverLife,
        emberLifecycle,
      ],
    });

    system.userData = {
      windForce,
      ownerEffect: this,
      updraftForce: buoyancy,
      baseUpdraftMag: p.fireHeight * 0.4,
      turbulence,
      baseCurlStrength: emberCurlStrength.clone(),
      isEmber: true,
      _msEmissionScale: weight,
    };

    return system;
  }

  /** @private */
  _createSmokeSystem(shape, weight) {
    const THREE = window.THREE;
    if (!THREE) return null;

    const p = this.params;
    const material = new THREE.MeshBasicMaterial({
      map: this._emberTexture,
      transparent: true,
      blending: THREE.NormalBlending,
      color: 0xffffff,
      depthWrite: false,
      depthTest: false,
      side: THREE.DoubleSide,
    });
    material.toneMapped = false;

    const timeScale = Math.max(0.1, p.timeScale ?? 1.0);
    const lifeMin = Math.max(0.01, (p.smokeLifeMin ?? 0.9) / timeScale);
    const lifeMax = Math.max(lifeMin, (p.smokeLifeMax ?? 3.0) / timeScale);
    const sizeMin = Math.max(1.0, p.smokeSizeMin ?? 183);
    const sizeMax = Math.max(sizeMin, p.smokeSizeMax ?? 400);
    const smokeRatio = Math.max(0.0, p.smokeRatio ?? 0.3);

    const smokeLifecycle = new SmokeLifecycleBehavior(this);
    const smokeUpdraftMag = Math.max(0.0, p.smokeUpdraft ?? 2.5);
    const smokeUpdraft = new ApplyForce(new THREE.Vector3(0, 0, 1), new ConstantValue(smokeUpdraftMag));
    const windForce = new SmartWindBehavior();
    const smokeTurbMult = Math.max(0.0, p.smokeTurbulence ?? 1.0);
    const smokeCurlStrengthBase = new THREE.Vector3(200 * smokeTurbMult, 200 * smokeTurbMult, 80 * smokeTurbMult);
    const turbulence = new CurlNoiseField(new THREE.Vector3(100, 100, 40), smokeCurlStrengthBase.clone(), 2.0);

    const system = new QuarksParticleSystem({
      duration: 1,
      looping: true,
      startLife: new IntervalValue(lifeMin, lifeMax),
      startSpeed: new ConstantValue(0),
      startSize: new IntervalValue(sizeMin, sizeMax),
      startColor: new ColorRange(new Vector4(1, 1, 1, 1), new Vector4(1, 1, 1, 1)),
      worldSpace: true,
      maxParticles: 3000,
      emissionOverTime: new IntervalValue(
        10.0 * weight * smokeRatio * 0.5,
        20.0 * weight * smokeRatio * 0.8
      ),
      shape,
      material,
      renderMode: RenderMode.BillBoard,
      renderOrder: 52,
      startRotation: new IntervalValue(0, Math.PI * 2),
      behaviors: [windForce, smokeUpdraft, turbulence, new FireSpinBehavior(), smokeLifecycle],
    });

    system.userData = {
      windForce,
      ownerEffect: this,
      updraftForce: smokeUpdraft,
      baseUpdraftMag: smokeUpdraftMag,
      turbulence,
      baseCurlStrength: new THREE.Vector3(200, 200, 80),
      isSmoke: true,
      _msEmissionScale: weight,
    };

    return system;
  }

  // ── Private: Floor switching ───────────────────────────────────────────────

  /** Activate all floors up to the current active floor. @private */
  _activateCurrentFloor() {
    const floorStack = window.MapShine?.floorStack;
    const activeFloor = floorStack?.getActiveFloor();
    const maxFloorIndex = activeFloor?.index ?? Infinity;
    this.onFloorChange(maxFloorIndex);
  }

  /** Add a floor's systems to the BatchedRenderer + scene. @private */
  _activateFloor(floorIndex) {
    const state = this._floorStates.get(floorIndex);
    if (!state || !this._batchRenderer) return;

    const allSystems = [...state.systems, ...state.emberSystems, ...state.smokeSystems];
    for (const sys of allSystems) {
      try { this._batchRenderer.addSystem(sys); } catch (_) {}
      // Emitters must be in the scene graph for three.quarks to update their
      // world matrices. Adding them as children of the BatchedRenderer (which
      // is already in the bus scene) achieves this without exposing the bus's
      // private scene reference.
      if (sys.emitter) this._batchRenderer.add(sys.emitter);
    }
    log.debug(`FireEffectV2: activated floor ${floorIndex} (${allSystems.length} systems)`);
  }

  /** Remove a specific floor's systems from the BatchedRenderer. @private */
  _deactivateFloor(floorIndex) {
    if (!this._batchRenderer) return;
    const state = this._floorStates.get(floorIndex);
    if (!state) return;

    const allSystems = [...state.systems, ...state.emberSystems, ...state.smokeSystems];
    for (const sys of allSystems) {
      try { this._batchRenderer.deleteSystem(sys); } catch (_) {}
      if (sys.emitter) this._batchRenderer.remove(sys.emitter);
    }
    log.debug(`FireEffectV2: deactivated floor ${floorIndex}`);
  }

  /** Dispose all systems in a floor state. @private */
  _disposeFloorState(state) {
    const allSystems = [...state.systems, ...state.emberSystems, ...state.smokeSystems];
    for (const sys of allSystems) {
      try {
        if (this._batchRenderer) this._batchRenderer.deleteSystem(sys);
      } catch (_) {}
      if (sys.emitter && this._batchRenderer) {
        this._batchRenderer.remove(sys.emitter);
      }
      // Dispose material.
      try { sys.material?.dispose(); } catch (_) {}
    }
    state.systems.length = 0;
    state.emberSystems.length = 0;
    state.smokeSystems.length = 0;
  }

  // ── Private: Per-frame param sync ──────────────────────────────────────────

  /** Update emission rates, updraft, curl based on current params. @private */
  _updateSystemParams() {
    const p = this.params;
    const globalRate = Math.max(0.0, p.globalFireRate ?? 1.0);

    for (const [, state] of this._floorStates) {
      // Fire systems.
      for (const sys of state.systems) {
        if (!sys?.userData) continue;
        const w = sys.userData._msEmissionScale ?? 1.0;
        if (sys.emissionOverTime) {
          sys.emissionOverTime.a = 10.0 * w * globalRate;
          sys.emissionOverTime.b = 20.0 * w * globalRate;
        }
        // Updraft.
        const ud = sys.userData.updraftForce;
        if (ud?.magnitude) ud.magnitude.value = (p.fireHeight ?? 10) * 0.125 * (p.fireUpdraft ?? 1.0);
        // Curl turbulence.
        const turb = sys.userData.turbulence;
        const baseCurl = sys.userData.baseCurlStrength;
        if (turb?.force && baseCurl) {
          const cs = p.fireCurlStrength ?? 1.0;
          turb.force.set(baseCurl.x * cs, baseCurl.y * cs, baseCurl.z * cs);
        }
        // Wind influence.
        const wf = sys.userData.windForce;
        if (wf && sys.userData) sys.userData.windInfluence = p.windInfluence ?? 1.0;
      }

      // Ember systems.
      for (const sys of state.emberSystems) {
        if (!sys?.userData) continue;
        const w = sys.userData._msEmissionScale ?? 1.0;
        if (sys.emissionOverTime) {
          sys.emissionOverTime.a = 5.0 * (p.emberRate ?? 1.0) * w * globalRate;
          sys.emissionOverTime.b = 10.0 * (p.emberRate ?? 1.0) * w * globalRate;
        }
        const ud = sys.userData.updraftForce;
        if (ud?.magnitude) ud.magnitude.value = (p.fireHeight ?? 10) * 0.4 * (p.emberUpdraft ?? 1.0);
        const turb = sys.userData.turbulence;
        const baseCurl = sys.userData.baseCurlStrength;
        if (turb?.force && baseCurl) {
          const cs = p.emberCurlStrength ?? 1.0;
          turb.force.set(baseCurl.x * cs, baseCurl.y * cs, baseCurl.z * cs);
        }
      }

      // Smoke systems.
      for (const sys of state.smokeSystems) {
        if (!sys?.userData) continue;
        const w = sys.userData._msEmissionScale ?? 1.0;
        const smokeRatio = Math.max(0.0, p.smokeRatio ?? 0.3);
        if (sys.emissionOverTime) {
          sys.emissionOverTime.a = 10.0 * w * smokeRatio * 0.5 * globalRate;
          sys.emissionOverTime.b = 20.0 * w * smokeRatio * 0.8 * globalRate;
        }
        const ud = sys.userData.updraftForce;
        if (ud?.magnitude) ud.magnitude.value = Math.max(0.0, p.smokeUpdraft ?? 2.5);
        const turb = sys.userData.turbulence;
        const baseCurl = sys.userData.baseCurlStrength;
        if (turb?.force && baseCurl) {
          const cs = Math.max(0.0, p.smokeTurbulence ?? 1.0);
          turb.force.set(baseCurl.x * cs, baseCurl.y * cs, baseCurl.z * cs);
        }
        if (sys.userData) sys.userData.windInfluence = p.smokeWindInfluence ?? 1.0;
      }
    }
  }

  // ── Private: Texture loading ───────────────────────────────────────────────

  /**
   * Load fire and ember sprite textures. Returns a promise that resolves
   * when both are loaded so populate() can safely reference them.
   * @returns {Promise<void>}
   * @private
   */
  _loadTextures() {
    const THREE = window.THREE;
    if (!THREE) return Promise.resolve();
    const loader = new THREE.TextureLoader();

    const fireP = new Promise((resolve) => {
      loader.load('modules/map-shine-advanced/assets/flame.webp', (tex) => {
        tex.minFilter = THREE.LinearMipmapLinearFilter;
        tex.magFilter = THREE.LinearFilter;
        tex.generateMipmaps = true;
        tex.needsUpdate = true;
        this._fireTexture = tex;
        resolve();
      }, undefined, () => { log.warn('Failed to load flame.webp'); resolve(); });
    });

    const emberP = new Promise((resolve) => {
      loader.load('modules/map-shine-advanced/assets/particle.webp', (tex) => {
        tex.minFilter = THREE.LinearMipmapLinearFilter;
        tex.magFilter = THREE.LinearFilter;
        tex.generateMipmaps = true;
        tex.needsUpdate = true;
        this._emberTexture = tex;
        resolve();
      }, undefined, () => { log.warn('Failed to load particle.webp'); resolve(); });
    });

    return Promise.all([fireP, emberP]).then(() => {
      log.info('Fire textures loaded');
    });
  }

  /**
   * Load an image from URL and return the HTMLImageElement.
   * @private
   */
  _loadImage(url) {
    return new Promise((resolve) => {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => resolve(img);
      img.onerror = () => { log.warn(`Failed to load fire mask image: ${url}`); resolve(null); };
      img.src = url;
    });
  }

  // ── Private: Floor resolution ──────────────────────────────────────────────

  /** Same logic as SpecularEffectV2 and FloorRenderBus. @private */
  _resolveFloorIndex(tileDoc, floors) {
    if (!floors || floors.length <= 1) return 0;
    if (tileHasLevelsRange(tileDoc)) {
      const flags = readTileLevelsFlags(tileDoc);
      const tileBottom = Number(flags.rangeBottom);
      const tileTop = Number(flags.rangeTop);
      const tileMid = (tileBottom + tileTop) / 2;
      for (let i = 0; i < floors.length; i++) {
        const f = floors[i];
        if (tileMid >= f.elevationMin && tileMid <= f.elevationMax) return i;
      }
      for (let i = 0; i < floors.length; i++) {
        const f = floors[i];
        if (tileBottom <= f.elevationMax && f.elevationMin <= tileTop) return i;
      }
    }
    const elev = Number.isFinite(Number(tileDoc?.elevation)) ? Number(tileDoc.elevation) : 0;
    for (let i = 0; i < floors.length; i++) {
      const f = floors[i];
      if (elev >= f.elevationMin && elev <= f.elevationMax) return i;
    }
    return 0;
  }

  /** Get the elevation offset for a floor index (for Z positioning). @private */
  _resolveFloorElevation(floorIndex, floors) {
    if (!floors || floorIndex >= floors.length) return 0;
    const f = floors[floorIndex];
    return f?.elevationMin ?? 0;
  }
}
