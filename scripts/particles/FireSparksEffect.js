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
  Bezier,
  CurlNoiseField
} from '../libs/three.quarks.module.js';
import { weatherController } from '../core/WeatherController.js';

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

    // 1. Pick a random point in the precomputed (u, v, brightness) list
    const idx = Math.floor(Math.random() * count) * 3;
    const u = this.points[idx];
    const v = this.points[idx + 1];
    const brightness = this.points[idx + 2]; // 0.0 to 1.0 luminance from the _Fire mask

    // 2. Direct UV mapping onto the scene rectangle. The _Fire mask has the
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

    // 3. Apply brightness-based modifiers. The particle system has already
    // assigned random life/size/opacity; we now scale them by mask luminance.

    // Lifetime: Darker pixels die faster.
    // At 0 brightness, keep 30% life; at 1.0 brightness, keep 100%.
    if (typeof p.life === 'number') {
      p.life *= (0.3 + 0.7 * brightness);
    }

    // Size: Darker pixels spawn smaller flames.
    // At 0 brightness, 40% size; at 1.0 brightness, 100%.
    if (typeof p.size === 'number') {
      p.size *= (0.4 + 0.6 * brightness);
    }

    // Opacity (Alpha): Darker pixels are much more transparent.
    // Using brightness^2 gives a sharper falloff so grey pixels look ghostly.
    if (p.color && typeof p.color.w === 'number') {
      p.color.w *= (brightness * brightness);
    }

    // 4. Reset velocity to prevent accumulation across particle reuse
    if (p.velocity) {
      p.velocity.set(0, 0, 0);
    }
  }

  // three.quarks emitter shapes are expected to expose an update(system, delta)
  // method. Our fire mask is static in time, so this is a no-op.
  update(system, delta) {
    // No per-frame evolution of the spawn mask.
  }
}

// Simple sprite spin behavior for fire quads. Each particle gets a random
// angular velocity (both magnitude and direction) on spawn, then rotates in
// place over its lifetime. Parameters are read from the owning
// FireSparksEffect via system.userData.ownerEffect.
class FireSpinBehavior {
  constructor() {
    this.type = 'FireSpin';
  }

  initialize(particle, system) {
    // System is available here
    if (!particle || !system || !system.userData || !system.userData.ownerEffect) return;

    const effect = system.userData.ownerEffect;
    const params = effect?.params || {};

    // Check if enabled immediately
    if (params.fireSpinEnabled === false) {
      particle._spinSpeed = 0;
      return;
    }

    // Calculate speeds from params
    const min = typeof params.fireSpinSpeedMin === 'number' ? params.fireSpinSpeedMin : 0.5;
    const maxBase = typeof params.fireSpinSpeedMax === 'number' ? params.fireSpinSpeedMax : 2.5;
    const max = Math.max(min, maxBase);

    const base = min + Math.random() * (max - min);
    const dir = Math.random() < 0.5 ? -1 : 1;
    const spinBoost = 3.0;

    // Store final spin speed directly on particle for fast per-frame update
    particle._spinSpeed = base * dir * spinBoost;
  }

  update(particle, delta) {
    if (!particle || typeof delta !== 'number') return;

    // If speed is 0 or undefined, do nothing
    if (!particle._spinSpeed) return;

    // three.quarks usually uses a number for billboard rotation,
    // but some configurations use an object with .z
    if (typeof particle.rotation === 'number') {
      particle.rotation += particle._spinSpeed * delta;
    } else if (particle.rotation && typeof particle.rotation.z === 'number') {
      particle.rotation.z += particle._spinSpeed * delta;
    }
  }

  frameUpdate(delta) { /* no-op */ }

  reset() { /* no-op, required by behavior interface */ }

  clone() {
    return new FireSpinBehavior();
  }
}

