import { EffectBase, RenderLayers } from '../effects/EffectComposer.js';
import { createLogger } from '../core/log.js';
import { 
  ParticleSystem, 
  IntervalValue,
  ColorRange,
  Vector4,
  PointEmitter,
  RenderMode
} from '../libs/three.quarks.module.js';

const log = createLogger('FireSparksEffect');

class FireMaskShape {
  constructor(points, width, height, offsetX, offsetY) {
    this.points = points;
    this.width = width;
    this.height = height;
    this.offsetX = offsetX;
    this.offsetY = offsetY;
    this.type = 'fire_mask'; 
  }
  
  initialize(p) {
    const count = this.points.length / 3;
    if (count === 0) return;
    const idx = Math.floor(Math.random() * count) * 3;
    const u = this.points[idx];
    const v = this.points[idx + 1];
    p.position.x = this.offsetX + u * this.width;
    p.position.y = this.offsetY + v * this.height;
    p.position.z = 0;
  }
}

export class FireSparksEffect extends EffectBase {
  constructor() {
    super('fire-sparks', RenderLayers.PARTICLES, 'low');
    this.fires = [];
    this.particleSystemRef = null; 
    this.globalSystem = null;
    this.fireTexture = this._createFireTexture();
    this.settings = {
      enabled: true,
      windInfluence: 1.0,
      lightIntensity: 1.0,
      maxLights: 10
    };
    this.params = {
      enabled: true,
      globalFireRate: 0.25,
      fireAlpha: 0.6,
      fireCoreBoost: 1.0,
      fireHeight: 110.0,
      fireSize: 18.0
    };
  }
  
