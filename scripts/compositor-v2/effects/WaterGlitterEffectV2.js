/**
 * @fileoverview V2 Water Glitter Effect - particle-based glitter system for water surfaces.
 *
 * Creates bright, short-lived particle sparkles on water that are designed to catch
 * the bloom shader. Uses three.quarks particle system with the particle.webp texture.
 *
 * Architecture:
 *   - Owns a three.quarks BatchedRenderer added to the FloorRenderBus scene
 *   - Scans water masks to generate spawn points across water surfaces
 *   - Creates glitter particle systems with short lifetimes and high brightness
 *   - Floor-aware system swapping for multi-floor support
 *
 * @module compositor-v2/effects/WaterGlitterEffectV2
 */

import { createLogger } from '../../core/log.js';
import { OVERLAY_THREE_LAYER } from '../../core/render-layers.js';
import { probeMaskFile } from '../../assets/loader.js';
import { tileHasLevelsRange, readTileLevelsFlags } from '../../foundry/levels-scene-flags.js';
import {
  ParticleSystem as QuarksParticleSystem,
  BatchedRenderer,
  IntervalValue,
  ColorRange,
  Vector4,
  RenderMode,
  ConstantValue,
} from '../../libs/three.quarks.module.js';

const log = createLogger('WaterGlitterV2');

// Ground Z for the bus scene (matches FloorRenderBus GROUND_Z).
const GROUND_Z = 1000;

// Keep render-order math aligned with FloorRenderBus floor bands.
const RENDER_ORDER_PER_FLOOR = 10000;

// Spatial bucket size for splitting large water masks into smaller emitters (px).
const BUCKET_SIZE = 2500;

// Glitter particle lifecycle stops
const GLITTER_ALPHA_STOPS = [
  { t: 0.00, v: 0.00 },
  { t: 0.10, v: 0.80 },
  { t: 0.25, v: 1.00 },
  { t: 0.50, v: 0.90 },
  { t: 0.75, v: 0.40 },
  { t: 1.00, v: 0.00 },
];

const GLITTER_SIZE_STOPS = [
  { t: 0.00, v: 0.30 },
  { t: 0.15, v: 0.80 },
  { t: 0.40, v: 1.00 },
  { t: 0.70, v: 0.60 },
  { t: 1.00, v: 0.20 },
];

// Utility functions for stop interpolation
const clamp01 = (n) => Math.max(0.0, Math.min(1.0, n));
const lerp = (a, b, t) => a + (b - a) * t;
const smoothstep = (edge0, edge1, x) => {
  const t = clamp01((x - edge0) / (edge1 - edge0));
  return t * t * (3.0 - 2.0 * t);
};

function lerpScalarStops(stops, t) {
  let i = 0;
  while (i < stops.length - 1 && stops[i + 1].t <= t) i++;
  if (i >= stops.length - 1) return stops[stops.length - 1].v;
  const a = stops[i];
  const b = stops[i + 1];
  const f = (t - a.t) / Math.max(0.0001, b.t - a.t);
  return a.v + (b.v - a.v) * f;
}

function applyParticleScalarSize(particle, scalar, flipX = 1.0, flipY = 1.0) {
  if (!particle) return;
  let s = scalar;
  if (!Number.isFinite(s)) s = 1.0;

  if (typeof particle.size === 'number') {
    particle.size = s * (flipX < 0 ? -1.0 : 1.0);
    return;
  }

  if (particle.size && typeof particle.size.copy === 'function') {
    particle.size.set(s * flipX, s * flipY);
    return;
  }

  if (particle.size && typeof particle.size.set === 'function') {
    particle.size.set(s * flipX, s * flipY);
    return;
  }

  particle.size = s;
}

// Glitter lifecycle behavior
export class GlitterLifecycleBehavior {
  /**
   * @param {WaterGlitterEffectV2} owner
   * @param {number} floorIndex
   */
  constructor(owner, floorIndex) {
    this.owner = owner;
    this.floorIndex = floorIndex;
    this._time = 0;
  }

