 # Performance Plan (Three.js)
 
 ## Goals

 - **Maintain 60 FPS on "normal" scenes** (target baseline).
 - **Avoid GC hitches** during pan/zoom and token animations.
 - **Scale gracefully** with:
   - Lots of tiles (including overhead)
   - Many particle sources
   - Multiple post-processing effects
 - **Tiered quality**: high-end gets eye candy; low-end stays smooth.
 
 ## Current Baseline (TBD)

 - **Profile targets**
   - Representative scene: large map + overhead tiles + weather + 20+ tokens.
   - Stress scene: 200+ tiles, 100+ tokens, multiple effects enabled.
 - **Metrics to capture**
   - FPS (avg + 1% low)
   - `renderer.info` (calls, triangles, textures)
   - Render target sizes + count
   - CPU frame time vs GPU frame time (Chrome Performance)
   - Memory / GC frequency
 
 ## Early Guardrails

 ### Renderer & Render Targets

 - **Keep DPR under control**
   - Current: `renderer.setPixelRatio(Math.min(devicePixelRatio, 2))` in `scripts/core/renderer-strategy.js`.
   - Plan: add an *adaptive* DPR mode (drop DPR when GPU time spikes).
 - **Be intentional about HDR formats**
   - Current: EffectComposer uses `THREE.FloatType` render targets for scene + post.
   - Plan: evaluate `HalfFloatType` for post buffers (bandwidth/memory win) with FloatType reserved for high tier.

 ### Static Objects: Matrix Updates

 - **Disable matrix auto-updates for static objects**
   - Foundry scenes have many static tiles/props.
   - Strategy: set `object.matrixAutoUpdate = false` for any object that does not move/rotate/scale.
   - When an object *does* change (e.g. drag/drop edit), call `object.updateMatrix()` (and `object.updateMatrixWorld(true)` if needed) after applying the transform.
   - Likely targets:
     - tile sprites that do not animate
     - static lights/decals
     - any baked background/foreground layers

 ### Object Count, Draw Calls, and Scene Graph Cost

 - Official Three.js guidance: **many objects is often the bottleneck**.
   - Merging geometry / batching can turn "N objects" into ~1 draw call.
   - Also: adding many helper `Object3D` nodes can be expensive; prefer fewer scene graph nodes when possible.
   - Reference: `threejs.org/manual/en/optimize-lots-of-objects.html`

 - **Rule of thumb for Map Shine Advanced**
   - Tiles and static props are "lots of objects".
   - Tokens are *interactive/movable* so we likely keep them as independent instances, but still try to:
     - share materials where possible
     - reduce per-token per-frame work
     - avoid object allocations

 ### Effect Authoring Rules (hot-path safety)

 - **No per-frame allocations in `update()`**
   - Cache `Vector2/3/4`, `Color`, arrays, and any temp objects used in loops.
 - **No per-frame readbacks** (`getImageData`, texture-to-CPU) except during initialization or explicit "rebuild" events.
 - **Throttle Foundry hooks that can fire during animations**
   - Prefer "mark dirty" + throttled recompute over immediate rebuild.
 - **Post-processing effects must always preserve the chain**
   - If an effect is enabled but internally wants to "do nothing", it must blit/pass-through.
 - **Avoid per-object `onBeforeRender` / callback-driven updates**
   - Prefer centralized `Manager.update(dt)` loops (like we do via `EffectComposer` updatables) over attaching callbacks on hundreds of objects.

 ### Texture/VRAM Hygiene (Foundry scene switching)

 - Foundry users switch scenes frequently; VRAM can bloat if we do not explicitly free GPU resources.
 - **Dispose lifecycle must be strict** when scenes/effects are destroyed:
   - `geometry.dispose()`
   - `material.dispose()`
   - `material.map.dispose()` (and any other maps: normal/roughness/alpha/etc.)
 - If textures are shared/cached, use a **ref-count or cache ownership rule** so we only `dispose()` when no longer referenced.
 - Monitor for "slowdown over time" by tracking:
   - `renderer.info.memory.textures`
   - shader/program count growth over time (symptom of leaking materials/programs)
 - **Three.js disposal nuance (from the manual)**
   - Disposing a `Material` does **not** dispose its textures; textures are shared and must be disposed separately.
   - `WebGLRenderTarget` allocates textures + framebuffers/renderbuffers; it must be freed with `WebGLRenderTarget.dispose()`.
   - If we ever use `ImageBitmap` as a texture source, the manual notes we must call `ImageBitmap.close()` ourselves (three.js cannot safely do this automatically).
   - `renderer.info.memory.*` may never drop to literal zero after cleanup because three.js can keep some internal reusable resources (e.g. background/env contexts).

 ### Transparency & Sorting

 - Sprites and many effects are `transparent: true`, which can trigger extra CPU sorting work each frame.
 - Because our engine uses **explicit Z bands** + `renderOrder` in multiple places, we may be able to:
   - set `renderer.sortObjects = false` (or selectively reduce sorting work)
   - rely on strict layering
 - Needs validation: any particle systems or translucent overlays that truly require depth sorting.

 ### Enable/Disable Must Be Real
 
 - Ensure **UI toggles** actually set `effect.enabled = false` so EffectComposer can skip:
   - extra ping-pong buffers
   - full-screen passes
   - per-frame `update()` work
 
 ## High-Impact Opportunities (Prioritized)

 ### 0) Instrumentation & Profiling (do this early)

 - **Use `renderer.info` every frame**
   - Three.js provides `renderer.info` for "statistical information about the GPU memory and the rendering process".
   - If we want stable per-frame numbers, ensure frame metrics reset appropriately:
     - Option A: keep `renderer.info.autoReset = true` (default) and sample after render.
     - Option B: set `renderer.info.autoReset = false` and call `renderer.info.reset()` once per frame.
   - Track at least:
     - `renderer.info.render.calls`
     - `renderer.info.render.triangles`
     - `renderer.info.render.points`
     - `renderer.info.memory.textures`
     - `renderer.info.memory.geometries`
 - **Capture 1% lows + hitch frequency**
   - We care about micro-stutters during pan/zoom more than average FPS.

 ### 1) Low-risk quick wins (near term)

 - **Eliminate per-frame allocations** ✅ DONE
   - ~~`TokenManager.update()` allocates a new `THREE.Color` each frame.~~ Fixed: cached Color instances
   - ~~`BloomEffect.updateTintColor()` allocates a new `THREE.Vector3`.~~ Fixed: cached Vector3
   - ~~`CloudEffect._calculateTimeOfDayTint()` allocates new `THREE.Vector3` objects.~~ Fixed: cached tint vectors
 - **Reduce per-frame state churn**
   - Avoid toggling `material.needsUpdate` unless a define/blending/program change actually occurred.

 - **Debounce expensive resize work**
   - Foundry can trigger many resize-like events (sidebar, popouts, UI layout).
   - Debounce `renderer.setSize` and any render target reallocation by ~100–250ms.

 ### 2) Medium/large wins (architecture)

 - **Adaptive Resolution / Dynamic Quality**
   - Lower DPR (or half-res) when post stack is heavy (Bloom + ASCII + Lighting + etc.).
 - **Half-res by default for expensive full-screen effects**
   - Bloom, distortion composites, heavy blurs.
 - **Shader compilation warmup**
   - Pre-compile materials after scene load to avoid first-use stutters.
   - Use `renderer.compile(scene, camera)` or a controlled warmup render after scene load/effect initialization.
 - **Batching/Instancing strategy for tiles (big one)**
   - Current architecture: `TileManager` uses one `THREE.Sprite` per tile (object count + draw calls scale with tile count).
   - Candidate approach:
     - A dedicated `TileBatch` per layer (background/foreground/overhead).
     - Use `InstancedMesh` or a custom quad `BufferGeometry` with per-instance attributes:
       - world transform (or position + scale + rotation)
       - UV transform into a texture atlas or texture array
       - per-instance opacity (for occlusion fades)
       - per-instance flags (overhead, hoverHidden)
     - Update only the instance data that changed, not every tile every frame.
 - **Global tinting as a uniform (avoid per-object color writes)**
   - Current: `TileManager.update()` loops all tiles each frame and calls `sprite.material.color.copy(globalTint)`.
   - Current: `TokenManager.update()` also loops all tokens and sets material color.
   - Candidate: use a shared shader/material path where `globalTint` is a uniform and objects sample it in shader.
 - **Grid texture memory**
   - Current: `GridRenderer.createGridTexture()` creates a canvas the size of the entire scene (`dim.width x dim.height`).
   - On large maps this can become a large CPU+GPU allocation and upload.
   - Candidate: generate a **small tileable grid texture** (1-2 cells) and repeat it via texture `wrapS/T = RepeatWrapping`.

 - **Frustum culling strategy**
   - For large scenes, per-object frustum checks can become non-trivial at scale.
   - If we batch/instance tiles, culling becomes per-batch (one bounding volume), which is usually cheaper.
   - For individual token sprites:
     - Ensure `sprite.frustumCulled = true` (unless we have a strong reason to force-render).
   - For batched/instanced geometry:
     - ensure correct bounding volumes (or the batch may never cull).

 - **Foundry integration: Double-canvas sync & visibility culling**
   - We already hook into Foundry’s PIXI ticker in `scripts/core/frame-coordinator.js`; keep Three.js timing driven from that single source to avoid jitter.
   - **Don’t update what the user can’t see**:
     - when a token is not visible due to fog/vision/hidden state, skip its expensive effects (particles, distortion, etc.).
     - apply the same idea to area effects that are fully offscreen.

 - **Resolution scaling vs browser zoom**
   - Provide an "Internal Resolution Scale" slider that multiplies the effective pixel ratio.
   - Users on 4K displays (or high browser zoom) may need 0.5x–0.75x internal scale for stable 60 FPS.

 ### Quark Particles (three.quarks) Specific Considerations

 - **Global particle cap / emission throttling**
   - Implement a global "Max Active Particles" budget per tier.
   - If many systems are active (10 fire sources, heavy weather), reduce `emissionOverTime` per system so total active particles stays under budget.
 - **Prefer local space for moving emitters**
   - If a system is attached to a moving token, local space can be cheaper than world space since fewer per-particle world transforms are needed.
 - **Texture atlases / spritesheets**
   - Prefer one atlas (or a few) over many small textures to reduce texture binds and improve batching.
 - **Limit complex behaviors by tier**
   - Behaviors like noise/curves can be CPU-heavy.
   - For low tier: disable expensive behaviors or use simpler approximations.
 - **Pre-warm common systems**
   - Avoid first-use hitches by initializing / pre-warming common systems (e.g. fire) during scene load and enabling them on demand.

