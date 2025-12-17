import { 
  ParticleSystem, 
  IntervalValue, 
  ColorRange, 
  Vector4, 
  RenderMode,
  ConstantValue,
  BatchedRenderer,
  ApplyForce,
  ColorOverLife,
  TurbulenceField,
  CurlNoiseField,
  SizeOverLife,
  PiecewiseBezier,
  Bezier
} from '../libs/three.quarks.module.js';
import { createLogger } from '../core/log.js';
import { weatherController } from '../core/WeatherController.js';

const log = createLogger('WeatherParticles');

class RandomRectangleEmitter {
  constructor(parameters = {}) {
    this.type = 'random-rectangle';
    this.width = parameters.width ?? 1;
    this.height = parameters.height ?? 1;
  }

  initialize(particle) {
    const x = (Math.random() - 0.5) * this.width;
    const y = (Math.random() - 0.5) * this.height;
    particle.position.x = x;
    particle.position.y = y;
    particle.position.z = 0;
    particle.velocity.set(0, 0, particle.startSpeed);
  }

  update(system, delta) { /* no-op for now */ }
}

class ShorelineFoamEmitter {
  constructor(parameters = {}) {
    this.type = 'shoreline-foam';
    this.width = parameters.width ?? 1;
    this.height = parameters.height ?? 1;
    this.sceneX = parameters.sceneX ?? 0;
    this.sceneY = parameters.sceneY ?? 0;
    this.totalHeight = parameters.totalHeight ?? this.height;
    this.centerX = parameters.centerX ?? (this.sceneX + this.width / 2);
    this.centerY = parameters.centerY ?? (this.sceneY + this.height / 2);
    this._offsetY = (this.totalHeight - this.sceneY - this.height);

    this._points = null;
  }

  setPoints(points) {
    this._points = points && points.length ? points : null;
  }

  clearPoints() {
    this._points = null;
  }

  initialize(particle) {
    const pts = this._points;
    if (pts && pts.length >= 4) {
      const count = Math.floor(pts.length / 4);
      const idx = (Math.floor(Math.random() * count) * 4);
      const u = pts[idx];
      const v = pts[idx + 1];
      const nx = pts[idx + 2];
      const ny = pts[idx + 3];

      const worldX = this.sceneX + u * this.width;
      const worldY = this._offsetY + (1.0 - v) * this.height;

      particle.position.x = worldX - this.centerX;
      particle.position.y = worldY - this.centerY;
      particle.position.z = 0;

      if (typeof particle.rotation === 'number') {
        particle.rotation = Math.atan2(ny, nx);
      }

      particle.velocity.set(0, 0, particle.startSpeed);
      return;
    }

    const x = (Math.random() - 0.5) * this.width;
    const y = (Math.random() - 0.5) * this.height;
    particle.position.x = x;
    particle.position.y = y;
    particle.position.z = 0;
    particle.velocity.set(0, 0, particle.startSpeed);
  }

  update(system, delta) { /* no-op for now */ }
}

class WaterMaskedSplashEmitter {
  constructor(parameters = {}) {
    this.type = 'water-masked-splash';
    this.width = parameters.width ?? 1;
    this.height = parameters.height ?? 1;
    this.sceneX = parameters.sceneX ?? 0;
    this.sceneY = parameters.sceneY ?? 0;
    this.totalHeight = parameters.totalHeight ?? this.height;
    this.centerX = parameters.centerX ?? (this.sceneX + this.width / 2);
    this.centerY = parameters.centerY ?? (this.sceneY + this.height / 2);
    this._offsetY = (this.totalHeight - this.sceneY - this.height);

    this._points = null;
  }

  setPoints(points) {
    this._points = points && points.length ? points : null;
  }

  clearPoints() {
    this._points = null;
  }

  initialize(particle) {
    const pts = this._points;
    if (pts && pts.length >= 2) {
      const count = Math.floor(pts.length / 2);
      const idx = (Math.floor(Math.random() * count) * 2);
      const u = pts[idx];
      const v = pts[idx + 1];

      const worldX = this.sceneX + u * this.width;
      const worldY = this._offsetY + (1.0 - v) * this.height;

      particle.position.x = worldX - this.centerX;
      particle.position.y = worldY - this.centerY;
      particle.position.z = 0;
      particle.velocity.set(0, 0, particle.startSpeed);
      return;
    }

    const x = (Math.random() - 0.5) * this.width;
    const y = (Math.random() - 0.5) * this.height;
    particle.position.x = x;
    particle.position.y = y;
    particle.position.z = 0;
    particle.velocity.set(0, 0, particle.startSpeed);
  }

  update(system, delta) { /* no-op for now */ }
}

// Behavior: kill particles once they leave the world volume.
//
// Quarks runs all behaviors on the CPU each frame. Particles are removed
// from the system when `particle.died` becomes true, which in turn is
// driven by `particle.age >= particle.life` in the core update loop.
//
// This behavior therefore:
// 1. Converts the particle position into WORLD space (using emitter.matrixWorld)
//    so the test matches Foundry's scene rectangle.
// 2. Compares that world position against a world-space AABB.
// 3. Forces `age >= life` when a particle exits the box so Quarks culls it
//    immediately on the next core update.
//
// The world-space AABB itself is defined once in _initSystems from
// canvas.dimensions: [sceneX, sceneY, sceneWidth, sceneHeight] in X/Y and
// fixed 0..7500 in Z, matching the "scene volume" we treat as valid world.
// Any particle outside that 3D box is considered out-of-world and safe to cull.
class WorldVolumeKillBehavior {
  constructor(min, max) {
    this.type = 'WorldVolumeKill';
    this.min = min.clone();
    this.max = max.clone();
    // PERFORMANCE FIX: Reuse a single Vector3 for world-space transforms
    // instead of allocating a new one per particle per frame.
    // This eliminates massive GC pressure that caused pan/zoom hitches.
    this._tempVec = new window.THREE.Vector3();
  }

  initialize(particle, system) { /* no-op */ }

  update(particle, delta, system) {
    const p = particle.position;
    if (!p) return;

    // Convert to world space using the emitter's matrixWorld when available,
    // so this behavior works whether the system uses local or world space.
    let wx = p.x;
    let wy = p.y;
    let wz = p.z;

    if (system && system.emitter && system.emitter.matrixWorld) {
      // PERFORMANCE: Reuse _tempVec instead of allocating new Vector3
      this._tempVec.set(p.x, p.y, p.z);
      this._tempVec.applyMatrix4(system.emitter.matrixWorld);
      wx = this._tempVec.x;
      wy = this._tempVec.y;
      wz = this._tempVec.z;
    }

    if (
      wx < this.min.x || wx > this.max.x ||
      wy < this.min.y || wy > this.max.y ||
      wz < this.min.z || wz > this.max.z
    ) {
      // Mark particle as dead by forcing its age beyond lifetime.
      if (typeof particle.life === 'number') {
        particle.age = particle.life;
      } else {
        // Fallback: very large age so any age>=life check passes.
        particle.age = 1e9;
      }
    }
  }

  frameUpdate(delta) { /* no-op */ }

  clone() {
    return new WorldVolumeKillBehavior(this.min, this.max);
  }

  reset() { /* no-op */ }
}

class RainFadeInBehavior {
  constructor() {
    this.type = 'RainFadeIn';
    this.fadeDuration = 1.0;
  }

  initialize(particle, system) {
    if (particle && particle.color) {
      particle._baseAlpha = particle.color.w;
      particle.color.w = 0;
    }
  }

  update(particle, delta, system) {
    if (!particle || typeof particle.age !== 'number' || !particle.color) return;

    // If a particle has "landed" (used by SnowFloorBehavior), skip the
    // fade-in logic so the floor behavior can own alpha over time.
    if (particle._landed) return;

    const t = Math.min(Math.max(particle.age / this.fadeDuration, 0), 1);
    const baseA = typeof particle._baseAlpha === 'number' ? particle._baseAlpha : 1.0;
    particle.color.w = baseA * t;
  }

  frameUpdate(delta) { /* no-op */ }

  clone() {
    const b = new RainFadeInBehavior();
    b.fadeDuration = this.fadeDuration;
    return b;
  }

  reset() { /* no-op */ }
}

// Snow-specific flutter behavior to create the classic "paper falling" sway.
// This operates in world space and adds a gentle, per-particle sine-wave drift
// primarily along the X axis (with a small Y component) as flakes fall.
class SnowFlutterBehavior {
  constructor() {
    this.type = 'SnowFlutter';
    this.strength = 1.0;
  }

  initialize(particle, system) {
    // Assign per-particle random parameters once.
    if (!particle._flutterPhase) {
      particle._flutterPhase = Math.random() * Math.PI * 2;
      // Slight variation in how quickly each flake rocks.
      particle._flutterSpeed = 0.5 + Math.random() * 0.5; // 0.5–1.0 Hz
      // World-space sway amplitude in units per second.
      particle._flutterAmplitude = 40 + Math.random() * 60; // 40–100
      // Small bias so some flakes drift slightly "into" or "out of" camera.
      particle._flutterBiasY = (Math.random() - 0.5) * 0.25;
    }
  }

  update(particle, delta, system) {
    if (!particle || typeof particle.age !== 'number') return;

    // Once a flake has landed, SnowFloorBehavior owns its motion; do not
    // continue to flutter it across the ground.
    if (particle._landed) return;

    const t = particle.age;
    const phase = particle._flutterPhase || 0;
    const speed = particle._flutterSpeed || 0.7;
    const amp = particle._flutterAmplitude || 60;
    const biasY = particle._flutterBiasY || 0.0;

    // Sine-based oscillation controlling lateral displacement.
    const osc = Math.sin(t * speed + phase);
    const sway = osc * amp * delta * this.strength;

    // Apply primarily along X, with a subtle Y wobble bias.
    if (particle.position) {
      particle.position.x += sway;
      particle.position.y += sway * 0.2 + biasY * delta * amp * 0.25;
    }
  }

  frameUpdate(delta) { /* no-op */ }

  clone() {
    return new SnowFlutterBehavior();
  }

  reset() { /* no-op */ }
}

// Snow spin behavior: gives each flake a gentle, per-particle rotation while
// it is airborne. Rotation is stopped automatically once SnowFloorBehavior
// marks the particle as "landed" via the _landed flag.
class SnowSpinBehavior {
  constructor() {
    this.type = 'SnowSpin';
    this.strength = 1.0;
  }

  initialize(particle, system) {
    if (!particle) return;

    // Assign a small per-particle spin speed if not already present. Allow
    // clockwise and counter-clockwise rotation with slight variation.
    if (typeof particle._spinSpeed !== 'number') {
      const base = 1.2 + Math.random() * 1.2; // 1.2–2.4 rad/s for stronger visible spin
      const dir = Math.random() < 0.5 ? -1 : 1;
      particle._spinSpeed = base * dir;
    }
  }

  update(particle, delta, system) {
    if (!particle || typeof delta !== 'number') return;

    // Once the flake has landed, we no longer adjust rotation so it appears
    // settled on the ground.
    if (particle._landed) return;

    if (typeof particle.rotation === 'number' && typeof particle._spinSpeed === 'number') {
      // Drive tumbling intensity from current wind speed so calm snow
      // drifts with gentle spin while storms look much more chaotic.
      let wind = 0;
      try {
        if (weatherController && weatherController.currentState) {
          wind = weatherController.currentState.windSpeed || 0;
        }
      } catch (e) {
        wind = 0;
      }

      // 0 wind -> ~0.4x base spin, 1.0 wind -> ~3x base spin.
      const windFactor = 0.4 + 2.6 * Math.max(0, Math.min(1, wind));
      particle.rotation += particle._spinSpeed * this.strength * windFactor * delta;
    }
  }

  frameUpdate(delta) { /* no-op */ }

  clone() {
    const b = new SnowSpinBehavior();
    b.strength = this.strength;
    return b;
  }

  reset() { /* no-op */ }
}

// Snow floor behavior: when flakes reach the ground plane (z <= groundZ), stop their
// motion and fade them out over a short duration before killing them. This
// gives the impression of flakes "settling" on the ground instead of popping
// out of existence.
class SnowFloorBehavior {
  constructor() {
    this.type = 'SnowFloor';
    // Quarks internally clamps its per-frame delta to 0.1, and our
    // ParticleSystem feeds it an upscaled dt. A value around 1.0 here
    // corresponds to roughly ~2 seconds of real-time fade in practice.
    this.fadeDuration = 1.0;
    // Cache groundZ from SceneComposer; updated lazily in update() if needed.
    this._groundZ = null;
    this._tempVec = null;
  }

  /**
   * Get the ground plane Z position from SceneComposer.
   * @returns {number} Ground Z position (default 1000)
   * @private
   */
  _getGroundZ() {
    // Return cached value if available
    if (this._groundZ !== null) return this._groundZ;
    
    const sceneComposer = window.MapShine?.sceneComposer;
    if (sceneComposer && typeof sceneComposer.groundZ === 'number') {
      this._groundZ = sceneComposer.groundZ;
      return this._groundZ;
    }
    return 1000; // Default ground plane Z
  }