export class FireSparksEffect extends EffectBase {
  constructor() {
    super('fire-sparks', RenderLayers.PARTICLES, 'low');
    this.fires = [];
    this.particleSystemRef = null; 
    this.globalSystem = null;
    this.globalEmbers = null;
    this.emberTexture = null;
    this.fireTexture = this._createFireTexture();
    this.settings = {
      enabled: true,
      windInfluence: 1.0,
      lightIntensity: 1.0,
      maxLights: 10
    };
    this.params = {
      enabled: true,
      globalFireRate: 1.9,
      fireAlpha: 0.6,
      fireCoreBoost: 1.0,
      fireHeight: 600.0,
      fireSize: 18.0,
      emberRate: 5.0,
      windInfluence: 1.4,
      lightIntensity: 0.9,

      // Fire fine controls (defaults from tuned UI)
      fireSizeMin: 11.0,
      fireSizeMax: 86.0,
      fireLifeMin: 0.85,
      fireLifeMax: 1.55,
      fireOpacityMin: 0.06,
      fireOpacityMax: 0.41,
      fireColorBoostMin: 0.50,
      fireColorBoostMax: 4.50,
      fireSpinEnabled: true,
      fireSpinSpeedMin: 0.2,
      fireSpinSpeedMax: 4.5,

      // Ember fine controls (defaults from tuned UI)
      emberSizeMin: 5.0,
      emberSizeMax: 12.0,
      emberLifeMin: 1.0,
      emberLifeMax: 3.4,
      emberOpacityMin: 0.40,
      emberOpacityMax: 1.00,
      emberColorBoostMin: 1.70,
      emberColorBoostMax: 2.85,

      // New color controls
      fireStartColor: { r: 1.0, g: 1.0, b: 1.0 },
      fireEndColor: { r: 1.0, g: 0.0, b: 0.0 },
      emberStartColor: { r: 1.0, g: 1.0, b: 1.0 },
      emberEndColor: { r: 1.0, g: 0.0, b: 0.0 },

      // Physics controls
      fireUpdraft: 0.85,
      emberUpdraft: 0.15,
      fireCurlStrength: 0.10,
      emberCurlStrength: 3.95,

      // Per-effect time scaling (independent of global Simulation Speed)
      // 1.0 = baseline, >1.0 = faster (shorter lifetimes), <1.0 = slower.
      timeScale: 0.85,
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

  _ensureEmberTexture() {
    const THREE = window.THREE;
    if (!THREE) return null;

    if (!this.emberTexture) {
      const texture = new THREE.TextureLoader().load('modules/map-shine-advanced/assets/particle.webp');
      texture.minFilter = THREE.LinearMipmapLinearFilter;
      texture.magFilter = THREE.LinearFilter;
      texture.generateMipmaps = true;
      this.emberTexture = texture;
    }

    return this.emberTexture;
  }
  
  static getControlSchema() {
    return {
      enabled: true,
      groups: [
        { name: 'fire-main', label: 'Fire - Main', type: 'inline', parameters: ['globalFireRate', 'fireHeight'] },
        { name: 'fire-shape', label: 'Fire - Shape', type: 'inline', parameters: ['fireSizeMin', 'fireSizeMax', 'fireLifeMin', 'fireLifeMax'] },
        { name: 'fire-look', label: 'Fire - Look', type: 'inline', parameters: ['fireOpacityMin', 'fireOpacityMax', 'fireColorBoostMin', 'fireColorBoostMax', 'fireStartColor', 'fireEndColor'] },
        { name: 'fire-spin', label: 'Fire - Spin', type: 'inline', parameters: ['fireSpinEnabled', 'fireSpinSpeedMin', 'fireSpinSpeedMax'] },
        { name: 'fire-physics', label: 'Fire - Physics', type: 'inline', parameters: ['fireUpdraft', 'fireCurlStrength'] },
        { name: 'embers-main', label: 'Embers - Main', type: 'inline', parameters: ['emberRate'] },
        { name: 'embers-shape', label: 'Embers - Shape', type: 'inline', parameters: ['emberSizeMin', 'emberSizeMax', 'emberLifeMin', 'emberLifeMax'] },
        { name: 'embers-look', label: 'Embers - Look', type: 'inline', parameters: ['emberOpacityMin', 'emberOpacityMax', 'emberColorBoostMin', 'emberColorBoostMax', 'emberStartColor', 'emberEndColor'] },
        { name: 'embers-physics', label: 'Embers - Physics', type: 'inline', parameters: ['emberUpdraft', 'emberCurlStrength'] },
        { name: 'env', label: 'Environment', type: 'inline', parameters: ['windInfluence', 'lightIntensity', 'timeScale'] }
      ],
      parameters: {
        enabled: { type: 'checkbox', label: 'Fire Enabled', default: true },
        globalFireRate: { type: 'slider', label: 'Global Intensity', min: 0.0, max: 20.0, step: 0.1, default: 1.9 },
        fireAlpha: { type: 'slider', label: 'Opacity (Legacy)', min: 0.0, max: 1.0, step: 0.01, default: 0.6 },
        fireCoreBoost: { type: 'slider', label: 'Core Boost (Legacy)', min: 0.0, max: 5.0, step: 0.1, default: 1.0 },
        fireHeight: { type: 'slider', label: 'Height', min: 10.0, max: 600.0, step: 10.0, default: 600.0 },
        fireSizeMin: { type: 'slider', label: 'Size Min', min: 1.0, max: 100.0, step: 1.0, default: 11.0 },
        fireSizeMax: { type: 'slider', label: 'Size Max', min: 1.0, max: 150.0, step: 1.0, default: 86.0 },
        fireLifeMin: { type: 'slider', label: 'Life Min (s)', min: 0.1, max: 4.0, step: 0.05, default: 0.85 },
        fireLifeMax: { type: 'slider', label: 'Life Max (s)', min: 0.1, max: 6.0, step: 0.05, default: 1.55 },
        fireOpacityMin: { type: 'slider', label: 'Opacity Min', min: 0.0, max: 1.0, step: 0.01, default: 0.06 },
        fireOpacityMax: { type: 'slider', label: 'Opacity Max', min: 0.0, max: 1.0, step: 0.01, default: 0.41 },
        fireColorBoostMin: { type: 'slider', label: 'Color Boost Min', min: 0.0, max: 2.0, step: 0.05, default: 0.50 },
        fireColorBoostMax: { type: 'slider', label: 'Color Boost Max', min: 0.0, max: 12.0, step: 0.05, default: 4.50 },
        fireStartColor: { type: 'color', default: { r: 1.0, g: 1.0, b: 1.0 } },
        fireEndColor: { type: 'color', default: { r: 1.0, g: 0.0, b: 0.0 } },
        fireSpinEnabled: { type: 'checkbox', label: 'Spin Enabled', default: true },
        fireSpinSpeedMin: { type: 'slider', label: 'Spin Speed Min (rad/s)', min: 0.0, max: 50.0, step: 0.1, default: 0.2 },
        fireSpinSpeedMax: { type: 'slider', label: 'Spin Speed Max (rad/s)', min: 0.0, max: 50.0, step: 0.1, default: 4.5 },
        emberRate: { type: 'slider', label: 'Ember Density', min: 0.0, max: 5.0, step: 0.1, default: 5.0 },
        emberSizeMin: { type: 'slider', label: 'Ember Size Min', min: 1.0, max: 40.0, step: 1.0, default: 5.0 },
        emberSizeMax: { type: 'slider', label: 'Ember Size Max', min: 1.0, max: 60.0, step: 1.0, default: 12.0 },
        emberLifeMin: { type: 'slider', label: 'Ember Life Min (s)', min: 0.1, max: 8.0, step: 0.1, default: 1.0 },
        emberLifeMax: { type: 'slider', label: 'Ember Life Max (s)', min: 0.1, max: 12.0, step: 0.1, default: 3.4 },
        emberOpacityMin: { type: 'slider', label: 'Ember Opacity Min', min: 0.0, max: 1.0, step: 0.01, default: 0.40 },
        emberOpacityMax: { type: 'slider', label: 'Ember Opacity Max', min: 0.0, max: 1.0, step: 0.01, default: 1.00 },
        emberColorBoostMin: { type: 'slider', label: 'Ember Color Boost Min', min: 0.0, max: 2.0, step: 0.05, default: 1.70 },
        emberColorBoostMax: { type: 'slider', label: 'Ember Color Boost Max', min: 0.0, max: 3.0, step: 0.05, default: 2.85 },
        emberStartColor: { type: 'color', default: { r: 1.0, g: 1.0, b: 1.0 } },
        emberEndColor: { type: 'color', default: { r: 1.0, g: 0.0, b: 0.0 } },
        fireUpdraft: { type: 'slider', label: 'Updraft', min: 0.0, max: 12.0, step: 0.05, default: 0.85 },
        emberUpdraft: { type: 'slider', label: 'Updraft', min: 0.0, max: 12.0, step: 0.05, default: 0.15 },
        fireCurlStrength: { type: 'slider', label: 'Curl Strength', min: 0.0, max: 12.0, step: 0.05, default: 0.10 },
        emberCurlStrength: { type: 'slider', label: 'Curl Strength', min: 0.0, max: 12.0, step: 0.05, default: 3.95 },
        windInfluence: { type: 'slider', label: 'Wind Influence', min: 0.0, max: 5.0, step: 0.1, default: 1.4 },
        lightIntensity: { type: 'slider', label: 'Light Intensity', min: 0.0, max: 5.0, step: 0.1, default: 0.9 },
        timeScale: { type: 'slider', label: 'Time Scale', min: 0.1, max: 3.0, step: 0.05, default: 0.85 }
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
      this.particleSystemRef.batchRenderer.addSystem(this.globalSystem);

      this.globalEmbers = this._createEmberSystem({
        shape: shape,
        rate: new IntervalValue(5.0 * this.params.emberRate, 10.0 * this.params.emberRate),
        height: this.params.fireHeight
      });
      this.particleSystemRef.batchRenderer.addSystem(this.globalEmbers);

      this.scene.add(this.globalSystem.emitter);
      this.scene.add(this.globalEmbers.emitter);
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
      depthWrite: false, // Essential for fire to not occlude itself
      depthTest: true,   // Allow it to sit behind tokens/walls
      blending: THREE.AdditiveBlending,
      color: 0xffffff,
      side: THREE.DoubleSide
    });

    const colorOverLife = new ColorOverLife(
        new ColorRange(
            new Vector4(1.2, 1.0, 0.6, 0.2),
            new Vector4(0.8, 0.2, 0.05, 0.0)
        )
    );

    const sizeOverLife = new SizeOverLife(
        new PiecewiseBezier([
            [new Bezier(0.5, 1.2, 1.0, 0.0), 0]
        ])
    );
    
    // Vertical Lift: slightly more aggressive to match tapering
    const buoyancy = new ApplyForce(new THREE.Vector3(0, 0, 1), new ConstantValue(height * 2.5));
    
    const windForce = new ApplyForce(new THREE.Vector3(1, 0, 0), new ConstantValue(0));
    
    // Increased turbulence to break up uniform sprite look
    const fireCurlScale = new THREE.Vector3(150, 150, 50);
    const fireCurlStrengthBase = new THREE.Vector3(80, 80, 30);
    const turbulence = new CurlNoiseField(
        fireCurlScale,
        fireCurlStrengthBase.clone(),
        1.5
    );

    const p = this.params;
    const timeScale = Math.max(0.1, p.timeScale ?? 1.0);

    const baseLifeMin = p.fireLifeMin ?? 0.6;
    const baseLifeMax = p.fireLifeMax ?? 1.2;
    const lifeMin = Math.max(0.01, baseLifeMin / timeScale);
    const lifeMax = Math.max(lifeMin, baseLifeMax / timeScale);
    const sizeMin = Math.max(0.1, p.fireSizeMin ?? (size * 0.8));
    const sizeMax = Math.max(sizeMin, p.fireSizeMax ?? (size * 1.5));

    const opacityMin = Math.max(0.0, Math.min(1.0, p.fireOpacityMin ?? 0.3));
    const opacityMax = Math.max(opacityMin, Math.min(1.0, p.fireOpacityMax ?? 1.0));

    const colorBoostMin = p.fireColorBoostMin ?? 0.8;
    const colorBoostMax = Math.max(colorBoostMin, p.fireColorBoostMax ?? 1.2);

    const fireStart = p.fireStartColor || { r: 1.2, g: 1.0, b: 0.6 };
    const fireEnd = p.fireEndColor || { r: 0.8, g: 0.2, b: 0.05 };

    const system = new ParticleSystem({
      duration: 1,
      looping: true,
      startLife: new IntervalValue(lifeMin, lifeMax),
      startSpeed: new ConstantValue(0),
      startSize: new IntervalValue(sizeMin, sizeMax),
      startColor: new ColorRange(
        new Vector4(
          fireStart.r * colorBoostMin,
          fireStart.g * colorBoostMin,
          fireStart.b * colorBoostMin,
          opacityMin
        ),
        new Vector4(
          fireEnd.r * colorBoostMax,
          fireEnd.g * colorBoostMax,
          fireEnd.b * colorBoostMax,
          opacityMax
        )
      ),
      worldSpace: true,
      maxParticles: 10000,
      emissionOverTime: rate,
      shape: shape,
      material: material,
      renderMode: RenderMode.BillBoard,
      renderOrder: 50,
      // Randomize initial sprite orientation so flames feel more chaotic.
      startRotation: new IntervalValue(0, Math.PI * 2),
      behaviors: [
          colorOverLife,
          sizeOverLife,
          buoyancy,
          windForce,
          turbulence,
          new FireSpinBehavior()
      ]
    });
    
    system.userData = {
      windForce,
      ownerEffect: this,
      updraftForce: buoyancy,
      baseUpdraftMag: height * 2.5,
      turbulence,
      baseCurlStrength: fireCurlStrengthBase.clone()
    };
    
    return system;
  }

  _createEmberSystem(opts) {
    const { shape, rate, height } = opts;
    const THREE = window.THREE;

    const material = new THREE.MeshBasicMaterial({
      map: this._ensureEmberTexture(),
      transparent: true,
      blending: THREE.AdditiveBlending,
      color: 0xffaa00,
      depthWrite: false,
      depthTest: true
    });

    const p = this.params;
    const timeScale = Math.max(0.1, p.timeScale ?? 1.0);

    const baseLifeMin = p.emberLifeMin ?? 1.5;
    const baseLifeMax = p.emberLifeMax ?? 3.0;
    const lifeMin = Math.max(0.01, baseLifeMin / timeScale);
    const lifeMax = Math.max(lifeMin, baseLifeMax / timeScale);
    const sizeMin = Math.max(0.1, p.emberSizeMin ?? 4.0);
    const sizeMax = Math.max(sizeMin, p.emberSizeMax ?? 10.0);

    const opacityMin = Math.max(0.0, Math.min(1.0, p.emberOpacityMin ?? 0.4));
    const opacityMax = Math.max(opacityMin, Math.min(1.0, p.emberOpacityMax ?? 1.0));

    const colorBoostMin = p.emberColorBoostMin ?? 0.9;
    const colorBoostMax = Math.max(colorBoostMin, p.emberColorBoostMax ?? 1.5);

    const emberStart = p.emberStartColor || { r: 1.0, g: 0.8, b: 0.4 };
    const emberEnd = p.emberEndColor || { r: 1.0, g: 0.2, b: 0.0 };

    const emberCurlScale = new THREE.Vector3(30, 30, 30);
    const emberCurlStrengthBase = new THREE.Vector3(150, 150, 50);

    const system = new ParticleSystem({
      duration: 1,
      looping: true,
      startLife: new IntervalValue(lifeMin, lifeMax),
      startSpeed: new ConstantValue(0),
      startSize: new IntervalValue(sizeMin, sizeMax),
      startColor: new ColorRange(
        new Vector4(
          emberStart.r * colorBoostMin,
          emberStart.g * colorBoostMin,
          emberStart.b * colorBoostMin,
          opacityMin
        ),
        new Vector4(
          emberEnd.r * colorBoostMax,
          emberEnd.g * colorBoostMax,
          emberEnd.b * colorBoostMax,
          opacityMax
        )
      ),
      worldSpace: true,
      maxParticles: 2000,
      emissionOverTime: rate,
      shape: shape,
      material: material,
      renderMode: RenderMode.BillBoard,
      renderOrder: 51,
      behaviors: [
        new ApplyForce(new THREE.Vector3(0, 0, 1), new ConstantValue(height * 8.0)),
        new ApplyForce(new THREE.Vector3(1, 0, 0), new ConstantValue(0)),
        new CurlNoiseField(
          emberCurlScale,
          emberCurlStrengthBase.clone(),
          4.0
        ),
        new SizeOverLife(new PiecewiseBezier([[new Bezier(1, 0.9, 0.5, 0), 0]]))
      ]
    });

    system.userData = {
      windForce: system.behaviors.find(b => b instanceof ApplyForce && b.direction.x === 1),
      updraftForce: system.behaviors.find(b => b instanceof ApplyForce && b.direction.z === 1),
      baseUpdraftMag: height * 8.0,
      turbulence: system.behaviors.find(b => b instanceof CurlNoiseField),
      baseCurlStrength: emberCurlStrengthBase.clone(),
      isEmber: true,
      ownerEffect: this
    };

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
  
  applyParamChange(paramId, value) {
    if (this.params && Object.prototype.hasOwnProperty.call(this.params, paramId)) {
      this.params[paramId] = value;
    }
    if (paramId === 'enabled' || paramId === 'masterEnabled') {
      this.settings.enabled = value;
      if (this.params) {
        this.params.enabled = value;
      }
    }
  }
  
  update(timeInfo) {
    if (!this.settings.enabled) return;
    const t = timeInfo.elapsed;
    const THREE = window.THREE;

    // 1. Animate Lights (Flicker)
    const baseLightIntensity = (this.params && typeof this.params.lightIntensity === 'number')
      ? this.params.lightIntensity
      : (this.settings.lightIntensity || 1.0);

    // Chaotic multi-sine flicker to avoid smooth, gamey pulsing
    const flicker =
      Math.sin(t * 10.0) * 0.1 +
      Math.sin(t * 22.0) * 0.1 +
      Math.sin(t * 43.0) * 0.1;

    for (const f of this.fires) {
        // Added pseudo-random phase based on ID to desync lights
        const phase = f.id ? f.id.charCodeAt(0) : 0;
        const phaseFlicker = flicker + Math.sin(t * 17.0 + phase * 0.01) * 0.05;
        f.light.intensity = baseLightIntensity * (1.0 + phaseFlicker);
    }

    // 2. Update Global Fire Rate
    if (this.globalSystem) {
        const baseRate = 200.0 * this.params.globalFireRate; 
        this.globalSystem.emissionOverTime = new IntervalValue(baseRate * 0.8, baseRate * 1.2);
    }

    // 3. Apply Wind Forces
    // Map global wind vectors to ApplyForce behavior
    const windSpeed = weatherController.currentState.windSpeed || 0;
    const windDir = weatherController.currentState.windDirection || { x: 1, y: 0 };
    
    // Convert normalized 2D wind to 3D force vector
    const influence = (this.params && typeof this.params.windInfluence === 'number')
      ? this.params.windInfluence
      : (this.settings.windInfluence || 1.0);
    // Base force magnitude: 300 feels right for fire leaning
    const forceMag = windSpeed * 300.0 * influence; 

    // Collect all active systems
    const systems = [];
    if (this.globalSystem) systems.push(this.globalSystem);
    if (this.globalEmbers) systems.push(this.globalEmbers);
    for (const f of this.fires) systems.push(f.system);

    const p = this.params;
    const clamp01 = x => Math.max(0.0, Math.min(1.0, x));
    const timeScale = Math.max(0.1, p.timeScale ?? 1.0);

    for (const sys of systems) {
        const isEmber = !!(sys.userData && sys.userData.isEmber);

        // 3a. Wind force per-system
        if (sys.userData && sys.userData.windForce) {
            const wf = sys.userData.windForce;
            const multiplier = isEmber ? 1.5 : 1.0;
            if (wf.direction) {
                wf.direction.set(windDir.x, windDir.y, 0);
            }
            if (wf.magnitude) {
                wf.magnitude = new ConstantValue(forceMag * multiplier);
            }
        }

        // 3b. Updraft and curl noise per-system (physics controls)
        const updraftParam = isEmber ? (p.emberUpdraft ?? 1.0) : (p.fireUpdraft ?? 1.0);
        const curlParam = isEmber ? (p.emberCurlStrength ?? 1.0) : (p.fireCurlStrength ?? 1.0);

        if (sys.userData && sys.userData.updraftForce && typeof sys.userData.baseUpdraftMag === 'number') {
            const uf = sys.userData.updraftForce;
            const baseMag = sys.userData.baseUpdraftMag;
            if (typeof uf.magnitude !== 'undefined') {
                uf.magnitude = new ConstantValue(baseMag * Math.max(0.0, updraftParam));
            }
        }

        if (sys.userData && sys.userData.turbulence && sys.userData.baseCurlStrength && THREE && sys.userData.turbulence.strength) {
            const baseStrength = sys.userData.baseCurlStrength;
            sys.userData.turbulence.strength.copy(baseStrength).multiplyScalar(Math.max(0.0, curlParam));
        }

        if (isEmber) {
            const baseEmberLifeMin = p.emberLifeMin ?? 1.5;
            const baseEmberLifeMax = p.emberLifeMax ?? 3.0;
            const lifeMin = Math.max(0.01, baseEmberLifeMin / timeScale);
            const lifeMax = Math.max(lifeMin, baseEmberLifeMax / timeScale);
            const sizeMin = Math.max(0.1, p.emberSizeMin ?? 3.0);
            const sizeMax = Math.max(sizeMin, p.emberSizeMax ?? 14.0);
            const opacityMin = clamp01(p.emberOpacityMin ?? 0.4);
            const opacityMax = Math.max(opacityMin, clamp01(p.emberOpacityMax ?? 1.0));
            const colorBoostMin = p.emberColorBoostMin ?? 0.9;
            const colorBoostMax = Math.max(colorBoostMin, p.emberColorBoostMax ?? 1.5);

            const emberStart = p.emberStartColor || { r: 1.0, g: 0.8, b: 0.4 };
            const emberEnd = p.emberEndColor || { r: 1.0, g: 0.2, b: 0.0 };

            sys.startLife = new IntervalValue(lifeMin, lifeMax);
            sys.startSize = new IntervalValue(sizeMin, sizeMax);
            sys.startColor = new ColorRange(
              new Vector4(
                emberStart.r * colorBoostMin,
                emberStart.g * colorBoostMin,
                emberStart.b * colorBoostMin,
                opacityMin
              ),
              new Vector4(
                emberEnd.r * colorBoostMax,
                emberEnd.g * colorBoostMax,
                emberEnd.b * colorBoostMax,
                opacityMax
              )
            );
        } else {
            const baseFireLifeMin = p.fireLifeMin ?? 0.4;
            const baseFireLifeMax = p.fireLifeMax ?? 1.6;
            const lifeMin = Math.max(0.01, baseFireLifeMin / timeScale);
            const lifeMax = Math.max(lifeMin, baseFireLifeMax / timeScale);
            const rawOpMin = p.fireOpacityMin ?? 0.25;
            const rawOpMax = p.fireOpacityMax ?? 0.68;
            const opacityMin = clamp01(rawOpMin * 0.4);
            const opacityMax = Math.max(opacityMin, clamp01(rawOpMax * 0.5));
            const sizeMin = Math.max(0.1, p.fireSizeMin ?? 10.0);
            const sizeMax = Math.max(sizeMin, p.fireSizeMax ?? 40.0);
            const colorBoostMin = p.fireColorBoostMin ?? 0.8;
            const colorBoostMax = Math.max(colorBoostMin, p.fireColorBoostMax ?? 1.2);

            const fireStart = p.fireStartColor || { r: 1.2, g: 1.0, b: 0.6 };
            const fireEnd = p.fireEndColor || { r: 0.8, g: 0.2, b: 0.05 };

            sys.startLife = new IntervalValue(lifeMin, lifeMax);
            sys.startSize = new IntervalValue(sizeMin, sizeMax);
            sys.startColor = new ColorRange(
              new Vector4(
                fireStart.r * colorBoostMin,
                fireStart.g * colorBoostMin,
                fireStart.b * colorBoostMin,
                opacityMin
              ),
              new Vector4(
                fireEnd.r * colorBoostMax,
                fireEnd.g * colorBoostMax,
                fireEnd.b * colorBoostMax,
                opacityMax
              )
            );

            if (Array.isArray(sys.behaviors)) {
              const col = sys.behaviors.find(b => b && (b.type === 'ColorOverLife' || b.constructor?.name === 'ColorOverLife'));
              if (col) {
                const startVec = new Vector4(
                  fireStart.r * colorBoostMax,
                  fireStart.g * colorBoostMax,
                  fireStart.b * colorBoostMax,
                  1.0
                );
                const endVec = new Vector4(
                  fireEnd.r * colorBoostMax,
                  fireEnd.g * colorBoostMax,
                  fireEnd.b * colorBoostMax,
                  0.0
                );
                col.color = new ColorRange(startVec, endVec);
              }
            }
        }

        const baseLifeMinRaw = isEmber ? (p.emberLifeMin ?? 1.5) : (p.fireLifeMin ?? 0.6);
        const baseLifeMaxRaw = isEmber ? (p.emberLifeMax ?? 3.0) : (p.fireLifeMax ?? 1.2);
        const baseLifeMin = baseLifeMinRaw / timeScale;
        const baseLifeMax = baseLifeMaxRaw / timeScale;

        if (windSpeed > 0.1) {
            const factor = 1.0 - (windSpeed * 0.6);
            const minLife = Math.max(0.1, baseLifeMin * factor);
            const maxLife = Math.max(minLife, baseLifeMax * factor);
            sys.startLife = new IntervalValue(minLife, maxLife);
        }
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
      if (this.globalEmbers && this.particleSystemRef?.batchRenderer) {
          this.particleSystemRef.batchRenderer.deleteSystem(this.globalEmbers);
      }
      super.dispose();
  }
}
