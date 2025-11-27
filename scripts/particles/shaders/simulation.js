/**
 * @fileoverview TSL Compute Shader for Particle Simulation
 * Handles physics updates: position integration, lifetime management, and emitter spawning.
 * @module particles/shaders/simulation
 */

// We import TSL nodes from Three.js (assuming they are available globally or via a module shim)
// In a real module, these would be imported from 'three/tsl'
// For this implementation, we assume TSL functions are available on the THREE namespace or passed in.

/**
 * Creates the particle simulation compute node
 * @param {typeof THREE} THREE - Three.js library with TSL support
 * @param {Object} buffers - ParticleBuffers instance containing storage buffers
 * @param {Object} uniforms - Uniform nodes (deltaTime, time, seed, etc.)
 * @returns {Node} Compute node for the renderer
 */
export function createSimulationNode(THREE, buffers, uniforms) {
  const {
    float, vec3, vec4, 
    storage, 
    If, Loop, 
    sin, cos, mix, 
    uv, instanceIndex,
    timerLocal,
    hash,
    uint,
    Fn
  } = THREE; // TSL node helpers

  // 1. Access Storage Buffers
  const positionBuffer = storage(buffers.positionBuffer, 'vec3', buffers.capacity);
  const velocityBuffer = storage(buffers.velocityBuffer, 'vec3', buffers.capacity);
  const colorBuffer = storage(buffers.colorBuffer, 'vec4', buffers.capacity);
  const ageLifeBuffer = storage(buffers.ageLifeBuffer, 'vec2', buffers.capacity); // x=age, y=life
  const scaleTypeBuffer = storage(buffers.scaleTypeBuffer, 'vec2', buffers.capacity); // x=scale, y=type
  const seedBuffer = storage(buffers.seedBuffer, 'float', buffers.capacity);
  const emitterBuffer = storage(buffers.emitterBuffer, 'float', buffers.emitterCount * 8);

  // 2. Define Compute Logic
  // This function runs once per particle (workgroup size is usually handled by Three.js)
  const computeLogic = Fn(() => {
    // Get current particle index
    const index = instanceIndex;

    // Load state
    const ageLife = ageLifeBuffer.element(index);
    const position = positionBuffer.element(index);
    const velocity = velocityBuffer.element(index);
    
    let age = ageLife.x;
    const life = ageLife.y;

    // --- SPAWN LOGIC ---
    // Check if particle is dead (age >= life)
    // If dead, try to spawn from an active emitter
    If(age.greaterThanEqual(life), () => {
      // Loop through emitters to find one that needs to spawn
      // Note: In a real massive parallel system, this linear scan is inefficient,
      // but for < 32 emitters it's acceptable. 
      // A more advanced approach uses atomic counters.
      
      // Simple implementation: 
      // We can't easily coordinate "exactly N particles" without atomics.
      // Probabilistic spawning:
      // Each dead particle checks ONE random emitter slot.
      // If that emitter is active, we spawn.
      
      // Generate random index based on seed + time
      const randVal = hash(index.add(uniforms.time));
      const emitterIdx = uint(randVal.mul(buffers.emitterCount)); // Cast to uint for indexing
      
      // Read emitter data (stride 8)
      // Manually calculating offset since TSL might not support struct views on storage buffers yet
      const baseOffset = emitterIdx.mul(8);
      
      const emX = emitterBuffer.element(baseOffset.add(0));
      const emY = emitterBuffer.element(baseOffset.add(1));
      const emZ = emitterBuffer.element(baseOffset.add(2));
      const emType = emitterBuffer.element(baseOffset.add(3));
      const emCount = emitterBuffer.element(baseOffset.add(4));
      
      // If emitter has count > 0 (active)
      If(emCount.greaterThan(0), () => {
        // Respawn!
        
        // Common Reset
        ageLifeBuffer.element(index).x = float(0.0);
        
        // Logic Branch based on Type
        // Type 0: FIRE (Upwards, short life, orange)
        If(emType.equal(0), () => {
            // Life: 0.5 - 1.0s
            ageLifeBuffer.element(index).y = float(0.5).add(randVal.mul(0.5));
            
            // Pos: Jitter within param1 (spread) or default 0.5
            const spread = emCount.greaterThan(0) ? float(0.5) : float(0.5); // Use param1 later
            const jitterX = hash(index.add(1)).sub(0.5).mul(spread);
            const jitterY = hash(index.add(2)).sub(0.5).mul(spread);
            positionBuffer.element(index).assign(vec3(emX.add(jitterX), emY.add(jitterY), emZ));

            // Vel: Up + slight random
            const vx = hash(index.add(3)).sub(0.5).mul(1.0);
            const vy = hash(index.add(4)).sub(0.5).mul(1.0);
            velocityBuffer.element(index).assign(vec3(vx, vy, 3.0));

            // Color: Orange/Red (R=1, G=0.5, B=0)
            colorBuffer.element(index).assign(vec4(1.0, 0.5, 0.1, 1.0));
            
            // Scale: Start at 0.5
            scaleTypeBuffer.element(index).x = float(0.5);

        // Type 1: SMOKE (Upwards, slow, grey, long life)
        }).ElseIf(emType.equal(1), () => {
            // Life: 2.0 - 4.0s
            ageLifeBuffer.element(index).y = float(2.0).add(randVal.mul(2.0));

            const jitterX = hash(index.add(1)).sub(0.5).mul(1.0);
            const jitterY = hash(index.add(2)).sub(0.5).mul(1.0);
            positionBuffer.element(index).assign(vec3(emX.add(jitterX), emY.add(jitterY), emZ));

            // Vel: Slow Up
            velocityBuffer.element(index).assign(vec3(0, 0, 1.0));

            // Color: Grey
            colorBuffer.element(index).assign(vec4(0.5, 0.5, 0.5, 0.8));
             scaleTypeBuffer.element(index).x = float(0.8);

        // Type 2: RAIN (Downwards, fast, blue)
        }).ElseIf(emType.equal(2), () => {
            // Life: 1.0s (enough to fall)
            ageLifeBuffer.element(index).y = float(1.5);

            // Pos: Wide area spread (param1 should trigger this, default 100)
            const spread = float(500.0); 
            const jitterX = hash(index.add(1)).sub(0.5).mul(spread);
            const jitterY = hash(index.add(2)).sub(0.5).mul(spread);
            // Start high up (emZ + 500)
            positionBuffer.element(index).assign(vec3(emX.add(jitterX), emY.add(jitterY), emZ.add(500)));

            // Vel: Fast Down
            velocityBuffer.element(index).assign(vec3(0, 0, -50.0));

            // Color: Blueish
            colorBuffer.element(index).assign(vec4(0.6, 0.6, 1.0, 0.6));
            scaleTypeBuffer.element(index).x = float(0.2); // Thin

        // Type 3: MAGIC (Random burst, purple)
        }).Else(() => {
             // Life: 1.0 - 2.0s
            ageLifeBuffer.element(index).y = float(1.0).add(randVal);
            
            positionBuffer.element(index).assign(vec3(emX, emY, emZ));

            // Vel: Random Sphere
            const theta = hash(index.add(1)).mul(6.28);
            const phi = hash(index.add(2)).mul(3.14);
            const speed = float(5.0);
            
            const vx = sin(phi).mul(cos(theta)).mul(speed);
            const vy = sin(phi).mul(sin(theta)).mul(speed);
            const vz = cos(phi).mul(speed);
            
            velocityBuffer.element(index).assign(vec3(vx, vy, vz));

            // Color: Purple
            colorBuffer.element(index).assign(vec4(0.8, 0.2, 1.0, 1.0));
            scaleTypeBuffer.element(index).x = float(0.6);
        });
        
        // Save Type
        scaleTypeBuffer.element(index).y = emType;
      });
      
    }).Else(() => {
      // --- UPDATE LOGIC ---
      // Alive particle
      
      // 1. Integrate Age
      age = age.add(uniforms.deltaTime);
      ageLifeBuffer.element(index).x = age;
      
      // Get Type
      const pType = scaleTypeBuffer.element(index).y;
      
      // 2. Apply Forces based on Type
      // Default Gravity (Rain/Magic?)
      // Fire/Smoke have Buoyancy (Reverse Gravity)
      
      // Use a mutable vector node so component assignment is valid in WGSL
      const accel = vec3(0, 0, 0).toVar();
      
      If(pType.equal(0).or(pType.equal(1)), () => {
          // Buoyancy for Fire/Smoke
          accel.z.assign(float(2.0));
      }).ElseIf(pType.equal(2), () => {
          // Gravity for Rain
          accel.z.assign(float(-10.0)); // Minimal gravity, mostly initial velocity
      }).Else(() => {
          // Gravity for others
          accel.z.assign(float(-9.8));
      });

      const newVel = velocity.add(accel.mul(uniforms.deltaTime));
      velocityBuffer.element(index).assign(newVel);
      
      // 3. Integrate Position
      positionBuffer.element(index).addAssign(newVel.mul(uniforms.deltaTime));
      
      // 4. Kill if below ground (z < 0) AND not Fire/Smoke (which go up)
      // Rain needs to die on contact
      If(positionBuffer.element(index).z.lessThan(0), () => {
        If(pType.equal(2), () => {
             // Rain splash? Just die for now
             ageLifeBuffer.element(index).x = life.add(0.1); 
        });
      });
    });
  });

  // Return the compute node (count = capacity)
  return computeLogic().compute(buffers.capacity);
}
