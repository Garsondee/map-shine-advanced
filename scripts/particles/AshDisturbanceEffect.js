/**
 * @fileoverview Ash disturbance effect - burst of ash particles when tokens move.
 * Uses a mask-driven lookup of ash points to keep disturbance tied to _Ash texture.
 * @module particles/AshDisturbanceEffect
 */

import { EffectBase, RenderLayers } from '../effects/EffectComposer.js';
import { createLogger } from '../core/log.js';
import {
  ParticleSystem,
  IntervalValue,
  ColorRange,
  Vector4,
  RenderMode,
  ConstantValue,
  ApplyForce,
  ColorOverLife,
  SizeOverLife,
  PiecewiseBezier,
  Bezier,
  CurlNoiseField
} from '../libs/three.quarks.module.js';
import { weatherController } from '../core/WeatherController.js';
import Coordinates from '../utils/coordinates.js';

const log = createLogger('AshDisturbanceEffect');

class AshBurstShape {
  constructor(points, width, height, offsetX, offsetY, groundZ) {
    this.points = points;
    this.width = width;
    this.height = height;
    this.offsetX = offsetX;
    this.offsetY = offsetY;
    this.groundZ = groundZ;

    this.centerX = 0;
    this.centerY = 0;
    this.radius = 150;

    /**
     * Pre-filtered list of spawn point indices within the burst radius.
     * Rebuilt on each setCenter() call so initialize() has a 100% hit rate.
     * @type {number[]}
     */
    this._candidateIndices = [];

    this.type = 'ash_burst';
  }

  /**
   * Set the burst center and pre-filter spawn points within the radius.
   * This replaces the old per-particle rejection sampling (24 random tries)
   * with a single O(N) scan that guarantees every emitted particle gets a
   * valid position.
   */
  setCenter(x, y, radius) {
    this.centerX = x;
    this.centerY = y;
    this.radius = Math.max(10, radius || 150);

    // Pre-filter: collect all spawn point indices within the burst radius.
    const candidates = [];
    const count = this.points.length / 3;
    const rSq = this.radius * this.radius;

    for (let i = 0; i < count; i++) {
      const o = i * 3;
      const u = this.points[o];
      const v = this.points[o + 1];
      const b = this.points[o + 2];
      if (b <= 0.0) continue;

      const worldX = this.offsetX + u * this.width;
      const worldY = this.offsetY + (1.0 - v) * this.height;
      const dx = worldX - x;
      const dy = worldY - y;
      if ((dx * dx + dy * dy) <= rSq) {
        candidates.push(i);
      }
    }

    this._candidateIndices = candidates;
  }

  initialize(p) {
    const candidates = this._candidateIndices;
    if (!candidates || candidates.length === 0) {
      // No valid spawn points near the burst center — kill the particle.
      if (typeof p.life === 'number') p.life = 0;
      if (p.color && typeof p.color.w === 'number') p.color.w = 0;
      if (typeof p.size === 'number') p.size = 0;
      return;
    }

    const idx = candidates[Math.floor(Math.random() * candidates.length)];
    const o = idx * 3;
    const u = this.points[o];
    const v = this.points[o + 1];
    const brightness = this.points[o + 2];

    const worldX = this.offsetX + u * this.width;
    const worldY = this.offsetY + (1.0 - v) * this.height;

    p.position.x = worldX;
    p.position.y = worldY;
    p.position.z = this.groundZ + 5;

    const alphaScale = Math.max(0.2, Math.min(1.0, brightness));
    if (p.color && typeof p.color.w === 'number') {
      p.color.w *= alphaScale;
    }
    if (typeof p.size === 'number') {
      p.size *= (0.7 + 0.6 * alphaScale);
    }

    if (p.velocity) {
      p.velocity.set(0, 0, 0);
    }
  }

  update(system, delta) {
  }
}