  initialize(particle, system) {
    particle.age = 0;
    particle.life = particle.startLife;
    
    // Random brightness variation for bloom effect
    particle.brightnessMult = 0.5 + Math.random() * 1.5;
    
    // Slight color variation (warm white to pure white)
    const warmChance = Math.random();
    if (warmChance < 0.3) {
      particle.colorR = 1.0;
      particle.colorG = 0.95;
      particle.colorB = 0.85;
    } else {
      particle.colorR = 1.0;
      particle.colorG = 1.0;
      particle.colorB = 1.0;
    }
  }

  update(particle, delta, system) {
    particle.age += delta;
    const lifeT = clamp01(particle.age / particle.life);

    // Alpha envelope
    const alpha = lerpScalarStops(GLITTER_ALPHA_STOPS, lifeT);
    particle.alpha = alpha * particle.brightnessMult;

    // Size envelope
    const size = lerpScalarStops(GLITTER_SIZE_STOPS, lifeT);
    applyParticleScalarSize(particle, size);

    // Color
    if (particle.color) {
      particle.color.setRGB(particle.colorR, particle.colorG, particle.colorB);
    }

    // Suppress in dark areas
    const darkness = clamp01(this.owner.params.darknessSuppression);
    const sceneDarkness = this.owner._getSceneDarkness() || 0;
    const darkGate = 1.0 - smoothstep(0.0, darkness, sceneDarkness);
    particle.alpha *= darkGate;
  }

  frameUpdate(delta) {
    this._time += delta;
  }

  reset() {
    this._time = 0;
  }

  clone() {
    return new GlitterLifecycleBehavior(this.owner, this.floorIndex);
  }
}

// Water interior shape for spawning glitter across water surfaces
export class WaterInteriorGlitterShape {
  /**
   * @param {Array<{x: number, y: number}>} points - Precomputed interior spawn points
   * @param {number} width - Width of the original water mask
   * @param {number} height - Height of the original water mask
   */
  constructor(points, width, height, sceneWidth, sceneHeight, sceneX, sceneY, groundZ = 1000, floorElevation = 0) {
    this.points = points;
    this.width = width;
    this.height = height;
    this.sceneWidth = sceneWidth;
    this.sceneHeight = sceneHeight;
    this.sceneX = sceneX;
    this.sceneY = sceneY;
    this.groundZ = groundZ;
    this.floorElevation = Number.isFinite(floorElevation) ? floorElevation : 0;
    this._pointIndex = 0;
  }

  initialize(particle, system) {
    if (this.points.length === 0) {
      particle.position.set(0, 0, GROUND_Z);
      return;
    }

    // Pick a random point from the precomputed interior points
    const point = this.points[Math.floor(Math.random() * this.points.length)];
    
    // Convert pixel coordinates to world coordinates (match WaterSplashesEffectV2)
    const worldX = this.sceneX + point.x * (this.sceneWidth / this.width);
    const worldY = this.sceneY + (1.0 - point.y / this.height) * this.sceneHeight;
    
    particle.position.set(worldX, worldY, this.groundZ + this.floorElevation + Math.random() * 2); // Slight Z variation
  }

  update(particle, delta, system) {
    // Static position once spawned
  }

  clone() {
    return new WaterInteriorGlitterShape(this.points, this.width, this.height, this.sceneWidth, this.sceneHeight, this.sceneX, this.sceneY, this.groundZ, this.floorElevation);
  }
}

