# Shader Recompilation on Scene Transitions

## Problem Statement

When switching between scenes in a single session (activating a different scene), **every
shader program is recompiled from scratch**. This causes a noticeable stall during scene
transitions — the GPU blocks while compiling 50+ GLSL programs sequentially.

Since MapShine has a large number of custom `ShaderMaterial`/`RawShaderMaterial` instances
(effects, particles, scene managers, masks, vision), this adds up to a significant delay
that is completely unnecessary when returning to a previously-visited scene or loading a
scene that uses the same set of effects.

---

## Root Cause Analysis

### The Renderer Survives, But All Programs Are Destroyed

The `THREE.WebGLRenderer` is created once during `bootstrap()` and persists across scene
transitions (`canvas-replacement.js` line 4798: *"renderer is owned by MapShine global
state, don't dispose here"*).

However, the **entire scene graph and all materials** are destroyed on every transition:

```
Scene switch
  → destroyThreeCanvas()
    → SceneContext.dispose()
      → effectComposer.dispose()     → each effect.dispose() → material.dispose()
      → sceneComposer.dispose()      → basePlaneMesh.material.dispose()
      → tokenManager.dispose()       → sprite.material.dispose()
      → tileManager.dispose()        → sprite.material.dispose()
      → wallManager.dispose()        → material.dispose()
      → gridRenderer.dispose()       → material.dispose()
      → ... (every manager)
```

### What `material.dispose()` Does Inside Three.js

When `material.dispose()` fires, the renderer's `onMaterialDispose` handler calls:
1. `programCache.releaseProgram(program)` — decrements the program's `usedTimes` counter
2. If `usedTimes` reaches 0 → `gl.deleteProgram(glProgram)` — **the compiled GPU program
   is permanently deleted**
3. `programCache.releaseShaderCache(material)` — removes the shader source from the
   `WebGLShaderCache` if no other material references it

Since we create entirely new materials for the next scene, the old programs hit
`usedTimes=0` and are deleted. The new materials must trigger full recompilation:
`gl.createProgram()` → `gl.compileShader()` (vertex) → `gl.compileShader()` (fragment) →
`gl.linkProgram()`.

### Scale of the Problem

Approximate shader program count per scene load:

| Category              | Files | Approx. Unique Programs |
|-----------------------|-------|------------------------|
| Effects (post-proc)   | 34    | ~40                    |
| Particles (weather)   | 6     | ~10                    |
| Scene managers        | 9     | ~12                    |
| Masks / Vision        | 2     | ~4                     |
| **Total**             | **51**| **~60-70**             |

Each `gl.compileShader` + `gl.linkProgram` takes 1-20ms depending on shader complexity and
GPU driver. With 60-70 programs, this can add **200-800ms** of blocking time (or more on
integrated GPUs / older drivers).

---

## Three.js Shader Caching Internals

### `WebGLPrograms` (the program cache)

- Maintains a `programs[]` array of all active `WebGLProgram` instances
- Programs are identified by a `programCacheKey` — a long string hash of ALL shader
  parameters (precision, defines, extensions, vertex/fragment source, etc.)
- `acquireProgram(params, cacheKey)` creates a new GL program (does NOT check for existing
  programs with the same key — the cache is per-material via `materialProperties.programs`)
- When two materials produce the same `cacheKey`, Three.js **does** reuse the program (the
  `programs.get(programCacheKey)` check in `setProgram`), but only if both materials exist
  simultaneously

### `WebGLShaderCache`

- Caches compiled shader stages (vertex/fragment) by source code string
- Tracks `usedTimes` per shader stage
- When a material is disposed and its shader stages reach `usedTimes=0`, the cached source
  is evicted
- This cache helps when multiple materials share the same vertex or fragment shader, but
  is completely emptied when all materials are disposed

### Key Insight

**Three.js has no persistent shader program cache that survives material disposal.**
If all materials referencing a program are disposed, the GL program is deleted and must be
recompiled from scratch when a new material with the same source is created.

---

## Solution Design

### Strategy: Shader Program Pool

Create a `ShaderProgramPool` that keeps "template" materials alive across scene transitions,
preventing their compiled GL programs from being garbage collected. When effects need
materials for a new scene, they get cloned/configured copies whose shader programs are
already warm in the GPU.

### Architecture

```
ShaderProgramPool (singleton, lives on window.MapShine)
  ├── _templates: Map<string, THREE.ShaderMaterial>   // kept alive, never disposed
  ├── _warmupScene: THREE.Scene                        // tiny scene for compile()
  ├── _warmupCamera: THREE.Camera                      // minimal camera
  │
  ├── register(key, shaderDef)    // register a shader program template
  ├── acquire(key, uniforms)      // get a configured material (shares GL program)
  ├── release(material)           // return material (DO NOT dispose — just detach)
  ├── warmAll(renderer)           // pre-compile all registered templates
  └── dispose()                   // only on page unload
```

### How It Works

1. **Registration Phase** (module load / first scene):
   Each effect registers its shader source (vertex + fragment + defines) with a stable key.
   The pool creates a "template" `ShaderMaterial` and keeps a permanent reference.

2. **Compilation Phase** (first scene load only):
   `pool.warmAll(renderer)` calls `renderer.compile(warmupScene, warmupCamera)` with all
   template materials attached to dummy meshes. This triggers GPU compilation for all
   programs in one batch. With `KHR_parallel_shader_compile`, these compile in parallel.

3. **Acquisition Phase** (every scene load):
   Instead of `new THREE.ShaderMaterial({...})`, effects call `pool.acquire(key, uniforms)`.
   This returns a new material that **reuses the same program cache key** as the template,
   so Three.js's `setProgram` finds the existing compiled program via
   `programs.get(programCacheKey)` and skips compilation entirely.

4. **Release Phase** (scene teardown):
   Instead of `material.dispose()`, effects call `pool.release(material)`. The pool detaches
   the material from the scene but does NOT call `material.dispose()`, preserving the GL
   program's `usedTimes` count (the template still references it). The material's JS object
   becomes eligible for GC, but the GL program lives on.

5. **Template Survival**:
   Template materials are never disposed (they live on the pool singleton). Their associated
   GL programs remain compiled in the `WebGLPrograms` cache indefinitely. This is safe
   because the renderer itself also persists.

### Program Reuse Mechanism (Three.js internal)

Three.js generates a `programCacheKey` from shader parameters. Two materials with:
- Same vertex shader source
- Same fragment shader source
- Same defines
- Same precision
- Same extensions

...produce the **same cache key**. When the second material is first rendered, `setProgram`
finds the existing program via `programs.get(programCacheKey)` and reuses it — **zero
compilation**.

The pool exploits this: the template material keeps the program alive, and scene materials
with identical source automatically share it.

### Handling Shader Variants

Some effects have **conditional defines** that produce different shader source depending on
scene configuration (e.g., mask presence, feature toggles). Each unique combination of
defines creates a distinct program.

Strategy: Register the common variants eagerly, and let rare variants compile on-demand
(first-render compile, but cached thereafter via the template system).

```javascript
// Example: LightingEffect has variants based on mask presence
pool.register('lighting-base', { vertexShader, fragmentShader, defines: {} });
pool.register('lighting-with-roof', { vertexShader, fragmentShader, defines: { HAS_ROOF_MAP: '' } });
```

---

## Implementation Plan

### Phase 1: Core Infrastructure (ShaderProgramPool)

**New file**: `scripts/core/shader-program-pool.js`

1. `ShaderProgramPool` class with `register`, `acquire`, `release`, `warmAll`, `dispose`
2. Singleton instance on `window.MapShine.shaderPool`
3. Created during `bootstrap()`, persists across scene transitions
4. `warmAll()` uses `renderer.compileAsync()` to leverage `KHR_parallel_shader_compile`

### Phase 2: Effect Integration (High-Impact Effects First)

Modify the heaviest effects to use the pool. Priority order (by shader complexity / compile
time):

1. **LightingEffect** — complex multi-light fragment shader, biggest compile cost
2. **WorldSpaceFogEffect** — multiple materials (fog, vision, exploration)
3. **WaterEffectV2** — complex procedural water shader
4. **SpecularEffect** — PBR specular with many features
5. **WindowLightEffect** — multi-pass (light scene + main)
6. **BloomEffect** — multi-pass blur
7. **CloudEffect** — complex cloud shader
8. **BuildingShadowsEffect** — raymarching bake shader
9. **WeatherParticles** — multiple materials (rain, snow, splash)
10. **Remaining effects** — iterate through rest

Integration pattern per effect:
```javascript
// Before (current):
initialize(renderer, scene, camera) {
  this.material = new THREE.ShaderMaterial({
    vertexShader: VERT_SRC,
    fragmentShader: FRAG_SRC,
    uniforms: { ... }
  });
}

dispose() {
  this.material.dispose();  // KILLS the GL program
}

// After (with pool):
static SHADER_KEY = 'lighting-base';

static registerShaders(pool) {
  pool.register(LightingEffect.SHADER_KEY, {
    vertexShader: VERT_SRC,
    fragmentShader: FRAG_SRC,
    defines: { ... }
  });
}

initialize(renderer, scene, camera) {
  const pool = window.MapShine.shaderPool;
  this.material = pool.acquire(LightingEffect.SHADER_KEY, {
    uTime: { value: 0 },
    // ... scene-specific uniforms
  });
}

dispose() {
  const pool = window.MapShine.shaderPool;
  if (pool) {
    pool.release(this.material);  // Detaches but preserves GL program
  } else {
    this.material.dispose();       // Fallback if pool somehow missing
  }
  this.material = null;
}
```

### Phase 3: Particle System Integration

- `rendering.js` / `createParticleMaterial` — register particle shader variants
- `WeatherParticles` — rain, snow, splash materials
- `FireSparksEffect`, `DustMotesEffect`, `SmellyFliesEffect`

### Phase 4: Scene Manager Integration

- `grid-renderer.js` — grid overlay shader
- `interaction-manager.js` — selection/preview shaders
- `light-icon-manager.js`, `enhanced-light-icon-manager.js`
- `LightMesh.js`
- `MaskManager.js`, `VisionSDF.js`

### Phase 5: Warmup During Loading

Wire into the loading overlay flow in `createThreeCanvas()`:

```javascript
// After bootstrap, before first scene:
const pool = window.MapShine.shaderPool;

// Register all known shader programs
LightingEffect.registerShaders(pool);
WorldSpaceFogEffect.registerShaders(pool);
WaterEffectV2.registerShaders(pool);
// ... etc

// Pre-compile all in parallel
loadingOverlay.setStage('shaders', 0, 'Compiling shaders…');
await pool.warmAll(renderer);
loadingOverlay.setStage('shaders', 1.0, 'Shaders ready');
```

This happens **once per page load**. Subsequent scene transitions skip compilation entirely.

---

## Edge Cases & Considerations

### Memory Cost
Each template material is tiny (~1KB JS + one GL program handle). With ~70 templates, total
overhead is ~70KB JS + ~70 GL program objects. GPU memory for compiled programs is typically
a few hundred KB total — negligible compared to texture memory.

### Shader Source Changes (Hot Reload / Development)
During development, if shader source changes, the pool should detect stale templates. Can
add a hash check: `register()` compares incoming source hash with stored template; if
different, dispose old template and create new one.

### Conditional Defines
Effects with feature-dependent defines (e.g., `HAS_ROOF_MAP`, `HAS_SPECULAR_MASK`) need
multiple registered variants. The `acquire()` call would specify which defines are active,
mapping to the correct template.

Alternative: Use uniform-based branching instead of defines where performance allows. This
reduces variant count but adds minor GPU cost. Recommend keeping defines for hot inner-loop
code (lighting, fog) and using uniforms for rarely-hit branches.

### WebGL Context Loss
On context loss, all GL programs are destroyed regardless. The pool must handle
`webglcontextrestored` by re-running `warmAll()` to recompile all templates. This is
already handled by the existing context restore flow in `canvas-replacement.js`.

### Cleanup on Page Unload
`pool.dispose()` should be called from `bootstrap.cleanup()` to properly release GL
resources. In practice the browser handles this on tab close, but explicit cleanup is good
hygiene.

---

## Expected Impact

| Metric                       | Before        | After (warm)  |
|------------------------------|---------------|---------------|
| Shader compile time (scene 2+) | 200-800ms    | ~0ms          |
| First scene compile time     | 200-800ms     | 200-800ms*    |
| Memory overhead              | 0             | ~70KB JS      |
| Code complexity              | Low           | Medium        |

*First scene compile can be improved with `compileAsync()` + loading overlay, moving the
stall off the main thread (GPU still blocks but CPU can show progress).

### User-Facing Improvement
- **Scene A → Scene B → Scene A**: Currently recompiles all shaders twice. With pool,
  second and subsequent transitions have zero shader compilation.
- **Scene A → Scene B (different effects)**: Only compiles shaders for effects unique to
  Scene B. Common effects (lighting, fog, weather) are already warm.

---

## Alternatives Considered

### 1. Don't Dispose Materials on Scene Transition
**Rejected**: Would leak textures, uniforms, and scene-specific state. Materials hold
references to mask textures that MUST be freed when leaving a scene. Separating "disposable
state" from "shader program" is exactly what the pool pattern does.

### 2. WebGL Binary Shader Cache (gl.getShaderBinary / gl.shaderBinary)
**Rejected**: Not available in WebGL 2. Only exists in OpenGL ES 3.0+ native, and browser
implementations don't expose it. `KHR_parallel_shader_compile` is the closest WebGL gets.

### 3. Serialize Shader Source to IndexedDB and Precompile
**Rejected**: There's no way to restore a compiled GL program from stored source without
going through `gl.compileShader()` again. The GPU must compile; we can only avoid
*re-triggering* the compile by keeping the program alive.

### 4. Use `renderer.compile()` During Loading (Without Pool)
**Partial**: This moves compilation to the loading phase (good UX) but doesn't prevent
recompilation on scene 2+. The pool is needed for cross-scene persistence.

---

## Files to Create / Modify

### New Files
- `scripts/core/shader-program-pool.js` — Core pool implementation

### Modified Files (Phase 2-4, per effect)
- Each effect file: Add `static registerShaders(pool)`, modify `initialize()` to use
  `pool.acquire()`, modify `dispose()` to use `pool.release()`
- `scripts/core/bootstrap.js` — Create pool singleton
- `scripts/foundry/canvas-replacement.js` — Wire `warmAll()` into loading flow
- `scripts/core/scene-context.js` — Pool-aware disposal

### Documentation
- This file (planning reference)
