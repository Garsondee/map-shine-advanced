/**
 * @fileoverview Smelly Flies Effect - AI-driven particle swarm with state machine behavior
 * Flies spawn from map point areas, buzz around, land, walk, and take off again.
 * @module particles/SmellyFliesEffect
 */

import { EffectBase, RenderLayers } from '../effects/EffectComposer.js';
import { createLogger } from '../core/log.js';
import { 
  ParticleSystem, 
  IntervalValue,
  ColorRange,
  Vector4,
  RenderMode,
  ConstantValue
} from '../libs/three.quarks.module.js';
import { weatherController } from '../core/WeatherController.js';

const log = createLogger('SmellyFliesEffect');

/**
 * Fly behavior states
 */
const FLY_STATE = {
  SPAWNING: 'spawning',
  FLYING: 'flying',
  LANDING: 'landing',
  WALKING: 'walking',
  TAKING_OFF: 'takingOff'
};

/**
 * Walking sub-states
 */
const WALK_STATE = {
  IDLE: 'idle',
  ROTATING: 'rotating',
  MOVING: 'moving'
};

/**
 * Default configuration for fly behavior
 */
const DEFAULT_FLY_CONFIG = {
  enabled: true,
  maxParticles: 4,
  // Global behavior speed multiplier (affects all states)
  speedMultiplier: 2.75,
  
  // Flying behavior
  flying: {
    spawnDuration: 0.5,
    noiseStrength: 1500,
    tetherStrength: 20.0,
    maxSpeed: 600,
    drag: 0.85,
    landChance: 0.08,
    landingDuration: 0.8,
    flyHeight: 80
  },
  
  // Walking behavior
  walking: {
    walkSpeed: 40,
    minIdleTime: 1.0,
    maxIdleTime: 4.0,
    minMoveDistance: 15,
    maxMoveDistance: 60,
    takeoffChance: 0.03,
    rotationSpeed: 4.0
  },
  
  // Visual properties
  visual: {
    flyingScale: 18,
    walkingScale: 16,
    motionBlurEnabled: true,
    motionBlurStrength: 0.02,
    motionBlurMaxLength: 3,
    fadeInDuration: 0.5,     // Seconds to fade in
    fadeOutDuration: 1.0     // Seconds to fade out before death
  }
};

/**
 * Emitter shape that spawns particles within a polygon area
 * Uses rejection sampling to find valid spawn points
 */
class AreaSpawnShape {
  /**
   * @param {Array<{x: number, y: number}>} polygon - Polygon vertices
   * @param {{minX: number, minY: number, maxX: number, maxY: number, centerX: number, centerY: number, width: number, height: number}} bounds - Precomputed bounds
   * @param {SmellyFliesEffect} ownerEffect - Parent effect reference
   */
  constructor(polygon, bounds, ownerEffect) {
    this.polygon = polygon;
    this.bounds = bounds;
    this.ownerEffect = ownerEffect;
    this.type = 'area_spawn';
  }

  /**
   * Initialize a particle at a random position within the polygon
   * @param {Object} particle - three.quarks particle
   */
  initialize(particle) {
    const groundZ = this._getGroundZ();
    
    // Rejection sampling: try to find a point inside the polygon
    let x, y;
    let attempts = 0;
    const maxAttempts = 20;
    
    while (attempts < maxAttempts) {
      x = this.bounds.minX + Math.random() * this.bounds.width;
      y = this.bounds.minY + Math.random() * this.bounds.height;
      
      if (this._isPointInPolygon(x, y)) {
        break;
      }
      attempts++;
    }
    
    // Fallback to centroid if rejection sampling fails
    if (attempts >= maxAttempts) {
      x = this.bounds.centerX;
      y = this.bounds.centerY;
    }
    
    // Set initial position at ground level (spawn standing)
    particle.position.x = x;
    particle.position.y = y;
    particle.position.z = groundZ;
    
    // Initialize fly-specific userData - START AS WALKING (on ground)
    particle.userData = particle.userData || {};
    particle.userData.state = FLY_STATE.WALKING;  // Start on ground, not flying
    particle.userData.stateTimer = 0;
    particle.userData.home = { x, y };
    particle.userData.velocity = { x: 0, y: 0 };
    particle.userData.walkState = WALK_STATE.IDLE;
    particle.userData.walkTarget = null;
    particle.userData.idleTimer = Math.random() * 2.0;  // Random initial idle
    particle.userData.rotation = Math.random() * Math.PI * 2;
    particle.userData.polygon = this.polygon;
    particle.userData.bounds = this.bounds;
    particle.userData.spawnTime = 0;  // Track spawn time for fade-in
    
    // Reset velocity
    if (particle.velocity) {
      particle.velocity.set(0, 0, 0);
    }
    
    // Set initial rotation on particle
    particle.rotation = particle.userData.rotation;
  }

  /**
   * Ray-casting point-in-polygon test
   * @private
   */
  _isPointInPolygon(x, y) {
    let inside = false;
    const polygon = this.polygon;
    const n = polygon.length;
    
    for (let i = 0, j = n - 1; i < n; j = i++) {
      const xi = polygon[i].x, yi = polygon[i].y;
      const xj = polygon[j].x, yj = polygon[j].y;
      
      if (((yi > y) !== (yj > y)) &&
          (x < (xj - xi) * (y - yi) / (yj - yi) + xi)) {
        inside = !inside;
      }
    }
    
    return inside;
  }