export class AshDisturbanceEffect extends EffectBase {
  constructor() {
    super('ash-disturbance', RenderLayers.PARTICLES, 'low');

    this.priority = 2;
    this.alwaysRender = false;
    this.enabled = true;

    this.scene = null;
    this.renderer = null;
    this.camera = null;

    this.batchRenderer = null;

    this.params = {
      enabled: true,
      burstRate: 270,
      burstDuration: 1.6,
      burstRadius: 170,
      maxParticles: 3000,
      lifeMin: 4,
      lifeMax: 5.9,
      sizeMin: 54,
      sizeMax: 77,
      windInfluence: 0.35,
      curlStrength: 20,
      curlScale: 140,
      opacityStart: 0.5,
      opacityEnd: 0.15,
      colorStart: { r: 0.50, g: 0.46, b: 0.42, a: 0.5 },
      colorEnd: { r: 0.30, g: 0.27, b: 0.24, a: 0.15 }
    };

    this._assetBundle = null;
    this._ashMask = null;
    this._ashMaskData = null;
    this._ashMaskSize = { width: 0, height: 0 };
    this._ashMaskFlipV = false;
    this._spawnPoints = null;

    this._particleTexture = null;
    /** @type {boolean} True once the particle texture has fully decoded and is GPU-ready. */
    this._textureReady = false;

    this._burstSystems = [];
    this._burstIndex = 0;

    /**
     * Deferred rebuild flag. Set when setAssetBundle runs but systems cannot be
     * built yet (e.g. canvas.dimensions not ready, texture still loading).
     * The next handleTokenMovement or update call will retry.
     */
    this._needsRebuild = false;

    /** Number of deferred rebuild attempts (capped to avoid infinite retries). */
    this._rebuildAttempts = 0;
    /** @type {number} Max deferred rebuild attempts before giving up. */
    this._maxRebuildAttempts = 10;
  }

