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

    this.type = 'ash_burst';
  }

  setCenter(x, y, radius) {
    this.centerX = x;
    this.centerY = y;
    this.radius = Math.max(10, radius || 150);
  }

  initialize(p) {
    const count = this.points.length / 3;
    if (count <= 0) return;

    const maxTries = Math.min(24, count);
    let found = false;
    let worldX = 0;
    let worldY = 0;
    let brightness = 0.0;

    for (let i = 0; i < maxTries; i++) {
      const idx = Math.floor(Math.random() * count) * 3;
      const u = this.points[idx];
      const v = this.points[idx + 1];
      const b = this.points[idx + 2];
      if (!Number.isFinite(u) || !Number.isFinite(v) || !Number.isFinite(b) || b <= 0.0) {
        continue;
      }

      worldX = this.offsetX + u * this.width;
      worldY = this.offsetY + (1.0 - v) * this.height;
      brightness = b;

      const dx = worldX - this.centerX;
      const dy = worldY - this.centerY;
      if ((dx * dx + dy * dy) <= (this.radius * this.radius)) {
        found = true;
        break;
      }
    }

    if (!found) {
      if (typeof p.life === 'number') p.life = 0;
      if (p.color && typeof p.color.w === 'number') p.color.w = 0;
      if (typeof p.size === 'number') p.size = 0;
      return;
    }

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
      burstRate: 240,
      burstDuration: 0.35,
      burstRadius: 180,
      maxParticles: 1200,
      lifeMin: 0.8,
      lifeMax: 1.6,
      sizeMin: 8,
      sizeMax: 18,
      windInfluence: 0.6,
      curlStrength: 10,
      curlScale: 240,
      colorStart: { r: 0.45, g: 0.42, b: 0.38, a: 0.6 },
      colorEnd: { r: 0.25, g: 0.22, b: 0.2, a: 0.0 }
    };

    this._assetBundle = null;
    this._ashMask = null;
    this._ashMaskData = null;
    this._ashMaskSize = { width: 0, height: 0 };
    this._ashMaskFlipV = false;
    this._spawnPoints = null;

    this._particleTexture = null;

    this._burstSystems = [];
    this._burstIndex = 0;
  }

  static getControlSchema() {
    return {
      enabled: true,
      groups: [
        { name: 'ash', label: 'Ash Disturbance', type: 'inline', parameters: ['burstRate', 'burstDuration', 'burstRadius'] },
        { name: 'appearance', label: 'Appearance', type: 'inline', separator: true, parameters: ['sizeMin', 'sizeMax', 'lifeMin', 'lifeMax'] },
        { name: 'motion', label: 'Motion', type: 'inline', separator: true, parameters: ['windInfluence', 'curlStrength', 'curlScale'] }
      ],
      parameters: {
        enabled: { type: 'boolean', default: true },
        burstRate: { type: 'slider', label: 'Burst Rate', min: 10, max: 800, step: 5, default: 240, throttle: 50 },
        burstDuration: { type: 'slider', label: 'Burst Duration (s)', min: 0.05, max: 2.0, step: 0.05, default: 0.35, throttle: 50 },
        burstRadius: { type: 'slider', label: 'Burst Radius', min: 30, max: 600, step: 10, default: 180, throttle: 50 },
        maxParticles: { type: 'slider', label: 'Max Particles', min: 100, max: 6000, step: 100, default: 1200, throttle: 50 },
        lifeMin: { type: 'slider', label: 'Life Min (s)', min: 0.1, max: 5.0, step: 0.05, default: 0.8, throttle: 50 },
        lifeMax: { type: 'slider', label: 'Life Max (s)', min: 0.1, max: 6.0, step: 0.05, default: 1.6, throttle: 50 },
        sizeMin: { type: 'slider', label: 'Size Min', min: 2, max: 60, step: 1, default: 8, throttle: 50 },
        sizeMax: { type: 'slider', label: 'Size Max', min: 4, max: 80, step: 1, default: 18, throttle: 50 },
        windInfluence: { type: 'slider', label: 'Wind Influence', min: 0.0, max: 2.0, step: 0.05, default: 0.6, throttle: 50 },
        curlStrength: { type: 'slider', label: 'Curl Strength', min: 0.0, max: 60.0, step: 1, default: 10, throttle: 50 },
        curlScale: { type: 'slider', label: 'Curl Scale', min: 50, max: 800, step: 10, default: 240, throttle: 50 }
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
    } else {
      log.warn('BatchedRenderer not available; ash disturbance disabled');
      this.enabled = false;
      return;
    }

    this._ensureParticleTexture();
  }

  setAssetBundle(bundle) {
    this._assetBundle = bundle || null;
    const masks = bundle?.masks || [];
    this._ashMask = masks.find(m => m.id === 'ash' || m.type === 'ash')?.texture || null;

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
        log.warn('Ash disturbance: _Ash mask missing; using fallback spawn points across scene.');
      }
    }
    this._cacheMaskData(this._ashMask);

    this._rebuildSystems();
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
  }

  handleTokenMovement(tokenId) {
    if (!this.enabled || !this._spawnPoints || !this._spawnPoints.length) return;

    const token = canvas?.tokens?.get?.(tokenId);
    const doc = token?.document || canvas?.scene?.tokens?.get?.(tokenId);
    if (!doc) return;

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

    if (!this._isAshAtWorld(centerX, centerY)) return;

    const system = this._burstSystems[this._burstIndex++ % this._burstSystems.length];
    if (!system || !system.userData || !system.userData.burstShape) return;

    const shape = system.userData.burstShape;
    shape.setCenter(centerX, centerY, this.params.burstRadius);

    const emission = system.emissionOverTime;
    if (emission && typeof emission.value === 'number') {
      emission.value = Math.max(0, this.params.burstRate || 0);
    }
    system.userData.burstTime = Math.max(0.05, this.params.burstDuration || 0.2);
  }

  update(timeInfo) {
    if (!this.enabled || !this._burstSystems.length) return;

    const weather = weatherController?.getCurrentState?.() || {};
    const windSpeed = Number(weather.windSpeed) || 0;
    const windDir = weather.windDirection || { x: 1, y: 0 };

    const windX = Number(windDir.x) || 1;
    const windY = Number(windDir.y) || 0;
    const len = Math.hypot(windX, windY) || 1;
    const dirX = windX / len;
    const dirY = windY / len;

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
          windForce.magnitude.value = 600 * windSpeed * (this.params.windInfluence ?? 0.6);
        }
      }

      const curl = system.userData.curl;
      const baseCurl = system.userData.baseCurlStrength;
      if (curl && baseCurl) {
        curl.strength.copy(baseCurl).multiplyScalar(Math.max(0.0, this.params.curlStrength ?? 10));
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
      const texture = new THREE.TextureLoader().load('modules/map-shine-advanced/assets/particle.webp');
      texture.wrapS = THREE.ClampToEdgeWrapping;
      texture.wrapT = THREE.ClampToEdgeWrapping;
      texture.minFilter = THREE.LinearMipmapLinearFilter;
      texture.magFilter = THREE.LinearFilter;
      texture.generateMipmaps = true;
      texture.needsUpdate = true;
      this._particleTexture = texture;
      return texture;
    } catch (e) {
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
    if (!dims) return null;

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
  }
}