  /**
   * Get ground Z level
   * @private
   */
  _getGroundZ() {
    const sceneComposer = window.MapShine?.sceneComposer;
    return (sceneComposer && typeof sceneComposer.groundZ === 'number')
      ? sceneComposer.groundZ
      : 1000;
  }

  update(system, delta) {
    // Static shape, no per-frame evolution
  }
}

/**
 * Custom behavior that implements the fly state machine
 * Handles flying, landing, walking, and takeoff transitions
 */
class FlyBehavior {
  constructor(config = {}) {
    this.type = 'FlyBehavior';
    this.config = { ...DEFAULT_FLY_CONFIG, ...config };
    
    // PERFORMANCE: Reuse temp objects
    this._tempVec = { x: 0, y: 0 };
  }

  initialize(particle, system) {
    // Ensure userData exists with defaults
    if (!particle.userData) {
      particle.userData = {};
    }
    
    const ud = particle.userData;
    if (!ud.state) ud.state = FLY_STATE.SPAWNING;
    if (!ud.stateTimer) ud.stateTimer = 0;
    if (!ud.velocity) ud.velocity = { x: 0, y: 0 };
    if (!ud.home) ud.home = { x: particle.position.x, y: particle.position.y };
    if (!ud.walkState) ud.walkState = WALK_STATE.IDLE;
    if (typeof ud.rotation !== 'number') ud.rotation = Math.random() * Math.PI * 2;
    
    // Burst-based flight: flies dart in a direction, then pick a new one
    if (typeof ud.burstTimer !== 'number') ud.burstTimer = 0;
    if (typeof ud.burstDuration !== 'number') ud.burstDuration = 0;
    if (!ud.burstDir) ud.burstDir = { x: 0, y: 0 };
  }

  update(particle, delta, system) {
    if (!particle || !particle.userData) return;
    
    // Clamp delta to prevent physics explosions
    const rawDt = Math.min(Math.max(delta, 0), 0.1);
    if (rawDt <= 0.0001) return;

    // Apply per-effect speed multiplier so all states run faster/slower
    const speedMul = (this.config && typeof this.config.speedMultiplier === 'number')
      ? this.config.speedMultiplier
      : 1.0;
    const dt = rawDt * speedMul;
    
    const ud = particle.userData;
    ud.stateTimer += dt;
    
    switch (ud.state) {
      case FLY_STATE.SPAWNING:
        this._updateSpawning(particle, dt);
        break;
      case FLY_STATE.FLYING:
        this._updateFlying(particle, dt);
        break;
      case FLY_STATE.LANDING:
        this._updateLanding(particle, dt);
        break;
      case FLY_STATE.WALKING:
        this._updateWalking(particle, dt);
        break;
      case FLY_STATE.TAKING_OFF:
        this._updateTakingOff(particle, dt);
        break;
    }
    
    // Apply motion blur via scale stretching
    this._applyMotionBlur(particle);
    
    // Apply rotation to face direction of travel
    particle.rotation = ud.rotation;
    
    // Apply fade in/out via color alpha
    this._applyFade(particle, dt);
    
    // Set UV tile based on state (0 = flying, 1 = landed/walking)
    this._applyTextureTile(particle);
  }
  
  /**
   * Set particle.uvTile based on current state
   * Frame 0 = flying texture, Frame 1 = landed texture
   * @private
   */
  _applyTextureTile(particle) {
    const ud = particle.userData;
    
    // Walking and landing states use landed texture (frame 1)
    // All other states use flying texture (frame 0)
    if (ud.state === FLY_STATE.WALKING || ud.state === FLY_STATE.LANDING) {
      particle.uvTile = 1;
    } else {
      particle.uvTile = 0;
    }
  }
  
  /**
   * Apply fade in at spawn and fade out near death
   * @private
   */
  _applyFade(particle, dt) {
    const ud = particle.userData;
    const cfg = this.config.visual;
    
    // Track total time alive
    ud.spawnTime = (ud.spawnTime || 0) + dt;
    
    let alpha = 1.0;
    
    // Fade in
    if (ud.spawnTime < cfg.fadeInDuration) {
      alpha = ud.spawnTime / cfg.fadeInDuration;
    }
    
    // Fade out near end of life (check particle.life and particle.age)
    const remainingLife = (particle.life || 30) - (particle.age || 0);
    if (remainingLife < cfg.fadeOutDuration) {
      alpha = Math.min(alpha, remainingLife / cfg.fadeOutDuration);
    }
    
    // Clamp alpha
    alpha = Math.max(0, Math.min(1, alpha));
    
    // Apply to particle color
    if (particle.color) {
      particle.color.w = alpha;
    }
  }

  /**
   * Spawning state: initial burst upward from spawn point
   * @private
   */
  _updateSpawning(particle, dt) {
    const ud = particle.userData;
    const cfg = this.config.flying;
    const groundZ = this._getGroundZ();
    
    // Rise up from ground
    const progress = Math.min(ud.stateTimer / cfg.spawnDuration, 1.0);
    const targetZ = groundZ + cfg.flyHeight * progress;
    particle.position.z = targetZ;
    
    // Add some initial random velocity
    if (ud.stateTimer < 0.1) {
      ud.velocity.x = (Math.random() - 0.5) * cfg.noiseStrength * 0.5;
      ud.velocity.y = (Math.random() - 0.5) * cfg.noiseStrength * 0.5;
    }
    
    // Transition to flying after spawn duration
    if (ud.stateTimer >= cfg.spawnDuration) {
      ud.state = FLY_STATE.FLYING;
      ud.stateTimer = 0;
    }
  }