  static getControlSchema() {
    return {
      enabled: true,
      groups: [
        { name: 'burst', label: 'Burst Settings', type: 'inline', parameters: ['burstRate', 'burstDuration', 'burstRadius', 'maxParticles'] },
        { name: 'appearance', label: 'Appearance', type: 'inline', separator: true, parameters: ['sizeMin', 'sizeMax', 'lifeMin', 'lifeMax', 'opacityStart', 'opacityEnd'] },
        { name: 'motion', label: 'Motion', type: 'inline', separator: true, parameters: ['windInfluence', 'curlStrength', 'curlScale'] }
      ],
      presets: {
        'Light Disturbance': { burstRate: 200, burstDuration: 0.3, burstRadius: 180, maxParticles: 1500, sizeMin: 14, sizeMax: 35, lifeMin: 1.0, lifeMax: 2.5, opacityStart: 0.65, opacityEnd: 0.1, windInfluence: 0.5, curlStrength: 10, curlScale: 240 },
        'Standard': { burstRate: 500, burstDuration: 0.5, burstRadius: 250, maxParticles: 3000, sizeMin: 20, sizeMax: 50, lifeMin: 1.5, lifeMax: 3.5, opacityStart: 0.85, opacityEnd: 0.15, windInfluence: 0.6, curlStrength: 15, curlScale: 240 },
        'Heavy Disturbance': { burstRate: 800, burstDuration: 0.8, burstRadius: 350, maxParticles: 5000, sizeMin: 25, sizeMax: 65, lifeMin: 2.0, lifeMax: 4.5, opacityStart: 0.95, opacityEnd: 0.2, windInfluence: 0.8, curlStrength: 20, curlScale: 200 },
        'Volcanic': { burstRate: 1200, burstDuration: 1.2, burstRadius: 450, maxParticles: 6000, sizeMin: 30, sizeMax: 80, lifeMin: 2.5, lifeMax: 5.5, opacityStart: 1.0, opacityEnd: 0.3, windInfluence: 1.0, curlStrength: 30, curlScale: 160 }
      },
      parameters: {
        enabled: { type: 'boolean', default: true },
        burstRate: { type: 'slider', label: 'Burst Rate (particles/s)', min: 50, max: 2000, step: 10, default: 270, throttle: 50 },
        burstDuration: { type: 'slider', label: 'Burst Duration (s)', min: 0.1, max: 2.0, step: 0.05, default: 1.6, throttle: 50 },
        burstRadius: { type: 'slider', label: 'Burst Radius (px)', min: 50, max: 800, step: 10, default: 170, throttle: 50 },
        maxParticles: { type: 'slider', label: 'Max Particles', min: 500, max: 8000, step: 100, default: 3000, throttle: 50 },
        lifeMin: { type: 'slider', label: 'Life Min (s)', min: 0.2, max: 6.0, step: 0.1, default: 4, throttle: 50 },
        lifeMax: { type: 'slider', label: 'Life Max (s)', min: 0.5, max: 8.0, step: 0.1, default: 5.9, throttle: 50 },
        sizeMin: { type: 'slider', label: 'Size Min (px)', min: 4, max: 100, step: 1, default: 54, throttle: 50 },
        sizeMax: { type: 'slider', label: 'Size Max (px)', min: 8, max: 150, step: 1, default: 77, throttle: 50 },
        opacityStart: { type: 'slider', label: 'Opacity Start', min: 0.1, max: 1.0, step: 0.05, default: 0.5, throttle: 50 },
        opacityEnd: { type: 'slider', label: 'Opacity End', min: 0.0, max: 1.0, step: 0.05, default: 0.15, throttle: 50 },
        windInfluence: { type: 'slider', label: 'Wind Influence', min: 0.0, max: 3.0, step: 0.05, default: 0.35, throttle: 50 },
        curlStrength: { type: 'slider', label: 'Curl Strength', min: 0.0, max: 80.0, step: 1, default: 20, throttle: 50 },
        curlScale: { type: 'slider', label: 'Curl Scale', min: 50, max: 800, step: 10, default: 140, throttle: 50 }
      }
    };
  }

  initialize(renderer, scene, camera) {
    this.renderer = renderer;
    this.scene = scene;
    this.camera = camera;

    const particleSystem = window.MapShineParticles;
    if (particleSystem && particleSystem.batchRenderer) {
      this.batchRenderer = particleSystem.batchRenderer;
      log.info('Ash disturbance: acquired BatchedRenderer.');
    } else {
      log.warn('BatchedRenderer not available at init time; will retry on first use.');
      // Don't disable — we'll try to acquire the batchRenderer lazily.
    }

    this._ensureParticleTexture();
  }

  /**
   * Attempt to lazily acquire the BatchedRenderer if it wasn't available at init time.
   * @returns {boolean} true if batchRenderer is now available
   * @private
   */
  _ensureBatchRenderer() {
    if (this.batchRenderer) return true;
    const particleSystem = window.MapShineParticles;
    if (particleSystem && particleSystem.batchRenderer) {
      this.batchRenderer = particleSystem.batchRenderer;
      log.info('Ash disturbance: lazily acquired BatchedRenderer.');
      return true;
    }
    return false;
  }