// Main WaterGlitterEffectV2 class
export class WaterGlitterEffectV2 {
  /**
   * @param {import('../FloorRenderBus.js').FloorRenderBus} renderBus
   */
  constructor(renderBus) {
    this._renderBus = renderBus;
    this._enabled = true;
    this._initialized = false;

    /**
     * Per-floor cached system sets. Key: floorIndex.
     * Value: { glitterSystems: QuarksParticleSystem[] }
     * @type {Map<number, object>}
     */
    this._floorStates = new Map();

    /**
     * Set of floor indices whose systems are currently in the BatchedRenderer.
     * @type {Set<number>}
     */
    this._activeFloors = new Set();

    /** @type {THREE.Texture|null} Glitter particle texture */
    this._glitterTexture = null;
    /** @type {Promise<void>|null} Resolves when sprite texture is loaded */
    this._textureReady = null;

    // Effect parameters
    this.params = {
      enabled: true,
      strength: 2.5,
      spawnRate: 80, // particles per second per system
      lifeMin: 0.1,
      lifeMax: 0.3,
      sizeMin: 2,
      sizeMax: 8,
      brightness: 8.0,
      darknessSuppression: 0.3,
      windInfluence: 0.4,
    };

    /** @type {Array<QuarksParticleSystem>} reused systems list */
    this._tempSystems = [];

    /** @type {{ sx:number, syWorld:number, sw:number, sh:number }|null} cached scene bounds */
    this._sceneBounds = null;
  }

  /**
   * Initialize the effect - creates BatchedRenderer and loads textures.
   * @param {THREE.WebGLRenderer} renderer
   * @returns {Promise<void>}
   */
  async initialize(renderer) {
    if (this._initialized) return;

    const THREE = window.THREE;
    if (!THREE) {
      log.warn('WaterGlitterEffectV2: THREE not available');
      return;
    }

    // Create a dedicated BatchedRenderer for water glitter particles.
    this._batchRenderer = new BatchedRenderer();
    this._batchRenderer.renderOrder = RENDER_ORDER_PER_FLOOR;
    this._batchRenderer.frustumCulled = false;
    
    // Set up render layers
    try {
      if (this._batchRenderer.layers && typeof this._batchRenderer.layers.enable === 'function') {
        this._batchRenderer.layers.enable(OVERLAY_THREE_LAYER);
      }
    } catch (_) {}

    // Load texture
    this._textureReady = this._loadTexture();

    this._initialized = true;
    log.info('WaterGlitterEffectV2 initialized');
  }

  /**
   * Load the glitter particle texture.
   * @returns {Promise<void>}
   * @private
   */
  _loadTexture() {
    const THREE = window.THREE;
    if (!THREE) return Promise.resolve();

    const loader = new THREE.TextureLoader();

    return new Promise((resolve) => {
      loader.load('modules/map-shine-advanced/assets/particle.webp', (tex) => {
        tex.wrapS = THREE.RepeatWrapping;
        tex.wrapT = THREE.RepeatWrapping;
        tex.minFilter = THREE.LinearFilter;
        tex.magFilter = THREE.LinearFilter;
        tex.generateMipmaps = false;
        tex.needsUpdate = true;

        this._glitterTexture = tex;
        if (this._batchRenderer) {
          this._batchRenderer.texture = tex;
          // Update material properties for additive blending
          this._batchRenderer.material = new THREE.MeshBasicMaterial({
            map: tex,
            transparent: true,
            depthWrite: false,
            depthTest: false,
            blending: THREE.AdditiveBlending,
          });
        }
        log.info('WaterGlitterEffectV2: particle texture loaded');
        resolve();
      }, undefined, (error) => {
        log.warn('WaterGlitterEffectV2: failed to load particle texture:', error);
        resolve(); // Continue without texture
      });
    });
  }

  /**
   * Scan water mask to find interior spawn points for glitter.
   * @param {ImageBitmap} maskBitmap
   * @returns {Array<{x: number, y: number}>}
   * @private
   */
  async _scanWaterInteriorPoints(maskBitmap) {
    const width = maskBitmap.width;
    const height = maskBitmap.height;
    const imageData = new ImageData(width, height);
    
    // Get pixel data from bitmap
    const ctx = new OffscreenCanvas(width, height).getContext('2d');
    ctx.drawImage(maskBitmap, 0, 0);
    ctx.getImageData(0, 0, width, height, imageData);

    const points = [];
    const step = Math.max(1, Math.floor(width * height / 10000)); // Limit to ~10k points

    for (let y = 0; y < height; y += step) {
      for (let x = 0; x < width; x += step) {
        const idx = (y * width + x) * 4;
        const alpha = imageData.data[idx + 3];
        
        // Include points with some water presence (alpha > 32)
        if (alpha > 32) {
          points.push({ x, y });
        }
      }
    }

    return points;
  }