  _createFireTexture() {
    const canvas = document.createElement('canvas');
    canvas.width = 64;
    canvas.height = 64;
    const ctx = canvas.getContext('2d');
    const grad = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
    grad.addColorStop(0, 'rgba(255, 255, 255, 1)');
    grad.addColorStop(0.4, 'rgba(255, 255, 255, 0.5)');
    grad.addColorStop(1, 'rgba(255, 255, 255, 0)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, 64, 64);
    return new window.THREE.CanvasTexture(canvas);
  }
  
  static getControlSchema() {
    return {
      enabled: true,
      groups: [
        { name: 'debug', label: 'Fire Tuning', type: 'inline', parameters: ['globalFireRate', 'fireAlpha', 'fireHeight', 'fireSize'] }
      ],
      parameters: {
        enabled: { type: 'checkbox', label: 'Fire Enabled', default: true },
        globalFireRate: { type: 'slider', label: 'Global Intensity', min: 0.0, max: 5.0, step: 0.1, default: 0.25 },
        fireAlpha: { type: 'slider', label: 'Opacity', min: 0.0, max: 1.0, step: 0.01, default: 0.6 },
        fireHeight: { type: 'slider', label: 'Height', min: 10.0, max: 300.0, step: 10.0, default: 110.0 },
        fireSize: { type: 'slider', label: 'Particle Size', min: 1.0, max: 50.0, step: 1.0, default: 18.0 }
      }
    };
  }
  
  initialize(renderer, scene, camera) {
    this.scene = scene;
    log.info('FireSparksEffect initialized (Quarks)');
  }
  
  setParticleSystem(ps) {
    this.particleSystemRef = ps;
    log.info('Connected to ParticleSystem');
  }
  
  setAssetBundle(bundle) {
    if (!bundle || !bundle.masks) return;
    const fireMask = bundle.masks.find(m => m.type === 'fire');
    if (fireMask && this.particleSystemRef && this.particleSystemRef.batchRenderer) {
      const points = this._generatePoints(fireMask.texture);
      if (!points) return;
      const d = canvas.dimensions;
      const width = d.sceneWidth || d.width;
      const height = d.sceneHeight || d.height;
      const sx = d.sceneX || 0;
      const sy = d.sceneY || 0;
      const shape = new FireMaskShape(points, width, height, sx, sy);
      this.globalSystem = this._createFireSystem({
        shape: shape,
        rate: new IntervalValue(10.0, 20.0), 
        size: this.params.fireSize,
        height: this.params.fireHeight
      });
      this.particleSystemRef.batchRenderer.addSystem(this.globalSystem);
      log.info('Created Global Fire System from mask (' + (points.length/3) + ' points)');
    }
  }
  
  _generatePoints(maskTexture, threshold = 0.1) {
    const image = maskTexture.image;
    const c = document.createElement('canvas');
    c.width = image.width;
    c.height = image.height;
    const ctx = c.getContext('2d');
    ctx.drawImage(image, 0, 0);
    const data = ctx.getImageData(0, 0, c.width, c.height).data;
    const coords = [];
    for (let i = 0; i < data.length; i += 4) {
        const b = data[i] / 255.0;
        if (b > threshold) {
            const idx = i / 4;
            const x = (idx % c.width) / c.width;
            const y = Math.floor(idx / c.width) / c.height;
            coords.push(x, y, b);
        }
    }
    if (coords.length === 0) return null;
    return new Float32Array(coords);
  }
  
  _createFireSystem(opts) {
    const { shape, rate, size, height } = opts;
    const THREE = window.THREE;
    const material = new THREE.MeshBasicMaterial({
      map: this.fireTexture,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      color: 0xffffff
    });
    const system = new ParticleSystem({
      duration: 1,
      looping: true,
      startLife: new IntervalValue(0.5, 1.0),
      startSpeed: new IntervalValue(height * 0.5, height * 1.5),
      startSize: new IntervalValue(size * 0.8, size * 1.5),
      startColor: new ColorRange(new Vector4(1, 1, 0.5, 1), new Vector4(1, 0.2, 0, 1)),
      worldSpace: true,
      maxParticles: 10000,
      emissionOverTime: rate,
      shape: shape,
      material: material,
      renderMode: RenderMode.BillBoard,
      startRotation: new IntervalValue(0, Math.PI * 2),
    });
    return system;
  }
  
  createFire(x, y, radius = 50, height = 1.0, intensity = 1.0) {
     if (!this.particleSystemRef || !this.particleSystemRef.batchRenderer) return null;
     const system = this._createFireSystem({
        shape: new PointEmitter(),
        rate: new IntervalValue(intensity * 10, intensity * 20),
        size: radius * 0.4,
        height: height * 50.0
     });
     system.emitter.position.set(x, y, 0);
     this.particleSystemRef.batchRenderer.addSystem(system);
     const light = new window.THREE.PointLight(0xff6600, 1.0, radius * 8.0);
     light.position.set(x, y, 50);
     this.scene.add(light);
     const id = crypto.randomUUID();
     this.fires.push({ id, system, light });
     return id;
  }
  
  removeFire(id) {
      const idx = this.fires.findIndex(f => f.id === id);
      if (idx !== -1) {
          const { system, light } = this.fires[idx];
          if (this.particleSystemRef?.batchRenderer) {
              this.particleSystemRef.batchRenderer.deleteSystem(system);
          }
          this.scene.remove(light);
          light.dispose();
          this.fires.splice(idx, 1);
      }
  }
  
  update(timeInfo) {
    if (!this.settings.enabled) return;
    const t = timeInfo.elapsed;
    for (const f of this.fires) {
        f.light.intensity = 1.0 + Math.sin(t * 10) * 0.2;
    }
    if (this.globalSystem) {
        const baseRate = 200.0 * this.params.globalFireRate; 
        this.globalSystem.emissionOverTime = new IntervalValue(baseRate * 0.8, baseRate * 1.2);
    }
  }
  
  clear() {
      [...this.fires].forEach(f => this.removeFire(f.id));
  }
  
  dispose() {
      this.clear();
      if (this.globalSystem && this.particleSystemRef?.batchRenderer) {
          this.particleSystemRef.batchRenderer.deleteSystem(this.globalSystem);
      }
      super.dispose();
  }
}