### Compressed Textures (optional, for shipped assets)

 - If we ship custom textures (noise maps, effect atlases), consider KTX2/Basis so textures remain compressed in VRAM.
 - Biggest win is GPU memory footprint; this can also reduce upload cost on scene load.
 - Practical integration notes:
   - Use `KTX2Loader`, call `detectSupport(renderer)` before loading (required by the loader).
   - The Basis transcoder (WASM + JS wrapper) must be hosted with the module and referenced via `setTranscoderPath(...)`.
   - Call `KTX2Loader.dispose()` when the loader is no longer needed.

## Recommended Tiered Quality Mapping

| Feature | Low Tier | High Tier |
| --- | --- | --- |
| DPR | 0.75x - 1.0x | Native (up to 2.0) |
| Post-Processing | Disabled or FXAA only | Bloom, DOF, SSAO, etc. |
| Particles | 25% max count, no noise | 100% count, full behaviors |
| Shadows | Disabled | Enabled (PCSS / high map res) |
| Anisotropy | 1 | 4 or 8 |
| Render Target | HalfFloatType | FloatType |

## Implementation Checklist

### Baseline & Instrumentation

- [ ] Create two benchmark scenes (representative + stress) and save them for repeatable profiling.
- [ ] Add a debug toggle that logs (or overlays) per-frame `renderer.info` metrics (calls/triangles/textures/geometries).
- [ ] Capture:
  - [ ] average FPS
  - [ ] 1% low FPS / hitch frequency
  - [ ] `renderer.info.memory.*` over 5-10 minutes of scene activity (to detect leaks)