  setAssetBundle(bundle) {
    this._assetBundle = bundle || null;
    const masks = bundle?.masks || [];
    this._ashMask = masks.find(m => m.id === 'ash' || m.type === 'ash')?.texture || null;

    if (this._ashMask) {
      log.info('Ash disturbance: _Ash mask found in asset bundle.');
    }

    try {
      const mm = window.MapShine?.maskManager;
      const rec = mm?.getRecord ? mm.getRecord('ash.scene') : null;
      if (rec && typeof rec.uvFlipY === 'boolean') {
        this._ashMaskFlipV = rec.uvFlipY === true;
      } else if (typeof this._ashMask?.flipY === 'boolean') {
        this._ashMaskFlipV = this._ashMask.flipY === true;
      } else {
        this._ashMaskFlipV = false;
      }
    } catch (_) {
      this._ashMaskFlipV = this._ashMask?.flipY === true;
    }

    this._spawnPoints = this._generatePoints(this._ashMask);
    if (!this._spawnPoints) {
      this._spawnPoints = this._generateFallbackPoints();
      if (this._spawnPoints) {
        log.info('Ash disturbance: no _Ash mask; using fallback spawn points across entire scene.');
      } else {
        log.warn('Ash disturbance: canvas.dimensions not available yet; deferring system build.');
      }
    }
    this._cacheMaskData(this._ashMask);

    // Attempt to build systems now. If prerequisites are missing,
    // set the deferred-rebuild flag so we retry on first use.
    this._rebuildAttempts = 0;
    const built = this._tryRebuildSystems();
    if (!built) {
      this._needsRebuild = true;
      log.info('Ash disturbance: deferred system build (missing prerequisites).');
    }
  }

  applyParamChange(paramId, value) {
    if (!this.params) return;
    if (paramId === 'enabled' || paramId === 'masterEnabled') {
      this.enabled = !!value;
      this.params.enabled = !!value;
      return;
    }

    if (Object.prototype.hasOwnProperty.call(this.params, paramId)) {
      this.params[paramId] = value;
    }

    // Keep colorStart/colorEnd alpha in sync with opacity sliders.
    if (paramId === 'opacityStart') {
      this.params.colorStart.a = Number(value) || 0;
    } else if (paramId === 'opacityEnd') {
      this.params.colorEnd.a = Number(value) || 0;
    }

    // Flag that live systems need their properties synced on next update.
    this._paramsDirty = true;
  }

  handleTokenMovement(tokenId) {
    if (!this.enabled) return;

    // Attempt deferred rebuild if systems haven't been created yet.
    if (this._needsRebuild || !this._burstSystems.length) {
      this._attemptDeferredRebuild();
    }

    if (!this._spawnPoints || !this._spawnPoints.length) {
      if (!this._loggedNoSpawnPoints) {
        this._loggedNoSpawnPoints = true;
        log.warn('Ash disturbance: handleTokenMovement called but no spawn points available.');
      }
      return;
    }
    if (!this._burstSystems.length) {
      if (!this._loggedNoSystems) {
        this._loggedNoSystems = true;
        log.warn('Ash disturbance: handleTokenMovement called but no burst systems built.');
      }
      return;
    }

    const token = canvas?.tokens?.get?.(tokenId);
    const doc = token?.document || canvas?.scene?.tokens?.get?.(tokenId);
    if (!doc) {
      log.debug(`Ash disturbance: token ${tokenId} not found in canvas.tokens or scene.tokens.`);
      return;
    }

    const grid = canvas?.grid;
    const gridSizeX = (grid && typeof grid.sizeX === 'number' && grid.sizeX > 0)
      ? grid.sizeX
      : ((grid && typeof grid.size === 'number' && grid.size > 0) ? grid.size : 100);
    const gridSizeY = (grid && typeof grid.sizeY === 'number' && grid.sizeY > 0)
      ? grid.sizeY
      : gridSizeX;

    const widthPx = doc.width * gridSizeX;
    const heightPx = doc.height * gridSizeY;
    const worldCenter = Coordinates.toWorld(doc.x + widthPx / 2, doc.y + heightPx / 2);
    const centerX = worldCenter.x;
    const centerY = worldCenter.y;

    if (!this._isAshAtWorld(centerX, centerY)) {
      log.debug(`Ash disturbance: token ${tokenId} at world (${centerX.toFixed(0)}, ${centerY.toFixed(0)}) is NOT on ash mask.`);
      return;
    }

    // Safe modulo: avoid NaN from 0 % 0
    const count = this._burstSystems.length;
    if (count <= 0) return;
    const system = this._burstSystems[this._burstIndex++ % count];
    if (!system || !system.userData || !system.userData.burstShape) return;

    const shape = system.userData.burstShape;
    shape.setCenter(centerX, centerY, this.params.burstRadius);

    const candidateCount = shape._candidateIndices?.length ?? 0;

    const emission = system.emissionOverTime;
    if (emission && typeof emission.value === 'number') {
      emission.value = Math.max(0, this.params.burstRate || 0);
    }
    system.userData.burstTime = Math.max(0.05, this.params.burstDuration || 0.2);

    // One-time confirmation log
    if (!this._loggedFirstBurst) {
      this._loggedFirstBurst = true;
      log.info(`Ash disturbance: first burst triggered at (${centerX.toFixed(0)}, ${centerY.toFixed(0)}), candidates=${candidateCount}, rate=${this.params.burstRate}, duration=${this.params.burstDuration}s, systems=${count}.`);
    }
  }

