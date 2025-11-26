import { EffectBase, RenderLayers } from '../effects/EffectComposer.js';
import { createLogger } from '../core/log.js';
import { 
  ParticleSystem, 
  IntervalValue,
  ColorRange,
  Vector4,
  PointEmitter,
  RenderMode,
  ApplyForce,
  ConstantValue,
  ColorOverLife,
  SizeOverLife,
  PiecewiseBezier,
  Bezier
} from '../libs/three.quarks.module.js';

const log = createLogger('FireSparksEffect');

/**
 * Emitter shape that spawns particles from a precomputed list of valid
 * coordinates sampled from the _Fire mask.
 *
 * MASK AUTHORING CONTRACT (baked into this shape):
 * - The `_Fire` image must have the **same pixel resolution** as the main
 *   battlemap albedo texture (e.g. 2250x2250 in this scene).
 * - Fire authoring happens in the **same UV space** as the base texture:
 *     * u in [0,1] runs left → right across the scene.
 *     * v in [0,1] runs top  → bottom in image space.
 * - Bright pixels (red channel) in `_Fire` mark where fire should spawn.
 * - The loader (assets/loader.js) exposes this as `type: 'fire'` with
 *   `suffix: '_Fire'` in the MapAssetBundle.
 *
 * CPU SAMPLING CONTRACT:
 * - `_generatePoints` walks the `_Fire` image once on the CPU and collects
 *   (u, v, brightness) triples for all pixels above a luminance threshold.
 * - `width/height` and `offsetX/offsetY` passed to this shape define the
 *   **scene rectangle in world units** that the UVs are mapped onto.
 *   For Map Shine this is:
 *     width  = canvas.dimensions.sceneWidth
 *     height = canvas.dimensions.sceneHeight
 *     offsetX = canvas.dimensions.sceneX
 *     offsetY = H - sceneY - sceneHeight  (Y-inverted world coords)
 */
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
    // Direct UV mapping onto the scene rectangle. The _Fire mask has the
    // same pixel dimensions as the base albedo for the scene, so we treat
    // (u, v) exactly like the base texture UVs.
    //
    // IMPORTANT ORIENTATION DETAIL:
    // - Image v=0 is the **top** of the bitmap; v=1 is the bottom.
    // - World Y grows upward, while Foundry / PIXI images treat 0 as top.
    // - SceneComposer positions the base plane and then flips it with
    //   `scale.y = -1`, so visually the image looks correct in world space.
    // - To place particles back onto that same plane we must therefore use
    //   (1 - v) when mapping into world Y.
    p.position.x = this.offsetX + u * this.width;
    p.position.y = this.offsetY + (1.0 - v) * this.height;
    p.position.z = 0;
  }

  // three.quarks emitter shapes are expected to expose an update(system, delta)
  // method. Our fire mask is static in time, so this is a no-op.
  update(system, delta) {
    // No per-frame evolution of the spawn mask.
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
    const THREE = window.THREE;
    if (!THREE) return null;
    
    const texture = new THREE.TextureLoader().load('modules/map-shine-advanced/assets/flame.webp');
    texture.minFilter = THREE.LinearMipmapLinearFilter;
    texture.magFilter = THREE.LinearFilter;
    texture.generateMipmaps = true;
    return texture;
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
    // The asset loader (assets/loader.js) exposes any `<Base>_Fire.*` image
    // as a mask entry with `type: 'fire'`. We treat that as an author-painted
    // spawn mask for global fire: bright pixels mark where fire should exist.
    const fireMask = bundle.masks.find(m => m.type === 'fire');
    if (fireMask && this.particleSystemRef && this.particleSystemRef.batchRenderer) {
      try {
        const d = canvas.dimensions;
        const baseTex = bundle.baseTexture;
        log.info('Fire debug: base vs fire vs dims', {
          baseW: baseTex?.image?.width,
          baseH: baseTex?.image?.height,
          fireW: fireMask.texture?.image?.width,
          fireH: fireMask.texture?.image?.height,
          dims: {
            width: d?.width,
            height: d?.height,
            sceneWidth: d?.sceneWidth,
            sceneHeight: d?.sceneHeight,
            sceneX: d?.sceneX,
            sceneY: d?.sceneY,
            padding: d?.padding
          }
        });
      } catch (e) {
        log.warn('Fire debug logging failed', e);
      }
      // 1. Convert the `_Fire` bitmap into a compact list of UVs. This is a
      //    one-time CPU pass that builds a static lookup table; all per-frame
      //    spawning is then O(1) by randomly indexing into this array.
      const points = this._generatePoints(fireMask.texture);
      if (!points) return;
      const d = canvas.dimensions;
      // 2. Map mask UVs across the **scene rectangle**. The `_Fire` mask is
      //    authored 1:1 with the base battlemap albedo and is intended to
      //    cover only the playable scene area, not the padded world.
      //    This mirrors the world volume used by WeatherParticles and the
      //    base plane geometry in SceneComposer.
      const width = d.sceneWidth || d.width;
      const height = d.sceneHeight || d.height;
      const sx = d.sceneX || 0;
      // Invert Y so that mask v=0 is the **visual top** of the scene and
      // v=1 is the bottom, matching the base plane and token/tile transforms.
      const sy = (d.height || height) - (d.sceneY || 0) - height;
      const shape = new FireMaskShape(points, width, height, sx, sy);
      this.globalSystem = this._createFireSystem({
        shape: shape,
        rate: new IntervalValue(10.0, 20.0), 
        size: this.params.fireSize,
        height: this.params.fireHeight
      });
      this.scene.add(this.globalSystem.emitter);
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
      depthTest: false,
      blending: THREE.AdditiveBlending,
      color: 0xffffff,
      side: THREE.DoubleSide
    });

    const colorOverLife = new ColorOverLife(
        new ColorRange(
            new Vector4(1.0, 0.9, 0.6, 1.0), 
            new Vector4(1.0, 0.2, 0.1, 0.0)
        )
    );

    const sizeOverLife = new SizeOverLife(
        new PiecewiseBezier([
            [new Bezier(1.0, 1.2, 1.5, 2.0), 0]
        ])
    );

    const system = new ParticleSystem({
      duration: 1,
      looping: true,
      startLife: new IntervalValue(0.8, 1.4),
      // Debug: keep particles fixed at their spawn position to verify mask alignment.
      startSpeed: new ConstantValue(0),
      startSize: new IntervalValue(size * 0.8, size * 1.5),
      startColor: new ColorRange(new Vector4(1, 1, 1, 1), new Vector4(1, 1, 1, 1)),
      worldSpace: true,
      maxParticles: 10000,
      emissionOverTime: rate,
      shape: shape,
      material: material,
      renderMode: RenderMode.BillBoard,
      renderOrder: 50,
      startRotation: new IntervalValue(0, Math.PI * 2),
      behaviors: [
          colorOverLife,
          sizeOverLife
      ]
    });
    return system;
  }
  
  createFire(x, y, radius = 50, height = 1.0, intensity = 1.0) {
     if (!this.particleSystemRef || !this.particleSystemRef.batchRenderer) return null;
     const system = this._createFireSystem({
        shape: new PointEmitter(),
        rate: new IntervalValue(intensity * 15, intensity * 25),
        size: radius * 0.8,
        height: height * 50.0
     });
     system.emitter.position.set(x, y, 10);
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