- [ ] Decide whether we manage `renderer.info.reset()` ourselves (`autoReset=false`) or rely on default (`autoReset=true`).

### Renderer / Resize / Resolution

- [ ] Add an "Internal Resolution Scale" slider that multiplies the effective pixel ratio (separate from browser zoom).
- [ ] Debounce resize-driven GPU reallocations (renderer + render targets) by 100–250ms.
- [ ] Evaluate disabling MSAA (`antialias: false`) on low tier and using a cheaper AA strategy if needed.

### Scene Graph CPU Cost

- [x] Apply `matrixAutoUpdate = false` to static tile sprites (and any other static props).
- [x] On tile edits (drag/drop/resize), update transforms and call `updateMatrix()` (and `updateMatrixWorld(true)` if needed).
- [ ] Audit where we can safely reduce sorting work (trial `renderer.sortObjects = false`) given explicit `renderOrder` layering.

### Texture / VRAM Hygiene (Scene Switching)

- [ ] Establish a clear ownership rule for textures (ref-counted cache or single owner) so we dispose safely.
- [ ] On effect/scene teardown, ensure we dispose:
  - [ ] `BufferGeometry.dispose()`
  - [ ] `Material.dispose()`
  - [ ] `Texture.dispose()` (maps are not automatically disposed by material disposal)
  - [ ] `WebGLRenderTarget.dispose()`