  initialize(particle, system) {
    if (!particle) return;
    // Ensure landing flags are cleared on spawn.
    particle._landed = false;
    particle._landedAgeStart = 0;
    particle._landedBaseAlpha = undefined;
    particle._landedBaseSize = undefined;
    particle._landedPosition = undefined;
  }

  update(particle, delta, system) {
    if (!particle || !particle.position) return;

    // Already landed: keep them fixed and drive fade-out.
    if (particle._landed) {
      if (particle.velocity) {
        particle.velocity.set(0, 0, 0);
      }

      // Pin position to the landing point so external forces/behaviors cannot
      // slide the flake across the ground while it is shrinking.
      if (particle.position && particle._landedPosition) {
        particle.position.copy(particle._landedPosition);
      }

      if (particle.color) {
        const startAge = particle._landedAgeStart || 0;
        const baseA = (typeof particle._landedBaseAlpha === 'number') ? particle._landedBaseAlpha : particle.color.w;
        const t = Math.min(Math.max((particle.age - startAge) / this.fadeDuration, 0), 1);
        particle.color.w = baseA * (1.0 - t);

        // When fully faded, mark as dead by forcing age beyond lifetime.
        if (t >= 1.0) {
          if (typeof particle.life === 'number') {
            particle.age = particle.life;
          } else {
            particle.age = 1e9;
          }
        }
      }

      // Shrink the flake as it fades out.
      if (particle.size) {
        // Cache the size at the moment of landing so we shrink from that.
        if (!particle._landedBaseSize) {
          particle._landedBaseSize = particle.size.clone();
        }
        const startAge = particle._landedAgeStart || 0;
        const t = Math.min(Math.max((particle.age - startAge) / this.fadeDuration, 0), 1);
        const scale = 1.0 - t;
        particle.size.copy(particle._landedBaseSize).multiplyScalar(scale);
      }

      return;
    }

    // Not yet landed: check for contact with the ground plane.
    const groundZ = this._getGroundZ();
    let z = particle.position.z;
    const THREE = window.THREE;

    if (system && system.emitter && system.emitter.matrixWorld && THREE) {
      if (!this._tempVec) this._tempVec = new THREE.Vector3();
      this._tempVec.set(particle.position.x, particle.position.y, particle.position.z);
      this._tempVec.applyMatrix4(system.emitter.matrixWorld);
      z = this._tempVec.z;
    }
    if (z <= groundZ) {
      particle._landed = true;
      particle._landedAgeStart = typeof particle.age === 'number' ? particle.age : 0;
      if (particle.color) {
        particle._landedBaseAlpha = particle.color.w;
      }
      if (particle.size) {
        particle._landedBaseSize = particle.size.clone();
      }
      if (particle.position) {
        particle._landedPosition = particle.position.clone();
      }
      // Ensure the particle lives at least long enough to complete the fade.
      if (typeof particle.life === 'number' && typeof particle.age === 'number') {
        const minLife = particle.age + this.fadeDuration;
        if (particle.life < minLife) {
          particle.life = minLife;
        }
      }
      if (particle.velocity) {
        particle.velocity.set(0, 0, 0);
      }
    }
  }

  frameUpdate(delta) { /* no-op */ }

  clone() {
    const b = new SnowFloorBehavior();
    b.fadeDuration = this.fadeDuration;
    return b;
  }

  reset() { /* no-op */ }
}

// NOTE: For both rain and snow we now treat particle.position as world-space
// (worldSpace: true in the Quarks systems) and define the kill volume
// directly from the scene rectangle and 0..7500 height.

// Custom behavior to handle 0 -> 10% -> 0% opacity over life
class SplashAlphaBehavior {
  constructor(peakOpacity = 0.1) {
    this.type = 'SplashAlpha';
    this.peakOpacity = peakOpacity;
  }

  initialize(particle, system) {
    // No init needed, we drive alpha every frame
  }

  update(particle, delta, system) {
    if (!particle || typeof particle.age !== 'number') return;
    
    // Normalized life 0..1
    const t = particle.age / particle.life;
    
    let alpha = 0;
    if (t < 0.5) {
      // 0.0 -> 0.5 maps to 0.0 -> peak
      alpha = (t * 2.0) * this.peakOpacity;
    } else {
      // 0.5 -> 1.0 maps to peak -> 0.0
      alpha = ((1.0 - t) * 2.0) * this.peakOpacity;
    }
    
    // Apply to particle color alpha (w)
    if (particle.color) {
        particle.color.w = alpha;
    }
  }

  frameUpdate(delta) {}
  clone() { return new SplashAlphaBehavior(this.peakOpacity); }
  reset() {}
}

export class WeatherParticles {
  constructor(batchRenderer, scene) {
    this.batchRenderer = batchRenderer;
    this.scene = scene;
    this.rainSystem = null;
    this.snowSystem = null;
    this.splashSystem = null;
    this.splashSystems = [];
    this.rainTexture = this._createRainTexture();
    this.snowTexture = this._createSnowTexture();
    this.splashTexture = this._createSplashTexture();
    this.foamTexture = this._createFoamTexture();
    this.enabled = true;
    this._time = 0;

    this._splashShape = null;

    this._waterHitMaskUuid = null;
    this._waterHitPoints = null;
    this._waterHitShape = null;

    this._shoreFoamMaskUuid = null;
    this._shoreFoamPoints = null;
    this._shoreFoamShape = null;

    this._waterMaskThreshold = 0.15;
    this._waterMaskStride = 2;
    this._waterMaskMaxPoints = 20000;

    this._rainMaterial = null;
    this._snowMaterial = null;
    this._splashMaterial = null;
    this._foamMaterial = null;

    // ROOF / _OUTDOORS MASK INTEGRATION (high level):
    // - WeatherController owns the _Outdoors texture (roofMap) and two flags:
    //     * roofMaskActive: driven by TileManager when any overhead roof is hover-hidden.
    //     * roofMaskForceEnabled: manual override from the UI.
    // - ParticleSystem.update computes the Foundry scene bounds vector
    //   [sceneX, sceneY, sceneWidth, sceneHeight] each frame and passes it to
    //   WeatherParticles.update so we can project world X/Y into 0..1 mask UVs.
    // - WeatherParticles caches that bounds vector here as a THREE.Vector4 and
    //   reads roofMap/roofMask* from WeatherController each frame.
    // - For rendering, we do NOT touch the internal quarks shaders directly in
    //   user code. Instead we call _patchRoofMaskMaterial on both the source
    //   MeshBasicMaterials (rain/snow) and the SpriteBatch ShaderMaterials
    //   created by three.quarks' BatchedRenderer.
    // - _patchRoofMaskMaterial injects a world-space position varying and a
    //   small fragment mask block into those shaders, then we drive three
    //   uniforms each frame:
    //       uRoofMap       : sampler2D for the _Outdoors mask
    //       uSceneBounds   : (sceneX, sceneY, sceneWidth, sceneHeight)
    //       uRoofMaskEnabled : 0/1 gate from WeatherController flags
    //   so any future batched effects can follow the same pattern.

    /** @type {THREE.Texture|null} cached roof/outdoors mask texture */
    this._roofTexture = null;

    /** @type {THREE.Vector4|null} cached scene bounds for mask projection */
    this._sceneBounds = null;

    this._rainWindForce = null;
    this._snowWindForce = null;
    this._rainGravityForce = null;
    this._snowGravityForce = null;
    this._snowFlutter = null; // legacy; no longer used in behaviors
    this._snowCurl = null;
    this._snowCurlBaseStrength = null;
    this._rainCurl = null;
    this._rainCurlBaseStrength = null;

    /** @type {SplashAlphaBehavior|null} */
    this._splashAlphaBehavior = null;

    /** @type {SplashAlphaBehavior[]} */
    this._splashAlphaBehaviors = [];

    /** @type {ApplyForce[]} */
    this._splashWindForces = [];

    this._rainBaseGravity = 2500;
    this._snowBaseGravity = 3000;

    /** @type {THREE.ShaderMaterial|null} quarks batch material for rain */
    this._rainBatchMaterial = null;

    /** @type {THREE.ShaderMaterial|null} quarks batch material for snow */
    this._snowBatchMaterial = null;

    /** @type {THREE.ShaderMaterial|null} quarks batch material for splashes */
    this._splashBatchMaterial = null;

    /** @type {THREE.ShaderMaterial[]} quarks batch materials for per-tile splash systems */
    this._splashBatchMaterials = [];

    this._waterHitSplashSystems = [];
    this._waterHitSplashBatchMaterials = [];

    this._foamSystem = null;
    this._foamBatchMaterial = null;

    // Cache to avoid recomputing rain material/particle properties every frame.
    // We track key tuning values so we only update Quarks when they actually change.
    this._lastRainTuning = {
      brightness: null,
      dropSize: null,
      dropSizeMin: null,
      dropSizeMax: null,
      streakLength: null
    };

    // PERFORMANCE FIX: Reuse Vector3 for wind direction calculations in update()
    // instead of allocating a new one every frame.
    this._tempWindDir = new window.THREE.Vector3();

    this._initSystems();
  }

  _createRainTexture() {
    // Standard white streak
    const THREE = window.THREE;
    if (!THREE) return null;

    const texture = new THREE.TextureLoader().load('modules/map-shine-advanced/assets/rain.webp');
    texture.wrapS = THREE.ClampToEdgeWrapping;
    texture.wrapT = THREE.ClampToEdgeWrapping;
    texture.minFilter = THREE.LinearMipmapLinearFilter;
    texture.magFilter = THREE.LinearFilter;
    texture.generateMipmaps = true;
    texture.needsUpdate = true;
    return texture;
  }

_createSnowTexture() {
  // 1. INCREASE RESOLUTION
  // Bumped from 32 to 64 per cell. This creates a 128x128 texture.
  // This ensures flakes look crisp when they fall close to the camera.
  const cellSize = 64;
  const grid = 2;
  const totalSize = cellSize * grid;

  const canvas = document.createElement('canvas');
  canvas.width = totalSize;
  canvas.height = totalSize;
  const ctx = canvas.getContext('2d');

  const drawFlakeInCell = (cellX, cellY, variant) => {
    const cx = cellX * cellSize + cellSize / 2;
    const cy = cellY * cellSize + cellSize / 2;
    
    // 2. PADDING
    // We leave a roughly 4px gap between the flake and the cell edge.
    // This prevents "texture bleeding" (lines from one flake showing up on another)
    // when Mipmaps blur the texture at a distance.
    const maxRadius = (cellSize / 2) - 4;

    ctx.save();
    ctx.translate(cx, cy);

    // 3. THE "BOKEH" GLOW
    // A soft radial background that gives the flake volume and makes it
    // visible even if the fine structural lines are too small to see.
    const glow = ctx.createRadialGradient(0, 0, 0, 0, 0, maxRadius);
    glow.addColorStop(0, 'rgba(255, 255, 255, 0.8)');   // Bright center
    glow.addColorStop(0.3, 'rgba(255, 255, 255, 0.2)'); // Soft core
    glow.addColorStop(1, 'rgba(255, 255, 255, 0)');     // Fade out
    ctx.fillStyle = glow;
    ctx.beginPath();
    ctx.arc(0, 0, maxRadius, 0, Math.PI * 2);
    ctx.fill();

    // 4. CRYSTALLINE STRUCTURE
    // Real snowflakes have hexagonal symmetry. We draw one "arm"
    // and rotate it 6 times.
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.95)';
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    // A white shadow creates a "bloom" effect
    ctx.shadowColor = "rgba(255, 255, 255, 1)"; 
    ctx.shadowBlur = 4;

    for (let i = 0; i < 6; i++) {
      ctx.save(); 
      ctx.rotate((Math.PI / 3) * i); // Rotate 60 degrees per arm

      ctx.beginPath();
      
      if (variant === 0) {
        // Variant 1: The Classic Star
        ctx.lineWidth = 3;
        ctx.moveTo(0, 0);
        ctx.lineTo(0, maxRadius * 0.8);
      } 
      else if (variant === 1) {
        // Variant 2: The Fern (Dendrite)
        // Main spine
        ctx.lineWidth = 2;
        ctx.moveTo(0, 0);
        ctx.lineTo(0, maxRadius * 0.9);
        // Little branches V-shape
        ctx.lineWidth = 1.5;
        const branchY = maxRadius * 0.5;
        const branchW = maxRadius * 0.25;
        ctx.moveTo(0, branchY);
        ctx.lineTo(branchW, branchY + (maxRadius * 0.2));
        ctx.moveTo(0, branchY);
        ctx.lineTo(-branchW, branchY + (maxRadius * 0.2));
      } 
      else if (variant === 2) {
        // Variant 3: The Plate (Hexagon center)
        ctx.lineWidth = 3;
        ctx.moveTo(0, 0);
        ctx.lineTo(0, maxRadius * 0.7);
        // Crossbar to form the inner hexagon shape
        ctx.lineWidth = 2;
        ctx.moveTo(-5, maxRadius * 0.3);
        ctx.lineTo(5, maxRadius * 0.3);
      } 
      else {
        // Variant 4: The Heavy Flake (Clumped)
        // Thicker, shorter strokes to simulate flakes sticking together
        ctx.lineWidth = 4;
        ctx.moveTo(0, 0);
        ctx.lineTo(0, maxRadius * 0.6);
        ctx.moveTo(0, maxRadius * 0.3);
        ctx.lineTo(4, maxRadius * 0.5);
      }
      
      ctx.stroke();
      ctx.restore();
    }
    
    ctx.restore(); // Reset translation for next cell
  };