  /**
   * Flying state: burst-based darting with sharp direction changes
   * Real flies move in sudden jerky arcs, not smooth curves
   * @private
   */
  _updateFlying(particle, dt) {
    const ud = particle.userData;
    const cfg = this.config.flying;
    const groundZ = this._getGroundZ();
    
    // === BURST-BASED MOVEMENT ===
    // Flies dart in a direction for a short burst, then pick a new direction
    ud.burstTimer -= dt;
    
    if (ud.burstTimer <= 0) {
      // Pick a new burst direction and duration
      // Burst duration: 0.05 - 0.25 seconds (very short, frantic)
      ud.burstDuration = 0.05 + Math.random() * 0.2;
      ud.burstTimer = ud.burstDuration;
      
      // New random direction with some bias toward home if far away
      const dx = ud.home.x - particle.position.x;
      const dy = ud.home.y - particle.position.y;
      const distFromHome = Math.hypot(dx, dy) || 1;
      
      // Random angle, but bias toward home based on distance and tether strength
      // Tether strength 5 = very weak bias, 50 = strong bias
      const homeBias = Math.min(1.0, (distFromHome / 200) * (cfg.tetherStrength / 25));
      const homeAngle = Math.atan2(dy, dx);
      const randomAngle = Math.random() * Math.PI * 2;
      
      // Blend between random and home-directed based on distance
      const finalAngle = randomAngle + homeBias * this._angleDiff(randomAngle, homeAngle) * 0.6;
      
      // Burst speed varies - sometimes fast dart, sometimes slower drift
      const burstSpeed = cfg.noiseStrength * (0.3 + Math.random() * 0.7);
      
      ud.burstDir.x = Math.cos(finalAngle) * burstSpeed;
      ud.burstDir.y = Math.sin(finalAngle) * burstSpeed;
    }
    
    // Apply burst force (strong at start of burst, fades)
    const burstProgress = 1 - (ud.burstTimer / ud.burstDuration);
    const burstStrength = 1 - burstProgress * 0.5; // Fade to 50% over burst
    
    ud.velocity.x += ud.burstDir.x * burstStrength * dt;
    ud.velocity.y += ud.burstDir.y * burstStrength * dt;
    
    // === SOFT TETHER (only when far from home) ===
    const dx = ud.home.x - particle.position.x;
    const dy = ud.home.y - particle.position.y;
    const dist = Math.hypot(dx, dy) || 1;
    
    // Tether only kicks in beyond a threshold distance
    const tetherThreshold = 100;
    if (dist > tetherThreshold) {
      const nx = dx / dist;
      const ny = dy / dist;
      // Gentle pull, scaled by how far beyond threshold
      const overDist = dist - tetherThreshold;
      const tetherForce = overDist * cfg.tetherStrength * 0.02;
      ud.velocity.x += nx * tetherForce * dt;
      ud.velocity.y += ny * tetherForce * dt;
    }
    
    // === SPEED LIMIT ===
    const speed = Math.hypot(ud.velocity.x, ud.velocity.y);
    if (speed > cfg.maxSpeed) {
      const ratio = cfg.maxSpeed / speed;
      ud.velocity.x *= ratio;
      ud.velocity.y *= ratio;
    }
    
    // === DRAG (lower than before for snappier movement) ===
    const dragFactor = 1 - cfg.drag * 0.5 * dt;
    ud.velocity.x *= dragFactor;
    ud.velocity.y *= dragFactor;
    
    // === INTEGRATE POSITION ===
    particle.position.x += ud.velocity.x * dt;
    particle.position.y += ud.velocity.y * dt;
    
    // Keep at fly height
    particle.position.z = groundZ + cfg.flyHeight;
    
    // Update rotation to face movement direction
    if (speed > 10) {
      // Snap rotation more quickly for jerky feel
      const targetRot = Math.atan2(ud.velocity.y, ud.velocity.x);
      ud.rotation = this._lerpAngle(ud.rotation, targetRot, dt * 12);
    }
    
    // Random chance to land
    if (Math.random() < cfg.landChance * dt) {
      this._transitionToLanding(particle);
    }
  }

  /**
   * Landing state: descending to ground
   * @private
   */
  _updateLanding(particle, dt) {
    const ud = particle.userData;
    const cfg = this.config.flying;
    const groundZ = this._getGroundZ();
    
    // Slow down horizontal movement
    ud.velocity.x *= 0.9;
    ud.velocity.y *= 0.9;
    
    // Descend
    const progress = Math.min(ud.stateTimer / cfg.landingDuration, 1.0);
    const startZ = groundZ + cfg.flyHeight;
    particle.position.z = startZ + (groundZ - startZ) * progress;
    
    // Still move horizontally (slowly)
    particle.position.x += ud.velocity.x * dt * 0.3;
    particle.position.y += ud.velocity.y * dt * 0.3;
    
    // Transition to walking when landed
    if (progress >= 1.0) {
      ud.state = FLY_STATE.WALKING;
      ud.stateTimer = 0;
      ud.walkState = WALK_STATE.IDLE;
      ud.idleTimer = this._randomIdleTime();
      particle.position.z = groundZ;
    }
  }