- [ ] Add a "scene switch soak test": switch scenes N times and ensure `renderer.info.memory.textures` stabilizes.

### Tiles: Batching Strategy (High Impact)

- [ ] Define a minimal feature set for a tile batch (position/scale/rotation/opacity/uvTransform/renderOrder).
- [ ] Prototype a batched tile renderer (InstancedMesh or custom quad buffer) for background tiles first.
- [ ] Extend batching to overhead tiles (must preserve roof masking / alpha pass semantics).

### Tokens: Update Cost & Allocations

- [x] Remove per-frame allocations in hot paths (e.g. cache `THREE.Color`, `Vector*` scratch objects).
- [x] Reduce per-token per-frame loops (e.g. global tint as a uniform rather than `material.color.copy()` across all sprites).

### Post-Processing / Render Targets

- [ ] Evaluate moving some post buffers from `FloatType` to `HalfFloatType` on low/medium tiers.
- [ ] Ensure render targets only allocate the buffers they need (e.g. disable depth/stencil when unused).
- [ ] Consider half-res paths for expensive full-screen effects (Bloom/blur-heavy passes).

### Quarks (three.quarks) - MAJOR OPTIMIZATION OPPORTUNITY

#### Current State Analysis

The particle system currently has several performance issues:

1. **Full-Map Simulation**: Weather particles (rain/snow) emit across the **entire scene rectangle** regardless of camera view. On a 4000x3000 map, particles spawn everywhere even if the user is zoomed in on a 500x500 area.

2. **No View Frustum Culling**: `BatchedRenderer.update()` ticks ALL registered particle systems every frame, even if their emitters are completely off-screen.

3. **Fixed Emission Rates**: Rain emits at `4000 * intensity` particles/sec across the whole map. At 100% precipitation on a large map, this can mean 15,000+ active particles being simulated.

4. **Per-Particle Behaviors**: Custom behaviors (`WorldVolumeKillBehavior`, `RainFadeInBehavior`, `SmartWindBehavior`) run CPU-side per-particle per-frame.

5. **Multiple Particle Systems**: Weather alone has rain + snow + splashes + foam. Fire/dust/flies add more. Each system has its own update loop.

#### Architecture Overview

```
ParticleSystem (EffectBase)
  └─ BatchedRenderer (three.quarks)
       ├─ WeatherParticles
       │    ├─ rainSystem (15k max particles, full-map emitter)
       │    ├─ snowSystem (8k max particles, full-map emitter)
       │    ├─ splashSystems[] (per-tile water splashes)
       │    └─ foamSystem (shoreline foam)
       └─ [Other effects register their systems here]
  
FireSparksEffect
  └─ Uses same BatchedRenderer via ParticleSystem.batchRenderer
  
DustMotesEffect
  └─ Uses same BatchedRenderer
  
SmellyFliesEffect
  └─ Uses same BatchedRenderer
```