  /**
   * Create glitter particle systems for a water mask.
   * @param {ImageBitmap} maskBitmap
   * @param {number} floorIndex
   * @param {number} sceneWidth
   * @param {number} sceneHeight
   * @param {number} sceneX
   * @param {number} sceneY
   * @returns {Promise<QuarksParticleSystem[]>}
   * @private
   */
  async _createGlitterSystems(maskBitmap, floorIndex, sceneWidth, sceneHeight, sceneX, sceneY) {
    if (!this._batchRenderer || !this._glitterTexture) {
      return [];
    }

    const points = await this._scanWaterInteriorPoints(maskBitmap);
    if (points.length === 0) {
      return [];
    }

    const systems = [];
    const bucketSize = BUCKET_SIZE;
    const buckets = new Map();

    // Group points into spatial buckets
    for (const point of points) {
      const bucketX = Math.floor(point.x / bucketSize);
      const bucketY = Math.floor(point.y / bucketSize);
      const key = `${bucketX},${bucketY}`;
      
      if (!buckets.has(key)) {
        buckets.set(key, []);
      }
      buckets.get(key).push(point);
    }

    // Create one system per bucket
    const bucketsCount = buckets.size;
    for (const [bucketKey, bucketPoints] of buckets) {
      const system = this._createGlitterSystem(bucketPoints, maskBitmap.width, maskBitmap.height, floorIndex, sceneWidth, sceneHeight, sceneX, sceneY);
      if (system) {
        systems.push(system);
      }
    }

    return systems;
  }

  /**
   * Create a single glitter particle system.
   * @param {Array<{x: number, y: number}>} points
   * @param {number} maskWidth
   * @param {number} maskHeight
   * @param {number} floorIndex
   * @param {number} sceneWidth
   * @param {number} sceneHeight
   * @param {number} sceneX
   * @param {number} sceneY
   * @returns {QuarksParticleSystem}
   * @private
   */
  _createGlitterSystem(points, maskWidth, maskHeight, floorIndex, sceneWidth, sceneHeight, sceneX, sceneY) {
    const THREE = window.THREE;
    if (!THREE) return null;

    const p = this.params;
    const lifeMin = Math.max(0.05, p.lifeMin);
    const lifeMax = Math.max(lifeMin + 0.01, p.lifeMax);
    const sizeMin = Math.max(0.5, p.sizeMin);
    const sizeMax = Math.max(sizeMin + 0.1, p.sizeMax);

    const system = new QuarksParticleSystem({
      duration: 1,
      looping: true,
      startLife: new IntervalValue(lifeMin, lifeMax),
      startSpeed: new ConstantValue(0),
      startSize: new IntervalValue(sizeMin, sizeMax),
      startColor: new ColorRange(
        new Vector4(1, 1, 1, 1),
        new Vector4(1, 0.95, 0.85, 1)
      ),
      maxParticles: 200,
      emissionRate: p.spawnRate / bucketsCount, // Divide by bucket count
      renderMode: RenderMode.Billboard,
      renderOrder: RENDER_ORDER_PER_FLOOR + floorIndex * 10,
    });

    // Add behaviors
    system.addBehavior(new WaterInteriorGlitterShape(points, maskWidth, maskHeight, sceneWidth, sceneHeight, sceneX, sceneY));
    system.addBehavior(new GlitterLifecycleBehavior(this, floorIndex));

    // Add system userData for debugging
    system.userData = {
      ownerEffect: this,
      _msFloorIndex: floorIndex,
      isGlitter: true,
    };

    // Start the system
    if (typeof system.play === 'function') system.play();

    return system;
  }