  /**
   * Walking state: ground movement with idle/rotate/move sub-states
   * @private
   */
  _updateWalking(particle, dt) {
    const ud = particle.userData;
    const cfg = this.config.walking;
    const groundZ = this._getGroundZ();
    
    // Ensure we stay on ground
    particle.position.z = groundZ;
    
    switch (ud.walkState) {
      case WALK_STATE.IDLE:
        ud.idleTimer -= dt;
        if (ud.idleTimer <= 0) {
          // Pick new walk target inside polygon
          ud.walkTarget = this._pickWalkTarget(particle);
          ud.walkState = WALK_STATE.ROTATING;
        }
        break;
        
      case WALK_STATE.ROTATING:
        if (!ud.walkTarget) {
          ud.walkState = WALK_STATE.IDLE;
          ud.idleTimer = this._randomIdleTime();
          break;
        }
        
        // Calculate target angle
        const targetAngle = Math.atan2(
          ud.walkTarget.y - particle.position.y,
          ud.walkTarget.x - particle.position.x
        );
        
        // Lerp rotation toward target
        ud.rotation = this._lerpAngle(ud.rotation, targetAngle, dt * cfg.rotationSpeed);
        
        // Check if facing target
        if (Math.abs(this._angleDiff(ud.rotation, targetAngle)) < 0.1) {
          ud.walkState = WALK_STATE.MOVING;
        }
        break;
        
      case WALK_STATE.MOVING:
        if (!ud.walkTarget) {
          ud.walkState = WALK_STATE.IDLE;
          ud.idleTimer = this._randomIdleTime();
          break;
        }
        
        // Move toward target
        const tdx = ud.walkTarget.x - particle.position.x;
        const tdy = ud.walkTarget.y - particle.position.y;
        const dist = Math.hypot(tdx, tdy);
        
        if (dist < 5) {
          // Reached target
          ud.walkState = WALK_STATE.IDLE;
          ud.idleTimer = this._randomIdleTime();
          ud.walkTarget = null;
        } else {
          // Walk toward target
          const moveSpeed = cfg.walkSpeed * dt;
          particle.position.x += (tdx / dist) * moveSpeed;
          particle.position.y += (tdy / dist) * moveSpeed;
          
          // Update rotation to face movement
          ud.rotation = Math.atan2(tdy, tdx);
        }
        break;
    }
    
    // Random takeoff chance
    if (Math.random() < cfg.takeoffChance * dt) {
      this._transitionToTakingOff(particle);
    }
  }

  /**
   * Taking off state: rising from ground back to flying
   * @private
   */
  _updateTakingOff(particle, dt) {
    const ud = particle.userData;
    const cfg = this.config.flying;
    const groundZ = this._getGroundZ();
    
    // Rise up
    const progress = Math.min(ud.stateTimer / cfg.spawnDuration, 1.0);
    particle.position.z = groundZ + cfg.flyHeight * progress;
    
    // Build up velocity
    if (progress < 0.5) {
      ud.velocity.x += (Math.random() - 0.5) * cfg.noiseStrength * dt;
      ud.velocity.y += (Math.random() - 0.5) * cfg.noiseStrength * dt;
    }
    
    // Transition to flying
    if (progress >= 1.0) {
      ud.state = FLY_STATE.FLYING;
      ud.stateTimer = 0;
    }
  }

  /**
   * Transition to landing state
   * @private
   */
  _transitionToLanding(particle) {
    const ud = particle.userData;
    ud.state = FLY_STATE.LANDING;
    ud.stateTimer = 0;
  }

  /**
   * Transition to taking off state
   * @private
   */
  _transitionToTakingOff(particle) {
    const ud = particle.userData;
    ud.state = FLY_STATE.TAKING_OFF;
    ud.stateTimer = 0;
    ud.velocity.x = 0;
    ud.velocity.y = 0;
  }

  /**
   * Pick a random walk target inside the polygon
   * @private
   */
  _pickWalkTarget(particle) {
    const ud = particle.userData;
    const cfg = this.config.walking;
    
    if (!ud.polygon || !ud.bounds) {
      // No polygon constraint, pick nearby point
      const angle = Math.random() * Math.PI * 2;
      const dist = cfg.minMoveDistance + Math.random() * (cfg.maxMoveDistance - cfg.minMoveDistance);
      return {
        x: particle.position.x + Math.cos(angle) * dist,
        y: particle.position.y + Math.sin(angle) * dist
      };
    }
    
    // Try to find a point inside the polygon
    for (let i = 0; i < 10; i++) {
      const angle = Math.random() * Math.PI * 2;
      const dist = cfg.minMoveDistance + Math.random() * (cfg.maxMoveDistance - cfg.minMoveDistance);
      const x = particle.position.x + Math.cos(angle) * dist;
      const y = particle.position.y + Math.sin(angle) * dist;
      
      if (this._isPointInPolygon(x, y, ud.polygon)) {
        return { x, y };
      }
    }
    
    // Fallback: move toward center
    return {
      x: ud.bounds.centerX + (Math.random() - 0.5) * 20,
      y: ud.bounds.centerY + (Math.random() - 0.5) * 20
    };
  }

  /**
   * Ray-casting point-in-polygon test
   * @private
   */
  _isPointInPolygon(x, y, polygon) {
    let inside = false;
    const n = polygon.length;
    
    for (let i = 0, j = n - 1; i < n; j = i++) {
      const xi = polygon[i].x, yi = polygon[i].y;
      const xj = polygon[j].x, yj = polygon[j].y;
      
      if (((yi > y) !== (yj > y)) &&
          (x < (xj - xi) * (y - yi) / (yj - yi) + xi)) {
        inside = !inside;
      }
    }
    
    return inside;
  }