#### Documentation-backed Implementation Notes

- **three.quarks architecture (upstream)**
  - The library expects **one** `BatchedRenderer` per Three.js scene. Individual `ParticleSystem` instances register into it and it batches compatible systems into fewer draw calls.
  - Docs:
    - `https://raw.githubusercontent.com/Alchemist0823/three.quarks/master/README.md`
    - `https://raw.githubusercontent.com/Alchemist0823/three.quarks/master/DEVELOPMENT_GUIDE.md`

- **What we can use immediately (confirmed in our vendored `three.quarks.module.js`)**
  - **Pause simulation**: `ParticleSystem.pause()` / `ParticleSystem.play()` (hard stop of `system.update(delta)` early).
  - **Hide rendering at batch level**: batches collect visible systems via `system.emitter.visible` (see `getVisibleSystems()` in the renderer batches).
  - **Active particle count**: `system.particleNum` is the number of alive particles; batches sum this to size buffers.
  - **Emitter is a real `Object3D`**: `system.emitter` exists and has position/visibility; it’s what we add to the scene.

- **Important implication for culling**
  - In three.quarks, hiding the emitter (`system.emitter.visible = false`) can stop it from being included when batches build their render buffers.
  - But the current `BatchedRenderer.update(delta)` still calls `ps.update(delta)` for *all systems*. For **CPU savings**, we should also `system.pause()` (or add an external gate before calling `ps.update`).

- **Three.js frustum tests for per-system culling**
  - Use `THREE.Frustum` with `THREE.Box3` or `THREE.Sphere` to decide if a system is on-screen.
  - Recommended approach:
    - Build a frustum each frame from camera matrices (standard pattern):
      - `frustum.setFromProjectionMatrix(projectionMatrix * matrixWorldInverse)`
    - Test with `frustum.intersectsSphere(sphere)` (cheaper) or `frustum.intersectsBox(box)`.
  - Docs:
    - `https://threejs.org/docs/#api/en/math/Frustum`
    - `https://threejs.org/docs/#api/en/math/Box3`
    - `https://threejs.org/docs/#api/en/math/Sphere`

- **View-bounds computation (for view-dependent emission)**
  - Prefer using our existing “zoom => world units” contract rather than `unproject()` math:
    - We already compute visible world width/height in `CloudEffect` using:
      - `visibleWorldWidth = viewportWidth / zoom`
      - `visibleWorldHeight = viewportHeight / zoom`
    - This matches our FOV-based zoom system (`sceneComposer.currentZoom`) and avoids per-frame allocations.
  - Use camera center `(camera.position.x, camera.position.y)` as the center of the visible rectangle.
  - Add a margin (e.g. 20%) so particles spawned just off-screen can drift into view.

#### How this maps to our current WeatherParticles implementation

- We already use a custom emitter shape `RandomRectangleEmitter` with mutable `width` / `height`.
- The emitter shape initializes particles in **local emitter space** within `[-width/2..+width/2]` / `[-height/2..+height/2]`.
- Therefore, view-dependent emission is simply:
  - Each frame:
    - Set rain/snow emitter positions to camera center.
    - Set `RandomRectangleEmitter.width/height` to the visible world size (+ margin).
  - This reduces spawn area immediately without touching quarks internals.

#### Optimization Strategies (Prioritized)

**HIGH IMPACT - View-Dependent Emission**

- [ ] **Camera-Frustum Emitter Bounds**: Instead of emitting across the full scene rectangle, compute visible world bounds from camera and only emit within that region + a margin for particles entering the view.
  - Weather emitters should track `sceneComposer.camera` position and FOV
  - Dynamically resize emitter rectangle to `visibleBounds + 20% margin`
  - This alone could reduce active particle count by 80-95% when zoomed in