  /**
   * Populate glitter systems for water tiles.
   * @param {object} foundrySceneData - Scene geometry data
   * @returns {Promise<void>}
   */
  async populate(foundrySceneData) {
    if (!this._initialized || !this._enabled) return;

    // Wait for texture to load
    if (this._textureReady) {
      await this._textureReady;
    }

    // Clear existing systems
    this.clear();

    const tileDocs = canvas?.scene?.tiles?.contents ?? [];
    const floors = window.MapShine?.floorStack?.getFloors() ?? [];
    const d = canvas?.dimensions;
    if (!d) { log.warn('populate: no canvas dimensions'); return; }

    const sceneWidth = d.sceneWidth || d.width;
    const sceneHeight = d.sceneHeight || d.height;
    // Foundry scene origin (top-left, Y-down).
    const foundrySceneX = d.sceneX || 0;
    const foundrySceneY = d.sceneY || 0;
    // Three.js scene origin (Y-up).
    const sceneX = foundrySceneX;
    const sceneY = (d.height || sceneHeight) - foundrySceneY - sceneHeight;

    // Cache for per-frame uniform binding.
    this._sceneBounds = {
      sx: sceneX,
      syWorld: sceneY,
      sw: sceneWidth,
      sh: sceneHeight,
    };

    // Collect water mask data per floor from all tiles.
    // Key: floorIndex, Value: { maskBitmaps: ImageBitmap[] }
    const floorWaterData = new Map();

    // Process background image first (if it has a _Water mask)
    const bgSrc = canvas?.scene?.background?.src;
    if (bgSrc) {
      const dotIdx = bgSrc.lastIndexOf('.');
      const bgBasePath = dotIdx > 0 ? bgSrc.substring(0, dotIdx) : bgSrc;

      let bitmap = null;
      const waterResult = await probeMaskFile(bgBasePath, '_Water');
      if (waterResult?.path) {
        try {
          const response = await fetch(waterResult.path);
          if (response.ok) {
            const blob = await response.blob();
            bitmap = await createImageBitmap(blob);
          }
        } catch (error) {
          log.warn(`WaterGlitterEffectV2: Failed to load background water mask:`, error);
        }
      }

      if (bitmap) {
        const floorIndex = 0;
        if (!floorWaterData.has(floorIndex)) {
          floorWaterData.set(floorIndex, { maskBitmaps: [] });
        }
        floorWaterData.get(floorIndex).maskBitmaps.push(bitmap);
        log.info(`  background water mask loaded for floor ${floorIndex}`);
      }
    }

    // Process tiles
    for (const tileDoc of tileDocs) {
      const src = tileDoc?.texture?.src ?? tileDoc?.img ?? '';
      if (!src) continue;

      const tileId = tileDoc.id ?? tileDoc._id;
      if (!tileId) continue;

      // Check if this tile has a _Water mask
      const dotIdx = src.lastIndexOf('.');
      const tileBasePath = dotIdx > 0 ? src.substring(0, dotIdx) : src;

      let bitmap = null;
      const waterResult = await probeMaskFile(tileBasePath, '_Water');
      if (waterResult?.path) {
        try {
          const response = await fetch(waterResult.path);
          if (response.ok) {
            const blob = await response.blob();
            bitmap = await createImageBitmap(blob);
          }
        } catch (error) {
          log.warn(`WaterGlitterEffectV2: Failed to load water mask for tile ${tileId}:`, error);
        }
      }

      if (bitmap) {
        // Determine floor index for this tile
        let floorIndex = 0;
        if (tileHasLevelsRange(tileDoc)) {
          const flags = readTileLevelsFlags(tileDoc);
          if (flags && flags.range && flags.range.length > 0) {
            // Use the bottom of the range as the floor index
            floorIndex = flags.range[0] ?? 0;
          }
        }

        if (!floorWaterData.has(floorIndex)) {
          floorWaterData.set(floorIndex, { maskBitmaps: [] });
        }
        floorWaterData.get(floorIndex).maskBitmaps.push(bitmap);
        log.debug(`  tile ${tileId} water mask loaded for floor ${floorIndex}`);
      }
    }

    // Create glitter systems for each floor
    for (const [floorIndex, floorData] of floorWaterData) {
      const floorSystems = [];

      for (const bitmap of floorData.maskBitmaps) {
        try {
          // Create glitter systems for this bitmap
          const systems = await this._createGlitterSystems(bitmap, floorIndex, sceneWidth, sceneHeight, sceneX, sceneY);
          floorSystems.push(...systems);
        } catch (error) {
          log.warn(`WaterGlitterEffectV2: Failed to create systems for floor ${floorIndex}:`, error);
        }
      }

      this._floorStates.set(floorIndex, { glitterSystems: floorSystems });
    }

    log.info(`WaterGlitterEffectV2: Created glitter systems for ${this._floorStates.size} floors`);

    // Add the BatchedRenderer to the bus scene via the overlay API.
    if (this._batchRenderer && this._floorStates.size > 0) {
      this._renderBus.addEffectOverlay('__water_glitter_batch__', this._batchRenderer, 0);
    }
  }