  /**
   * Apply motion blur via scale stretching based on velocity
   * @private
   */
  _applyMotionBlur(particle) {
    const ud = particle.userData;
    const cfg = this.config.visual;
    
    // Optional: allow disabling motion blur entirely for performance / style
    if (cfg.motionBlurEnabled === false) {
      const baseSize = (ud.state === FLY_STATE.WALKING) ? cfg.walkingScale : cfg.flyingScale;
      if (particle.size && typeof particle.size.set === 'function') {
        particle.size.set(baseSize, baseSize, baseSize);
      } else if (particle.size && typeof particle.size === 'object') {
        particle.size.x = baseSize;
        particle.size.y = baseSize;
        particle.size.z = baseSize;
      }
      return;
    }

    let targetSize;
    if (ud.state === FLY_STATE.WALKING) {
      // No motion blur when walking
      targetSize = cfg.walkingScale;
    } else {
      const speed = Math.hypot(ud.velocity.x, ud.velocity.y);
      const blur = Math.min(speed * cfg.motionBlurStrength, cfg.motionBlurMaxLength);
      // Scale is base + blur stretch
      targetSize = cfg.flyingScale * (1 + blur * 0.1);
    }
    
    // Handle both scalar and Vector3 size (quarks uses Vector3 internally for BillBoard mode)
    // CRITICAL: Never assign a scalar to particle.size - quarks expects .copy() to exist
    if (particle.size && typeof particle.size.set === 'function') {
      particle.size.set(targetSize, targetSize, targetSize);
    } else if (particle.size && typeof particle.size === 'object') {
      // Fallback: manually set x/y/z if .set doesn't exist but it's an object
      particle.size.x = targetSize;
      particle.size.y = targetSize;
      particle.size.z = targetSize;
    }
    // If particle.size is already a scalar, don't touch it - let quarks handle it
  }

  /**
   * Lerp between two angles (handling wraparound)
   * @private
   */
  _lerpAngle(from, to, t) {
    let diff = to - from;
    
    // Normalize to [-PI, PI]
    while (diff > Math.PI) diff -= Math.PI * 2;
    while (diff < -Math.PI) diff += Math.PI * 2;
    
    return from + diff * Math.min(t, 1);
  }

  /**
   * Get angle difference (handling wraparound)
   * @private
   */
  _angleDiff(a, b) {
    let diff = b - a;
    while (diff > Math.PI) diff -= Math.PI * 2;
    while (diff < -Math.PI) diff += Math.PI * 2;
    return diff;
  }

  /**
   * Get random idle time
   * @private
   */
  _randomIdleTime() {
    const cfg = this.config.walking;
    return cfg.minIdleTime + Math.random() * (cfg.maxIdleTime - cfg.minIdleTime);
  }

  /**
   * Get ground Z level
   * @private
   */
  _getGroundZ() {
    const sceneComposer = window.MapShine?.sceneComposer;
    return (sceneComposer && typeof sceneComposer.groundZ === 'number')
      ? sceneComposer.groundZ
      : 1000;
  }

  frameUpdate(delta) {
    // No global per-frame update needed
  }

  clone() {
    return new FlyBehavior(this.config);
  }

  reset() {
    // No internal state to reset
  }
}

/**
 * Smelly Flies Effect - Creates swarms of flies that buzz, land, walk, and take off
 * Uses three.quarks ParticleSystem with custom FlyBehavior for AI-like movement
 */
export class SmellyFliesEffect extends EffectBase {
  /**
   * Get the control schema for Tweakpane UI
   * @returns {Object}
   */
  static getControlSchema() {
    return {
      enabled: true,
      parameters: {
        maxParticles: {
          type: 'slider',
          label: 'Max Flies',
          min: 1,
          max: 30,
          step: 1,
          default: 4
        },
        'flying.noiseStrength': {
          type: 'slider',
          label: 'Buzz Intensity',
          min: 500,
          max: 3000,
          step: 100,
          default: 1500
        },
        'flying.tetherStrength': {
          type: 'slider',
          label: 'Tether Strength',
          min: 5,
          max: 50,
          step: 1,
          default: 20
        },
        'flying.maxSpeed': {
          type: 'slider',
          label: 'Max Speed',
          min: 200,
          max: 1500,
          step: 50,
          default: 600
        },
        'flying.landChance': {
          type: 'slider',
          label: 'Land Chance',
          min: 0,
          max: 0.2,
          step: 0.01,
          default: 0.08
        },
        'flying.flyHeight': {
          type: 'slider',
          label: 'Fly Height',
          min: 20,
          max: 200,
          step: 10,
          default: 80
        },
        'walking.walkSpeed': {
          type: 'slider',
          label: 'Walk Speed',
          min: 10,
          max: 100,
          step: 5,
          default: 40
        },
        'walking.takeoffChance': {
          type: 'slider',
          label: 'Takeoff Chance',
          min: 0,
          max: 0.1,
          step: 0.005,
          default: 0.03
        },
        'visual.flyingScale': {
          type: 'slider',
          label: 'Flying Scale',
          min: 10,
          max: 60,
          step: 1,
          default: 18
        },
        'visual.walkingScale': {
          type: 'slider',
          label: 'Walking Scale',
          min: 10,
          max: 60,
          step: 1,
          default: 16
        },
        'visual.motionBlurEnabled': {
          type: 'boolean',
          label: 'Motion Blur',
          default: true
        },
        speedMultiplier: {
          type: 'slider',
          label: 'Speed',
          min: 0.25,
          max: 4.0,
          step: 0.05,
          default: 2.75
        }
      }
    };
  }

