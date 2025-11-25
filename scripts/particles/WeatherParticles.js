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
  CurlNoiseField
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
  }

  initialize(particle, system) { /* no-op */ }

  update(particle, delta, system) {
    const p = particle.position;
    if (!p) return;

    // Convert to world space using the emitter's matrixWorld when available,
    // so this behavior works whether the system uses local or world space.
    const THREE = window.THREE;
    let wx = p.x;
    let wy = p.y;
    let wz = p.z;

    if (THREE && system && system.emitter && system.emitter.matrixWorld) {
      const wp = new THREE.Vector3(p.x, p.y, p.z);
      wp.applyMatrix4(system.emitter.matrixWorld);
      wx = wp.x;
      wy = wp.y;
      wz = wp.z;
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

// NOTE: For both rain and snow we now treat particle.position as world-space
// (worldSpace: true in the Quarks systems) and define the kill volume
// directly from the scene rectangle and 0..7500 height.

export class WeatherParticles {
  constructor(batchRenderer, scene) {
    this.batchRenderer = batchRenderer;
    this.scene = scene;
    this.rainSystem = null;
    this.snowSystem = null;
    this.rainTexture = this._createRainTexture();
    this.snowTexture = this._createSnowTexture();
    this.enabled = true;
    this._time = 0;

    this._rainWindForce = null;
    this._snowWindForce = null;
    this._rainGravityForce = null;
    this._snowGravityForce = null;
    this._snowFlutter = null; // legacy; no longer used in behaviors
    this._snowCurl = null;
    this._snowCurlBaseStrength = null;
    this._rainCurl = null;
    this._rainCurlBaseStrength = null;

    this._rainBaseGravity = 8000;
    this._snowBaseGravity = 3000;

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
    const canvas = document.createElement('canvas');
    canvas.width = 32;
    canvas.height = 32;
    const ctx = canvas.getContext('2d');
    const grad = ctx.createRadialGradient(16, 16, 0, 16, 16, 16);
    grad.addColorStop(0, 'rgba(255, 255, 255, 1)');
    grad.addColorStop(1, 'rgba(255, 255, 255, 0)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, 32, 32);
    return new window.THREE.CanvasTexture(canvas);
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
    // We then extend this into 3D by treating Z=0 as the ground plane and
    // Z=7500 as the top of the world volume for all weather particles.
    log.info(`WeatherParticles: scene bounds [${sceneX}, ${sceneY}, ${sceneW}x${sceneH}]`);

    const centerX = sceneX + sceneW / 2;
    const centerY = sceneY + sceneH / 2;
    const emitterZ = 3000; // High ceiling

    // World volume in world space: scene rectangle in X/Y, 0..7500 in Z.
    const volumeMin = new THREE.Vector3(sceneX, sceneY, 0);
    const volumeMax = new THREE.Vector3(sceneX + sceneW, sceneY + sceneH, 7500);
    const killBehavior = new WorldVolumeKillBehavior(volumeMin, volumeMax);
    
    // --- COMMON OVER-LIFE BEHAVIORS ---
    // Rain: keep chroma roughly constant but fade alpha towards the end of life.
    const rainColorOverLife = new ColorOverLife(
      new ColorRange(
        new Vector4(1.0, 1.0, 1.0, 1.0),
        new Vector4(1.0, 1.0, 1.0, 0.2)
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
       blending: THREE.AdditiveBlending,
       color: 0xffffff,
       opacity: 1.0,
       side: THREE.DoubleSide // Ensure visibility from all angles
     });

     this.rainSystem = new ParticleSystem({
       duration: 1,
       looping: true,
       prewarm: true,
       
       // LIFE: Short life ensures they don't fall infinitely below the floor
       startLife: new IntervalValue(0.6, 0.8),
       
       // SPEED: High, but not game-breakingly high.
       // Gravity will accelerate them further.
       startSpeed: new IntervalValue(6000, 8000), 
       
       // SIZE: narrow streaks; actual visual width is mostly from texture.
      startSize: new IntervalValue(1.2, 2.2), 
       
       startColor: new ColorRange(new Vector4(0.6, 0.7, 1.0, 0.5), new Vector4(0.6, 0.7, 1.0, 0.2)),
       worldSpace: true,
       maxParticles: 15000,
       emissionOverTime: new ConstantValue(0), 
       shape: new RandomRectangleEmitter({ width: sceneW, height: sceneH }),
       material: rainMaterial,
       
       // RENDER MODE: StretchedBillBoard
       // Uses velocity to stretch the quad.
       renderMode: RenderMode.StretchedBillBoard,
       // speedFactor: Controls how "long" the rain streak is relative to speed.
       // 4000 speed * 0.05 factor = 200 unit long streak.
       speedFactor: 0.05, 
       
       startRotation: new ConstantValue(0),
       behaviors: [gravity, wind, rainColorOverLife, killBehavior],
    });
     
     this.rainSystem.emitter.position.set(centerX, centerY, emitterZ);
     // Rotate Emitter to shoot DOWN (-Z)
     this.rainSystem.emitter.rotation.set(Math.PI, 0, 0);

     if (this.scene) this.scene.add(this.rainSystem.emitter);
     this.batchRenderer.addSystem(this.rainSystem);

     // --- RAIN CURL NOISE (shared for all rain particles) ---
    const rainCurl = new CurlNoiseField(
      new THREE.Vector3(1400, 1400, 2000),   // larger cells than snow for broad gusts
      new THREE.Vector3(80, 80, 20),         // relatively subtle swirl
      0.08                                   // time scale
    );

    // Attach curl as a behavior to the rain system
    this.rainSystem.behaviors.push(rainCurl);

    // --- SNOW ---
     const snowMaterial = new THREE.MeshBasicMaterial({
       map: this.snowTexture,
       transparent: true,
       depthWrite: false,
       blending: THREE.AdditiveBlending,
       color: 0xffffff
     });

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
      // Snow uses standard Billboards (flakes don't stretch)
      renderMode: RenderMode.BillBoard,
      startRotation: new IntervalValue(0, Math.PI * 2),
      // Horizontal motion now comes only from snowWind (driven by windSpeed)
      // and snowCurl (turbulence field), plus gravity for vertical fall.
      behaviors: [snowGravity, snowWind, snowCurl, snowColorOverLife, killBehavior.clone()],
    });
     
     this.snowSystem.emitter.position.set(centerX, centerY, emitterZ);
     this.snowSystem.emitter.rotation.set(Math.PI, 0, 0);

     if (this.scene) this.scene.add(this.snowSystem.emitter);
     this.batchRenderer.addSystem(this.snowSystem);
     
     // Cache references to key forces/behaviors so we can drive them from WeatherController
     this._rainWindForce = wind;
    this._snowWindForce = snowWind;
    this._rainGravityForce = gravity;
    this._snowGravityForce = snowGravity;
    this._snowCurl = snowCurl;
    this._snowCurlBaseStrength = snowCurl.strength.clone();
    this._rainCurl = rainCurl;
    this._rainCurlBaseStrength = rainCurl.strength.clone();

     log.info(`Weather systems initialized. Area: ${sceneW}x${sceneH}`);
  }

  update(dt) {
    const weather = weatherController.getCurrentState();
    if (!weather) return;
    
    // Safety check: if dt is unexpectedly in MS (e.g. 16.6), clamp it.
    // Three.quarks explodes if given MS instead of Seconds.
    const safeDt = dt > 1.0 ? dt / 1000 : dt;
    this._time += safeDt;

    const THREE = window.THREE;

    const precip = weather.precipitation || 0;
    const freeze = weather.freezeLevel || 0;
    const rainTuning = weatherController.rainTuning || {};
    const snowTuning = weatherController.snowTuning || {};
    const rainIntensity = precip * (1.0 - freeze) * (rainTuning.intensityScale ?? 1.0);
    const snowIntensity = precip * freeze * (snowTuning.intensityScale ?? 1.0);
    
    if (this.rainSystem) {
        this.rainSystem.emissionOverTime = new ConstantValue(4000 * rainIntensity);

        const dropSize = rainTuning.dropSize ?? 1.0;
        const sizeMin = 1.2 * dropSize;
        const sizeMax = 2.2 * dropSize;
        this.rainSystem.startSize = new IntervalValue(sizeMin, sizeMax);

        const streakLen = rainTuning.streakLength ?? 1.0;
        this.rainSystem.speedFactor = 0.05 * streakLen;

        // Map brightness tuning to material opacity so user can make rain more/less visible.
        const brightness = rainTuning.brightness ?? 1.0;
        if (this.rainSystem.material) {
          // Simple mapping: 0.5 -> quite faint, 2.5+ -> very solid but clamped to 1.0
          const targetOpacity = THREE.MathUtils.clamp(0.3 + 0.3 * brightness, 0.0, 1.0);
          this.rainSystem.material.opacity = targetOpacity;
          this.rainSystem.material.needsUpdate = true;
        }
    }
    if (this.snowSystem) {
        this.snowSystem.emissionOverTime = new ConstantValue(500 * snowIntensity);

        const flakeSize = snowTuning.flakeSize ?? 1.0;
        const sMin = 8 * flakeSize;
        const sMax = 12 * flakeSize;
        this.snowSystem.startSize = new IntervalValue(sMin, sMax);

        // Scale curl noise strength based on tuning so users can dial swirl intensity.
        if (this._snowCurl && this._snowCurlBaseStrength) {
          const curlStrength = snowTuning.curlStrength ?? 1.0;
          this._snowCurl.strength.copy(this._snowCurlBaseStrength).multiplyScalar(curlStrength);
        }
    }

    // --- WIND & GRAVITY COUPLING ---
    if (THREE && (this._rainWindForce || this._snowWindForce || this._rainGravityForce || this._snowGravityForce)) {
      const windSpeed = weather.windSpeed || 0; // 0-1 scalar
      const dir2 = weather.windDirection; // Expected THREE.Vector2 or Vector3-like

      const baseDir = new THREE.Vector3(
        dir2?.x ?? 1,
        dir2?.y ?? 0,
        0
      );
      if (baseDir.lengthSq() === 0) baseDir.set(1, 0, 0);
      baseDir.normalize();

      // Rain: follow wind direction directly (no turbulence needed here)
      // Scale magnitude by windSpeed and user windInfluence so the UI control has visible effect.
      const rainWindInfluence = rainTuning.windInfluence ?? 1.0;
      if (this._rainWindForce && this._rainWindForce.direction) {
        this._rainWindForce.direction.set(baseDir.x, baseDir.y, 0);
        if (typeof this._rainWindForce.magnitude !== 'undefined') {
          this._rainWindForce.magnitude = new ConstantValue(3000 * windSpeed * rainWindInfluence);
        }
      }

      // Rain curl turbulence: very low at calm, grows with wind speed.
      if (this._rainCurl && this._rainCurlBaseStrength) {
        const curlScale = THREE.MathUtils.clamp(windSpeed, 0, 1);
        this._rainCurl.strength.copy(this._rainCurlBaseStrength).multiplyScalar(curlScale);
      }

      // Snow: align large-scale drift with global wind; fine-grained turbulence now
      // comes from TurbulenceField behavior instead of manual sine-based drift.
      const snowWindInfluence = snowTuning.windInfluence ?? 1.0;
      if (this._snowWindForce && this._snowWindForce.direction) {
        this._snowWindForce.direction.set(baseDir.x, baseDir.y, 0);

        // Let windSpeed fully control alignment strength; at 0 wind, no directional drift.
        if (typeof this._snowWindForce.magnitude !== 'undefined') {
          const baseMag = 800; // matches constructor default above
          const align = THREE.MathUtils.clamp(windSpeed, 0, 1);
          const strength = align * snowWindInfluence;
          this._snowWindForce.magnitude = new ConstantValue(baseMag * strength);
        }
      }

      // Gravity scaling for rain and snow
      const rainGravScale = rainTuning.gravityScale ?? 1.0;
      if (this._rainGravityForce && typeof this._rainGravityForce.magnitude !== 'undefined') {
        this._rainGravityForce.magnitude = new ConstantValue(this._rainBaseGravity * rainGravScale);
      }

      const snowGravScale = snowTuning.gravityScale ?? 1.0;
      if (this._snowGravityForce && typeof this._snowGravityForce.magnitude !== 'undefined') {
        this._snowGravityForce.magnitude = new ConstantValue(this._snowBaseGravity * snowGravScale);
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
    if (this.rainTexture) this.rainTexture.dispose();
    if (this.snowTexture) this.snowTexture.dispose();
  }
}