  update(timeInfo) {
    if (!this.enabled) return;

    // Attempt deferred rebuild if systems haven't been created yet.
    if (this._needsRebuild && !this._burstSystems.length) {
      this._attemptDeferredRebuild();
    }

    if (!this._burstSystems.length) return;

    const p = this.params;
    const weather = weatherController?.getCurrentState?.() || {};
    const windSpeed = Number(weather.windSpeed) || 0;
    const windDir = weather.windDirection || { x: 1, y: 0 };

    const windX = Number(windDir.x) || 1;
    const windY = Number(windDir.y) || 0;
    const len = Math.hypot(windX, windY) || 1;
    const dirX = windX / len;
    const dirY = windY / len;

    // Dynamically sync slider params to live burst systems so changes take
    // immediate effect without a full rebuild.
    const syncParams = this._paramsDirty;
    if (syncParams) this._paramsDirty = false;

    for (const system of this._burstSystems) {
      if (!system || !system.userData) continue;

      const t = Number(system.userData.burstTime) || 0;
      if (t > 0) {
        system.userData.burstTime = Math.max(0, t - (timeInfo.delta || 0));
        if (system.userData.burstTime <= 0) {
          const emission = system.emissionOverTime;
          if (emission && typeof emission.value === 'number') emission.value = 0;
        }
      }

      const windForce = system.userData.windForce;
      if (windForce && windForce.direction) {
        windForce.direction.set(dirX, dirY, 0);
        if (windForce.magnitude && typeof windForce.magnitude.value === 'number') {
          windForce.magnitude.value = 600 * windSpeed * (p.windInfluence ?? 0.6);
        }
      }

      const curl = system.userData.curl;
      const baseCurl = system.userData.baseCurlStrength;
      if (curl && baseCurl) {
        curl.strength.copy(baseCurl).multiplyScalar(Math.max(0.0, p.curlStrength ?? 15));
      }

      // Live-sync size, life, and color when sliders change.
      if (syncParams) {
        if (system.startSize && typeof system.startSize.a === 'number') {
          system.startSize.a = p.sizeMin;
          system.startSize.b = Math.max(p.sizeMin, p.sizeMax);
        }
        if (system.startLife && typeof system.startLife.a === 'number') {
          system.startLife.a = p.lifeMin;
          system.startLife.b = Math.max(p.lifeMin, p.lifeMax);
        }
        // Update ColorOverLife behavior for new opacity values.
        for (const behavior of (system.behaviors || [])) {
          if (behavior instanceof ColorOverLife && behavior.color) {
            try {
              const cr = behavior.color;
              if (cr.a && cr.b) {
                cr.a.x = p.colorStart.r; cr.a.y = p.colorStart.g; cr.a.z = p.colorStart.b; cr.a.w = p.colorStart.a;
                cr.b.x = p.colorEnd.r;   cr.b.y = p.colorEnd.g;   cr.b.z = p.colorEnd.b;   cr.b.w = p.colorEnd.a;
              }
            } catch (_) { /* ColorRange structure may vary */ }
          }
        }
      }
    }
  }