  constructor() {
    super('smellyFlies', RenderLayers.PARTICLES, 'low');
    
    this.priority = 10;
    this.alwaysRender = false;
    
    /** @type {THREE.Scene} */
    this.scene = null;
    
    /** @type {THREE.Camera} */
    this.camera = null;
    
    /** @type {THREE.WebGLRenderer} */
    this.renderer = null;
    
    /** @type {import('../libs/three.quarks.module.js').BatchedRenderer} */
    this.batchRenderer = null;
    
    /** @type {Map<string, ParticleSystem>} - One system per area group */
    this.flySystems = new Map();
    
    /** @type {THREE.Texture} */
    this.flyTexture = null;
    
    /** @type {THREE.Texture} */
    this.flyLandedTexture = null;
    
    /** @type {THREE.Texture} */
    this.atlasTexture = null;  // Combined 2-frame atlas
    
    /** @type {MapPointsManager} */
    this.mapPointsManager = null;
    
    /** @type {Object} */
    this.params = { ...DEFAULT_FLY_CONFIG };
    
    /** @type {Function} */
    this._changeListener = null;
    
    log.debug('SmellyFliesEffect created');
  }

  /**
   * Initialize the effect
   * @param {THREE.WebGLRenderer} renderer
   * @param {THREE.Scene} scene
   * @param {THREE.Camera} camera
   */
  async initialize(renderer, scene, camera) {
    this.renderer = renderer;
    this.scene = scene;
    this.camera = camera;
    
    const THREE = window.THREE;
    if (!THREE) {
      log.error('THREE.js not available');
      this.enabled = false;
      return;
    }
    
    // Get BatchedRenderer from ParticleSystem effect
    const particleSystem = window.MapShineParticles;
    if (particleSystem && particleSystem.batchRenderer) {
      this.batchRenderer = particleSystem.batchRenderer;
    } else {
      log.warn('BatchedRenderer not available, flies will not render');
      this.enabled = false;
      return;
    }
    
    // Load fly texture
    await this._loadTexture();
    
    log.info('SmellyFliesEffect initialized');
  }

  /**
   * Load both fly textures and create a 2-frame atlas
   * Frame 0 = flying, Frame 1 = landed/walking
   * @private
   */
  async _loadTexture() {
    const THREE = window.THREE;
    const flyingPath = 'modules/map-shine-advanced/assets/fly.webp';
    const landedPath = 'modules/map-shine-advanced/assets/fly_landed.webp';
    
    // Load both textures
    const loader = new THREE.TextureLoader();
    
    const loadTexture = (path) => new Promise((resolve) => {
      loader.load(
        path,
        (texture) => {
          texture.minFilter = THREE.LinearFilter;
          texture.magFilter = THREE.LinearFilter;
          resolve(texture);
        },
        undefined,
        (err) => {
          log.warn(`Failed to load texture ${path}:`, err);
          resolve(null);
        }
      );
    });
    
    const [flyingTex, landedTex] = await Promise.all([
      loadTexture(flyingPath),
      loadTexture(landedPath)
    ]);
    
    this.flyTexture = flyingTex;
    this.flyLandedTexture = landedTex;
    
    // Create a 2-frame horizontal atlas (side by side)
    // Frame 0 (left) = flying, Frame 1 (right) = landed
    if (flyingTex && landedTex) {
      this.atlasTexture = this._createAtlas(flyingTex, landedTex);
      log.debug('Fly atlas texture created (2 frames)');
    } else if (flyingTex) {
      // Fallback: use flying texture for both frames
      this.atlasTexture = this._createAtlas(flyingTex, flyingTex);
      log.warn('Using flying texture for both frames (landed texture missing)');
    } else {
      // Create fallback
      const canvas = document.createElement('canvas');
      canvas.width = 64;
      canvas.height = 32;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#222';
      // Frame 0 (flying)
      ctx.beginPath();
      ctx.ellipse(16, 16, 12, 8, 0, 0, Math.PI * 2);
      ctx.fill();
      // Frame 1 (landed)
      ctx.beginPath();
      ctx.ellipse(48, 16, 10, 6, 0, 0, Math.PI * 2);
      ctx.fill();
      this.atlasTexture = new THREE.CanvasTexture(canvas);
      this.atlasTexture.minFilter = THREE.LinearFilter;
      this.atlasTexture.magFilter = THREE.LinearFilter;
      log.warn('Using fallback fly atlas');
    }
  }
  