- [ ] **Per-System Frustum Culling**: Before calling `system.update(delta)`, check if the system's bounding volume intersects the camera frustum. Skip update entirely for off-screen systems.
  - Fire sources off-screen: skip
  - Dust motes in a distant room: skip
  - Flies around a trash pile not in view: skip

**MEDIUM IMPACT - Emission Throttling**

- [ ] **Global Particle Budget**: Implement a hard cap on total active particles across all systems (e.g., 20k for high tier, 8k for low tier).
  - Track `totalActiveParticles` in `ParticleSystem.update()`
  - When approaching budget, reduce emission rates proportionally
  - Priority: weather < ambient (dust) < gameplay (fire near tokens)

- [ ] **Zoom-Adaptive Emission**: Scale emission rate inversely with zoom level.
  - Zoomed out (zoom < 0.5): reduce emission by 50-75%
  - Zoomed in (zoom > 1.5): full emission (smaller visible area anyway)
  - Particles are less individually visible when zoomed out

- [ ] **Distance-Based LOD for Behaviors**: Expensive per-particle behaviors (curl noise, smart wind) could be simplified or skipped for particles far from camera center.

**LOWER IMPACT - System Optimizations**

- [ ] **Hybrid CPU/GPU Behaviors**: Move simple behaviors (gravity, linear forces) to vertex shader; keep complex behaviors (mask sampling, state machines) on CPU.

- [ ] **Shader-Based Kill Volume**: Replace `WorldVolumeKillBehavior` (CPU per-particle) with a shader discard based on world position uniforms.

- [ ] **Texture Atlasing**: Consolidate rain/snow/splash/foam textures into a single atlas to reduce texture binds.

- [ ] **Pre-warming**: Call `system.update()` a few times during scene load with `emissionOverTime = 0` to warm up shader compilation.

#### Implementation Checklist

**Phase 1: View-Dependent Weather (Highest Impact)**

- [ ] Add `_getVisibleWorldBounds()` helper to WeatherParticles that computes camera-visible rectangle
- [ ] Modify rain/snow emitter shapes to use dynamic bounds instead of full scene rect
- [ ] Add margin factor (configurable, default 20%) for particles entering view
- [ ] Update emitter position each frame to track camera center

**Phase 2: System-Level Culling**

- [ ] Add `boundingBox` or `boundingSphere` to each ParticleSystem
- [ ] In `BatchedRenderer.update()`, check frustum intersection before `system.update()`
- [ ] Add `system.visible` flag that can be set by culling logic
- [ ] Expose culling stats for debugging

**Phase 3: Global Budget & Throttling**

- [ ] Add `ParticleSystem.maxGlobalParticles` setting (tier-dependent)
- [ ] Track active particle count across all systems
- [ ] Implement proportional emission throttling when over budget
- [ ] Add zoom-based emission scaling

**Phase 4: Behavior Optimization**

- [ ] Profile per-particle behavior cost
- [ ] Move `WorldVolumeKillBehavior` to shader (discard in fragment)
- [ ] Simplify `SmartWindBehavior` for distant particles
- [ ] Consider LOD system for behavior complexity

### Foundry Integration

- [ ] Keep Three.js frame timing driven from Foundry’s ticker (single authoritative clock) to avoid jitter.
- [ ] Add visibility-based culling gates (don’t update particles/effects for tokens the user can’t see).

## References

- `https://threejs.org/manual/en/optimize-lots-of-objects.html`
- `https://threejs.org/manual/en/matrix-transformations.html`
- `https://threejs.org/manual/en/how-to-dispose-of-objects.html`
- `https://threejs.org/manual/en/rendertargets.html`
- `https://threejs.org/docs/pages/Info.html`
- `https://threejs.org/docs/pages/Renderer.html`
- `https://threejs.org/docs/pages/KTX2Loader.html`

## Open Questions

- Should the default HDR buffer be **FloatType or HalfFloatType** on WebGL2?
- Do we want **MSAA** (renderer `antialias: true`) long-term, or move to a cheaper AA strategy?
- What is the intended **“low tier” visual contract** (which effects are allowed to run)?