  render(renderer, scene, camera) {
    // no-op (quarks renderer handles rendering)
  }

  dispose() {
    for (const system of this._burstSystems) {
      try {
        if (this.batchRenderer && system) this.batchRenderer.deleteSystem(system);
        if (system?.emitter?.parent) system.emitter.parent.remove(system.emitter);
      } catch (_) {
      }
    }
    this._burstSystems.length = 0;
    if (this._particleTexture) {
      try { this._particleTexture.dispose(); } catch (_) {}
      this._particleTexture = null;
    }
  }

  _ensureParticleTexture() {
    const THREE = window.THREE;
    if (!THREE) return null;
    if (this._particleTexture) return this._particleTexture;

    try {
      const texture = new THREE.TextureLoader().load(
        'modules/map-shine-advanced/assets/particle.webp',
        // onLoad: texture is decoded and ready
        () => {
          this._textureReady = true;
          log.info('Ash disturbance: particle texture loaded.');
          // If we were waiting on the texture for a deferred rebuild, try now.
          if (this._needsRebuild) {
            this._attemptDeferredRebuild();
          }
        },
        undefined,
        // onError
        (err) => {
          log.error('Ash disturbance: failed to load particle texture:', err);
        }
      );
      texture.wrapS = THREE.ClampToEdgeWrapping;
      texture.wrapT = THREE.ClampToEdgeWrapping;
      texture.minFilter = THREE.LinearMipmapLinearFilter;
      texture.magFilter = THREE.LinearFilter;
      texture.generateMipmaps = true;
      texture.needsUpdate = true;
      this._particleTexture = texture;
      return texture;
    } catch (e) {
      log.error('Ash disturbance: exception loading particle texture:', e);
      return null;
    }
  }

  _generatePoints(maskTexture, threshold = 0.12) {
    if (!maskTexture || !maskTexture.image) return null;

    const image = maskTexture.image;
    const w = image.width || 0;
    const h = image.height || 0;
    if (w <= 0 || h <= 0) return null;

    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.drawImage(image, 0, 0);
    const data = ctx.getImageData(0, 0, w, h).data;

    const coords = [];
    const flipV = this._ashMaskFlipV === true;
    for (let y = 0; y < h; y++) {
      const ySample = flipV ? (h - 1 - y) : y;
      for (let x = 0; x < w; x++) {
        const idx = (ySample * w + x) * 4;
        const b = data[idx] / 255.0;
        if (b > threshold) {
          coords.push(x / w, y / h, b);
        }
      }
    }

    if (coords.length === 0) return null;
    return new Float32Array(coords);
  }

  _generateFallbackPoints(count = 12000) {
    const dims = canvas?.dimensions;
    if (!dims || !dims.sceneWidth || !dims.sceneHeight) {
      // canvas.dimensions may not be populated yet during early init.
      // Caller should set _needsRebuild and retry later.
      return null;
    }

    const total = Math.max(1000, Math.floor(count));
    const coords = new Float32Array(total * 3);
    for (let i = 0; i < total; i++) {
      const o = i * 3;
      coords[o] = Math.random();
      coords[o + 1] = Math.random();
      coords[o + 2] = 1.0;
    }
    return coords;
  }

  _cacheMaskData(maskTexture) {
    this._ashMaskData = null;
    this._ashMaskSize = { width: 0, height: 0 };
    if (!maskTexture || !maskTexture.image) return;

    const image = maskTexture.image;
    const w = image.width || 0;
    const h = image.height || 0;
    if (!w || !h) return;

    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.drawImage(image, 0, 0);
    const data = ctx.getImageData(0, 0, w, h).data;

    const out = new Uint8Array(w * h);
    const flipV = this._ashMaskFlipV === true;
    for (let y = 0; y < h; y++) {
      const ySample = flipV ? (h - 1 - y) : y;
      for (let x = 0; x < w; x++) {
        const srcIdx = (ySample * w + x) * 4;
        const dstIdx = y * w + x;
        out[dstIdx] = data[srcIdx];
      }
    }

    this._ashMaskData = out;
    this._ashMaskSize = { width: w, height: h };
  }