  /**
   * Create a horizontal 2-frame atlas from two textures
   * @param {THREE.Texture} tex1 - Left frame (flying)
   * @param {THREE.Texture} tex2 - Right frame (landed)
   * @returns {THREE.Texture}
   * @private
   */
  _createAtlas(tex1, tex2) {
    const THREE = window.THREE;
    
    // Get image dimensions from the first texture
    const img1 = tex1 && tex1.image;
    const img2 = tex2 && tex2.image;
    
    if (!img1) {
      log.warn('Cannot create atlas: base flying texture image not loaded');
      return tex1;
    }
    
    const w = img1.width;
    const h = img1.height;
    
    // Create canvas for atlas (2x width)
    const canvas = document.createElement('canvas');
    canvas.width = w * 2;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    
    // Draw frame 0 (flying) on left
    ctx.drawImage(img1, 0, 0, w, h);
    
    // Draw frame 1 (landed) on right if available; otherwise fall back
    // to a solid color so tile 1 is still visually distinct.
    if (img2) {
      ctx.drawImage(img2, w, 0, w, h);
    } else {
      ctx.fillStyle = '#ff00ff';
      ctx.fillRect(w, 0, w, h);
      log.warn('Landed texture image missing; using solid debug color for atlas frame 1');
    }
    
    const atlas = new THREE.CanvasTexture(canvas);
    atlas.minFilter = THREE.LinearFilter;
    atlas.magFilter = THREE.LinearFilter;
    atlas.needsUpdate = true;
    
    return atlas;
  }

  /**
   * Set the MapPointsManager and create fly systems for smellyFlies areas
   * @param {MapPointsManager} manager
   */
  setMapPointsSources(manager) {
    this.mapPointsManager = manager;
    
    // Remove old change listener
    if (this._changeListener && manager) {
      manager.removeChangeListener(this._changeListener);
    }
    
    // Create systems for existing areas
    this._rebuildSystems();
    
    // Listen for changes
    this._changeListener = () => this._rebuildSystems();
    if (manager) {
      manager.addChangeListener(this._changeListener);
    }
  }

  /**
   * Rebuild all fly systems based on current map points
   * @private
   */
  _rebuildSystems() {
    // Dispose existing systems
    this._disposeSystems();
    
    if (!this.mapPointsManager || !this.batchRenderer || !this.atlasTexture) {
      return;
    }
    
    // Get all smellyFlies areas
    const areas = this.mapPointsManager.getAreasForEffect('smellyFlies');
    
    // Also support point groups (single spawn location)
    const pointGroups = this.mapPointsManager.getGroupsByEffect('smellyFlies')
      .filter(g => g.type === 'point' && g.points && g.points.length > 0);
    
    log.info(`Creating fly systems: ${areas.length} areas, ${pointGroups.length} point groups`);
    
    // Create system for each area
    for (const area of areas) {
      const system = this._createFlySystem(area);
      if (system) {
        this.flySystems.set(area.groupId, system);
      }
    }
    
    // Create system for each point group
    for (const group of pointGroups) {
      const system = this._createPointFlySystem(group);
      if (system) {
        this.flySystems.set(group.id, system);
      }
    }
  }

  /**
   * Create a fly system for an area polygon
   * @param {AreaPolygon} area
   * @returns {ParticleSystem|null}
   * @private
   */
  _createFlySystem(area) {
    const THREE = window.THREE;
    if (!THREE || !this.atlasTexture) return null;
    
    const cfg = this.params;
    
    // Create material using the 2-frame atlas
    const material = new THREE.MeshBasicMaterial({
      map: this.atlasTexture,
      transparent: true,
      depthWrite: false,
      depthTest: false,
      blending: THREE.NormalBlending,
      side: THREE.DoubleSide
    });
    
    // Create spawn shape
    const shape = new AreaSpawnShape(area.points, area.bounds, this);
    
    // Use the configured maxParticles directly (no area scaling for now)
    const maxParticles = cfg.maxParticles;
    
    // Calculate emission rate to maintain steady population
    // With 15-30s lifetime, emit at rate = maxParticles / avgLifetime to maintain count
    // But cap emission once we reach maxParticles (quarks handles this via pool)
    const avgLifetime = 22.5; // Average of 15-30
    const emissionRate = maxParticles / avgLifetime;
    
    const system = new ParticleSystem({
      duration: 1,
      looping: true,
      startLife: new IntervalValue(15, 30), // Shorter lifetime for better population control
      startSpeed: new ConstantValue(0),
      startSize: new IntervalValue(cfg.visual.flyingScale * 0.9, cfg.visual.flyingScale * 1.1),
      startColor: new ColorRange(
        new Vector4(1.0, 1.0, 1.0, 1.0),  // White tint, let texture show through
        new Vector4(1.0, 1.0, 1.0, 1.0)
      ),
      worldSpace: true,
      maxParticles: maxParticles,
      emissionOverTime: new ConstantValue(emissionRate),
      shape: shape,
      material: material,
      renderMode: RenderMode.BillBoard,
      renderOrder: 52,
      // UV tile atlas: 2 columns (flying, landed), 1 row
      uTileCount: 2,
      vTileCount: 1,
      startTileIndex: new ConstantValue(1),  // Start with flying frame
      behaviors: [
        new FlyBehavior(cfg)
      ]
    });
    
    // IMPORTANT: Keep emitter at origin for worldSpace particles.
    // AreaSpawnShape already writes world-space positions, so any emitter
    // transform would offset flies away from their intended area.
    system.emitter.position.set(0, 0, 0);
    
    // Add to scene and batch renderer
    this.scene.add(system.emitter);
    this.batchRenderer.addSystem(system);
    
    // Store reference
    system.userData = {
      areaId: area.groupId,
      ownerEffect: this
    };
    
    log.debug(`Created fly system for area ${area.groupId} with ${maxParticles} max particles`);
    
    return system;
  }