  /**
   * Set active floor - swaps systems in/out of BatchedRenderer.
   * @param {number} floorIndex
   */
  setActiveFloor(floorIndex) {
    if (!this._batchRenderer) return;

    // Remove all current systems from renderer
    for (const systemId of this._activeFloors) {
      const state = this._floorStates.get(systemId);
      if (state) {
        for (const system of state.glitterSystems) {
          try { this._batchRenderer.removeSystem(system); } catch (_) {}
          // Remove emitter from BatchedRenderer
          if (system.emitter) this._batchRenderer.remove(system.emitter);
        }
      }
    }
    this._activeFloors.clear();

    // Add systems for the active floor
    const state = this._floorStates.get(floorIndex);
    if (state) {
      for (const system of state.glitterSystems) {
        try { this._batchRenderer.addSystem(system); } catch (_) {}
        // Add emitter as child of BatchedRenderer for scene membership
        if (system.emitter) this._batchRenderer.add(system.emitter);
      }
      this._activeFloors.add(floorIndex);
    }
  }

  /**
   * Handle floor change - delegates to setActiveFloor.
   * @param {number} maxFloorIndex
   */
  onFloorChange(maxFloorIndex) {
    this.setActiveFloor(maxFloorIndex);
  }

  /**
   * Update effect parameters.
   * @param {object} params
   */
  updateParams(params) {
    Object.assign(this.params, params);
  }

  /**
   * Per-frame update - steps the BatchedRenderer simulation.
   * @param {{ elapsed: number, delta: number }} timeInfo
   */
  update(timeInfo) {
    if (!this._batchRenderer) return;
    
    const dt = Math.min(Math.max(0.0, Number(timeInfo?.delta) || 0), 0.1);
    
    // Step the BatchedRenderer simulation
    try {
      this._batchRenderer.update(dt);
    } catch (err) {
      log.warn('WaterGlitterEffectV2: BatchedRenderer.update threw, skipping frame:', err);
    }
  }

  /**
   * Get current scene darkness level.
   * @returns {number}
   * @private
   */
  _getSceneDarkness() {
    try {
      return globalThis.canvas?.environment?.darknessLevel ?? 0;
    } catch (_) {
      return 0;
    }
  }