  _isAshAtWorld(worldX, worldY) {
    if (!this._ashMaskData || !this._ashMaskSize.width) return true;

    const dims = canvas?.dimensions;
    if (!dims) return false;

    // worldX/worldY are in Three.js world space (Y-up).
    // Convert back to Foundry coords (Y-down) for mask sampling.
    const foundryX = worldX;
    const foundryY = (dims.height || 0) - worldY;

    const sceneX = dims.sceneX || 0;
    const sceneY = dims.sceneY || 0;
    const sceneW = dims.sceneWidth || dims.width || 1;
    const sceneH = dims.sceneHeight || dims.height || 1;

    // UV in Foundry space: u left->right, v top->bottom (matches mask data layout)
    const u = (foundryX - sceneX) / sceneW;
    const v = (foundryY - sceneY) / sceneH;
    if (!Number.isFinite(u) || !Number.isFinite(v)) return false;

    const cu = Math.max(0, Math.min(1, u));
    const cv = Math.max(0, Math.min(1, v));
    const w = this._ashMaskSize.width;
    const h = this._ashMaskSize.height;
    const px = Math.floor(cu * (w - 1));
    const py = Math.floor(cv * (h - 1));
    const idx = py * w + px;
    const value = this._ashMaskData[idx] / 255.0;
    return value > 0.1;
  }

  /**
   * Attempt a deferred rebuild. Called lazily from handleTokenMovement/update
   * when _needsRebuild is true. Retries generating fallback spawn points if
   * canvas.dimensions is now available.
   * @private
   */
  _attemptDeferredRebuild() {
    if (!this._needsRebuild) return;
    if (this._rebuildAttempts >= this._maxRebuildAttempts) {
      // Give up after too many attempts to avoid log spam.
      this._needsRebuild = false;
      log.warn(`Ash disturbance: giving up on deferred rebuild after ${this._rebuildAttempts} attempts.`);
      return;
    }
    this._rebuildAttempts++;

    // Ensure we have a batchRenderer (may have been unavailable at init).
    if (!this._ensureBatchRenderer()) return;

    // If we still don't have spawn points, try generating fallback points now.
    if (!this._spawnPoints || !this._spawnPoints.length) {
      this._spawnPoints = this._generateFallbackPoints();
      if (this._spawnPoints) {
        log.info('Ash disturbance: deferred fallback points generated successfully.');
      }
    }

    const built = this._tryRebuildSystems();
    if (built) {
      this._needsRebuild = false;
      log.info(`Ash disturbance: deferred rebuild succeeded on attempt ${this._rebuildAttempts} (${this._burstSystems.length} systems).`);
    }
  }

  /**
   * Try to build burst systems. Returns true if systems were created.
   * Does not set _needsRebuild — caller decides.
   * @returns {boolean}
   * @private
   */
  _tryRebuildSystems() {
    if (!this._ensureBatchRenderer()) return false;
    if (!this.scene) return false;
    if (!this._spawnPoints || !this._spawnPoints.length) return false;

    const d = canvas?.dimensions;
    if (!d || !d.sceneWidth || !d.sceneHeight) return false;

    this._rebuildSystems();
    return this._burstSystems.length > 0;
  }