  /**
   * Create a fly system for a point group (flies orbit around the point)
   * @param {MapPointGroup} group
   * @returns {ParticleSystem|null}
   * @private
   */
  _createPointFlySystem(group) {
    const THREE = window.THREE;
    if (!THREE || !this.atlasTexture || !group.points || group.points.length === 0) return null;
    
    const cfg = this.params;
    const point = group.points[0]; // Use first point as center
    
    // Create a small circular area around the point
    const radius = 100;
    const fakePolygon = [];
    for (let i = 0; i < 8; i++) {
      const angle = (i / 8) * Math.PI * 2;
      fakePolygon.push({
        x: point.x + Math.cos(angle) * radius,
        y: point.y + Math.sin(angle) * radius
      });
    }
    
    const bounds = {
      minX: point.x - radius,
      minY: point.y - radius,
      maxX: point.x + radius,
      maxY: point.y + radius,
      centerX: point.x,
      centerY: point.y,
      width: radius * 2,
      height: radius * 2
    };
    
    // Create material using the 2-frame atlas
    const material = new THREE.MeshBasicMaterial({
      map: this.atlasTexture,
      transparent: true,
      depthWrite: false,
      depthTest: false,
      blending: THREE.NormalBlending,
      side: THREE.DoubleSide
    });
    
    // Create spawn shape
    const shape = new AreaSpawnShape(fakePolygon, bounds, this);
    
    const maxParticles = Math.max(2, cfg.maxParticles);
    // Maintain steady population: emit at rate = maxParticles / avgLifetime
    const avgLifetime = 22.5;
    const emissionRate = maxParticles / avgLifetime;
    
    const system = new ParticleSystem({
      duration: 1,
      looping: true,
      startLife: new IntervalValue(15, 30),
      startSpeed: new ConstantValue(0),
      startSize: new IntervalValue(cfg.visual.flyingScale * 0.9, cfg.visual.flyingScale * 1.1),
      startColor: new ColorRange(
        new Vector4(1.0, 1.0, 1.0, 1.0),  // White tint, let texture show through
        new Vector4(1.0, 1.0, 1.0, 1.0)
      ),
      worldSpace: true,
      maxParticles: maxParticles,
      emissionOverTime: new ConstantValue(emissionRate),
      shape: shape,
      material: material,
      renderMode: RenderMode.BillBoard,
      renderOrder: 52,
      // UV tile atlas: 2 columns (flying, landed), 1 row
      uTileCount: 2,
      vTileCount: 1,
      startTileIndex: new ConstantValue(0),  // Start with flying frame
      behaviors: [
        new FlyBehavior(cfg)
      ]
    });
    
    // Same reasoning as area systems: emitter stays at origin so the
    // AreaSpawnShape's world-space positions are not additionally offset.
    system.emitter.position.set(0, 0, 0);
    
    this.scene.add(system.emitter);
    this.batchRenderer.addSystem(system);
    
    system.userData = {
      groupId: group.id,
      ownerEffect: this
    };
    
    log.debug(`Created fly system for point group ${group.id}`);
    
    return system;
  }

  /**
   * Update per frame
   * @param {TimeInfo} timeInfo
   */
  update(timeInfo) {
    if (!this.enabled) return;
    
    // Fly systems are updated by the BatchedRenderer in ParticleSystem.update()
    // We only need to handle parameter changes here
    
    // Optional: Weather integration - reduce activity in rain/wind
    if (weatherController) {
      const state = weatherController.getCurrentState();
      if (state) {
        const precipitation = state.precipitation || 0;
        const windSpeed = state.windSpeed || 0;
        
        // Reduce emission rate in bad weather
        const weatherFactor = Math.max(0.1, 1.0 - (precipitation * 0.5 + windSpeed * 0.3));
        
        for (const system of this.flySystems.values()) {
          if (system.emissionOverTime && system.emissionOverTime.value !== undefined) {
            // Store base rate if not already stored
            if (system.userData.baseEmissionRate === undefined) {
              system.userData.baseEmissionRate = system.emissionOverTime.value;
            }
            system.emissionOverTime.value = system.userData.baseEmissionRate * weatherFactor;
          }
        }
      }
    }
  }

  /**
   * Apply a parameter change
   * @param {string} paramId
   * @param {*} value
   */
  applyParamChange(paramId, value) {
    // Update params
    const parts = paramId.split('.');
    let target = this.params;
    for (let i = 0; i < parts.length - 1; i++) {
      target = target[parts[i]];
      if (!target) return;
    }
    target[parts[parts.length - 1]] = value;
    
    // Rebuild systems to apply changes
    this._rebuildSystems();
  }

  /**
   * Dispose of all fly systems
   * @private
   */
  _disposeSystems() {
    for (const [id, system] of this.flySystems) {
      try {
        if (this.batchRenderer) {
          this.batchRenderer.deleteSystem(system);
        }
        if (system.emitter && this.scene) {
          this.scene.remove(system.emitter);
        }
        if (system.material) {
          system.material.dispose();
        }
      } catch (e) {
        log.warn(`Error disposing fly system ${id}:`, e);
      }
    }
    this.flySystems.clear();
  }

  /**
   * Dispose of all resources
   */
  dispose() {
    this._disposeSystems();
    
    if (this.flyTexture) {
      this.flyTexture.dispose();
      this.flyTexture = null;
    }
    
    if (this._changeListener && this.mapPointsManager) {
      this.mapPointsManager.removeChangeListener(this._changeListener);
    }
    
    this.mapPointsManager = null;
    this.batchRenderer = null;
    
    log.info('SmellyFliesEffect disposed');
  }
}