  /**
   * Tweakpane control schema for WaterGlitterEffectV2.
   * Keep this schema aligned with the live params consumed in update().
   */
  static getControlSchema() {
    return {
      enabled: true,
      groups: [
        {
          type: 'folder',
          label: 'Water Glitter',
          expanded: true,
          separator: true,
          parameters: [
            'enabled',
            'strength', 
            'spawnRate',
            'lifeMin',
            'lifeMax',
            'sizeMin',
            'sizeMax',
            'brightness',
            'darknessSuppression',
            'windInfluence'
          ]
        }
      ],
      parameters: {
        enabled: {
          type: 'boolean',
          default: true,
          label: 'Enabled'
        },
        strength: {
          type: 'number',
          default: 2.5,
          min: 0.0,
          max: 10.0,
          step: 0.1,
          label: 'Strength'
        },
        spawnRate: {
          type: 'number',
          default: 80,
          min: 0,
          max: 500,
          step: 5,
          label: 'Spawn Rate (particles/sec)'
        },
        lifeMin: {
          type: 'number',
          default: 0.1,
          min: 0.05,
          max: 1.0,
          step: 0.05,
          label: 'Min Lifetime (sec)'
        },
        lifeMax: {
          type: 'number',
          default: 0.3,
          min: 0.1,
          max: 2.0,
          step: 0.1,
          label: 'Max Lifetime (sec)'
        },
        sizeMin: {
          type: 'number',
          default: 2,
          min: 1,
          max: 20,
          step: 1,
          label: 'Min Size (pixels)'
        },
        sizeMax: {
          type: 'number',
          default: 8,
          min: 2,
          max: 50,
          step: 1,
          label: 'Max Size (pixels)'
        },
        brightness: {
          type: 'number',
          default: 8.0,
          min: 1.0,
          max: 20.0,
          step: 0.5,
          label: 'Brightness (bloom)'
        },
        darknessSuppression: {
          type: 'number',
          default: 0.3,
          min: 0.0,
          max: 1.0,
          step: 0.1,
          label: 'Darkness Suppression'
        },
        windInfluence: {
          type: 'number',
          default: 0.4,
          min: 0.0,
          max: 2.0,
          step: 0.1,
          label: 'Wind Influence'
        }
      }
    };
  }

  /**
   * Clear all particle systems.
   */
  clear() {
    // Remove all systems from BatchedRenderer
    for (const systemId of this._activeFloors) {
      const state = this._floorStates.get(systemId);
      if (state) {
        for (const system of state.glitterSystems) {
          try { this._batchRenderer.removeSystem(system); } catch (_) {}
          if (system.emitter) this._batchRenderer.remove(system.emitter);
        }
      }
    }
    this._activeFloors.clear();
  }

  get enabled() { return this._enabled; }
  set enabled(v) {
    this._enabled = !!v;
    if (this.params && Object.prototype.hasOwnProperty.call(this.params, 'enabled')) {
      this.params.enabled = this._enabled;
    }
  }

  /**
   * Enable/disable the effect.
   * @param {boolean} enabled
   */
  setEnabled(enabled) {
    this.enabled = enabled;
  }

  /**
   * Dispose of all resources.
   */
  dispose() {
    // Clear all active systems first
    this.clear();

    // Dispose individual systems and materials
    for (const [, state] of this._floorStates) {
      this._disposeFloorState(state);
    }
    this._floorStates.clear();

    // Remove from render bus
    if (this._renderBus) {
      this._renderBus.removeEffectOverlay('__water_glitter_batch__');
    }

    // Dispose texture
    if (this._glitterTexture) {
      this._glitterTexture.dispose();
      this._glitterTexture = null;
    }

    // Clear BatchedRenderer reference (no dispose method available)
    this._batchRenderer = null;
    this._initialized = false;
  }

  /** Dispose all systems in a floor state. @private */
  _disposeFloorState(state) {
    for (const system of state.glitterSystems) {
      try {
        // Remove emitter from BatchedRenderer
        if (system.emitter && this._batchRenderer) {
          this._batchRenderer.remove(system.emitter);
        }
        // Dispose material
        if (system.material) {
          system.material.dispose();
        }
        // Dispose system
        system.dispose();
      } catch (_) {}
    }
    state.glitterSystems.length = 0;
  }
}
