# Planning Document: Migration to three.quarks

## Objective
Replace the current custom-built, compute-shader-based particle system with **three.quarks**, a robust and feature-rich particle system library for Three.js. This will simplify maintenance, enable easier effect creation (potentially via external editors), and standardize the particle pipeline.

## 1. Vendoring three.quarks
Since we cannot rely on runtime `npm install` for end-users of the Foundry module, we must vendor the library.

*   **Action**: Download the browser-compatible ES module build of `three.quarks`.
*   **Target**: `scripts/libs/three.quarks.module.js`
*   **Source**: We will use a specific version (e.g., v0.12.0 or latest stable) from a CDN like `esm.sh` or `unpkg` during the implementation phase.

## 2. Architecture Changes

### Current System
*   **`ParticleSystem.js`**: Manages `ParticleBuffers` (custom GPU buffers), `RainStreakGeometry`, and `SnowGeometry`.
*   **`ParticleBuffers.js`**: Handles raw WebGL/WebGPU buffers for generic particles.
*   **`shaders/`**: Contains raw GLSL/TSL code for simulation and rendering.
*   **`FireSparksEffect.js`**: Manages fire logic and feeds the generic particle system.

### New System
*   **`ParticleSystem.js`**: Will become the central manager for `three.quarks.BatchRenderer`.
*   **`RainSystem.js` / `SnowSystem.js`**: specialized wrappers around `three.quarks` configurations.
*   **`FireSystem.js`**: Updated to use `three.quarks` emitters.

## 3. Implementation Steps

### Phase 1: Setup & Integration
1.  **Vendor Library**: Create `scripts/libs/three.quarks.module.js`.
2.  **Update Imports**: Ensure `scripts/libs/three.quarks.module.js` is importable in the module.
3.  **Initialize Renderer**: In `ParticleSystem.initialize()`, set up the `BatchRenderer` from `three.quarks`.
    *   Add the `BatchRenderer` to the scene.
    *   Ensure it renders in the correct layer (PARTICLES layer).

### Phase 2: Fire & Sparks Migration
*   **Challenge**: The current system uses a "Lookup Map" (texture) to spawn fire particles only on specific pixels of the background.
*   **Solution**: Implement a Custom Emitter Shape in `three.quarks` (or use CPU-side logic).
    *   The `FireSparksEffect` already parses the texture into a list of valid `(x, y)` coordinates on the CPU (`validCoords`).
    *   We will create a `MaskGridEmitter` (or similar) that picks a random coordinate from this list for each spawn event.
    *   **Sparks**: Add a secondary system for ballistic sparks using standard `three.quarks` physics (gravity + wind).

### Phase 3: Weather (Rain & Snow) Migration
*   **Challenge 1: Wind**:
    *   `three.quarks` has built-in Force modules.
    *   We need to wire `WeatherController.currentState.windDirection` and `windSpeed` to these modules dynamically in the `update()` loop.
*   **Challenge 2: Roof Mask (Indoor Culling)**:
    *   Current system samples `uRoofMap` in the pixel shader to discard rain indoors.
    *   **Strategy**: `three.quarks` allows custom textures/materials. We will likely need to patch the material used by the BatchRenderer or provide a custom `onBeforeCompile` hook to inject the masking logic.
    *   *Backup Plan*: If direct shader injection is too complex, we might keep the existing `RainStreakGeometry` for simple rain and only use `three.quarks` for complex effects, but the goal is full migration. We will attempt to inject the code:
        ```glsl
        // Fragment Shader Patch
        uniform sampler2D uRoofMap;
        uniform vec4 uSceneBounds;
        ...
        float mask = texture2D(uRoofMap, uv).r;
        if (mask < 0.5) discard;
        ```

### Phase 4: Cleanup
*   Remove `ParticleBuffers.js`.
*   Remove `shaders/simulation.js` and `shaders/rendering.js`.
*   Remove `EmitterManager.js` (the new `ParticleSystem` will manage `three.quarks` systems directly).

## 4. Detailed Task List

1.  [ ] **Download & Save `three.quarks`**: Get the source and save to `scripts/libs/`.
2.  [ ] **Refactor `ParticleSystem.js`**:
    *   Import `three.quarks`.
    *   Initialize `BatchRenderer`.
    *   Expose methods to add/remove systems.
3.  [ ] **Migrate Fire**:
    *   Update `FireSparksEffect` to create a `ParticleSystem` (Quarks version) instead of generic emitters.
    *   Implement the coordinate picking logic.
4.  [ ] **Migrate Weather**:
    *   Create `WeatherParticles.js` (or update `ParticleSystem` weather logic).
    *   Implement Rain configuration (Texture, velocity, gravity).
    *   Implement Snow configuration (Noise/Texture, drag, flutter).
    *   Link `WeatherController` updates to system parameters.
5.  [ ] **Implement Shader Culling**:
    *   Add `uRoofMap` and logic to the Quarks material.
6.  [ ] **Testing**: Verify performance and visual fidelity.

## 5. Risks & Mitigations
*   **Performance**: `three.quarks` is CPU-simulated (mostly). Large particle counts (Rain/Snow ~20k-50k) might be heavier than the previous purely GPU compute shader.
    *   *Mitigation*: Use `BatchRenderer`. If performance is poor for heavy rain, we might retain `RainStreakGeometry` (which is highly optimized) and only use Quarks for "fancy" particles (Fire, Magic, Smoke). **Decision**: We will attempt migration; if FPS drops significantly, we revert Rain/Snow to the specialized geometry but keep Quarks for everything else.
