# Phase 2: The Particle Core (WebGL2) - Technical Specification

**Objective**: Implement a high-performance, GPU-resident particle system capable of rendering 50,000+ concurrent particles using WebGL2-friendly techniques (instancing, vertex-shader-driven updates, and optional transform feedback where supported).

## 1. Architectural Overview

The particle system will operate on a "Pull" architecture where the GPU simulates all particle physics as much as possible. The CPU's role is limited to:
1.  Updating the global `TimeInfo` uniform.
2.  Writing new emission requests to an `EmitterBuffer`.
3.  Dispatching the vertex shader.

This decoupling allows for massive scale (magic effects, weather, environmental ambience) with negligible CPU cost.

## 2. File Structure

We will introduce a new `scripts/particles/` directory:

```
scripts/particles/
├── ParticleSystem.js       # Main entry point, extends EffectBase
├── ParticleBuffers.js      # Manages GPU-side buffers (e.g., InstancedBufferAttribute)
├── EmitterManager.js       # Handles CPU-side emitter logic & buffer updates
└── shaders/
    ├── simulation.js       # Vertex shader (Physics)
    └── rendering.js        # ShaderMaterial (Visuals)
```

## 3. Data Structures (GPU Layout)

We will use GPU-side buffers (e.g., `InstancedBufferAttribute` or equivalent WebGL2-backed attributes) to store particle state on the GPU.

### 3.1 Global Particle Buffer (Struct)
Capacity: Fixed at initialization (e.g., 100,000 particles).

| Field | Type | Description |
|-------|------|-------------|
| `position` | `vec3` | World space position (x, y, z) |
| `velocity` | `vec3` | World space velocity vector |
| `color` | `vec4` | Particle color (RGBA) |
| `age` | `float` | Current age in seconds |
| `life` | `float` | Max lifespan in seconds |
| `size` | `float` | Base size of the particle |
| `type` | `uint` | Effect Type ID (0=Fire, 1=Smoke, 2=Magic, etc.) |
| `seed` | `float` | Random seed for procedural variation |

### 3.2 Emitter Buffer (CPU -> GPU Bridge)
A smaller buffer updated every frame by the CPU to trigger new spawns.

| Field | Type | Description |
|-------|------|-------------|
| `position` | `vec3` | Emitter world position |
| `rate` | `float` | Particles to spawn this frame (accumulated) |
| `type` | `uint` | Effect Type ID to spawn |
| `param1` | `float` | Generic parameter (e.g., spread, speed) |

## 4. GPU Simulation Logic (WebGL2)

The `simulation.js` shader logic will be expressed in a way that can run entirely in the vertex stage (instanced particles) and optionally via transform feedback where available. The goal is to keep all per-particle updates GPU-resident while remaining compatible with standard WebGL2.

**Logic Flow:**
1.  **Dead Check**: If `age > life`, mark particle as "dead" (or available for respawn).
2.  **Spawn Step**:
    *   Read from `EmitterBuffer`.
    *   If particle is dead and Emitter needs to spawn, reset particle state:
        *   `age = 0`
        *   `position = emitter.position + randomOffset`
        *   `velocity = calculateInitialVelocity(type)`
3.  **Update Step**:
    *   `age += deltaTime`
    *   `velocity += gravity * deltaTime`
    *   `velocity += curlNoise(position) * turbulenceStrength` (for smoke/fire)
    *   `position += velocity * deltaTime`
4.  **Write Back**: Store updated state in buffers (via transform feedback where supported, or by recomputing from seed/state in the vertex shader each frame).

## 5. Rendering Logic

The `rendering.js` shader uses a sprite/billboarded material suitable for WebGL2 (e.g., `ShaderMaterial` or a lightweight PBR-friendly material on quads).

*   **Position**: Read from `position` buffer.
*   **Color**: Read from `color` buffer, modulated by `age/life` (fade out).
*   **Size**: Read from `size` buffer, scaled by distance to camera (perspective).
*   **Lighting**: Simple unlit (emissive) for magic, or lit for smoke.

## 6. Integration Plan (WebGL2)

### Step 6.1: Infrastructure (Buffer Management)
*   Create `ParticleBuffers.js`.
*   Initialize WebGL2-friendly GPU buffers for 100k particles (instanced attributes / typed arrays).
*   **Milestone**: Verify VRAM allocation without crashing.

### Step 6.2: The Simulation Shader
*   Create `simulation.js` with basic "Gravity + Bounce" physics expressed for the vertex stage (and optional transform feedback path).
*   Create `ParticleSystem.js` implementing `EffectBase`.
*   **Milestone**: Particles spawning at (0,0,0) and falling down.

### Step 6.3: The Emitter Bridge
*   Create `EmitterManager.js`.
*   Implement `emit(position, type, count)` method.
*   **Milestone**: Clicking on the canvas spawns an explosion of particles at the cursor.

### Step 6.4: Effect Types
*   Implement TSL logic for different effect types (Fire, Smoke, Rain).
*   **Milestone**: Different visual behaviors based on `type` ID.

## 7. Fallback Strategy (WebGL1)
On WebGL1 (if supported by the browser/Foundry runtime), we will:
- Greatly reduce particle counts and effect complexity.
- Fall back to simpler, CPU-assisted updates for critical particles only (or disable the particle system entirely if performance is unacceptable).

## 8. Task List
- [ ] Create `ParticleBuffers` class
- [ ] Create `simulation.js` (TSL)
- [ ] Create `ParticleSystem` class
- [ ] Integrate with `EffectComposer`
- [ ] Implement `EmitterManager`
- [ ] Add "Click to Spawn" debug tool