  _rebuildSystems() {
    if (!this.batchRenderer || !this.scene || !this._spawnPoints) return;

    const THREE = window.THREE;
    if (!THREE) return;

    for (const system of this._burstSystems) {
      try {
        if (this.batchRenderer && system) this.batchRenderer.deleteSystem(system);
        if (system?.emitter?.parent) system.emitter.parent.remove(system.emitter);
      } catch (_) {
      }
    }
    this._burstSystems.length = 0;

    const d = canvas?.dimensions;
    if (!d) return;

    const width = d.sceneWidth || d.width;
    const height = d.sceneHeight || d.height;
    const offsetX = d.sceneX || 0;
    const offsetY = (d.height || height) - (d.sceneY || 0) - height;

    const sceneComposer = window.MapShine?.sceneComposer;
    // groundZ fallback must be 0 (ground plane), NOT camera height
    const groundZ = (sceneComposer && typeof sceneComposer.groundZ === 'number')
      ? sceneComposer.groundZ
      : 0;

    const material = new THREE.MeshBasicMaterial({
      map: this._particleTexture,
      transparent: true,
      depthWrite: false,
      depthTest: false,
      blending: THREE.NormalBlending,
      color: 0x6b625b,
      opacity: 1.0,
      side: THREE.DoubleSide
    });

    const p = this.params;
    const startColor = new ColorRange(
      new Vector4(p.colorStart.r, p.colorStart.g, p.colorStart.b, p.colorStart.a),
      new Vector4(p.colorStart.r, p.colorStart.g, p.colorStart.b, p.colorStart.a)
    );

    const colorOverLife = new ColorOverLife(new ColorRange(
      new Vector4(p.colorStart.r, p.colorStart.g, p.colorStart.b, p.colorStart.a),
      new Vector4(p.colorEnd.r, p.colorEnd.g, p.colorEnd.b, p.colorEnd.a)
    ));

    const sizeOverLife = new SizeOverLife(new PiecewiseBezier([
      [new Bezier(0.2, 1.0, 0.8, 0.0), 0]
    ]));

    const createBurstSystem = () => {
      const shape = new AshBurstShape(this._spawnPoints, width, height, offsetX, offsetY, groundZ);
      const windForce = new ApplyForce(new THREE.Vector3(1, 0, 0), new ConstantValue(0));
      const curlScale = Math.max(1.0, p.curlScale ?? 240);
      const curlStrength = Math.max(0.0, p.curlStrength ?? 10);
      const curl = new CurlNoiseField(
        new THREE.Vector3(curlScale, curlScale, curlScale),
        new THREE.Vector3(curlStrength, curlStrength, curlStrength),
        1.0
      );

      const system = new ParticleSystem({
        duration: 1,
        looping: true,
        prewarm: false,
        startLife: new IntervalValue(p.lifeMin, p.lifeMax),
        startSpeed: new ConstantValue(0),
        startSize: new IntervalValue(p.sizeMin, p.sizeMax),
        startColor,
        worldSpace: true,
        maxParticles: p.maxParticles,
        emissionOverTime: new ConstantValue(0),
        shape,
        material,
        renderMode: RenderMode.BillBoard,
        renderOrder: 49,
        behaviors: [
          windForce,
          curl,
          colorOverLife,
          sizeOverLife
        ]
      });

      if (system.emitter) {
        system.emitter.position.set(0, 0, 0);
      }

      system.userData = {
        burstShape: shape,
        windForce,
        curl,
        baseCurlStrength: curl.strength.clone(),
        burstTime: 0
      };

      this.scene.add(system.emitter);
      this.batchRenderer.addSystem(system);

      return system;
    };

    const systemCount = 6;
    for (let i = 0; i < systemCount; i++) {
      this._burstSystems.push(createBurstSystem());
    }

    log.info(`Ash disturbance: _rebuildSystems created ${this._burstSystems.length} burst systems.`, {
      spawnPoints: this._spawnPoints ? (this._spawnPoints.length / 3) : 0,
      sceneSize: `${width}x${height}`,
      offset: `(${offsetX}, ${offsetY})`,
      groundZ,
      hasMask: !!this._ashMask,
      textureReady: this._textureReady
    });
  }
}