  // Generate the 4 variants
  drawFlakeInCell(0, 0, 0);
  drawFlakeInCell(1, 0, 1);
  drawFlakeInCell(0, 1, 2);
  drawFlakeInCell(1, 1, 3);

  const tex = new window.THREE.CanvasTexture(canvas);
  const THREE = window.THREE;

  if (THREE) {
    // 5. BETTER FILTERING
    // Use LinearMipmapLinear so it looks smooth (not pixelated) at a distance,
    // but retains the crisp shape when close.
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.needsUpdate = true;
  }

  return tex;
}

  _createSplashTexture() {
    // Build a 2x2 atlas of unique splash shapes (4 variants) so each
    // particle can sample a different tile for more variety.
    const cellSize = 64;
    const grid = 2; // 2x2 grid
    const totalSize = cellSize * grid; // 128x128 texture
    
    const canvas = document.createElement('canvas');
    canvas.width = totalSize;
    canvas.height = totalSize;
    const ctx = canvas.getContext('2d');

    const drawSplashInCell = (cellX, cellY) => {
      const imgData = ctx.createImageData(cellSize, cellSize);
      const data = imgData.data;

      // Make each of the 4 cells deliberately different so we can visually
      // confirm that all tiles are being sampled.

      // Cell (0,0): thin, clean ring
      if (cellX === 0 && cellY === 0) {
        const radius = cellSize * 0.35;
        const thickness = 2.0;
        for (let y = 0; y < cellSize; y++) {
          for (let x = 0; x < cellSize; x++) {
            const lx = x - cellSize / 2;
            const ly = y - cellSize / 2;
            const dist = Math.sqrt(lx * lx + ly * ly);
            const distFromRing = Math.abs(dist - radius);
            const idx = (y * cellSize + x) * 4;
            if (distFromRing < thickness) {
              const alpha = 1 - (distFromRing / thickness);
              data[idx] = 255;
              data[idx + 1] = 255;
              data[idx + 2] = 255;
              data[idx + 3] = Math.floor(alpha * 255);
            } else {
              data[idx + 3] = 0;
            }
          }
        }
        ctx.putImageData(imgData, cellX * cellSize, cellY * cellSize);
        return;
      }

      // Cell (1,0): thick, broken, noisy ring with strong angular gaps
      if (cellX === 1 && cellY === 0) {
        const radius = cellSize * 0.38;
        const thickness = 5.0;
        for (let y = 0; y < cellSize; y++) {
          for (let x = 0; x < cellSize; x++) {
            const lx = x - cellSize / 2;
            const ly = y - cellSize / 2;
            const dist = Math.sqrt(lx * lx + ly * ly);
            const angle = Math.atan2(ly, lx);
            const distFromRing = Math.abs(dist - radius);
            const idx = (y * cellSize + x) * 4;
            if (distFromRing < thickness) {
              let alpha = 1 - (distFromRing / thickness);
              // Strong angular gating to make clear broken arcs
              alpha *= (0.3 + 0.7 * Math.max(0, Math.sin(angle * 4.0)));
              alpha *= (0.5 + 0.5 * (Math.random()));
              data[idx] = 255;
              data[idx + 1] = 255;
              data[idx + 2] = 255;
              data[idx + 3] = Math.floor(alpha * 255);
            } else {
              data[idx + 3] = 0;
            }
          }
        }
        ctx.putImageData(imgData, cellX * cellSize, cellY * cellSize);
        return;
      }

      // Cell (0,1): mostly small droplets, no main ring
      if (cellX === 0 && cellY === 1) {
        const maxR = cellSize * 0.45;
        for (let y = 0; y < cellSize; y++) {
          for (let x = 0; x < cellSize; x++) {
            const lx = x - cellSize / 2;
            const ly = y - cellSize / 2;
            const dist = Math.sqrt(lx * lx + ly * ly);
            const idx = (y * cellSize + x) * 4;
            // Sparse random droplets in an annulus
            if (dist < maxR && dist > maxR * 0.2 && Math.random() > 0.93) {
              const alpha = 0.6 + Math.random() * 0.4;
              data[idx] = 255;
              data[idx + 1] = 255;
              data[idx + 2] = 255;
              data[idx + 3] = Math.floor(alpha * 255);
            } else {
              data[idx + 3] = 0;
            }
          }
        }
        ctx.putImageData(imgData, cellX * cellSize, cellY * cellSize);
        return;
      }

      // Cell (1,1): filled inner puddle with soft edge
      {
        const innerR = cellSize * 0.22;
        const outerR = cellSize * 0.40;
        for (let y = 0; y < cellSize; y++) {
          for (let x = 0; x < cellSize; x++) {
            const lx = x - cellSize / 2;
            const ly = y - cellSize / 2;
            const dist = Math.sqrt(lx * lx + ly * ly);
            const idx = (y * cellSize + x) * 4;
            if (dist < outerR) {
              let alpha;
              if (dist < innerR) {
                // Solid core
                alpha = 1.0;
              } else {
                // Falloff towards outer radius
                const t = (dist - innerR) / (outerR - innerR);
                alpha = 1.0 - t;
              }
              data[idx] = 255;
              data[idx + 1] = 255;
              data[idx + 2] = 255;
              data[idx + 3] = Math.floor(alpha * 255);
            } else {
              data[idx + 3] = 0;
            }
          }
        }
        ctx.putImageData(imgData, cellX * cellSize, cellY * cellSize);
      }
    };

    // Generate 4 unique splashes
    drawSplashInCell(0, 0);
    drawSplashInCell(1, 0);
    drawSplashInCell(0, 1);
    drawSplashInCell(1, 1);

    const tex = new window.THREE.CanvasTexture(canvas);
    // Important for atlases to reduce bleeding between tiles
    const THREE = window.THREE;
    if (THREE) {
      tex.minFilter = THREE.NearestFilter;
      tex.magFilter = THREE.LinearFilter;
    }
    return tex;
  }

  _createFoamTexture() {
    const THREE = window.THREE;
    if (!THREE) return null;

    const texture = new THREE.TextureLoader().load('modules/map-shine-advanced/assets/foam.webp');
    texture.wrapS = THREE.ClampToEdgeWrapping;
    texture.wrapT = THREE.ClampToEdgeWrapping;
    texture.minFilter = THREE.LinearMipmapLinearFilter;
    texture.magFilter = THREE.LinearFilter;
    texture.generateMipmaps = true;
    texture.needsUpdate = true;
    return texture;
  }

  _initSystems() {
     const THREE = window.THREE;
     const d = window.canvas?.dimensions;
     const sceneW = d?.sceneWidth ?? d?.width ?? 2000;
    const sceneH = d?.sceneHeight ?? d?.height ?? 2000;
    const sceneX = d?.sceneX ?? 0;
    const sceneY = d?.sceneY ?? 0;
    
    // Scene rectangle comes directly from Foundry's canvas.dimensions.
    // This gives us the true playable area in world units (top-left origin).
    // We then extend this into 3D using the same canonical ground plane Z
    // that SceneComposer uses for the base plane mesh.
    //
    // Ground plane alignment contract:
    // - SceneComposer.createBasePlane() positions the base plane at
    //   GROUND_Z = 1000 (with camera at Z=2000), so the visible map lives
    //   at Z=1000 in world space.
    // - Previously WeatherParticles assumed Z=0 as ground, which caused
    //   rain/snow and splashes to appear offset relative to the map when the
    //   base plane Z moved.
    // - Here we derive the effective groundZ from SceneComposer when
    //   available, otherwise fall back to 1000 as the canonical value.
    //
    const sceneComposer = window.MapShine?.sceneComposer;
    // Canonical vertical wires from SceneComposer so all world-space effects
    // share the same notion of ground plane, emitter height, and world top.
    const groundZ = (sceneComposer && typeof sceneComposer.groundZ === 'number')
      ? sceneComposer.groundZ
      : 1000; // Fallback to SceneComposer's canonical ground plane Z

    const worldTopZ = (sceneComposer && typeof sceneComposer.worldTopZ === 'number')
      ? sceneComposer.worldTopZ
      : (groundZ + 7500);

    const emitterZ = (sceneComposer && typeof sceneComposer.weatherEmitterZ === 'number')
      ? sceneComposer.weatherEmitterZ
      : (groundZ + 6500);

    // IMPORTANT: Keep the weather emitter within the camera frustum.
    // The PerspectiveCamera looks down -Z from a fixed height (typically z=2000)
    // with far=5000. Spawning at groundZ+6500 (e.g. 7500) puts particles behind
    // the camera / beyond the far plane. Rain still appears because it falls fast
    // enough to enter the frustum, but snow falls slowly and may never become visible.
    let safeEmitterZ = emitterZ;
    try {
      const cam = sceneComposer?.camera;
      if (cam && typeof cam.position?.z === 'number') {
        // Ensure spawn plane is in front of the camera (smaller Z than camera).
        safeEmitterZ = Math.min(safeEmitterZ, cam.position.z - 10);
      }
    } catch (e) {
      // Fallback: use computed emitterZ
    }

    // LAYERING CONTRACT (weather vs. tiles / overhead):
    // - Overhead tiles use Z_OVERHEAD=20, depthTest=true, depthWrite=false,
    //   renderOrder=10 (see TileManager.updateSpriteTransform).
    // - three.quarks builds its own SpriteBatch ShaderMaterials from the
    //   MeshBasicMaterial we provide here; we must NOT override SpriteBatch
    //   materials directly or we risk losing the texture map.
    // - To ensure rain/snow render visibly above roofs we:
    //     * keep depthWrite=false so particles never write depth,
    //     * set depthTest=false so they ignore the depth buffer, and
    //     * set renderOrder=50 on the ParticleSystem configs below.
    //   Combined with ParticleSystem's BatchedRenderer.renderOrder=50 this
    //   guarantees weather batches draw after tiles and appear as an overlay.
    log.info(`WeatherParticles: scene bounds [${sceneX}, ${sceneY}, ${sceneW}x${sceneH}]`);

    const centerX = sceneX + sceneW / 2;
    const centerY = sceneY + sceneH / 2;

    const maskParams = {
      width: sceneW,
      height: sceneH,
      sceneX,
      sceneY,
      totalHeight: d?.height ?? sceneH,
      centerX,
      centerY
    };

    this._splashShape = new RandomRectangleEmitter({ width: sceneW, height: sceneH });
    this._waterHitShape = new WaterMaskedSplashEmitter(maskParams);
    this._shoreFoamShape = new ShorelineFoamEmitter(maskParams);
    // Place the weather emitters well above the ground plane so rain/snow
    // have room to fall before hitting the map. Use SceneComposer.weatherEmitterZ
    // when available so all systems share a single canonical emitter height.

    // World volume in world space: scene rectangle in X/Y, groundZ..worldTopZ in Z.
    // We keep a tall band here so strong gravity/wind forces do not immediately
    // cull particles before they have a chance to render.
    const volumeMin = new THREE.Vector3(sceneX, sceneY, groundZ);
    const volumeMax = new THREE.Vector3(sceneX + sceneW, sceneY + sceneH, worldTopZ);
    const killBehavior = new WorldVolumeKillBehavior(volumeMin, volumeMax);
    
    // For snow we want flakes to be able to rest on the ground (z ~= groundZ) and
    // fade out instead of being culled the instant they touch the floor.
    // Use a slightly relaxed kill volume in Z so the SnowFloorBehavior can
    // manage their lifetime once they land.
    const snowVolumeMin = new THREE.Vector3(sceneX, sceneY, groundZ - 100);
    const snowKillBehavior = new WorldVolumeKillBehavior(snowVolumeMin, volumeMax);
    
    // --- COMMON OVER-LIFE BEHAVIORS ---
    // Rain: keep chroma and alpha roughly constant over life; fade handled by RainFadeInBehavior.
    const rainColorOverLife = new ColorOverLife(
      new ColorRange(
        new Vector4(1.0, 1.0, 1.0, 1.0),
        new Vector4(1.0, 1.0, 1.0, 1.0)
      )
    );

    // Snow: slightly warm/bright at spawn, fade and desaturate over life.
    const snowColorOverLife = new ColorOverLife(
      new ColorRange(
        new Vector4(1.0, 1.0, 1.0, 1.0),
        new Vector4(0.9, 0.95, 1.0, 0.0)
      )
    );
     
     // --- GRAVITY & WIND ---
     // 1. Gravity (Down Z)
     const gravity = new ApplyForce(new THREE.Vector3(0, 0, -1), new ConstantValue(this._rainBaseGravity));
     // 2. Wind (lateral) - direction and strength will be driven by WeatherController each frame
     const wind = new ApplyForce(new THREE.Vector3(1, 0, 0), new ConstantValue(3000));

     // --- RAIN ---
    const rainMaterial = new THREE.MeshBasicMaterial({
      map: this.rainTexture,
      transparent: true,
      depthWrite: false,
      depthTest: false,
      blending: THREE.NormalBlending,
      color: 0xffffff,
      opacity: 1.0,
      side: THREE.DoubleSide
    });

    this._rainMaterial = rainMaterial;

    // Inject roof mask support into the rain material without changing its core look.
    this._patchRoofMaskMaterial(this._rainMaterial);

    this.rainSystem = new ParticleSystem({
      duration: 1,
      looping: true,
      prewarm: true,
      
      // LIFE: Long enough that particles are culled by the world-volume floor instead of timing out mid-air.
      startLife: new IntervalValue(3.0, 4.0),
      
      // SPEED: Tuned to give a readable fall rate at default gravity.
      // Gravity will still accelerate them further, but base speed is lower.
      startSpeed: new IntervalValue(2500, 3500), 
      
      // SIZE: narrow streaks; actual visual width is mostly from texture.
      startSize: new IntervalValue(1.2, 2.2), 
      
      startColor: new ColorRange(new Vector4(0.6, 0.7, 1.0, 1.0), new Vector4(0.6, 0.7, 1.0, 1.0)),
      worldSpace: true,
      maxParticles: 15000,
      emissionOverTime: new ConstantValue(0), 
      shape: new RandomRectangleEmitter({ width: sceneW, height: sceneH }),
      material: rainMaterial,
      renderOrder: 50,
      
      // RENDER MODE: StretchedBillBoard
      // Uses velocity to stretch the quad.
      renderMode: RenderMode.StretchedBillBoard,
      // speedFactor: Controls how "long" the rain streak is relative to speed.
      // 4000 speed * 0.01 factor = 40 unit long streak.
      speedFactor: 0.01, 
      
      startRotation: new ConstantValue(0),
      behaviors: [gravity, wind, rainColorOverLife, killBehavior, new RainFadeInBehavior()],
    });
     
    this.rainSystem.emitter.position.set(centerX, centerY, safeEmitterZ);
     // Rotate Emitter to shoot DOWN (-Z)
     this.rainSystem.emitter.rotation.set(Math.PI, 0, 0);

     if (this.scene) this.scene.add(this.rainSystem.emitter);
     this.batchRenderer.addSystem(this.rainSystem);

     // Patch the actual quarks batch material used to render rain so the
     // roof/outdoors mask logic runs on the SpriteBatch shader.
     try {
       const idx = this.batchRenderer.systemToBatchIndex?.get(this.rainSystem);
       if (idx !== undefined && this.batchRenderer.batches && this.batchRenderer.batches[idx]) {
         const batch = this.batchRenderer.batches[idx];
         if (batch.material) {
           this._rainBatchMaterial = batch.material;
           this._patchRoofMaskMaterial(this._rainBatchMaterial);
         }
       }
     } catch (e) {
       log.warn('Failed to patch rain batch material for roof mask:', e);
     }

     // --- RAIN CURL NOISE (shared for all rain particles) ---
    const rainCurl = new CurlNoiseField(
      new THREE.Vector3(1400, 1400, 2000),   // larger cells than snow for broad gusts
      new THREE.Vector3(80, 80, 20),         // relatively subtle swirl
      0.08                                   // time scale
    );

    // Attach curl as a behavior to the rain system
    this.rainSystem.behaviors.push(rainCurl);

    // --- SPLASHES ---
    const splashMaterial = new THREE.MeshBasicMaterial({
      map: this.splashTexture,
      transparent: true,
      depthWrite: false,
      depthTest: false,
      blending: THREE.AdditiveBlending,
      color: 0xffffff,
      opacity: 0.8
    });

    this._splashMaterial = splashMaterial;
    this._patchRoofMaskMaterial(this._splashMaterial);

    // Use custom alpha behavior for "triangle" fade: 0 -> 10% -> 0
    const splashAlphaBehavior = new SplashAlphaBehavior(0.10);
    this._splashAlphaBehavior = splashAlphaBehavior;

    // Rapid expansion behavior: much faster/larger
    // Start small (0.2 scale) and grow aggressively over a short life
    const splashSizeOverLife = new SizeOverLife(
      // Stronger curve than before so splashes expand more within their (now shorter) lifetime.
      new PiecewiseBezier([[new Bezier(0.4, 4.0, 7.0, 9.0), 0]])
    );
    
    // Create four independent splash systems (one per atlas tile) so each
    // splash archetype can be tuned separately.
    this.splashSystems = [];
    this._splashAlphaBehaviors = [];
    this._splashWindForces = [];

    const createSplashSystemForTile = (tileIndex) => {
      const alphaBehavior = new SplashAlphaBehavior(0.10);
      this._splashAlphaBehaviors[tileIndex] = alphaBehavior;
      
      // Wind force for splashes (initially 0)
      const splashWind = new ApplyForce(new THREE.Vector3(1, 0, 0), new ConstantValue(0));
      this._splashWindForces.push(splashWind);

      const system = new ParticleSystem({
        duration: 1,
        looping: true,
        prewarm: false,
        
        // Very short life baseline; will be overridden by tuning each frame.
        startLife: new IntervalValue(0.1, 0.2),
        
        // Static on the ground (no speed)
        startSpeed: new ConstantValue(0),
        
        // Size: randomization (World units/pixels)
        // Was 0.5-1.2 which is 1px. Needs to be visible, e.g. 12-24px.
        startSize: new IntervalValue(12, 24), 
        
        // Start at full white (1.0). SplashAlphaBehavior will drive alpha 0 -> 0.1 -> 0.
        startColor: new ColorRange(new Vector4(0.8, 0.9, 1.0, 1.0), new Vector4(0.8, 0.9, 1.0, 1.0)),
        worldSpace: true,
        maxParticles: 2000, // Enough for heavy rain
        emissionOverTime: new ConstantValue(0),
        
        // Atlas: 2x2 tiles (4 variants) on the splash texture
        uTileCount: 2,
        vTileCount: 2,
        // Lock this system to a specific atlas tile
        startTileIndex: new ConstantValue(tileIndex),
        
        shape: this._splashShape,
        
        material: splashMaterial,
        renderOrder: 50, // Same layer as rain
        renderMode: RenderMode.BillBoard, // Face camera (top-down view = circle on ground)
        
        // Pick a random orientation once at spawn; no over-life spin behavior.
        startRotation: new IntervalValue(0, Math.PI * 2),
        behaviors: [
          alphaBehavior,
          splashSizeOverLife,
          splashWind,
          // We do NOT add gravity. Splashes stay on the ground plane but can drift with wind.
          // We use the same kill behavior to clean up if map changes size (optional)
          killBehavior
        ]
      });

      // Z Position: Ground level, aligned with the base plane.
    // We nudge slightly above groundZ so splashes draw above the map but
    // below tokens.
    system.emitter.position.set(centerX, centerY, groundZ + 10);
      system.emitter.rotation.set(0, 0, 0); // No rotation needed for billboards

      if (this.scene) this.scene.add(system.emitter);
      this.batchRenderer.addSystem(system);

      // Patch the batch material for this splash system
      try {
        const idx = this.batchRenderer.systemToBatchIndex?.get(system);
        if (idx !== undefined && this.batchRenderer.batches && this.batchRenderer.batches[idx]) {
          const batch = this.batchRenderer.batches[idx];
          if (batch.material) {
            this._splashBatchMaterial = batch.material;
            this._splashBatchMaterials.push(batch.material);
            this._patchRoofMaskMaterial(batch.material);
          }
        }
      } catch (e) {
        log.warn('Failed to patch splash batch material:', e);
      }

      this.splashSystems[tileIndex] = system;
      return system;
    };

    const createWaterHitSplashSystemForTile = (tileIndex) => {
      const alphaBehavior = new SplashAlphaBehavior(0.10);
      const splashWind = new ApplyForce(new THREE.Vector3(1, 0, 0), new ConstantValue(0));

      const system = new ParticleSystem({
        duration: 1,
        looping: true,
        prewarm: false,
        startLife: new IntervalValue(0.1, 0.2),
        startSpeed: new ConstantValue(0),
        startSize: new IntervalValue(12, 24),
        startColor: new ColorRange(new Vector4(1.0, 1.0, 1.0, 1.0), new Vector4(1.0, 1.0, 1.0, 1.0)),
        worldSpace: true,
        maxParticles: 1500,
        emissionOverTime: new ConstantValue(0),
        uTileCount: 2,
        vTileCount: 2,
        startTileIndex: new ConstantValue(2),
        shape: this._waterHitShape,
        material: splashMaterial,
        renderOrder: 50,
        renderMode: RenderMode.BillBoard,
        startRotation: new IntervalValue(0, Math.PI * 2),
        behaviors: [alphaBehavior, splashSizeOverLife, splashWind, killBehavior]
      });

      system.emitter.position.set(centerX, centerY, groundZ + 10);
      system.emitter.rotation.set(0, 0, 0);

      if (this.scene) this.scene.add(system.emitter);
      this.batchRenderer.addSystem(system);

      try {
        const idx = this.batchRenderer.systemToBatchIndex?.get(system);
        if (idx !== undefined && this.batchRenderer.batches && this.batchRenderer.batches[idx]) {
          const batch = this.batchRenderer.batches[idx];
          if (batch.material) {
            this._waterHitSplashBatchMaterials.push(batch.material);
            this._patchRoofMaskMaterial(batch.material);
          }
        }
      } catch (e) {
        log.warn('Failed to patch water-hit splash batch material:', e);
      }

      this._waterHitSplashSystems[tileIndex] = { system, alphaBehavior, splashWind };
      return system;
    };

    // Tile indices: 0=(0,0 thin ring), 1=(1,0 broken ring), 2=(0,1 droplets), 3=(1,1 puddle)
    createSplashSystemForTile(0);
    createSplashSystemForTile(1);
    createSplashSystemForTile(2);
    createSplashSystemForTile(3);

    createWaterHitSplashSystemForTile(0);
    createWaterHitSplashSystemForTile(1);
    createWaterHitSplashSystemForTile(2);
    createWaterHitSplashSystemForTile(3);

    const foamMaterial = new THREE.MeshBasicMaterial({
      map: this.foamTexture,
      transparent: true,
      depthWrite: false,
      depthTest: false,
      blending: THREE.NormalBlending,
      color: 0xffffff,
      opacity: 1.0
    });

    this._foamMaterial = foamMaterial;
    this._patchRoofMaskMaterial(this._foamMaterial);

    this._foamSystem = new ParticleSystem({
      duration: 1,
      looping: true,
      prewarm: false,
      startLife: new IntervalValue(0.6, 1.4),
      startSpeed: new ConstantValue(0),
      startSize: new IntervalValue(40, 90),
      startColor: new ColorRange(new Vector4(1.0, 1.0, 1.0, 0.7), new Vector4(1.0, 1.0, 1.0, 0.0)),
      worldSpace: true,
      maxParticles: 2500,
      emissionOverTime: new ConstantValue(0),
      shape: this._shoreFoamShape,
      material: foamMaterial,
      renderOrder: 50,
      renderMode: RenderMode.BillBoard,
      startRotation: new ConstantValue(0),
      behaviors: [killBehavior]
    });

    this._foamSystem.emitter.position.set(centerX, centerY, groundZ + 10);
    this._foamSystem.emitter.rotation.set(0, 0, 0);
    if (this.scene) this.scene.add(this._foamSystem.emitter);
    this.batchRenderer.addSystem(this._foamSystem);

    try {
      const idx = this.batchRenderer.systemToBatchIndex?.get(this._foamSystem);
      if (idx !== undefined && this.batchRenderer.batches && this.batchRenderer.batches[idx]) {
        const batch = this.batchRenderer.batches[idx];
        if (batch.material) {
          this._foamBatchMaterial = batch.material;
          this._patchRoofMaskMaterial(batch.material);
        }
      }
    } catch (e) {
      log.warn('Failed to patch foam batch material:', e);
    }

    // --- SNOW ---
     const snowMaterial = new THREE.MeshBasicMaterial({
       map: this.snowTexture,
       transparent: true,
       depthWrite: false,
       depthTest: false,
       blending: THREE.AdditiveBlending,
       color: 0xffffff,
       opacity: 1.0,
       side: THREE.DoubleSide
     });

     this._snowMaterial = snowMaterial;

    // Inject roof mask support into the snow material as well.
    this._patchRoofMaskMaterial(this._snowMaterial);

    // Slower gravity for snow; lateral motion (wind + turbulence) will be configured per-frame.
    // Increase gravity so flakes clearly fall rather than drifting mostly sideways.
    const snowGravity = new ApplyForce(new THREE.Vector3(0, 0, -1), new ConstantValue(this._snowBaseGravity));
    const snowWind = new ApplyForce(new THREE.Vector3(1, 0, 0), new ConstantValue(800));

    // Curl-noise flow field for snow: divergence-free-looking swirls built
    // from scalar noise, creating gentle eddies in the XY plane.
    const snowCurl = new CurlNoiseField(
      new THREE.Vector3(900, 900, 1200),   // spatial scale (large, lazy cells)
      new THREE.Vector3(140, 140, 40),     // swirl strength (XY, Z)
      0.06                                  // time scale (slower evolution)
    );

    // Per-flake flutter to capture the "paper falling" rocking motion.
    const snowFlutter = new SnowFlutterBehavior();
    // Gentle spin while airborne; stops once SnowFloorBehavior marks flakes as
    // landed via the _landed flag.
    const snowSpin = new SnowSpinBehavior();

     this.snowSystem = new ParticleSystem({
       duration: 5,
       looping: true,
       prewarm: true,
       startLife: new IntervalValue(4, 6),
       startSpeed: new IntervalValue(200, 400),
       startSize: new IntervalValue(8, 12), // Snow can be larger
       startColor: new ColorRange(new Vector4(1, 1, 1, 0.8), new Vector4(1, 1, 1, 0.4)),
       worldSpace: true,
       maxParticles: 8000,
      emissionOverTime: new ConstantValue(0),
      shape: new RandomRectangleEmitter({ width: sceneW, height: sceneH }),
      material: snowMaterial,
      renderOrder: 50,
      // Snow uses standard Billboards (flakes don't stretch)
      renderMode: RenderMode.BillBoard,
      // 2x2 flake atlas: four variants.
      uTileCount: 2,
      vTileCount: 2,
      // Randomly choose one of the four atlas tiles per particle.
      // NOTE: IntervalValue uses lerp(a, b, random) where random ∈ [0,1),
      // so IntervalValue(0,3) produces [0,3) and floor() never yields 3.
      // Use (0,4) so floor([0,4)) → {0,1,2,3}.
      startTileIndex: new IntervalValue(0, 4),
      startRotation: new IntervalValue(0, Math.PI * 2),
      // Horizontal motion now comes only from snowWind (driven by windSpeed)
      // and snowCurl (turbulence field), plus gravity for vertical fall.
      // SnowFloorBehavior owns ground contact + fade-out, while SnowSpinBehavior
      // adds a gentle rotation only while flakes are airborne. A relaxed
      // WorldVolumeKillBehavior (snowKillBehavior) still enforces the scene
      // rectangle in X/Y so flakes cannot drift infinitely off the sides.
      behaviors: [
        snowGravity,
        snowWind,
        snowCurl,
        snowColorOverLife,
        snowFlutter,
        snowSpin,
        new SnowFloorBehavior(),
        new RainFadeInBehavior(),
        snowKillBehavior
      ],
    });
     
     this.snowSystem.emitter.position.set(centerX, centerY, safeEmitterZ);
     this.snowSystem.emitter.rotation.set(Math.PI, 0, 0);

     if (this.scene) this.scene.add(this.snowSystem.emitter);
     this.batchRenderer.addSystem(this.snowSystem);

     // Patch the quarks batch material used for snow as well.
     try {
       const idx = this.batchRenderer.systemToBatchIndex?.get(this.snowSystem);
       if (idx !== undefined && this.batchRenderer.batches && this.batchRenderer.batches[idx]) {
         const batch = this.batchRenderer.batches[idx];
         if (batch.material) {
           this._snowBatchMaterial = batch.material;
           this._snowBatchMaterial.side = THREE.DoubleSide;
           this._patchRoofMaskMaterial(this._snowBatchMaterial);
         }
       }
     } catch (e) {
       log.warn('Failed to patch snow batch material for roof mask:', e);
     }
     
     // Cache references to key forces/behaviors so we can drive them from WeatherController
     this._rainWindForce = wind;
    this._snowWindForce = snowWind;
    this._rainGravityForce = gravity;
    this._snowGravityForce = snowGravity;
    this._snowCurl = snowCurl;
    this._snowCurlBaseStrength = snowCurl.strength.clone();
    this._snowFlutter = snowFlutter;
    this._rainCurl = rainCurl;
    this._rainCurlBaseStrength = rainCurl.strength.clone();

     log.info(`Weather systems initialized. Area: ${sceneW}x${sceneH}`);
  }

  /**
   * Patch a MeshBasicMaterial to support sampling the roof/_Outdoors mask.
   * This keeps the existing lighting and texturing logic intact and only adds
   * a late discard based on uRoofMap/uSceneBounds/uRoofMaskEnabled.
   * @param {THREE.Material} material
   * @private
   */
  _patchRoofMaskMaterial(material) {
    const THREE = window.THREE;
    if (!material || !THREE) return;

    // Avoid double-patching the same material
    if (material.userData && material.userData.roofUniforms) {
      return;
    }

    // These uniforms live on material.userData so WeatherParticles.update can
    // drive them every frame. They are then wired into either the real
    // ShaderMaterial.uniforms (for quarks SpriteBatches) or into the shader
    // object passed to onBeforeCompile (for plain MeshBasicMaterials).
    //
    // DUAL-MASK SYSTEM:
    // - uRoofMap: World-space _Outdoors mask (white=outdoors, black=indoors)
    // - uRoofAlphaMap: Screen-space roof alpha from LightingEffect (alpha>0 = roof visible)
    //
    // Logic:
    // - Show rain if: (outdoors AND roof hidden) OR (roof visible - rain lands on roof)
    // - Hide rain if: indoors AND no visible roof overhead
    const uniforms = {
      uRoofMap: { value: null },
      uRoofAlphaMap: { value: null },
      // (sceneX, sceneY, sceneWidth, sceneHeight) in world units
      uSceneBounds: { value: new THREE.Vector4(0, 0, 1, 1) },
      // 0.0 = disabled, 1.0 = enabled
      uRoofMaskEnabled: { value: 0.0 },
      // 0.0 = no roof alpha map, 1.0 = has roof alpha map
      uHasRoofAlphaMap: { value: 0.0 },
      // Screen size for gl_FragCoord -> UV conversion
      uScreenSize: { value: new THREE.Vector2(1920, 1080) },
      uWaterMask: { value: null },
      uWaterMaskEnabled: { value: 0.0 },
      uWaterMaskThreshold: { value: 0.15 }
    };

    // Store for per-frame updates in update()
    material.userData = material.userData || {};
    material.userData.roofUniforms = uniforms;

    const isShaderMat = material.isShaderMaterial === true;

    // The GLSL fragment code for dual-mask precipitation visibility.
    // This is shared between ShaderMaterial and onBeforeCompile paths.
    const fragmentMaskCode =
      '  // DUAL-MASK PRECIPITATION VISIBILITY\n' +
      '  // uRoofMap: _Outdoors mask (world-space, white=outdoors, black=indoors)\n' +
      '  // uRoofAlphaMap: screen-space roof alpha (alpha>0 = roof visible)\n' +
      '  {\n' +
      '    // Map world XY into 0..1 UVs inside the scene rectangle for _Outdoors mask.\n' +
      '    vec2 uvMask = vec2(\n' +
      '      (vRoofWorldPos.x - uSceneBounds.x) / uSceneBounds.z,\n' +
      '      1.0 - (vRoofWorldPos.y - uSceneBounds.y) / uSceneBounds.w\n' +
      '    );\n' +
      '    \n' +
      '    // Quick bounds check to avoid sampling outside the mask.\n' +
      '    if (uvMask.x < 0.0 || uvMask.x > 1.0 || uvMask.y < 0.0 || uvMask.y > 1.0) {\n' +
      '      discard;\n' +
      '    }\n' +
      '    \n' +
      '    // Sample _Outdoors mask (world-space): white=outdoors, black=indoors\n' +
      '    float outdoorsMask = 1.0;\n' +
      '    if (uRoofMaskEnabled > 0.5) {\n' +
      '      outdoorsMask = texture2D(uRoofMap, uvMask).r;\n' +
      '    }\n' +
      '    \n' +
      '    // Sample roof alpha (screen-space): alpha>0 = roof tile visible\n' +
      '    // roofAlphaTarget is rendered with the same camera, so we use\n' +
      '    // gl_FragCoord to get proper screen-space UVs.\n' +
      '    float roofAlpha = 0.0;\n' +
      '    if (uHasRoofAlphaMap > 0.5) {\n' +
      '      // gl_FragCoord.xy gives pixel coordinates, divide by viewport size\n' +
      '      // uScreenSize is passed as (width, height) in the uniform\n' +
      '      vec2 screenUv = gl_FragCoord.xy / uScreenSize;\n' +
      '      roofAlpha = texture2D(uRoofAlphaMap, screenUv).a;\n' +
      '    }\n' +
      '    \n' +
      '    // VISIBILITY LOGIC:\n' +
      '    // Show rain if:\n' +
      '    //   1. Roof is visible (roofAlpha > 0.1) - rain lands on roof\n' +
      '    //   2. OR: Outdoors (outdoorsMask > 0.5) AND roof hidden (roofAlpha < 0.1)\n' +
      '    // Hide rain if:\n' +
      '    //   Indoors (outdoorsMask < 0.5) AND no visible roof (roofAlpha < 0.1)\n' +
      '    \n' +
      '    bool roofVisible = roofAlpha > 0.1;\n' +
      '    bool isOutdoors = outdoorsMask > 0.5;\n' +
      '    \n' +
      '    // Rain shows on visible roofs OR in outdoor areas without roofs\n' +
      '    bool showPrecip = roofVisible || isOutdoors;\n' +
      '    \n' +
      '    if (!showPrecip) {\n' +
      '      discard;\n' +
      '    }\n' +
      '    if (uWaterMaskEnabled > 0.5) {\n' +
      '      float wm = texture2D(uWaterMask, uvMask).r;\n' +
      '      if (wm < uWaterMaskThreshold) discard;\n' +
      '    }\n' +
      '  }\n';

    if (isShaderMat) {
      // Directly patch the quarks SpriteBatch ShaderMaterial in place. This is
      // the path used for the actual batched rain/snow draw calls produced by
      // three.quarks' BatchedRenderer.
      const uni = material.uniforms || (material.uniforms = {});
      uni.uRoofMap = uniforms.uRoofMap;
      uni.uRoofAlphaMap = uniforms.uRoofAlphaMap;
      uni.uSceneBounds = uniforms.uSceneBounds;
      uni.uRoofMaskEnabled = uniforms.uRoofMaskEnabled;
      uni.uHasRoofAlphaMap = uniforms.uHasRoofAlphaMap;
      uni.uScreenSize = uniforms.uScreenSize;
      uni.uWaterMask = uniforms.uWaterMask;
      uni.uWaterMaskEnabled = uniforms.uWaterMaskEnabled;
      uni.uWaterMaskThreshold = uniforms.uWaterMaskThreshold;

      if (typeof material.vertexShader === 'string') {
        // All quarks billboard variants use an `offset` attribute plus
        // #include <soft_vertex>. We piggyback on that include to compute a
        // world-space position once per vertex, without depending on quarks'
        // internal naming of matrices.
        material.vertexShader = material.vertexShader
          .replace(
            'void main() {',
            'varying vec3 vRoofWorldPos;\nvoid main() {'
          )
          .replace(
            '#include <soft_vertex>',
            '#include <soft_vertex>\n  vRoofWorldPos = (modelMatrix * vec4(offset, 1.0)).xyz;'
          );
      }

      if (typeof material.fragmentShader === 'string') {
        material.fragmentShader = material.fragmentShader
          .replace(
            'void main() {',
            'varying vec3 vRoofWorldPos;\n' +
            'uniform sampler2D uRoofMap;\n' +
            'uniform sampler2D uRoofAlphaMap;\n' +
            'uniform vec4 uSceneBounds;\n' +
            'uniform float uRoofMaskEnabled;\n' +
            'uniform float uHasRoofAlphaMap;\n' +
            'uniform vec2 uScreenSize;\n' +
            'uniform sampler2D uWaterMask;\n' +
            'uniform float uWaterMaskEnabled;\n' +
            'uniform float uWaterMaskThreshold;\n' +
            'void main() {'
          )
          .replace(
            '#include <soft_fragment>',
            fragmentMaskCode + '#include <soft_fragment>'
          );
      }

      material.needsUpdate = true;
      return;
    }

    // Fallback path: patch non-ShaderMaterials via onBeforeCompile so quarks
    // can pick up the modifications when building its internal ShaderMaterial
    // from our MeshBasicMaterial template. The injected code is the same as
    // above; the only difference is that we edit the temporary `shader`
    // object instead of the final ShaderMaterial instance.
    material.onBeforeCompile = (shader) => {
      shader.uniforms.uRoofMap = uniforms.uRoofMap;
      shader.uniforms.uRoofAlphaMap = uniforms.uRoofAlphaMap;
      shader.uniforms.uSceneBounds = uniforms.uSceneBounds;
      shader.uniforms.uRoofMaskEnabled = uniforms.uRoofMaskEnabled;
      shader.uniforms.uHasRoofAlphaMap = uniforms.uHasRoofAlphaMap;
      shader.uniforms.uScreenSize = uniforms.uScreenSize;
      shader.uniforms.uWaterMask = uniforms.uWaterMask;
      shader.uniforms.uWaterMaskEnabled = uniforms.uWaterMaskEnabled;
      shader.uniforms.uWaterMaskThreshold = uniforms.uWaterMaskThreshold;

      shader.vertexShader = shader.vertexShader
        .replace(
          'void main() {',
          'varying vec3 vRoofWorldPos;\nvoid main() {'
        )
        .replace(
          '#include <soft_vertex>',
          '#include <soft_vertex>\n  vRoofWorldPos = (modelMatrix * vec4(offset, 1.0)).xyz;'
        );

      shader.fragmentShader = shader.fragmentShader
        .replace(
          'void main() {',
          'varying vec3 vRoofWorldPos;\n' +
          'uniform sampler2D uRoofMap;\n' +
          'uniform sampler2D uRoofAlphaMap;\n' +
          'uniform vec4 uSceneBounds;\n' +
          'uniform float uRoofMaskEnabled;\n' +
          'uniform float uHasRoofAlphaMap;\n' +
          'uniform vec2 uScreenSize;\n' +
          'uniform sampler2D uWaterMask;\n' +
          'uniform float uWaterMaskEnabled;\n' +
          'uniform float uWaterMaskThreshold;\n' +
          'void main() {'
        )
        .replace(
          '#include <soft_fragment>',
          fragmentMaskCode + '#include <soft_fragment>'
        );
    };

    material.needsUpdate = true;
  }

  update(dt, sceneBoundsVec4) {
    const weather = weatherController.getCurrentState();
    if (!weather) return;
    
    // Safety check: if dt is unexpectedly in MS (e.g. 16.6), clamp it.
    // Three.quarks explodes if given MS instead of Seconds.
    const safeDt = dt > 1.0 ? dt / 1000 : dt;
    this._time += safeDt;

    const THREE = window.THREE;

    // Phase 1 (Quarks perf): view-dependent emission bounds.
    // Reduce spawn area to the camera-visible rectangle (+ margin) instead of the full map.
    // We keep the _Outdoors mask projection in full-scene coordinates via uSceneBounds.
    const sceneComposer = window.MapShine?.sceneComposer;
    const mainCamera = sceneComposer?.camera;
    if (THREE && sceneComposer && mainCamera) {
      const zoom = sceneComposer.currentZoom || 1.0;
      const viewportWidth = sceneComposer.baseViewportWidth || window.innerWidth;
      const viewportHeight = sceneComposer.baseViewportHeight || window.innerHeight;

      const visibleW = viewportWidth / Math.max(1e-6, zoom);
      const visibleH = viewportHeight / Math.max(1e-6, zoom);

      const marginScale = 1.2;
      const desiredW = visibleW * marginScale;
      const desiredH = visibleH * marginScale;

      // Clamp the view rectangle to the scene rect in *world-space* (Y-up).
      let sceneX = 0;
      let sceneY = 0;
      let sceneW = 0;
      let sceneH = 0;
      try {
        const d = canvas?.dimensions;
        const rect = d?.sceneRect;
        const totalH = d?.height ?? 0;
        if (rect && typeof rect.x === 'number') {
          sceneX = rect.x;
          sceneW = rect.width;
          sceneH = rect.height;
          sceneY = (totalH > 0) ? (totalH - (rect.y + rect.height)) : rect.y;
        } else if (d) {
          sceneX = d.sceneX ?? 0;
          sceneW = d.sceneWidth ?? d.width ?? 0;
          sceneH = d.sceneHeight ?? d.height ?? 0;
          sceneY = (totalH > 0) ? (totalH - ((d.sceneY ?? 0) + sceneH)) : (d.sceneY ?? 0);
        }
      } catch (e) {
        // Fallback: no clamping
      }

      const camX = mainCamera.position.x;
      const camY = mainCamera.position.y;

      let minX = camX - desiredW / 2;
      let maxX = camX + desiredW / 2;
      let minY = camY - desiredH / 2;
      let maxY = camY + desiredH / 2;

      if (sceneW > 0 && sceneH > 0) {
        const sMinX = sceneX;
        const sMaxX = sceneX + sceneW;
        const sMinY = sceneY;
        const sMaxY = sceneY + sceneH;

        minX = Math.max(sMinX, minX);
        maxX = Math.min(sMaxX, maxX);
        minY = Math.max(sMinY, minY);
        maxY = Math.min(sMaxY, maxY);
      }

      const emitW = Math.max(1, maxX - minX);
      const emitH = Math.max(1, maxY - minY);
      const emitCX = (minX + maxX) * 0.5;
      const emitCY = (minY + maxY) * 0.5;

      if (this.rainSystem?.emitter && this.rainSystem.emitterShape) {
        const shape = this.rainSystem.emitterShape;
        if (typeof shape.width === 'number') shape.width = emitW;
        if (typeof shape.height === 'number') shape.height = emitH;
        this.rainSystem.emitter.position.x = emitCX;
        this.rainSystem.emitter.position.y = emitCY;
      }

      if (this.snowSystem?.emitter && this.snowSystem.emitterShape) {
        const shape = this.snowSystem.emitterShape;
        if (typeof shape.width === 'number') shape.width = emitW;
        if (typeof shape.height === 'number') shape.height = emitH;
        this.snowSystem.emitter.position.x = emitCX;
        this.snowSystem.emitter.position.y = emitCY;
      }
    }

    // Global scene darkness coupling (0 = fully lit, 1 = max darkness).
    // We use this as a scalar on particle brightness/opacity so that
    // weather is not self-illuminated in dark scenes, while still
    // remaining faintly visible at full darkness.
    let sceneDarkness = 0;
    try {
      const le = window.MapShine?.lightingEffect;
      if (le && typeof le.getEffectiveDarkness === 'function') {
        sceneDarkness = le.getEffectiveDarkness();
      } else if (typeof canvas !== 'undefined' && canvas?.scene?.environment?.darknessLevel !== undefined) {
        sceneDarkness = canvas.scene.environment.darknessLevel;
      }
    } catch (e) {
      // If canvas is not ready, keep previous/default darkness.
    }
    sceneDarkness = Math.max(0, Math.min(1, sceneDarkness));

    // Map 0..1 darkness to a brightness scale of ~1.0 -> 0.3. This keeps
    // particles readable but clearly dimmer in night scenes.
    const darknessBrightnessScale = THREE
      ? THREE.MathUtils.lerp(1.0, 0.3, sceneDarkness)
      : (1.0 - 0.7 * sceneDarkness);

    // Cache scene bounds for mask projection
    if (sceneBoundsVec4 && THREE) {
      if (!this._sceneBounds) this._sceneBounds = new THREE.Vector4();
      this._sceneBounds.copy(sceneBoundsVec4);
    }

    const waterEffect = window.MapShine?.waterEffect;
    const waterEnabled = !!(waterEffect && waterEffect.enabled);
    const waterTex = waterEffect?.waterMask || null;

    if (this._waterHitShape) {
      if (waterEnabled && waterTex && waterTex.image) {
        const uuid = waterTex.uuid;
        if (uuid !== this._waterHitMaskUuid) {
          this._waterHitMaskUuid = uuid;
          this._waterHitPoints = this._generateWaterSplashPoints(
            waterTex,
            this._waterMaskThreshold,
            this._waterMaskStride,
            this._waterMaskMaxPoints
          );
          this._waterHitShape.setPoints(this._waterHitPoints);
        }
      } else if (this._waterHitMaskUuid !== null) {
        this._waterHitMaskUuid = null;
        this._waterHitPoints = null;
        this._waterHitShape.clearPoints();
      }
    }

    if (this._shoreFoamShape) {
      if (waterEnabled && waterTex && waterTex.image) {
        const uuid = waterTex.uuid;
        if (uuid !== this._shoreFoamMaskUuid) {
          this._shoreFoamMaskUuid = uuid;
          this._shoreFoamPoints = this._generateWaterEdgePoints(
            waterTex,
            this._waterMaskThreshold,
            this._waterMaskStride,
            12000
          );
          this._shoreFoamShape.setPoints(this._shoreFoamPoints);
        }
      } else if (this._shoreFoamMaskUuid !== null) {
        this._shoreFoamMaskUuid = null;
        this._shoreFoamPoints = null;
        this._shoreFoamShape.clearPoints();
      }
    }

    // Update roof/outdoors texture and mask state from WeatherController
    const roofTex = weatherController.roofMap || null;
    this._roofTexture = roofTex;
    
    // DUAL-MASK SYSTEM:
    // - roofMaskEnabled: Always true if we have an _Outdoors mask (controls indoor/outdoor gating)
    // - roofAlphaMap: Screen-space texture from LightingEffect showing visible overhead tiles
    //
    // The shader logic is:
    // - Show rain if: (outdoors AND roof hidden) OR (roof visible - rain lands on roof)
    // - Hide rain if: indoors AND no visible roof overhead
    const roofMaskEnabled = !!roofTex;
    
    // Get the roof alpha texture from LightingEffect (screen-space overhead tile visibility)
    let roofAlphaTexture = null;
    let screenWidth = 1920;
    let screenHeight = 1080;
    try {
      const mm = window.MapShine?.maskManager;
      const rec = mm ? mm.getRecord('roofAlpha.screen') : null;
      if (rec && rec.texture) {
        roofAlphaTexture = rec.texture;
        screenWidth = rec.width || 1920;
        screenHeight = rec.height || 1080;
      } else {
        const le = window.MapShine?.lightingEffect;
        if (le && le.roofAlphaTarget && le.roofAlphaTarget.texture) {
          roofAlphaTexture = le.roofAlphaTarget.texture;
          // Get screen size from the render target dimensions
          screenWidth = le.roofAlphaTarget.width || 1920;
          screenHeight = le.roofAlphaTarget.height || 1080;
        }
      }
    } catch (e) {
      // LightingEffect not available
    }
    const hasRoofAlphaMap = !!roofAlphaTexture;

    const precip = weather.precipitation || 0;
    const freeze = weather.freezeLevel || 0;
    const rainTuning = weatherController.rainTuning || {};
    const snowTuning = weatherController.snowTuning || {};
    const baseRainIntensity = precip * (1.0 - freeze) * (rainTuning.intensityScale ?? 1.0);
    const snowIntensity = precip * freeze * (snowTuning.intensityScale ?? 1.0);

    if (this.rainSystem) {
        // Minimal per-frame work: just drive emission by precipitation/intensity.
        // PERFORMANCE: Mutate existing ConstantValue instead of creating new one every frame
        const rainIntensity = baseRainIntensity;
        const emission = this.rainSystem.emissionOverTime;
        if (emission && typeof emission.value === 'number') {
            emission.value = 4000 * rainIntensity;
        }

        // --- EFFICIENT TUNING UPDATES ---
        // Only update system properties if the specific tuning value has changed.

        // 1. Drop Size -> startSize (configurable min/max, with sane fallbacks)
        const currentDropSize = rainTuning.dropSize ?? 1.0;
        const currentDropSizeMin = rainTuning.dropSizeMin ?? (1.2 * currentDropSize);
        const currentDropSizeMax = rainTuning.dropSizeMax ?? (2.2 * currentDropSize);

        if (currentDropSize !== this._lastRainTuning.dropSize ||
            currentDropSizeMin !== this._lastRainTuning.dropSizeMin ||
            currentDropSizeMax !== this._lastRainTuning.dropSizeMax) {

          this._lastRainTuning.dropSize = currentDropSize;
          this._lastRainTuning.dropSizeMin = currentDropSizeMin;
          this._lastRainTuning.dropSizeMax = currentDropSizeMax;

          // PERFORMANCE: Mutate existing IntervalValue instead of creating new one
          if (this.rainSystem.startSize && typeof this.rainSystem.startSize.a === 'number') {
            this.rainSystem.startSize.a = currentDropSizeMin;
            this.rainSystem.startSize.b = currentDropSizeMax;
          }
        }

        // 2. Streak Length -> speedFactor
        const currentStreakLen = rainTuning.streakLength ?? 1.0;
        if (currentStreakLen !== this._lastRainTuning.streakLength) {
          this._lastRainTuning.streakLength = currentStreakLen;
          // Keep this in sync with the baseline speedFactor set in _initSystems.
          // Smaller values (e.g. 0.25) now produce noticeably shorter streaks.
          this.rainSystem.speedFactor = 0.02 * currentStreakLen;
        }

        // 3. Brightness -> material opacity & startColor alpha
        const currentBrightness = (rainTuning.brightness ?? 1.0) * darknessBrightnessScale;
        if (currentBrightness !== this._lastRainTuning.brightness &&
            (this._rainMaterial || this.rainSystem.material)) {

          this._lastRainTuning.brightness = currentBrightness;

          const clampedB = THREE.MathUtils.clamp(currentBrightness, 0.0, 3.0);
          const alphaScale = clampedB / 3.0; // 0 -> invisible, 1 -> full

          // Material opacity
          const targetOpacity = THREE.MathUtils.clamp(alphaScale * 1.2, 0.0, 1.0);
          if (this._rainMaterial) {
            this._rainMaterial.opacity = targetOpacity;
            this._rainMaterial.needsUpdate = true;
          }
          if (this.rainSystem.material) {
            this.rainSystem.material.opacity = targetOpacity;
            this.rainSystem.material.needsUpdate = true;
          }

          // Particle alpha
          // PERFORMANCE: Mutate existing ColorRange Vector4s instead of creating new ones
          const baseMinAlpha = 1.0;
          const baseMaxAlpha = 0.7;
          const minA = baseMinAlpha * alphaScale;
          const maxA = baseMaxAlpha * alphaScale;
          if (this.rainSystem.startColor && this.rainSystem.startColor.a && this.rainSystem.startColor.b) {
            this.rainSystem.startColor.a.set(0.6, 0.7, 1.0, minA);
            this.rainSystem.startColor.b.set(0.6, 0.7, 1.0, maxA);
          }
        }
        // Apply roof mask uniforms for rain (base material)
        if (this._rainMaterial && this._rainMaterial.userData && this._rainMaterial.userData.roofUniforms) {
          const uniforms = this._rainMaterial.userData.roofUniforms;
          uniforms.uRoofMaskEnabled.value = roofMaskEnabled ? 1.0 : 0.0;
          uniforms.uHasRoofAlphaMap.value = hasRoofAlphaMap ? 1.0 : 0.0;
          if (this._sceneBounds) {
            uniforms.uSceneBounds.value.copy(this._sceneBounds);
          }
          uniforms.uRoofMap.value = this._roofTexture;
          uniforms.uRoofAlphaMap.value = roofAlphaTexture;
          uniforms.uScreenSize.value.set(screenWidth, screenHeight);
        }

        // Also drive the batch ShaderMaterial uniforms used by quarks for rain.
        if (this._rainBatchMaterial && this._rainBatchMaterial.userData && this._rainBatchMaterial.userData.roofUniforms) {
          const uniforms = this._rainBatchMaterial.userData.roofUniforms;
          uniforms.uRoofMaskEnabled.value = roofMaskEnabled ? 1.0 : 0.0;
          uniforms.uHasRoofAlphaMap.value = hasRoofAlphaMap ? 1.0 : 0.0;
          if (this._sceneBounds) {
            uniforms.uSceneBounds.value.copy(this._sceneBounds);
          }
          uniforms.uRoofMap.value = this._roofTexture;
          uniforms.uRoofAlphaMap.value = roofAlphaTexture;
          uniforms.uScreenSize.value.set(screenWidth, screenHeight);
        }
    }
    
    if (this.splashSystems && this.splashSystems.length > 0) {
        // Splashes only happen during rain.
        // Logic: Precipitation > 0 AND FreezeLevel < 0.5 (Rain)

        const baseIntensity = baseRainIntensity;

        // Drive splash emission with a different curve than raindrops.
        // From 0-25% precipitation: no splashes.
        // From 25%-100%: ramp splash factor from 0 -> 1.
        let splashPrecipFactor = 0.0;
        if (precip > 0.25) {
          const t = (precip - 0.25) / 0.75;
          splashPrecipFactor = THREE ? THREE.MathUtils.clamp(t, 0.0, 1.0) : Math.max(0, Math.min(1, t));
        }

        const perSplash = [
          {
            system: this.splashSystems[0],
            tuning: {
              intensity: rainTuning.splash1IntensityScale,
              lifeMin: rainTuning.splash1LifeMin,
              lifeMax: rainTuning.splash1LifeMax,
              sizeMin: rainTuning.splash1SizeMin,
              sizeMax: rainTuning.splash1SizeMax,
              peak:    rainTuning.splash1OpacityPeak
            },
            alphaBehavior: this._splashAlphaBehaviors?.[0]
          },
          {
            system: this.splashSystems[1],
            tuning: {
              intensity: rainTuning.splash2IntensityScale,
              lifeMin: rainTuning.splash2LifeMin,
              lifeMax: rainTuning.splash2LifeMax,
              sizeMin: rainTuning.splash2SizeMin,
              sizeMax: rainTuning.splash2SizeMax,
              peak:    rainTuning.splash2OpacityPeak
            },
            alphaBehavior: this._splashAlphaBehaviors?.[1]
          },
          {
            system: this.splashSystems[2],
            tuning: {
              intensity: rainTuning.splash3IntensityScale,
              lifeMin: rainTuning.splash3LifeMin,
              lifeMax: rainTuning.splash3LifeMax,
              sizeMin: rainTuning.splash3SizeMin,
              sizeMax: rainTuning.splash3SizeMax,
              peak:    rainTuning.splash3OpacityPeak
            },
            alphaBehavior: this._splashAlphaBehaviors?.[2]
          },
          {
            system: this.splashSystems[3],
            tuning: {
              intensity: rainTuning.splash4IntensityScale,
              lifeMin: rainTuning.splash4LifeMin,
              lifeMax: rainTuning.splash4LifeMax,
              sizeMin: rainTuning.splash4SizeMin,
              sizeMax: rainTuning.splash4SizeMax,
              peak:    rainTuning.splash4OpacityPeak
            },
            alphaBehavior: this._splashAlphaBehaviors?.[3]
          }
        ];

        for (const entry of perSplash) {
          const system = entry.system;
          if (!system) continue;

          const t = entry.tuning || {};

          // Base emission scaled by rain intensity, precipitation curve, and per-splash intensity.
          const splashIntensityScale = t.intensity ?? 0.0;
          let splashEmission = 0;
          if (baseIntensity > 0 && splashIntensityScale > 0 && splashPrecipFactor > 0) {
            // 200 splashes/sec at full intensity, further scaled per splash and precipitation factor.
            splashEmission = 200 * baseIntensity * splashIntensityScale * splashPrecipFactor;
          }

          // PERFORMANCE: Mutate existing values instead of creating new objects every frame
          const emissionVal = system.emissionOverTime;
          if (emissionVal && typeof emissionVal.value === 'number') {
            emissionVal.value = splashEmission;
          }

          // --- Lifetime Tuning for this splash ---
          const lifeMin = Math.max(0.001, t.lifeMin ?? 0.1);
          const lifeMax = Math.max(lifeMin, t.lifeMax ?? 0.2);
          if (system.startLife && typeof system.startLife.a === 'number') {
            system.startLife.a = lifeMin;
            system.startLife.b = lifeMax;
          }

          // --- Size Tuning for this splash ---
          const sizeMin = t.sizeMin ?? 12.0;
          const sizeMax = Math.max(sizeMin, t.sizeMax ?? 24.0);
          if (system.startSize && typeof system.startSize.a === 'number') {
            system.startSize.a = sizeMin;
            system.startSize.b = sizeMax;
          }

          // --- Opacity Peak Tuning for this splash ---
          const peak = (t.peak ?? 0.10) * darknessBrightnessScale;
          if (entry.alphaBehavior) {
            entry.alphaBehavior.peakOpacity = peak;
          }
        }

        // --- Mask Uniforms ---
        if (this._splashMaterial && this._splashMaterial.userData.roofUniforms) {
           const u = this._splashMaterial.userData.roofUniforms;
           u.uRoofMaskEnabled.value = roofMaskEnabled ? 1.0 : 0.0;
           u.uHasRoofAlphaMap.value = hasRoofAlphaMap ? 1.0 : 0.0;
           if (this._sceneBounds) u.uSceneBounds.value.copy(this._sceneBounds);
           u.uRoofMap.value = this._roofTexture;
           u.uRoofAlphaMap.value = roofAlphaTexture;
           u.uScreenSize.value.set(screenWidth, screenHeight);
        }

        if (this._splashBatchMaterials && this._splashBatchMaterials.length > 0) {
          for (const mat of this._splashBatchMaterials) {
            if (!mat || !mat.userData || !mat.userData.roofUniforms) continue;
            const u = mat.userData.roofUniforms;
            u.uRoofMaskEnabled.value = roofMaskEnabled ? 1.0 : 0.0;
            u.uHasRoofAlphaMap.value = hasRoofAlphaMap ? 1.0 : 0.0;
            if (this._sceneBounds) u.uSceneBounds.value.copy(this._sceneBounds);
            u.uRoofMap.value = this._roofTexture;
            u.uRoofAlphaMap.value = roofAlphaTexture;
            u.uScreenSize.value.set(screenWidth, screenHeight);
          }
        }
    }

    if (this._waterHitSplashSystems && this._waterHitSplashSystems.length > 0) {
      const baseIntensity = baseRainIntensity;

      let splashPrecipFactor = 0.0;
      if (precip > 0.25) {
        const t = (precip - 0.25) / 0.75;
        splashPrecipFactor = THREE ? THREE.MathUtils.clamp(t, 0.0, 1.0) : Math.max(0, Math.min(1, t));
      }

      for (let i = 0; i < this._waterHitSplashSystems.length; i++) {
        const entry = this._waterHitSplashSystems[i];
        const sys = entry?.system;
        if (!sys) continue;

        let emission = 0;
        if (waterEnabled && this._waterHitPoints && baseIntensity > 0 && splashPrecipFactor > 0) {
          emission = 80 * baseIntensity * splashPrecipFactor;
        }

        if (sys.emissionOverTime && typeof sys.emissionOverTime.value === 'number') {
          sys.emissionOverTime.value = emission;
        }

        if (entry.alphaBehavior) {
          entry.alphaBehavior.peakOpacity = 0.27 * darknessBrightnessScale;
        }
      }
    }

    if (this._foamSystem) {
      const foamEnabled = !!(waterEffect?.params?.shoreFoamEnabled);
      const foamIntensity = waterEffect?.params?.shoreFoamIntensity ?? 1.0;
      const windSpeed = weather.windSpeed || 0;

      let foamEmission = 0;
      if (foamEnabled && waterEnabled && this._shoreFoamPoints && this._shoreFoamPoints.length) {
        foamEmission = (10 + 60 * windSpeed) * foamIntensity;
      }

      if (this._foamSystem.emissionOverTime && typeof this._foamSystem.emissionOverTime.value === 'number') {
        this._foamSystem.emissionOverTime.value = foamEmission;
      }
    }

    if (this._waterHitSplashBatchMaterials && this._waterHitSplashBatchMaterials.length > 0) {
      for (const mat of this._waterHitSplashBatchMaterials) {
        if (!mat || !mat.userData || !mat.userData.roofUniforms) continue;
        const u = mat.userData.roofUniforms;
        u.uRoofMaskEnabled.value = roofMaskEnabled ? 1.0 : 0.0;
        u.uHasRoofAlphaMap.value = hasRoofAlphaMap ? 1.0 : 0.0;
        if (this._sceneBounds) u.uSceneBounds.value.copy(this._sceneBounds);
        u.uRoofMap.value = this._roofTexture;
        u.uRoofAlphaMap.value = roofAlphaTexture;
        u.uScreenSize.value.set(screenWidth, screenHeight);
      }
    }

    if (this._foamMaterial && this._foamMaterial.userData && this._foamMaterial.userData.roofUniforms) {
      const u = this._foamMaterial.userData.roofUniforms;
      u.uRoofMaskEnabled.value = roofMaskEnabled ? 1.0 : 0.0;
      u.uHasRoofAlphaMap.value = hasRoofAlphaMap ? 1.0 : 0.0;
      if (this._sceneBounds) u.uSceneBounds.value.copy(this._sceneBounds);
      u.uRoofMap.value = this._roofTexture;
      u.uRoofAlphaMap.value = roofAlphaTexture;
      u.uScreenSize.value.set(screenWidth, screenHeight);

      u.uWaterMaskEnabled.value = (waterEnabled && !!waterTex) ? 1.0 : 0.0;
      u.uWaterMaskThreshold.value = this._waterMaskThreshold;
      u.uWaterMask.value = waterTex;
    }

    if (this._foamBatchMaterial && this._foamBatchMaterial.userData && this._foamBatchMaterial.userData.roofUniforms) {
      const u = this._foamBatchMaterial.userData.roofUniforms;
      u.uRoofMaskEnabled.value = roofMaskEnabled ? 1.0 : 0.0;
      u.uHasRoofAlphaMap.value = hasRoofAlphaMap ? 1.0 : 0.0;
      if (this._sceneBounds) u.uSceneBounds.value.copy(this._sceneBounds);
      u.uRoofMap.value = this._roofTexture;
      u.uRoofAlphaMap.value = roofAlphaTexture;
      u.uScreenSize.value.set(screenWidth, screenHeight);

      u.uWaterMaskEnabled.value = (waterEnabled && !!waterTex) ? 1.0 : 0.0;
      u.uWaterMaskThreshold.value = this._waterMaskThreshold;
      u.uWaterMask.value = waterTex;
    }

    if (this.snowSystem) {
        // PERFORMANCE: Mutate existing values instead of creating new objects every frame
        const snowEmission = this.snowSystem.emissionOverTime;
        if (snowEmission && typeof snowEmission.value === 'number') {
            snowEmission.value = 500 * snowIntensity;
        }

        const flakeSize = snowTuning.flakeSize ?? 1.0;
        const sMin = 8 * flakeSize;
        const sMax = 12 * flakeSize;
        if (this.snowSystem.startSize && typeof this.snowSystem.startSize.a === 'number') {
            this.snowSystem.startSize.a = sMin;
            this.snowSystem.startSize.b = sMax;
        }

        // Snow brightness: modulate by scene darkness so flakes are dim in
        // dark scenes rather than fully self-illuminated.
        const snowBrightness = (snowTuning.brightness ?? 1.0) * darknessBrightnessScale;
        const clampedSnowB = THREE ? THREE.MathUtils.clamp(snowBrightness, 0.0, 3.0) : snowBrightness;
        const snowAlphaScale = clampedSnowB / 3.0;
        const snowMinAlpha = 1.0 * snowAlphaScale;
        const snowMaxAlpha = 0.8 * snowAlphaScale;
        // PERFORMANCE: Mutate existing ColorRange Vector4s
        if (this.snowSystem.startColor && this.snowSystem.startColor.a && this.snowSystem.startColor.b) {
            this.snowSystem.startColor.a.set(1.0, 1.0, 1.0, snowMinAlpha);
            this.snowSystem.startColor.b.set(0.9, 0.95, 1.0, snowMaxAlpha);
        }

        // Scale curl noise strength based on tuning so users can dial swirl intensity.
        if (this._snowCurl && this._snowCurlBaseStrength) {
          const curlStrength = snowTuning.curlStrength ?? 1.0;
          this._snowCurl.strength.copy(this._snowCurlBaseStrength).multiplyScalar(curlStrength);
        }

        // Drive per-flake flutter wobble from tuning so Snow Flutter Strength has effect.
        if (this._snowFlutter) {
          const flutterStrength = snowTuning.flutterStrength ?? 1.0;
          this._snowFlutter.strength = flutterStrength;
        }
        // Apply roof mask uniforms for snow (base material)
        if (this._snowMaterial && this._snowMaterial.userData && this._snowMaterial.userData.roofUniforms) {
          const uniforms = this._snowMaterial.userData.roofUniforms;
          uniforms.uRoofMaskEnabled.value = roofMaskEnabled ? 1.0 : 0.0;
          uniforms.uHasRoofAlphaMap.value = hasRoofAlphaMap ? 1.0 : 0.0;
          if (this._sceneBounds) {
            uniforms.uSceneBounds.value.copy(this._sceneBounds);
          }
          uniforms.uRoofMap.value = this._roofTexture;
          uniforms.uRoofAlphaMap.value = roofAlphaTexture;
          uniforms.uScreenSize.value.set(screenWidth, screenHeight);
        }

        // Also drive the batch ShaderMaterial uniforms used by quarks for snow.
        if (this._snowBatchMaterial && this._snowBatchMaterial.userData && this._snowBatchMaterial.userData.roofUniforms) {
          const uniforms = this._snowBatchMaterial.userData.roofUniforms;
          uniforms.uRoofMaskEnabled.value = roofMaskEnabled ? 1.0 : 0.0;
          uniforms.uHasRoofAlphaMap.value = hasRoofAlphaMap ? 1.0 : 0.0;
          if (this._sceneBounds) {
            uniforms.uSceneBounds.value.copy(this._sceneBounds);
          }
          uniforms.uRoofMap.value = this._roofTexture;
          uniforms.uRoofAlphaMap.value = roofAlphaTexture;
          uniforms.uScreenSize.value.set(screenWidth, screenHeight);
        }
    }

    // --- WIND & GRAVITY COUPLING ---
    if (THREE && (this._rainWindForce || this._snowWindForce || this._rainGravityForce || this._snowGravityForce)) {
      const windSpeed = weather.windSpeed || 0; // 0-1 scalar
      const dir2 = weather.windDirection; // Expected THREE.Vector2 or Vector3-like

      // PERFORMANCE FIX: Reuse _tempWindDir instead of allocating new Vector3 every frame
      const baseDir = this._tempWindDir;
      baseDir.set(dir2?.x ?? 1, dir2?.y ?? 0, 0);
      if (baseDir.lengthSq() === 0) baseDir.set(1, 0, 0);
      baseDir.normalize();

      // Rain: follow wind direction directly (no turbulence needed here)
      // Scale magnitude by windSpeed and user windInfluence so the UI control has visible effect.
      const rainWindInfluence = rainTuning.windInfluence ?? 1.0;
      if (this._rainWindForce && this._rainWindForce.direction) {
        this._rainWindForce.direction.set(baseDir.x, baseDir.y, 0);
        // PERFORMANCE: Mutate existing ConstantValue instead of creating new one
        if (this._rainWindForce.magnitude && typeof this._rainWindForce.magnitude.value === 'number') {
          this._rainWindForce.magnitude.value = 3000 * windSpeed * rainWindInfluence;
        }
      }

      // Rain curl turbulence: very low at calm, grows with wind speed.
      if (this._rainCurl && this._rainCurlBaseStrength) {
        // Start introducing turbulence once windSpeed exceeds 0.5, ramping to full at 1.0.
        let windTurbulenceFactor = 0;
        if (windSpeed > 0.5) {
          windTurbulenceFactor = THREE.MathUtils.clamp((windSpeed - 0.5) / 0.5, 0, 1);
        }

        const curlStrength = rainTuning.curlStrength ?? 1.0;
        const curlScale = windTurbulenceFactor * curlStrength;
        this._rainCurl.strength.copy(this._rainCurlBaseStrength).multiplyScalar(curlScale);
      }

      // Snow: align large-scale drift with global wind; fine-grained turbulence now
      // comes from TurbulenceField behavior instead of manual sine-based drift.
      const snowWindInfluence = snowTuning.windInfluence ?? 1.0;
      if (this._snowWindForce && this._snowWindForce.direction) {
        this._snowWindForce.direction.set(baseDir.x, baseDir.y, 0);

        // Let windSpeed fully control alignment strength; at 0 wind, no directional drift.
        // PERFORMANCE: Mutate existing ConstantValue instead of creating new one
        if (this._snowWindForce.magnitude && typeof this._snowWindForce.magnitude.value === 'number') {
          const baseMag = 800; // matches constructor default above
          const align = THREE.MathUtils.clamp(windSpeed, 0, 1);
          const strength = align * snowWindInfluence;
          this._snowWindForce.magnitude.value = baseMag * strength;
        }
      }

      // Gravity scaling for rain and snow
      // PERFORMANCE: Mutate existing ConstantValue instead of creating new one
      const rainGravScale = rainTuning.gravityScale ?? 1.0;
      if (this._rainGravityForce && this._rainGravityForce.magnitude && typeof this._rainGravityForce.magnitude.value === 'number') {
        this._rainGravityForce.magnitude.value = this._rainBaseGravity * rainGravScale;
      }

      const snowGravScale = snowTuning.gravityScale ?? 1.0;
      if (this._snowGravityForce && this._snowGravityForce.magnitude && typeof this._snowGravityForce.magnitude.value === 'number') {
        this._snowGravityForce.magnitude.value = this._snowBaseGravity * snowGravScale;
      }

      // Splashes: Wind coupling (> 25%)
      // PERFORMANCE: Mutate existing ConstantValue instead of creating new one
      if (this._splashWindForces && this._splashWindForces.length > 0) {
        let splashWindMag = 0;
        // "Start subtle but at 100% wind speed it can be stronger."
        if (windSpeed > 0.25) {
          // Map 0.25..1.0 to 0.0..1.0
          const t = (windSpeed - 0.25) * 4.0;
          // Base magnitude 75 (~5x weaker than previous 375)
          splashWindMag = t * 75;
        }

        for (const force of this._splashWindForces) {
          if (force.direction) force.direction.set(baseDir.x, baseDir.y, 0);
          if (force.magnitude && typeof force.magnitude.value === 'number') {
            force.magnitude.value = splashWindMag;
          }
        }
      }
    }
  }

  dispose() {
    if (this.rainSystem) {
      this.batchRenderer.deleteSystem(this.rainSystem);
      if (this.rainSystem.emitter.parent) this.rainSystem.emitter.parent.remove(this.rainSystem.emitter);
    }
    if (this.snowSystem) {
      this.batchRenderer.deleteSystem(this.snowSystem);
      if (this.snowSystem.emitter.parent) this.snowSystem.emitter.parent.remove(this.snowSystem.emitter);
    }

    if (this.splashSystems && this.splashSystems.length) {
      for (const sys of this.splashSystems) {
        if (!sys) continue;
        this.batchRenderer.deleteSystem(sys);
        if (sys.emitter?.parent) sys.emitter.parent.remove(sys.emitter);
      }
    }

    if (this._waterHitSplashSystems && this._waterHitSplashSystems.length) {
      for (const entry of this._waterHitSplashSystems) {
        const sys = entry?.system;
        if (!sys) continue;
        this.batchRenderer.deleteSystem(sys);
        if (sys.emitter?.parent) sys.emitter.parent.remove(sys.emitter);
      }
    }

    if (this._foamSystem) {
      this.batchRenderer.deleteSystem(this._foamSystem);
      if (this._foamSystem.emitter?.parent) this._foamSystem.emitter.parent.remove(this._foamSystem.emitter);
    }

    if (this.rainTexture) this.rainTexture.dispose();
    if (this.snowTexture) this.snowTexture.dispose();
    if (this.splashTexture) this.splashTexture.dispose();
    if (this.foamTexture) this.foamTexture.dispose();
  }

  _generateWaterSplashPoints(maskTexture, threshold = 0.15, stride = 2, maxPoints = 20000) {
    const image = maskTexture?.image;
    if (!image) return null;

    const w = image.width;
    const h = image.height;
    if (!w || !h) return null;

    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;

    try {
      ctx.drawImage(image, 0, 0);
    } catch (e) {
      return null;
    }

    let img;
    try {
      img = ctx.getImageData(0, 0, w, h);
    } catch (e) {
      return null;
    }

    const data = img.data;
    const pts = [];

    const s = Math.max(1, stride | 0);
    for (let y = 0; y < h; y += s) {
      const row = y * w;
      for (let x = 0; x < w; x += s) {
        const i = (row + x) * 4;
        const r = data[i] / 255;
        if (r >= threshold) {
          pts.push(x / w);
          pts.push(y / h);
          if (pts.length >= maxPoints * 2) {
            y = h;
            break;
          }
        }
      }
    }

    if (pts.length < 2) return null;
    return new Float32Array(pts);
  }

  _generateWaterEdgePoints(maskTexture, threshold = 0.15, stride = 2, maxPoints = 12000) {
    const image = maskTexture?.image;
    if (!image) return null;

    const w = image.width;
    const h = image.height;
    if (!w || !h) return null;

    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;

    try {
      ctx.drawImage(image, 0, 0);
    } catch (e) {
      return null;
    }

    let img;
    try {
      img = ctx.getImageData(0, 0, w, h);
    } catch (e) {
      return null;
    }

    const data = img.data;
    const pts = [];

    const s = Math.max(1, stride | 0);
    const sample = (x, y) => {
      const ix = (y * w + x) * 4;
      return data[ix] / 255;
    };

    for (let y = 1; y < h - 1; y += s) {
      for (let x = 1; x < w - 1; x += s) {
        const r = sample(x, y);
        if (r < threshold) continue;

        const rl = sample(x - 1, y);
        const rr = sample(x + 1, y);
        const ru = sample(x, y - 1);
        const rd = sample(x, y + 1);
        const isEdge = (rl < threshold) || (rr < threshold) || (ru < threshold) || (rd < threshold);
        if (!isEdge) continue;

        let nx = rr - rl;
        let ny = rd - ru;
        const len = Math.sqrt(nx * nx + ny * ny);
        if (len > 1e-5) {
          nx /= len;
          ny /= len;
        } else {
          nx = 1;
          ny = 0;
        }

        pts.push(x / w);
        pts.push(y / h);
        pts.push(nx);
        pts.push(-ny);

        if (pts.length >= maxPoints * 4) {
          y = h;
          break;
        }
      }
    }

    if (pts.length < 4) return null;
    return new Float32Array(pts);
  }
}
