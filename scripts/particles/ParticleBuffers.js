/**
 * @fileoverview GPU Particle Buffer Management
 * Allocates and manages GPU storage buffers for GPU-resident particles.
 * @module particles/ParticleBuffers
 */

import { createLogger } from '../core/log.js';

const log = createLogger('ParticleBuffers');

/**
 * Manages GPU storage buffers for the particle system.
 * Handles VRAM allocation, buffer updates, and struct definitions.
 */
export class ParticleBuffers {
  /**
   * @param {number} [capacity=100000] - Maximum number of particles
   */
  constructor(capacity = 100000) {
    this.capacity = capacity;
    this.initialized = false;

    /** @type {THREE.StorageInstancedBufferAttribute|null} */
    this.positionBuffer = null;

    /** @type {THREE.StorageInstancedBufferAttribute|null} */
    this.velocityBuffer = null;

    /** @type {THREE.StorageInstancedBufferAttribute|null} */
    this.colorBuffer = null;

    /** @type {THREE.StorageInstancedBufferAttribute|null} */
    this.ageLifeBuffer = null; // x: age, y: life

    /** @type {THREE.StorageInstancedBufferAttribute|null} */
    this.scaleTypeBuffer = null; // x: scale, y: typeID (float)

    /** @type {THREE.StorageInstancedBufferAttribute|null} */
    this.seedBuffer = null; // Random seed per particle

    // Emitter Buffer (CPU -> GPU communication)
    // We support a fixed number of emitter instructions per frame (e.g., 32)
    this.emitterCount = 32;
    this.emitterBuffer = null; // StorageBufferAttribute
    this.emitterArray = null;  // CPU-side Float32Array mirror
  }

  /**
   * Initialize all storage buffers
   * @param {typeof THREE} THREE - Three.js instance
   */
  initialize(THREE) {
    if (this.initialized) return;

    log.info(`Initializing particle buffers (Capacity: ${this.capacity})`);

    try {
      // 1. Position Buffer (vec3)
      // Initialize off-screen (y = -1000)
      const positionArray = new Float32Array(this.capacity * 3);
      for (let i = 0; i < this.capacity; i++) {
        positionArray[i * 3 + 1] = -1000; 
      }
      this.positionBuffer = new THREE.BufferAttribute(positionArray, 3);

      // 2. Velocity Buffer (vec3)
      const velocityArray = new Float32Array(this.capacity * 3);
      this.velocityBuffer = new THREE.BufferAttribute(velocityArray, 3);

      // 3. Color Buffer (vec4)
      const colorArray = new Float32Array(this.capacity * 4);
      this.colorBuffer = new THREE.BufferAttribute(colorArray, 4);

      // 4. Age/Life Buffer (vec2) - x: age, y: life
      // Initialize age > life so they start "dead"
      const ageLifeArray = new Float32Array(this.capacity * 2);
      for (let i = 0; i < this.capacity; i++) {
        ageLifeArray[i * 2] = 1.0; // age
        ageLifeArray[i * 2 + 1] = 0.0; // life
      }
      this.ageLifeBuffer = new THREE.BufferAttribute(ageLifeArray, 2);

      // 5. Scale/Type Buffer (vec2) - x: scale, y: type
      const scaleTypeArray = new Float32Array(this.capacity * 2);
      this.scaleTypeBuffer = new THREE.BufferAttribute(scaleTypeArray, 2);

      // 6. Seed Buffer (float) - Deterministic procedural noise
      const seedArray = new Float32Array(this.capacity);
      for (let i = 0; i < this.capacity; i++) {
        seedArray[i] = Math.random();
      }
      this.seedBuffer = new THREE.BufferAttribute(seedArray, 1);

      // 7. Emitter Buffer (Uniform Buffer / small Storage Buffer)
      // Struct: [posX, posY, posZ, type, count, param1, param2, padding] -> 8 floats per emitter
      // Total size: emitterCount * 8
      this.emitterArray = new Float32Array(this.emitterCount * 8);
      // Use DataTexture for random access in WebGL2 shader
      this.emitterTexture = new THREE.DataTexture(
        this.emitterArray, 
        this.emitterCount * 8, 
        1, 
        THREE.RedFormat, 
        THREE.FloatType
      );
      this.emitterTexture.needsUpdate = true;

      this.initialized = true;
      log.info('Buffers allocated successfully');

    } catch (error) {
      log.error('Failed to allocate particle buffers:', error);
      throw error;
    }
  }

  /**
   * Write emitter data to the GPU buffer
   * @param {Array<Object>} emitters - List of active emitters for this frame
   */
  updateEmitters(emitters) {
    if (!this.initialized) return;

    // Clear previous frame data
    this.emitterArray.fill(0);

    // Cap at max emitters
    const count = Math.min(emitters.length, this.emitterCount);
    
    if (count > 0) {
      log.debug(`Updating emitter buffer with ${count} emitters`);
    }

    for (let i = 0; i < count; i++) {
      const e = emitters[i];
      const offset = i * 8;

      this.emitterArray[offset + 0] = e.x;
      this.emitterArray[offset + 1] = e.y;
      this.emitterArray[offset + 2] = e.z;
      this.emitterArray[offset + 3] = e.type; // encoded as float
      this.emitterArray[offset + 4] = e.count;
      this.emitterArray[offset + 5] = e.param1 || 0;
      this.emitterArray[offset + 6] = e.param2 || 0;
      // offset + 7 is padding
    }

    // Mark buffer for upload
    // For StorageBufferAttribute, we typically create a Node that reads this array.
    // Update texture
    if (this.emitterTexture) {
        this.emitterTexture.needsUpdate = true;
    }
  }

  /**
   * dispose all buffers to free VRAM
   */
  dispose() {
    // StorageBufferAttributes don't always have a dispose method in early Three.js versions
    // but we should null them out.
    this.positionBuffer = null;
    this.velocityBuffer = null;
    this.colorBuffer = null;
    this.ageLifeBuffer = null;
    this.scaleTypeBuffer = null;
    this.seedBuffer = null;
    this.emitterBuffer = null;
    this.initialized = false;
    log.info('Buffers disposed');
  }
}
