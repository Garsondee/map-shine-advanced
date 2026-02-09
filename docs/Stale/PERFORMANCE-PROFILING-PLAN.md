# Map Shine Advanced – Performance Profiling & Evaluation Plan

> **Scope**: This is a *planning + mapping* document. It intentionally does **not** implement fixes.
>
> **Goal**: Add tooling to identify which subsystems/effects are the worst offenders for:
>- **FPS / frame-time spikes** (CPU + GPU)
>- **Performance degradation over time** (leaks, accumulating work)
>- **Loading time** (startup + scene switch)

---

## High-level strategy

### What we need to measure

- **Frame time decomposition** (per frame, rolling averages)
  - Total frame time (ms)
  - CPU time spent in:
    - `EffectComposer.render()`
    - `updatables.update(timeInfo)` aggregate and per-updatable
    - `effect.update(timeInfo)` per effect
    - `effect.render(...)` per effect
  - **GPU time (optional / best-effort)**
    - WebGL timer queries (`EXT_disjoint_timer_query_webgl2`) if available
    - Otherwise approximate with renderer stats and frame-time deltas

- **Resource / leak tracking** (sampled periodically)
  - `renderer.info` (programs, geometries, textures, calls)
  - Custom counts of:
    - active effects, render targets
    - active event listeners/intervals
    - cached asset bundles (`assets/loader.js` cache)
    - per-effect allocations if detectable (via counters)

- **Loading time breakdown**
  - Bootstrap time
  - SceneComposer initialization time
    - mask discovery/loading
    - composite mask creation (canvas-based)
  - Effect initialization time (per effect)
  - Scene syncing time (TokenManager, TileManager, WallManager, etc.)

### Where to put instrumentation (lowest friction)

- **Primary hook point**: `scripts/effects/EffectComposer.js` (single orchestrator)
- **Secondary hook points**:
  - `scripts/foundry/canvas-replacement.js` (scene lifecycle: create/destroy, effect registration, UI init)
  - `scripts/scene/*-manager.js` (per-frame update + hook-based sync)
  - `scripts/assets/loader.js` + `scripts/scene/composer.js` (loading breakdown + cache behavior)

---

## Module entrypoint & runtime pipeline (mapped)

### 1) Entrypoint: `scripts/module.js`

**Lifecycle**

- `Hooks.once('init')`
  - registers settings:
    - `scripts/settings/scene-settings.js`
    - `registerUISettings()` from `scripts/ui/tweakpane-manager.js`
  - registers UI hooks:
    - `getSceneControlButtons`
    - `renderTileConfig` (adds MapShine-specific tile flags)
  - calls `canvasReplacement.initialize()`

- `Hooks.once('ready')`
  - runs `bootstrap({ verbose:false })` from `scripts/core/bootstrap.js`
  - copies returned state into `window.MapShine`

**Primary performance relevance**

- Hooks here are mostly *one-time* or UI-driven.
- If FPS drops over time, it’s more likely in:
  - Three render loop (EffectComposer)
  - per-frame updatables
  - leaks across scene reloads

---

### 2) Bootstrap: `scripts/core/bootstrap.js`

**Responsibilities**

- Loads Three.js: `import('../vendor/three/three.custom.js')`
- Detects GPU capabilities: `scripts/core/capabilities.js`
- Creates renderer via fallback strategy: `scripts/core/renderer-strategy.js`
- Initializes `GameSystemManager`: `scripts/core/game-system.js`
- Installs console helpers: `scripts/utils/console-helpers.js`

**Potential perf issues / unknowns**

- Renderer created once and reused across scenes (good), but **resource cleanup across scenes must be perfect**.

---

### 3) Foundry integration + lifecycle: `scripts/foundry/canvas-replacement.js`

**Hook registration** (`initialize()`)

- `Hooks.on('canvasConfig', ...)` sets PIXI renderer transparency
- `Hooks.on('canvasReady', onCanvasReady)`
- `Hooks.on('canvasTearDown', onCanvasTearDown)`
- `Hooks.on('updateScene', onUpdateScene)`
- `Hooks.on('pauseGame', ...)` forwards pause to TimeManager
- `installCanvasTransitionWrapper()` (wraps tearDown for fade transitions)

**Scene load (enabled)**: `onCanvasReady()` → `createThreeCanvas(scene)`

Key steps (in order):

1. Create/attach Three canvas next to `#board`
2. Hide/disable replaced PIXI layers; keep tokens interactive (transparent meshes)
3. `SceneComposer.initialize(scene, viewportW, viewportH, { onProgress })`
   - builds base plane, camera
   - loads masks via `assets/loader.js`
   - may create composite masks (canvas) for multi-tile scenes
4. Initialize `MaskManager`, register `bundle.masks` textures
   - defines derived masks like `indoor.scene`, `roofVisible.screen`, etc.
5. `weatherController.setRoofMap(...)` if `_Outdoors` is present
6. Initialize `EffectComposer(renderer, threeScene, camera)`
   - calls `effectComposer.initialize(capabilities)`
   - ensures TimeManager matches Foundry pause state
7. `await weatherController.initialize(); effectComposer.addUpdatable(weatherController)`
8. Register effects (async, awaited) — **each effect has `initialize()`**
   - Material/Surface: Specular, Iridescence, WindowLight, Prism, Water, Bush, Tree
   - Post: ColorCorrection, FilmGrain, DotScreen, Halftone, Sharpen, ASCII
   - Lighting/Fog: WorldSpaceFogEffect, LightingEffect, CandleFlames
   - Env/Post: OverheadShadows, BuildingShadows, CloudEffect, AtmosphericFog, DistortionManager, Bloom, Lensflare
   - Debug: MaskDebugEffect, DebugLayerEffect
   - Particles: ParticleSystem, FireSparksEffect, SmellyFliesEffect, DustMotesEffect, LightningEffect
9. Wire base mesh + bundle into effects (`setBaseMesh(basePlane, bundle)`)
10. Initialize scene managers:
    - GridRenderer
    - TokenManager (registered as updatable)
    - TileManager
    - WallManager
    - DoorMeshManager
    - DrawingManager, NoteManager, TemplateManager, LightIconManager
    - InteractionManager
    - MapPointsManager
    - PhysicsRopeManager
11. Start RenderLoop: `new RenderLoop(renderer, scene, camera, effectComposer).start()`
12. Setup resize handling + FrameCoordinator
13. Initialize UI (Tweakpane + ControlPanel) and register effects
14. Wait for overhead tiles decode, wait for “three frames”, then fade overlay

**Scene tear down**: `onCanvasTearDown()` → `destroyThreeCanvas()`

Observed cleanup:

- stops RAF loop (`renderLoop.stop()`)
- disposes:
  - UI managers
  - controls integration
  - managers (token/tile/wall/etc.)
  - `effectComposer.dispose()` (disposes effects + render targets)
  - `sceneComposer.dispose()` (clears scene, disposes base plane material/geo)
- clears intervals (`fpsLogIntervalId`, `windVaneIntervalId`)
- removes WebGL context lost/restored listeners
- restores Foundry rendering

**Potential perf issues / suspects (drop over time)**

- **Hook accumulation risk**: `initialize()` registers multiple `Hooks.on(...)` with no explicit unregister.
  - Mitigation: `initialize()` is guarded by `isHooked`, so it *should not double-register* per reload.
  - Still, if this file is hot-reloaded / evaluated multiple times, verify `isHooked` really persists.

- **Intervals/timers**: `setInterval` exists (FPS logging, wind vane).
  - Cleanup exists in `destroyThreeCanvas()`.
  - Still: verify no other timers exist in effects/managers.

- **SceneComposer composites allocate `THREE.Texture(canvas)`** for masks/albedo.
  - These textures are *not obviously disposed* by `SceneComposer.dispose()` (it only disposes basePlaneMesh geometry/material).
  - If those composite textures remain referenced by bundle/effects or caches, **VRAM leak risk**.

- **Asset loader caching**: `assets/loader.js` has `assetCache` that persists across scene loads.
  - `clearCache()` exists but is not clearly called during teardown.
  - If users switch scenes a lot, cache growth could increase memory and degrade performance.

---

### 4) Per-frame pipeline

#### RenderLoop: `scripts/core/render-loop.js`

- runs `requestAnimationFrame`
- each frame calls `effectComposer.render(deltaTime)`

#### EffectComposer: `scripts/effects/EffectComposer.js`

Per frame:

1. `resolveRenderOrder()` — builds and sorts `_cachedRenderOrder` (reused array)
2. `timeManager.update()` — centralized time info
3. Iterates `updatables` set: `updatable.update(timeInfo)`
4. Splits effects into scene vs post
5. Scene effects:
   - `effect.update(timeInfo)`
   - `effect.render(renderer, scene, camera)`
6. Renders main scene once (to screen or `sceneRenderTarget`)
7. Post effects:
   - ping-pong render targets `post_1`/`post_2`
   - for each post effect:
     - `effect.update(timeInfo)`
     - `effect.setInputTexture(input.texture)` (if supported)
     - `effect.setBuffers(...)` (if supported)
     - `effect.render(...)`
8. Renders overlay layer to screen

**Potential perf issues / suspects (drop over time)**

- **Updatable set growth**: if managers/effects register themselves repeatedly without removing, this would compound CPU work.
  - Need to verify add/remove patterns and teardown.

- **RenderTargets**: `getRenderTarget(name, ...)` caches targets in a Map.
  - `dispose()` clears and disposes them (good).
  - Must ensure `dispose()` is called on teardown (it is).

- **Effect error handling**: `handleEffectError()` disables effects but sets `errorTime = Date.now()` (fine).

---

> This section is intentionally exhaustive and checkbox-driven. Some items are “mapped” at directory level but need deeper per-file inspection.

### `scripts/core/`

- [x] `bootstrap.js` – loads Three, detects GPU, creates renderer
- [x] `render-loop.js` – RAF loop
- [x] `time.js` – centralized TimeManager
- [x] `WeatherController.js` – singleton; has timers + CPU-side roof map extraction + DataTexture distance field
- [x] `frame-coordinator.js` – ticker integration; **potentially expensive perception updates** via `forcePerceptionUpdate()`
- [ ] `renderer-strategy.js` – check renderer settings that affect perf (pixel ratio, antialias, preserveDrawingBuffer)
- [ ] `shader-validator.js` – ensure it’s not running per-frame
- [ ] `errors.js` – ensure notifications don’t spam

### `scripts/foundry/`

- [x] `canvas-replacement.js` – lifecycle orchestrator
- [ ] `controls-integration.js` – input routing, layer visibility, edit tools

### `scripts/assets/`

- [x] `loader.js` – suffix-mask discovery + caching
- [x] **Audit cache lifetime**: determine when/if `clearCache()` should be called → **CONFIRMED: `clearCache()` is never called**

### `scripts/masks/`

- [x] `MaskManager.js` – texture registry + derived masks; owns derived render targets; dispose has gaps (see findings)

### `scripts/ui/`

- [ ] `tweakpane-manager.js` – very large; ensure UI updates aren’t per-frame heavy
- [ ] `control-panel-manager.js`
- [ ] `loading-overlay.js`
- [x] `texture-manager.js` – UI-only; uses DOM listeners (removed when container removed); no obvious timers

### `scripts/vision/`

- [x] `VisionManager.js` – verify update frequency, throttle → **Has good throttling (100ms)**
- [ ] `VisionPolygonComputer.js` – geometry cost, allocations

### `scripts/effects/` (GPU-heavy, audited)

- [x] `LightingEffect.js` – **8 render targets**, 8+ render passes/frame, publishes 5 textures to MaskManager
- [x] `CloudEffect.js` – **7 render targets**, has temporal skip (updateEveryNFrames=3), 0.5x resolution
- [x] `WorldSpaceFogEffect.js` – **highest render target refs (58)**, calls forcePerceptionUpdate frequently
- [x] `DistortionManager.js` – **16 render target refs**, manages heat/rain distortion passes
- [x] `WindowLightEffect.js` – 1 render target, complex rain-on-glass shader, possible allocation in resize
- [x] `PlayerLightEffect.js` – spring physics, particle systems, multiple noise evaluations
- [ ] `BloomEffect.js` – multiple mip levels, check resolution scaling
- [ ] `AtmosphericFogEffect.js` – check update frequency
- [ ] `BuildingShadowsEffect.js` – **cached** (world-space baking), low per-frame cost
- [ ] `OverheadShadowsEffect.js` – 0.5x resolution, check skip logic

### `scripts/particles/`

- [ ] `FireSparksEffect.js` – uses MultiPointEmitterShape aggregation (optimized)
- [ ] `ParticleSystem.js` – batch renderer, check per-frame particle count

---

## Confirmed Issues (Audit Findings)

> These issues have been **confirmed** through code inspection. They represent real leak vectors or performance risks.

### CRITICAL: Asset Cache Never Cleared

**File**: `scripts/assets/loader.js`

**Finding**: `clearCache()` function exists (lines 550-568) but is **never imported or called anywhere** in the codebase.

```javascript
// This function exists but is dead code:
export function clearCache() {
  for (const bundle of assetCache.values()) {
    bundle.baseTexture?.dispose();
    for (const mask of bundle.masks) {
      mask.texture?.dispose();
    }
  }
  assetCache.clear();
}
```

**Impact**: Every scene load adds textures to the cache. Switching scenes repeatedly will cause unbounded VRAM growth.

**Fix Priority**: HIGH

**Fix**: Call `clearCache()` in `destroyThreeCanvas()` or `onCanvasTearDown()`.

---

### CRITICAL: Hook Leaks in Managers

**Files**: Multiple managers register Foundry hooks but never unregister them.

| Manager | Hooks Registered | `Hooks.off()` in dispose? |
|---------|------------------|---------------------------|
| `TokenManager` | `canvasReady`, `createToken`, `updateToken`, `deleteToken`, `refreshToken` | **NO** |
| `VisionManager` | `updateToken`, `controlToken`, `createToken`, `deleteToken`, `refreshToken`, `createWall`, `updateWall`, `deleteWall` | **NO** |
| `TileManager` | `canvasReady`, `createTile`, `updateTile`, `deleteTile`, `refreshTile`, `updateScene` | **NO** |
| `WallManager` | `createWall`, `updateWall`, `deleteWall` | **NO** |
| `DoorMeshManager` | `createWall`, `updateWall`, `deleteWall` | **NO** |
| `DrawingManager` | `createDrawing`, `updateDrawing`, `deleteDrawing`, `canvasReady`, `activateDrawingsLayer`, `deactivateDrawingsLayer` | **NO** |
| `NoteManager` | `createNote`, `updateNote`, `deleteNote`, `canvasReady`, `activateNotesLayer`, `deactivateNotesLayer` | **NO** |
| `TemplateManager` | `createMeasuredTemplate`, `updateMeasuredTemplate`, `deleteMeasuredTemplate`, `canvasReady`, `activateTemplateLayer`, `deactivateTemplateLayer` | **NO** |
| `LightIconManager` | `createAmbientLight`, `updateAmbientLight`, `deleteAmbientLight`, `canvasReady` | **NO** |
| `LensflareEffect` | `createAmbientLight`, `updateAmbientLight`, `deleteAmbientLight` | YES |
| `SpecularEffect` | `createAmbientLight`, `updateAmbientLight`, `deleteAmbientLight` | YES |
| `CandleFlamesEffect` | multiple | YES |
| `PlayerLightEffect` | multiple | YES |
| `MapPointsManager` | multiple | YES |
| `SurfaceRegistry` | multiple | YES |

**Impact**: Hook handlers accumulate across scene reloads. Each reload adds duplicate handlers that fire on every hook event, compounding CPU work.

**Fix Priority**: HIGH

**Fix**: Store hook IDs during registration and call `Hooks.off(hookName, hookId)` in `dispose()`.

---

### HIGH: TileManager Alpha Mask Cache Can Grow Unbounded

**File**: `scripts/scene/tile-manager.js`

**Finding**:
- `TileManager` builds and caches CPU-side alpha masks in `alphaMaskCache`:
  - For overhead tile hover selection (pixel-opaque tests) it does `ctx.getImageData(...)` and caches `{width,height,data}`.
  - Cache key is derived from `texture.uuid || image.src || texture.id || tileDoc.id`.
- `dispose(clearCache=true)` clears `textureCache` and disposes textures, but **does not clear `alphaMaskCache`**.

**Impact**:
- Long sessions with many tile texture changes (or multiple scenes) can retain a large number of `Uint8ClampedArray` buffers.
- This is a **CPU memory growth** risk (not VRAM).

**Profiling Need**:
- Track `tileManager.alphaMaskCache.size` over time.
- Estimate total bytes retained: `sum(width*height*4)`.

**Fix Priority**: MEDIUM

**Fix**: Clear `alphaMaskCache` in `dispose()` (and optionally whenever a tile’s texture changes).

---

### HIGH: PhysicsRopeManager GPU Readback Risk (`readRenderTargetPixels`)

**File**: `scripts/scene/physics-rope-manager.js`

**Finding**:
- `PhysicsRopeManager` is registered as an `EffectComposer` updatable.
- It contains `_sampleWindowLightFromTarget(...)` which uses `renderer.readRenderTargetPixels(...)` against `WindowLightEffect.lightTarget`.
- The call is throttled to every 2 frames (global) but remains a **GPU→CPU readback**.

**Impact**:
- `readRenderTargetPixels` can force a pipeline stall and becomes a major hitch source on some GPUs/drivers.
- Because ropes are simulated every frame (Verlet + constraints + geometry updates), combined cost scales with rope count and segment count.

**Profiling Need**:
- Track total ropes, total segments.
- Count readbacks/sec and time spent inside `_sampleWindowLightFromTarget`.
- Identify whether this correlates with pan/zoom hitches.

**Fix Priority**: MEDIUM

**Fix (later)**:
- Replace readback with a GPU-side sampling path (e.g., screen-space texture sampling in shader, or a small position-map lookup texture updated on CPU at low frequency).

---

### HIGH: DoorMeshManager Hook Leak

**File**: `scripts/scene/DoorMeshManager.js`

**Finding**:
- Registers `Hooks.on('createWall'|'updateWall'|'deleteWall', ...)` but does not track or unregister those functions in `dispose()`.

**Impact**:
- On scene reloads, duplicate handlers accumulate, potentially recreating door meshes multiple times per wall update.

**Fix Priority**: HIGH

**Fix**: Track hook fns in an array and call `Hooks.off(...)` during `dispose()`.

---

### MEDIUM: InteractionManager Hot Path Costs (Hover Raycasts + HUD Projection)

**File**: `scripts/scene/interaction-manager.js`

**Finding**:
- `InteractionManager` is registered as an `EffectComposer` updatable.
- `update()` runs every frame when the Token HUD is open, and calls `updateHUDPosition()`.
- `updateHUDPosition()` currently does `sprite.position.clone()` per update, then `.project(camera)`.
- Hover handling (`handleHover`) does multiple potentially-expensive operations per pointer move:
  - Raycast against wall group when wall layer/GM.
  - Overhead tile picking involves:
    - ray-plane intersection
    - iterating all overhead tile sprites
    - CPU alpha test via `TileManager.isWorldPointOpaque()` (can be expensive for large images)

**Impact**:
- Not a “slow leak”, but can be a **frame-time spike** source during active interaction.
- Tile alpha test creates/uses cached `ImageData` buffers (see TileManager alphaMaskCache risk).

**Profiling Need**:
- Count raycasts/sec and average time spent in:
  - `handleHover()`
  - overhead tile alpha test loop
  - `updateHUDPosition()`

---

### MEDIUM: ParticleSystem (three.quarks) Per-Frame Cost + Culling

**File**: `scripts/particles/ParticleSystem.js`

**Finding**:
- `ParticleSystem` is an `EffectBase` but does most work in `update()`:
  - Calls `weatherController.update(timeInfo)` (note: WeatherController is also registered separately as an updatable)
  - Updates `WeatherParticles`
  - Calls `batchRenderer.update(dt)`
- Implements frustum culling by iterating `batchRenderer.systemToBatchIndex` and toggling emitters.

**Impact**:
- Potential **double-stepping** risk: WeatherController may be updated twice per frame (once as an updatable, once from ParticleSystem).
- Quarks simulation cost scales with active particle count and system count.
- Culling loop cost scales with number of particle systems.

**Profiling Need**:
- Count:
  - total active particle systems
  - total alive particles (if accessible)
  - number of culled systems
- Time:
  - `WeatherParticles.update()`
  - `batchRenderer.update()`

---

### MEDIUM: SmellyFliesEffect Rejection Sampling + State Machine

**File**: `scripts/particles/SmellyFliesEffect.js`

**Finding**:
- `AreaSpawnShape.initialize()` uses rejection sampling (up to 20 attempts) to find a point inside a polygon.
- `FlyBehavior` stores per-particle `userData` objects (velocity/home/etc.) and runs a state machine.

**Impact**:
- Worst-case CPU spikes when many particles spawn at once (20 attempts * spawn rate).
- More sensitive to `delta` spikes; although Quarks delta is clamped in `ParticleSystem`, it still can produce bursty spawn patterns.

**Profiling Need**:
- Track spawn attempts distribution (avg/max)
- Track per-frame behavior update time

---

### LOW: DustMotesEffect Mask-Driven Spawn + MaxParticles

**File**: `scripts/particles/DustMotesEffect.js`

**Finding**:
- Spawns from precomputed points list (mask sampling) and uses per-particle fade behavior.
- Default `maxParticles: 3000`.

**Profiling Need**:
- Track actual live particle count and GPU fill impact (sprites overdraw)

---

### MEDIUM: TweakpaneManager UI Loop + Debounced Saves

**File**: `scripts/ui/tweakpane-manager.js`

**Finding**:
- Runs a dedicated UI RAF loop at `uiFrameRate = 15` Hz.
- Loop is gated by `visible`; when hidden it still schedules RAF but does minimal work.
- Uses debounced `saveUIState()` (500ms) and batched `flushSaveQueue()`.

**Impact**:
- Not expected to cause frame drops when hidden.
- When visible, can still be a periodic CPU cost (15Hz) and can generate background async work (settings writes).

**Profiling Need**:
- Track:
  - UI loop time per tick (`perf.lastFrameTime` already exists)
  - `saveQueue` depth over time
  - number of `game.settings.set` calls/min while actively tweaking

---

### HIGH: BloomEffect GPU Cost (UnrealBloomPass + Dedicated Float RenderTarget)

**File**: `scripts/effects/BloomEffect.js`

**Finding**:
- Wraps Three’s `UnrealBloomPass` (multi-pass, multi-mip chain).
- Creates additional full-resolution fullscreen quads:
  - `copyScene`/`copyMaterial`/`copyQuad` for passthrough safety.
  - `bloomCompositeScene`/`bloomCompositeMaterial`/`bloomCompositeQuad` for overlay.
- Allocates a dedicated output `this._bloomTarget = new THREE.WebGLRenderTarget(width,height,{ type: THREE.FloatType, depthBuffer:false })`.
- In `render()`:
  - Computes / updates multiple mapping uniforms (scene rect + view bounds) and syncs vision texture via `FoundryFogBridge` if the fog effect RT isn’t available.
  - Calls `this.pass.render(renderer, this._bloomTarget, this.readBuffer, ...)` then composites base + bloom.

**Impact**:
- Bloom is typically one of the largest **fill-rate and bandwidth** multipliers in the post stack.
- `FloatType` render target increases bandwidth and can be disproportionately expensive on some GPUs.

**Profiling Need**:
- GPU timer around:
  - `this.pass.render(...)`
  - the final composite (base + bloom overlay)
- Track `this._bloomTarget` size and format (width/height/type).
- Track how often `FoundryFogBridge.sync()` is called and its CPU cost.

---

### MEDIUM: AtmosphericFogEffect (Single Fullscreen Pass + Per-Frame Allocation)

**File**: `scripts/effects/AtmosphericFogEffect.js`

**Finding**:
- Single fullscreen quad pass (no extra render targets owned by the effect).
- Uses `weatherController.currentState.fogDensity` and `weatherController.roofDistanceMap` (distance field) to reduce fog “indoors”.
- Updates both view bounds and scene bounds every `update()`.
- `_updateSceneBounds()` does `const size = new window.THREE.Vector2(); this.renderer.getDrawingBufferSize(size);` which is a **per-frame allocation**.

**Impact**:
- GPU cost is dominated by fullscreen fragment shader work (noise/fbm + distance field sample).
- Per-frame allocation adds avoidable GC pressure (small, but persistent).

**Profiling Need**:
- Time `AtmosphericFogEffect.update()` vs `render()` separately.
- GPU time of the fullscreen pass.
- Track how often `roofDistanceMap` exists and its effective resolution.

---

### HIGH: LensflareEffect Per-Light Framebuffer Copies

**File**: `scripts/effects/LensflareEffect.js`

**Finding**:
- Each lensflare is a `THREE.Mesh` with a custom `onBeforeRender` that:
  - Calls `renderer.copyFramebufferToTexture(...)` to a 16x16 `FramebufferTexture` (tempMap).
  - Renders a pink quad, then copies again into an occlusion map (another `FramebufferTexture`).
  - Restores the saved pixels.
  - Renders multiple flare elements via `renderer.renderBufferDirect(...)`.
- This happens **per flare, per frame**, when the flare is on-screen.
- `LensflareEffect.update()` allocates a new `THREE.Color` each frame for the global tint.

**Impact**:
- Scales directly with number of AmbientLights.
- `copyFramebufferToTexture` can be surprisingly expensive and may introduce pipeline stalls.

**Profiling Need**:
- Count active flares and average `onBeforeRender` cost per flare.
- Track CPU time in `LensflareEffect.update()` and total number of lights processed.
- Consider a debug toggle to disable occlusion sampling for profiling (measure flare draw without framebuffer copies).

---

### MEDIUM: LightningEffect (Bounded CPU Work + Strike Geometry Updates)

**File**: `scripts/effects/LightningEffect.js`

**Finding**:
- Maintains a pool of `this._maxActiveStrikes` strike meshes (default 24), each with preallocated `BufferGeometry` arrays.
- Per frame (`update()`):
  - Advances strike schedules per lightning source (map points groups of effect `lightning`).
  - Updates strike materials/uniforms and toggles visibility.
  - Updates an “outside flash” value (`window.MapShine.environment.lightningFlash`) for downstream effects.

**Impact**:
- CPU work is bounded by:
  - number of sources (map points groups)
  - number of active strikes (pool size)
  - segments/point count per strike
- No render targets; GPU cost is mostly additive overdraw (depends on scene).

**Profiling Need**:
- Count sources, active strikes, branches spawned.
- Time:
  - strike spawn path (`_spawnStrike` + `_fillStrikeGeometry`)
  - per-frame strike update loop

---

### HIGH: CandleFlamesEffect (Instanced Flames + Glow Bucketing + Wall Clip Rebuilds)

**File**: `scripts/effects/CandleFlamesEffect.js`

**Finding**:
- Instanced flames:
  - Allocates `Float32Array` attributes sized to `maxFlames` (default 5000) and uses an `InstancedMesh`.
  - `_rebuildFromMapPoints()` is event-driven (map point changes), but can be heavy:
    - iterates all candle points
    - calls `weatherController.getRoofMaskIntensity(u,v)` per point
    - updates instance matrices + attribute arrays
- Glow bucketing:
  - Clusters candles into buckets (`glowBucketSizePx`, `glowMaxBuckets`).
  - `_rebuildGlowMeshes()` can call `VisionPolygonComputer.compute(...)` per cluster when wall clipping is enabled.
  - Wall hooks (`createWall/updateWall/deleteWall`) set `_needsGlowRebuild`; `update()` rebuilds at most every ~0.12s.
- Per frame (`update()`):
  - Uniform updates + `_updateGlowFlicker()` loops over glow buckets (up to `glowMaxBuckets`).

**Impact**:
- One of the highest-risk systems for **burst CPU spikes** during:
  - map point edits
  - wall editing
- Sustained per-frame cost scales with glow bucket count.

**Profiling Need**:
- Counters:
  - candle points total
  - instanced flame count
  - glow bucket count
  - glow rebuilds/sec
- Timers:
  - `_rebuildFromMapPoints()`
  - `_rebuildGlowMeshes()` (and time inside `VisionPolygonComputer.compute`)
  - `_updateGlowFlicker()`

---

### LOW/MEDIUM: ControlPanelManager Status Interval (4 Hz) + Flag Writes

**File**: `scripts/ui/control-panel-manager.js`

**Finding**:
- When visible, starts a `setInterval(..., 250)` to update the status panel.
- Uses debounced saves to scene flags (`scene.setFlag('map-shine-advanced','controlState', ...)`).
- `destroy()` clears interval and removes document listeners.

**Impact**:
- Not per-frame, but adds periodic CPU + DOM update cost.
- Worst-case risk is bursty DB writes if debounce is bypassed or state changes rapidly.

**Profiling Need**:
- Time `_updateStatusPanel()` and count calls/sec while visible.
- Count `scene.setFlag` calls/min.

---

### LOW: LoadingOverlay RAF Progress Loop

**File**: `scripts/ui/loading-overlay.js`

**Finding**:
- Uses a small RAF loop to smooth progress bar updates (`_progressTick`).
- Properly stops RAF when target is reached (`_stopProgressLoop`) and resets state on `hide()`.

**Profiling Need**:
- Generally none. If investigating UI jank during loading, track RAF tick time and DOM style writes.

---

### LOW/MEDIUM: EffectStackUI Refresh Debounce + Settings Writes

**File**: `scripts/ui/effect-stack.js`

**Finding**:
- UI is interactive and can rebuild a lot of DOM.
- Uses `_scheduleRefresh()` with a `setTimeout(..., 120)` debounce.
- Persists state via `game.settings.set('map-shine-advanced','effect-stack-state', ...)`.
- When toggling effects, writes scene flags (GM) or player overrides (non-GM).

**Impact**:
- Not per-frame, but can become a noticeable stutter if refresh is triggered repeatedly during intense interaction.
- Settings/flag writes can be slow on some worlds.

**Profiling Need**:
- Time `EffectStackUI.refresh()` and count calls/min.
- Count `game.settings.set` calls/min and `scene.setFlag` calls/min from the panel.

---

## Module Coverage Assessment

> Goal: determine when we’ve covered the “vast majority” of likely offenders and have tooling plans to identify the rest.

### Covered (mapped + audited for perf risk)

- [x] Entrypoint/lifecycle: `scripts/module.js`, `scripts/foundry/canvas-replacement.js`
- [x] Render loop + orchestration: `scripts/core/render-loop.js`, `scripts/effects/EffectComposer.js`
- [x] Core timing: `scripts/core/time.js`
- [x] Renderer baseline strategy: `scripts/core/renderer-strategy.js`
- [x] Mask system + derived RTs: `scripts/masks/MaskManager.js`
- [x] Long-run VRAM risk: `scripts/assets/loader.js` cache lifetime
- [x] High-cost effects (RT-heavy): `LightingEffect`, `CloudEffect`, `WorldSpaceFogEffect`, `DistortionManager`, `WindowLightEffect`, `PlayerLightEffect`
- [x] Perception spam path: `FrameCoordinator.forcePerceptionUpdate()` + callsites
- [x] Scene managers / updatables (hot paths + leak risks):
  - `TokenManager` (hook leak)
  - `TileManager` (hook leak + alphaMaskCache growth)
  - `WallManager` (hook leak + perception updates)
  - `DoorMeshManager` (hook leak)
  - `InteractionManager` (raycast + HUD projection hot paths)
  - `MapPointsManager` (proper hook cleanup)
  - `PhysicsRopeManager` (GPU readback risk)
- [x] UI loop: `TweakpaneManager` (15Hz RAF + debounced saves)
- [x] Particles baseline: `ParticleSystem` (Quarks + culling) and representative effects (Fire/Flies/Dust)
- [x] Remaining post/overlay effects (optional follow-up): `BloomEffect`, `AtmosphericFogEffect`, `LensflareEffect`
- [x] Remaining map-point effects (optional follow-up): `LightningEffect`, `CandleFlamesEffect`
- [x] Remaining UI subsystems (optional follow-up): `ControlPanelManager`, `LoadingOverlay`, `EffectStackUI`

### Remaining (not fully audited, but lower confidence)

- [ ] Remaining scene helpers:
  - `GridRenderer`, `DrawingManager`, `NoteManager`, `TemplateManager`, `LightIconManager` (likely low per-frame but **hook cleanup still needed**)

### “Done” threshold recommendation

We will be “done” (vast majority covered) once:

- [ ] The **profiling tools** are implemented (Profiler + memory sampler + leak detector + console commands)
- [ ] Hook/timer leak fixes are queued (even if not implemented yet) for all managers that register hooks
- [ ] We can run one profiling session and produce a ranked offender list

At that point, any remaining un-audited effects can be treated as “measure-first” rather than “inspect-first”.

### MEDIUM: EffectComposer.dispose() Doesn't Clear Updatables

**File**: `scripts/effects/EffectComposer.js` (lines 516-530)

**Finding**: `dispose()` clears `this.effects` and `this.renderTargets` but does NOT clear `this.updatables`.

```javascript
dispose() {
  for (const effect of this.effects.values()) {
    effect.dispose();
  }
  this.effects.clear();

  for (const target of this.renderTargets.values()) {
    target.dispose();
  }
  this.renderTargets.clear();
  // NOTE: this.updatables is NOT cleared!
}
```

**Mitigation**: Currently safe because `destroyThreeCanvas()` sets `effectComposer = null`, so the whole object is GC'd. However, if the composer were ever reused, updatables would accumulate.

**Fix Priority**: LOW (defensive)

**Fix**: Add `this.updatables.clear()` to `dispose()`.

---

### MEDIUM: Per-Frame Allocations in Effects

**Finding**: Some effects allocate `new THREE.Vector2()` inside `update()` or `render()` methods, causing GC pressure.

**Confirmed allocations in hot paths**:

| File | Location | Allocation |
|------|----------|------------|
| `WindowLightEffect.js` | line ~2847 in resize path | `const size = new THREE.Vector2()` |
| `CloudEffect.js` | line ~1848 in update | `if (!this._tempVec2A) this._tempVec2A = new THREE.Vector2()` |
| `CloudEffect.js` | line ~2094 in update | `if (!this._shadeSunDir) this._shadeSunDir = new THREE.Vector2()` |
| `CloudEffect.js` | line ~2153 in render | `if (!this._tempSize) this._tempSize = new THREE.Vector2()` |
| `LightingEffect.js` | line ~1106 in render | `if (!this._tempSize) this._tempSize = new THREE.Vector2()` |

**Pattern**: Most of these use lazy initialization (`if (!this._temp) this._temp = new...`) which is acceptable—allocation happens once. However, `WindowLightEffect.js` line ~2847 creates a new Vector2 unconditionally in a path that may be called per-frame during resize.

**Fix Priority**: LOW (most are lazy-init, which is fine)

**Fix**: Audit any unconditional `new` statements inside `update()`/`render()` methods.

---

### LOW: SceneComposer Composite Texture Disposal

**File**: `scripts/scene/composer.js`

**Finding**: `SceneComposer.dispose()` (lines 1216-1232) only disposes the basePlaneMesh geometry/material and clears the scene. It does NOT explicitly dispose composite textures created via `new THREE.Texture(canvas)` for multi-tile scenes.

```javascript
dispose() {
  if (this.basePlaneMesh) {
    this.basePlaneMesh.geometry.dispose();
    this.basePlaneMesh.material.dispose();
    this.basePlaneMesh = null;
  }
  if (this.scene) {
    this.scene.clear();
    this.scene = null;
  }
  // NOTE: No explicit disposal of this.currentBundle textures
}
```

**Mitigation**: The basePlaneMesh material likely holds the main albedo texture, so `material.dispose()` may free it. The mask textures in `bundle.masks` may be orphaned.

**Fix Priority**: MEDIUM

**Fix**: Either dispose bundle textures explicitly, or ensure `clearCache()` is called (which would dispose them).

---

### LOW: VisionManager Has Good Throttling

**File**: `scripts/vision/VisionManager.js`

**Positive Finding**: VisionManager already implements throttling correctly:
- `_updateThrottleMs = 100` (10 updates/sec max)
- `_pendingThrottledUpdate` flag for `refreshToken` events
- Reusable objects (`_tempCenter`, pooled data structures)

No action needed.

---

### HIGH: MaskManager Derived RenderTargets + Quad Resource Leak

**File**: `scripts/masks/MaskManager.js`

**Finding**: Derived mask evaluation allocates and caches **3 WebGLRenderTargets per derived mask id**:
- `a` (output)
- `b` (ping-pong)
- `boost` (prepass for blur workflows)

This is correct architecturally, and `dispose()` does dispose these render targets.

**However**: `_ensureQuad()` allocates a `PlaneGeometry` and a `MeshBasicMaterial` and they are **never disposed**.

```javascript
// MaskManager._ensureQuad()
this._quadMesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), new THREE.MeshBasicMaterial());
```

`dispose()` sets `this._quadMesh = null` but does not call `geometry.dispose()` / `material.dispose()`.

**Impact**: Small but real GPU memory leak per MaskManager lifecycle. Since MaskManager is recreated per scene, this accumulates across scene switches.

**Fix Priority**: HIGH

**Fix**: In `MaskManager.dispose()`, dispose quad mesh geometry/material (and optionally any MeshBasicMaterial created in `_ensureQuad()`).

 ---

 ### MEDIUM: Derived Mask Churn (Currently Low, But One Hot Path Exists)

 **Files**:
 - `scripts/foundry/canvas-replacement.js`
 - `scripts/masks/MaskManager.js`
 - `scripts/particles/FireSparksEffect.js`

 **Finding**:
 - Derived masks are defined for:
   - `roofVisible.screen` (threshold of `roofAlpha.screen`)
   - `roofClear.screen` (invert of `roofVisible.screen`)
   - `precipVisibility.screen` (max of `outdoors.screen` + `roofClear.screen`)
 - A search found **no runtime consumers** of these three derived IDs (only definitions and UI label maps).
   - Meaning: they currently do **not** appear to be recomputed per frame.

 **One confirmed derived-mask generator path**:
 - `FireSparksEffect._registerHeatDistortion()` calls `MaskManager.getOrCreateBlurredMask('fire.heatExpanded.scene', 'fire.scene', ...)`.
 - This is cached by a key derived from input texture UUID + blur/tuning params. If those params are edited frequently, the blurred mask may be regenerated.

 **Profiling Need**:
 - Add a counter inside `MaskManager._evaluateDerived()` / `getOrCreateBlurredMask()` to record:
   - calls/frame
   - actual recomputes (cache misses)
   - render target sizes

---

### HIGH: Perception Update Spam via FrameCoordinator

**Files**:
- `scripts/core/frame-coordinator.js`
- `scripts/effects/WorldSpaceFogEffect.js`
- `scripts/scene/wall-manager.js`

**Finding**: `FrameCoordinator.forcePerceptionUpdate()` calls `canvas.perception.update({ refreshVision:true, refreshLighting:true })`.
This is a known expensive operation in Foundry.

**Call sites discovered**:
- `WorldSpaceFogEffect._registerHooks()` calls it on:
  - `controlToken`
  - initial render
- `WorldSpaceFogEffect._detectCameraMovement()` calls it whenever the camera moves more than:
  - `dx/dy > 50px` or `zoom delta > 0.1`
  - During pan/zoom, this can trigger **many times per second**, repeatedly forcing perception recomputation.
- `WorldSpaceFogEffect` also retries perception updates when LOS polygons are missing (multiple call sites around vision-mask retries).
- `WallManager` schedules a `setTimeout(... forcePerceptionUpdate ..., 0)` when wall changes.

**Impact**: Likely a major contributor to pan/zoom hitching and FPS drops, especially with complex walls/lighting.

**Fix Priority**: HIGH

**Fix**: Add throttling/debouncing inside `FrameCoordinator.forcePerceptionUpdate()` (or at call sites) and record how many times per second it triggers.

---

### MEDIUM: WeatherController Singleton Lifecycle + Pending Timeouts

**File**: `scripts/core/WeatherController.js`

**Finding**: `weatherController` is a global singleton (`export const weatherController = new WeatherController();`) with **no `dispose()`**.

It schedules multiple debounced state writes via `setTimeout` fields (examples):
- `_weatherSnapshotSaveTimeout`
- `_dynamicStateSaveTimeout`
- `_queuedTransitionSaveTimeout`

It also holds onto:
- `roofMaskData` (Uint8Array)
- `roofDistanceMap` (THREE.DataTexture)

The roof distance map is explicitly disposed when rebuilt (`_disposeRoofDistanceMap()`), which is good.

**Risk**:
- Pending timeouts can fire after scene teardown (most code guards with `canvas?.scene`, but still creates extra tasks).
- Singleton state can drift across scene switches if not explicitly refreshed by scene init.

**Fix Priority**: MEDIUM

**Fix**: Add a `dispose()` (or `onSceneTearDown()`) to clear pending timeouts and release cached arrays/textures when appropriate.

---

### MEDIUM: WeatherParticles Uses MaskManager-published Screen-Space Roof Alpha

**File**: `scripts/particles/WeatherParticles.js`

**Finding**:
- Uses `MaskManager` record `weatherRoofAlpha.screen` (published by `LightingEffect`) as a screen-space roof visibility map.
- Falls back to `lightingEffect.weatherRoofAlphaTarget.texture` if the registry entry is missing.
- Uses `weatherController.roofMap` (world-space `_Outdoors`) and may call `weatherController.setRoofMap()` as a fallback.

**Positive**:
- Most expensive CPU scanning (water edge points) is gated by texture UUID changes (not per-frame).
- Per-frame tuning updates are mostly mutation-based (avoids allocating new objects repeatedly).

**Profiling Need**:
- Count how often roof/alpha uniforms are rebound and whether derived visibility masks are recomputed.
- Track particle system emission scaling vs. GPU fill/overdraw.

 ---

 ### MEDIUM: Renderer Strategy Defaults (AA + Pixel Ratio) Can Dominate Fill Rate

 **File**: `scripts/core/renderer-strategy.js`

 **Finding**:
 - WebGL2 renderer is created with `antialias: true` and `powerPreference: 'high-performance'`.
 - Renderer is configured with `renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))`.
 - Output color space is set to `THREE.SRGBColorSpace` and tone mapping is disabled via `THREE.NoToneMapping`.

 **Impact**:
 - On high-DPI displays, `pixelRatio` capped at 2 can still be very expensive (4x pixels vs 1x), especially with a heavy post stack.
 - `antialias: true` on WebGL2 increases GPU cost and can interact poorly with full-screen post effects (since post will blur/resolve anyway).

 **Notes**:
 - This is not a “leak over time” risk, but it is a **baseline GPU cost multiplier** that can make all effects look like offenders.
 - For profiling sessions, we should be able to force:
   - pixel ratio = 1
   - AA off
   - (optional) lower internal render targets for post

 **Profiling Tooling Hook**:
 - Add a profiler/config panel toggle to temporarily override pixel ratio and AA (without changing the scene configuration).

 ---

 ### MEDIUM: ControlsIntegration Hook Density + Deferred setTimeout Work

 **File**: `scripts/foundry/controls-integration.js`

 **Finding**:
 - Registers many hooks and schedules multiple `setTimeout(..., 0)` / `setTimeout(..., 50)` callbacks:
   - `activateCanvasLayer`, `renderSceneControls`, `canvasPan`, `collapseSidebar`, `refreshToken`, `controlToken`, `refreshWall`, `createWall`, `createToken`, `renderApplication`, `closeApplication`.
 - Most hooks are properly tracked in `_hookIds` and unregistered via `unregisterHooks()`.
 - It also wraps `canvas.environment.initialize` (`_wrapEnvironmentInitialize()`), and **does unwrap it** in `destroy()`.

 **Risk**:
 - The repeated `setTimeout` usage can cause bursty microtasks during active play (token refreshes, tool changes, wall edits).
 - `configurePixiOverlay()` registers `Hooks.on('sightRefresh', ...)` directly (not tracked in `_hookIds`). If `configurePixiOverlay()` can run multiple times, this is a potential hook duplication risk.

 **Profiling Need**:
 - Count hook callbacks/sec during normal play and during wall editing.
 - Count queued timeouts/sec (instrument via a tiny wrapper in debug/profiling builds).

 ---

 ### LOW: UnifiedCameraController Has Per-Frame Drift Detection (Confirm Whether It’s Active)

 **File**: `scripts/foundry/unified-camera.js`

 **Finding**:
 - Implements an `update()` method that polls `canvas.stage` each frame to detect drift and triggers `syncFromPixi('frame-detect')`.
 - Input handlers are correctly attached/detached on the Three canvas, and hooks are tracked/untracked via `_hookIds`.
 - The codebase also has `CameraFollower` which is explicitly described as the intended per-frame sync mechanism.

 **Impact**:
 - If `UnifiedCameraController.update()` is being called anywhere, it adds per-frame polling overhead.
 - If it is unused, it can be ignored for profiling priority.

 **Profiling Need**:
 - Confirm whether `UnifiedCameraController` is instantiated and its `update()` is registered as an updatable.
 - Ensure only one camera sync mechanism is active (`CameraFollower` vs UnifiedCameraController vs any legacy CameraSync).

---

## Effect-Specific Audit Findings (GPU/Fill-Rate Heavy)

> The following effects have been identified as the **highest GPU cost** based on render target count and per-frame work.

### HIGH COST: LightingEffect (7+ render targets, multipass)

**File**: `scripts/effects/LightingEffect.js`

**Render Targets** (all screen-resolution):
| Target | Type | Purpose |
|--------|------|---------|
| `lightTarget` | HalfFloatType | HDR light accumulation |
| `darknessTarget` | UnsignedByteType | Darkness sources |
| `roofAlphaTarget` | UnsignedByteType | Roof layer 20 occlusion |
| `weatherRoofAlphaTarget` | UnsignedByteType | Weather roof layer 21 |
| `ropeMaskTarget` | UnsignedByteType | Rope mask layer 25 |
| `tokenMaskTarget` | UnsignedByteType | Token mask layer 26 |
| `masksTarget` | UnsignedByteType | Packed masks |
| `outdoorsTarget` | UnsignedByteType | Outdoors projection |

**Per-Frame Work**:
- `update()`: ~100 lines of uniform updates, cross-effect queries (BuildingShadows, Bush, Tree, Overhead)
- `render()`: **8+ separate render passes** (roof, weather roof, rope mask, token mask, outdoors, lights, darkness, composite)
- Publishes 5 textures to MaskManager with `lifecycle: 'dynamicPerFrame'`

**Profiling Hooks Needed**:
- Time each render pass separately
- Count `renderer.render()` calls per frame
- Track render target resize frequency

---

### HIGH COST: CloudEffect (5+ render targets, temporal skip)

**File**: `scripts/effects/CloudEffect.js`

**Render Targets** (internal resolution, typically 0.5x screen):
| Target | Purpose |
|--------|---------|
| `cloudDensityTarget` | Raw cloud coverage |
| `cloudShadowTarget` | Processed shadow factor |
| `cloudShadowRawTarget` | Unprocessed shadow |
| `cloudShadowDensityTarget` | Shadow density |
| `cloudTopTarget` | Cloud top overlay |
| `cloudShadowBlockerTarget` | Tile feature blockers |
| `cloudTopBlockerTarget` | Tile feature blockers |

**Per-Frame Work**:
- `update()`: ~340 lines, multi-layer wind offset calculations, view bounds computation
- `render()`: Conditional temporal skipping via `updateEveryNFrames` (default 3)
- Heavy parameter hash computation to detect changes and force updates
- Publishes multiple textures to MaskManager

**Performance Features Already Present**:
- `internalResolutionScale: 0.5` (renders at half resolution)
- `updateEveryNFrames: 3` (skips 2 out of 3 frames when stable)
- Motion-aware: forces full update when camera moves

**Profiling Hooks Needed**:
- Track actual skip rate vs requested skip rate
- Measure density pass vs shadow pass vs top pass separately

---

### HIGH COST: WorldSpaceFogEffect (58 render target references)

**File**: `scripts/effects/WorldSpaceFogEffect.js`

**Finding**: Has the highest render target reference count in the codebase (58 matches).

**Key Concerns**:
- Calls `frameCoordinator.forcePerceptionUpdate()` frequently (already documented)
- Vision mask rendering can be expensive
- Exploration texture management

**Profiling Hooks Needed**:
- Count perception update calls/sec
- Time vision mask render passes
- Track exploration texture updates

---

### MEDIUM COST: DistortionManager (16 render target references)

**File**: `scripts/effects/DistortionManager.js`

**Finding**: Manages multiple distortion sources (heat, rain, etc.) with separate render passes.

**Profiling Hooks Needed**:
- Count active distortion sources
- Time each distortion pass

---

### MEDIUM COST: WindowLightEffect (7 render target references)

**File**: `scripts/effects/WindowLightEffect.js`

**Render Targets**:
- `lightTarget`: Window light brightness for TileManager consumption
- Rain flow map generation (CPU-heavy when config changes)

**Per-Frame Work**:
- Complex shader with rain-on-glass simulation
- RGB shift calculations
- Cloud shadow integration

**Known Issues**:
- Line ~2847: Possible unconditional `new THREE.Vector2()` in resize path

---

### MEDIUM COST: PlayerLightEffect

**File**: `scripts/effects/PlayerLightEffect.js`

**Per-Frame Work**:
- Spring physics simulation for torch/flashlight position
- Particle system updates (torch flames, sparks)
- Multiple noise evaluations for flicker/wobble
- Cookie texture rotation

**Profiling Hooks Needed**:
- Time particle update vs render
- Track particle count

---

## Effect Render Target Summary

| Effect | Targets | Type | Resolution | Skip Logic |
|--------|---------|------|------------|------------|
| LightingEffect | 8 | Various | Full | None |
| CloudEffect | 7 | UnsignedByte | 0.5x | Every N frames |
| WorldSpaceFogEffect | 3+ | Various | Full | None |
| DistortionManager | 3+ | Various | Full | None |
| WindowLightEffect | 1 | UnsignedByte | Full | None |
| BloomEffect | 3+ | Various | Multiple | None |
| BuildingShadowsEffect | 1 | UnsignedByte | Full | Cached |
| OverheadShadowsEffect | 1 | UnsignedByte | 0.5x | None |

**Total per-frame render target cost**: ~25+ render passes at various resolutions.

---

## Suspected long-run degradation sources (updated hypotheses)

> These are *suspects* based on current mapping; they require measurement.

- [x] **Asset cache growth**: `assets/loader.js` caches bundles forever unless `clearCache()` is called.
  - **CONFIRMED**: `clearCache()` is never called. See Confirmed Issues above.

- [x] **Composite mask/albedo textures**: `SceneComposer` can create `new THREE.Texture(canvas)` for masks/albedo.
  - **CONFIRMED**: Not explicitly disposed. See Confirmed Issues above.

- [x] **Updatable accumulation**: if updatables are added repeatedly across scene rebuilds without being removed.
  - **MITIGATED**: EffectComposer is recreated each scene, so updatables don't accumulate across scenes. But `dispose()` should still clear them defensively.

- [ ] **GPU overdraw / fill-rate**: post-processing stack can be heavy; combined with FloatType buffers.
  - Identify worst offenders by toggling effects and measuring (needs tooling).

- [x] **Hidden allocations inside effects**: any `new Vector2/Vector3/Color/Array` per-frame will cause GC spikes.
  - **MOSTLY GOOD**: Most effects use lazy initialization pattern. A few unconditional allocations found but not in critical hot paths.

---

## Proposed Performance Tooling (Detailed Design)

> This section provides **implementation-ready specifications** for a robust performance evaluation system.

---

### A) Core Profiler (`scripts/core/profiler.js`)

#### Data Structures

```javascript
// FrameSample: One frame's worth of timing data
{
  frameNumber: number,
  timestamp: number,           // performance.now() at frame start
  totalFrameMs: number,
  
  // CPU breakdown
  timeManagerMs: number,
  updatablesMs: number,
  updatableBreakdown: Map<string, number>,  // id → ms
  sceneEffectsMs: number,
  sceneEffectBreakdown: Map<string, number>,
  mainSceneRenderMs: number,
  postEffectsMs: number,
  postEffectBreakdown: Map<string, number>,
  
  // GPU (optional)
  gpuMs: number | null,
  
  // Memory snapshot (sampled periodically)
  memorySnapshot: MemorySnapshot | null
}

// MemorySnapshot
{
  timestamp: number,
  renderCalls: number,
  textures: number,
  geometries: number,
  programs: number,
  assetCacheSize: number
}
```

#### Profiler Class API

```javascript
class Profiler {
  frameBuffer: RingBuffer<FrameSample>;  // ~300 frames
  memoryBuffer: RingBuffer<MemorySnapshot>; // ~60 samples
  enabled: boolean;
  
  // Lifecycle
  enable(), disable(), reset()
  
  // Frame timing (called by EffectComposer)
  beginFrame(), mark(label), endMark(label), endFrame()
  
  // Memory sampling
  sampleMemory(renderer, effectComposer)
  
  // Analysis
  getFrameSummary(windowMs?): FrameSummary
  getTopOffenders({ limit }): OffenderReport
  getMemoryTrend(): MemoryTrend
  
  // Export
  exportJson(), exportCsv()
}
```

#### Checkboxes

- [ ] Implement `RingBuffer` class
- [ ] Implement `Profiler` class with frame timing
- [ ] Add instrumentation to `EffectComposer.render()`
- [ ] Add periodic memory sampling (2-second interval)
- [ ] Expose on `window.MapShine.profiler`

---

### B) GPU Timing (`EXT_disjoint_timer_query_webgl2`)

- Wrap WebGL timer queries for key render calls
- Handle extension unavailability gracefully
- Record GPU ms alongside CPU ms

#### Checkboxes

- [ ] Implement `GpuTimerQuery` wrapper
- [ ] Detect extension at bootstrap
- [ ] Add timing around main scene + post effects

---

### C) Memory/Resource Tracker

```javascript
function sampleMemory(renderer, effectComposer, assetLoader) {
  return {
    renderCalls: renderer.info.render.calls,
    textures: renderer.info.memory.textures,
    geometries: renderer.info.memory.geometries,
    programs: renderer.info.programs?.length ?? 0,
    assetCacheSize: assetLoader?.getCacheStats?.()?.count ?? 0,
    derivedMasksCount: window.MapShine?.maskManager?._derived?.size ?? 0
  };
}
```

#### Checkboxes

- [ ] Add `getCacheStats()` to `assets/loader.js`
- [ ] Implement periodic sampling
- [ ] Implement `detectLeaks()` analysis

---

### D) Loading Time Profiler

Uses `performance.mark/measure` for DevTools integration.

#### Instrumentation Points

- `createThreeCanvas:start` / `done`
- `sceneComposer:start` / `done`  
- `effect:{id}:start` / `done` per effect

#### Checkboxes

- [ ] Implement `LoadingProfiler` class
- [ ] Add marks in `canvas-replacement.js`
- [ ] Print report after scene ready

---

### E) Console Commands (`MapShine.perf`)

```javascript
window.MapShine.perf = {
  start: () => profiler.enable(),
  stop: () => profiler.disable(),
  summary: (windowMs) => profiler.getFrameSummary(windowMs),
  top: (limit) => profiler.getTopOffenders({ limit }),
  memory: () => profiler.getMemoryTrend(),
  leaks: () => detectLeaks(samples),
  hud: (show) => togglePerformanceHUD(show),
  disableEffect: (id) => /* ... */,
  enableEffect: (id) => /* ... */
};
```

#### Checkboxes

- [ ] Add `MapShine.perf` namespace
- [ ] Implement `PerformanceHUD` overlay
- [ ] Document commands

---

### F) Instrumentation Checklist by File

| File | Instrumentation |
|------|-----------------|
| `EffectComposer.js` | Wrap `render()` with marks |
| `canvas-replacement.js` | Loading profiler marks |
| `LightingEffect.js` | Per-pass timing |
| `CloudEffect.js` | Skip rate tracking |
| `WorldSpaceFogEffect.js` | Perception update counter |
| `MaskManager.js` | Derived mask eval counter |
| `frame-coordinator.js` | `forcePerceptionUpdate()` counter |
| `assets/loader.js` | Add `getCacheStats()` |

---

## Test Protocol / Workflows

---

## Automated Performance Testing (Playwright E2E Benchmarks)

> Goal: produce **repeatable, automated** performance numbers (load time + FPS/frame-time + basic memory stats) by booting a real local Foundry server, logging in, waiting for the scene + MapShine to be ready, then executing scripted benchmark procedures.

### Status

- Playwright is **integrated** (Playwright config + baseline perf suite exist in-repo).
- The recommended flow below is based on a proven older-project pattern for reliably:
  - launching a local Foundry server
  - logging in
  - gating on `canvas.ready` + `MapShine.initialized`
  - collecting stable performance samples

### A) What we want to measure (automated)

#### 1) Loading milestones (wall-clock)

- **Server start**
  - `t_server_start` → `t_server_responding` (HTTP 200/401)
- **Browser navigation**
  - `t_goto_start` → `t_domcontentloaded` / `t_networkidle` (optional)
- **Auth**
  - `t_join_form_visible` → `t_join_submitted` → `t_post_login_nav`
- **Foundry readiness**
  - `t_canvas_ready` (`window.canvas?.ready === true`)
  - Optional: `t_game_ready` (`window.game?.ready === true`)
- **MapShine readiness**
  - `t_mapshine_ready` (`window.MapShine?.initialized === true`)
  - Optional “deep readiness”: required managers exist (e.g. `window.MapShine?.effectComposer`, `maskManager`, `sceneComposer`)

#### 2) Runtime performance (steady state)

Minimum viable metrics (CPU-side observable):

- **Frame time samples** captured in-page over a fixed window (e.g. 30s)
  - avg frame ms
  - p50 / p95 / p99 frame ms
  - “hitch count” over thresholds (e.g. >33ms, >50ms, >100ms)
- **FPS** derived from frame time samples
- **MapShine-provided FPS** (if present) via `window.MapShine.renderLoop.getFPS()`

Optional / best-effort (only if implemented by the module tools):

- `window.MapShine.profiler.exportJson()` (CPU breakdown, GPU ms if timer queries exist)
- `renderer.info` snapshots (textures/geometries/programs/calls)

### B) Harness architecture

Recommended folder layout (in this repo):

- `playwright.config.js`
- `playwright-headed.config.js` (optional)
- `tests/playwright/`
  - `foundry-launcher.js` (start/stop Foundry node process)
  - `map-shine-utils.js` (page helper: authenticate, waits, unpause, etc.)
  - `perf-utils.js` (metrics capture + JSON writing)
  - `perf-bench.spec.js` (the benchmark suite)
- `tests/playwright-artifacts/` (reports, screenshots, traces)

Key requirement: tests must target a **real Foundry server** started locally.

#### FoundryLauncher responsibilities

- Spawn Foundry via Node (Foundry `main.js`), with args:
  - `--headless`
  - `--world=<WorldName>`
  - `--port=<Port>`
- Poll `GET http://localhost:<port>/` until responding (treat 200 or 401 as “up”).
- Expose timestamps:
  - `serverStartTs`, `serverReadyTs`
- Ensure clean shutdown:
  - SIGTERM then SIGKILL fallback

**Configuration** should come from env vars so CI and local can differ:

- `FOUNDRY_PATH` (path to Foundry `main.js`)
- `FOUNDRY_DATA_PATH` (if needed)
- `FOUNDRY_WORLD`
- `FOUNDRY_PORT` (default 30000)
- `FOUNDRY_ADMIN_KEY` / auth strategy if your Foundry setup requires it
- `MAP_SHINE_TEST_MODE=true` (so the module can reduce noise / disable non-deterministic features)

#### MapShineTestHelper responsibilities (browser-side)

**Standard gate sequence** (every perf run):

1. `page.goto('/')`
2. `authenticate('Gamemaster')` (or configured user)
3. `waitForCanvasReady()`
4. `waitForMapShineReady()`
5. Stabilize: `await page.waitForTimeout(5000)` (or wait N frames)
6. Ensure interactive: unpause if necessary

**Hard rule**: perf collection starts only after (4) + stabilization.

### C) How to collect FPS / frame-time in Playwright reliably

Playwright does not provide real GPU frame timing; we need in-page instrumentation.

#### Option 1 (recommended baseline): RAF frame-time sampler

Inject a tiny sampler in the browser context that uses `requestAnimationFrame`:

- Record `performance.now()` deltas between frames
- Store deltas in an array
- Stop after `durationMs`
- Compute summary stats (avg/p50/p95/p99, hitch counts)

Pros:
- Works everywhere
- Captures real jank visible to the user

Cons:
- Measures *presented frame cadence*, not GPU execution time

#### Option 2: Use MapShine’s `RenderLoop` FPS

MapShine exposes `window.MapShine.renderLoop` and `renderLoop.getFPS()`.

Pros:
- Very low overhead
- Aligns with MapShine’s internal definition of “FPS”

Cons:
- Coarser (updates once per second)
- Doesn’t give frame-time distribution

Recommendation:
- Use **Option 1** as the authoritative benchmark.
- Include Option 2 as a diagnostic field in the report.

#### Option 3 (future): module profiler export

Once the in-module profiler exists:

- `window.MapShine.profiler.enable()`
- run procedure
- `window.MapShine.profiler.exportJson()`

This becomes the best way to get *breakdowns* (updatables vs effects, etc.).

### D) Benchmark procedures (scripted)

All procedures should be explicit and repeatable. Each should output its own metrics block.

Baseline procedures:

1. **Idle baseline**
  - Duration: 30s
  - No user input
  - Captures steady-state background cost

2. **Pan/zoom stress**
  - Duration: 30s
  - Scripted camera pan pattern (e.g. hold right mouse / or call Foundry canvas pan API if exposed)
  - Scripted zoom in/out (careful: zoom triggers expensive RT resizes)

3. **Effect A/B testing (every effect)**
  - Goal: generate a ranked list of “FPS / frame-time impact” per effect by comparing steady-state performance under controlled toggles.
  - Two complementary modes:
    - **Disable-one (A/B vs baseline)**:
      - A: baseline (default enabled set)
      - B: baseline with effect `X` disabled
      - Metric: `Δ(frameMs.p95)`, `Δ(frameMs.p99)`, `Δ(hitches)` (and optionally `ΔfpsAvg`)
    - **Solo (A/B vs minimal stack)**:
      - A: “minimal viable stack” (only required dependencies enabled)
      - B: minimal stack + effect `X` enabled
      - Metric: same deltas, but avoids “everything else dominates” masking
  - Implementation detail:
    - Enumerate **all registered effects** from `window.MapShine.effectComposer.effects`.
    - Support an allow/deny list so the suite can skip:
      - required effects (if disabling them breaks the run)
      - debug-only effects
      - effects that are intentionally disabled by default
  - Stabilization requirements:
    - After each toggle, always:
      - wait a warm-up window (e.g. 5-10s)
      - then sample a fixed duration (e.g. 15-30s)

4. **Scene switch (optional)**
  - Switch away and back (or reload the world)
  - Captures long-run leak vectors

Stabilization rules (important):

- Always run a warm-up window (e.g. 5-10s) before collecting a sample.
- Always collect at least N frames (e.g. 600 frames) so percentiles are meaningful.

### E) Determinism / noise control

Perf tests are inherently noisy. Use “good enough” controls:

- Run in **headed Chromium** for Foundry stability (but keep consistent across runs).
- Disable OS/browser throttling where possible (Playwright launch args).
- Use a dedicated local world with:
  - fixed scene
  - minimal external modules
  - fixed token counts / tile set
- Avoid interacting with UI panels during measurement.
- Prefer measuring after everything is loaded and stable.

Module knobs (future):

- When `MAP_SHINE_TEST_MODE` is enabled:
  - disable random seed variation where possible
  - pause/disable time-of-day drift
  - pin weather state
  - optionally disable expensive background tasks not relevant to the benchmark

### F) Report format (JSON)

Write one JSON file per run, plus an optional summary table printed in CI.

Proposed structure:

```json
{
  "meta": {
    "timestamp": "2026-01-10T00:00:00Z",
    "foundryVersion": "...",
    "world": "...",
    "scene": "...",
    "mapShineVersion": "...",
    "browser": "chromium",
    "headless": false,
    "viewport": { "width": 1920, "height": 1080 }
  },
  "load": {
    "serverMs": 1234,
    "gotoMs": 456,
    "authMs": 789,
    "canvasReadyMs": 12345,
    "mapShineReadyMs": 23456
  },
  "benchmarks": {
    "idle_30s": {
      "durationMs": 30000,
      "frames": 1800,
      "fpsAvg": 58.7,
      "frameMs": { "avg": 17.0, "p50": 16.3, "p95": 22.1, "p99": 33.4 },
      "hitches": { ">33ms": 12, ">50ms": 2, ">100ms": 0 },
      "mapShineFps": 59,
      "rendererInfo": { "calls": 123, "textures": 45, "geometries": 67, "programs": 12 }
    }
  },
  "ab": {
    "mode": "disable_one" ,
    "baselineKey": "idle_30s",
    "sampleMs": 15000,
    "warmupMs": 7000,
    "effects": {
      "bloom": {
        "baseline": { "fpsAvg": 58.7, "frameMs": { "p95": 22.1, "p99": 33.4 } },
        "variant":  { "fpsAvg": 54.2, "frameMs": { "p95": 26.8, "p99": 45.0 } },
        "delta":    { "fpsAvg": -4.5, "frameMs": { "p95": 4.7, "p99": 11.6 }, "hitches": { ">33ms": 18 } }
      }
    }
  }
}
```

### G) Regression strategy

- Keep a committed baseline JSON (or a derived summary) for a known-good commit.
- In CI, compare current run vs baseline with tolerances, e.g.:
  - `load.mapShineReadyMs` must not regress by > X%
  - `idle_30s.fpsAvg` must not drop by > Y%
  - `idle_30s.frameMs.p95` must not increase by > Z%

Important: run-to-run variance is real; treat CI perf checks as **warning gates** unless you control the environment tightly.

### H) Checkboxes

- [x] Add Playwright dev dependencies + configs
- [x] Implement `FoundryLauncher` (start/stop + server poll)
- [x] Implement `MapShineTestHelper` standard gate sequence
- [x] Implement `RAFFrameSampler` and JSON report writer
- [x] Add `perf-bench.spec.js` with baseline + pan/zoom procedures
- [x] Add `perf-effects.spec.js` to run **A/B for every effect** (disable-one)
- [ ] Extend `perf-effects.spec.js` to support solo-mode A/B (minimal viable stack allowlist)
- [ ] Add CLI/env flags to run **selective** vs **full** perf suites (see below)
- [ ] Add `MAP_SHINE_TEST_MODE` deterministic knobs (optional)

### I) Selective vs full test mode (targeted perf runs)

We need the harness to support:

- **Full perf suite**: run everything end-to-end (load milestones + idle + pan/zoom + A/B matrix for all effects)
- **Selective perf run**: run only what’s needed (e.g. just load milestones, or A/B for one named effect)

Recommended control surface (env vars are easiest for CI and tool-driven runs):

- `PERF_MODE=full|smoke|effects|effect|load|idle|panzoom`
- `PERF_EFFECT_ID=<effectId>` (used when `PERF_MODE=effect`)
- `PERF_EFFECT_FILTER=<glob|regex>` (optional subset when `PERF_MODE=effects`)
- `PERF_SAMPLE_MS=15000` (default sampling window)
- `PERF_WARMUP_MS=7000` (default warmup)
- `PERF_HEADLESS=true|false`

Design intent:

- Tooling (including an LLM) can request **targeted** measurements quickly (`PERF_MODE=effect PERF_EFFECT_ID=bloom`).
- Nightly/CI can run the full suite to keep a long-term baseline.

---

### J) Minimal viable stack (solo-mode A/B)

Solo-mode A/B requires a stable “A” baseline that still renders a valid scene.

Rules:

- **Never disable required infrastructure**:
  - Anything that would prevent a frame from rendering or would spam errors.
- **Prefer a declarative allowlist** (explicit IDs) over inference.
- Solo-mode should still represent “normal gameplay rendering” in a minimal form:
  - base scene render
  - material pipeline
  - lighting/fog only if the visual output becomes meaningless without them

Recommended initial allowlist (adjust as needed once the harness exists):

- **Always-on (minimum)**
  - `specular`
  - `color-correction` (or whatever post baseline you treat as default)
  - `water` (optional; only if it’s part of baseline maps)

- **Usually allow to disable in solo-mode**
  - Post stack effects (bloom, halftone, ascii, etc.)
  - Particles (fire, flies, dust, lightning)
  - Environmental overlays (clouds, atmospheric fog)

- **Special-case effects**
  - Debug effects (`mask-debug`, `debug-layer`) should be excluded from A/B rankings by default.
  - Effects that provide textures consumed elsewhere (example patterns: a lighting effect publishing masks) may need to be tagged as “dependency providers”.

Implementation checkbox:

- [ ] Add `MIN_VIABLE_EFFECTS` allowlist and `SKIP_EFFECTS` denylist to the Playwright suite.

---

### K) Effect toggle + state restore contract (for automation)

To make A/B runs reliable, the harness needs a consistent way to:

- snapshot the current enabled/disabled set
- toggle one effect
- restore the prior state

Recommended approach (browser-side helper):

- Snapshot:
  - iterate `window.MapShine.effectComposer.effects` and record `{ id, enabled }`
- Toggle:
  - prefer `effect.applyParamChange('enabled', boolean)` when present
  - otherwise fall back to `effect.enabled = boolean`
- Restore:
  - re-apply the snapshot to all effects

Implementation checkbox:

- [x] Implement `setEffectEnabled(effectId, enabled)` + snapshot/restore (implemented in `tests/playwright/perf-effects.spec.js`)
- [ ] (Optional refactor) Move toggle/snapshot/restore helpers into `tests/playwright/perf-utils.js` for reuse

---

---

### Repro: "performance drops over time"

- [ ] Establish baseline (fresh reload): record FPS, frame-time breakdown, renderer.info
- [ ] Run for 10 minutes idle
- [ ] Pan/zoom heavily for 2 minutes
- [ ] Toggle several effects on/off
- [ ] Switch scenes 5 times
- [ ] Compare memory and texture counts over time

### Repro: "loading time too long"

- [ ] Record `Scene Load Report`
- [ ] Identify top N slow effects to initialize
- [ ] Identify expensive mask composite steps

---

## Action checklist (progress tracker)

> This is the main progress tracker for a large multi-week effort. Keep it updated as work lands.

### Phase 0: Critical Fixes (from audit)

> These are **confirmed issues** that should be fixed before adding profiling tooling.

- [x] **HIGH**: Call `clearCache()` from `assets/loader.js` in `destroyThreeCanvas()` or `onCanvasTearDown()`
- [x] **HIGH**: Dispose `MaskManager` fullscreen quad geometry/material in `MaskManager.dispose()`
- [x] **HIGH**: Throttle/debounce `FrameCoordinator.forcePerceptionUpdate()` and add counters (calls/sec)
- [x] **HIGH**: Fix `TokenManager.dispose()` to unregister hooks (store hook IDs, call `Hooks.off()`)
- [x] **HIGH**: Fix `VisionManager.dispose()` to unregister hooks (store hook IDs, call `Hooks.off()`)
- [x] **MEDIUM**: Add `this.updatables.clear()` to `EffectComposer.dispose()`
- [ ] **MEDIUM**: Dispose bundle textures explicitly in `SceneComposer.dispose()` or rely on cache clear
- [ ] **MEDIUM**: Add a `WeatherController` teardown (`dispose()` or `onSceneTearDown`) to clear pending timeouts and release buffers/textures when appropriate
- [ ] **LOW**: Audit `WindowLightEffect.js` line ~2847 for unconditional allocation in resize path

### Phase 1: Confirm baseline map + identify obvious leak candidates

- [x] Audit `SceneComposer` composite textures disposal ownership → **See Confirmed Issues**
- [x] Audit `assets/loader.js` cache lifetime and where to clear → **CONFIRMED: Never cleared**
- [x] Audit hook registration/unregistration in managers → **CONFIRMED: TokenManager, VisionManager leak**
- [x] Audit any global singletons (WeatherController, MaskManager) for retained textures/arrays → **WeatherController has no dispose; MaskManager quad not disposed**

### Phase 2: Implement measurement tools (no optimizations)

- [x] Implement `core/profiler.js` (ring buffer + per-frame marks)
- [x] Instrument `EffectComposer.render()` with per-updatable and per-effect timers
- [x] Implement renderer.info + cache samplers (periodic)
- [x] Implement LoadingProfiler marks + report (`effect:{id}:start/done` per effect)
- [x] Add export APIs (`exportJson`, `exportCsv`) for both frame samples and loading report
- [x] Add `MapShine.perf` console namespace for manual profiling (start/stop/summary/top/memory)

### Phase 3: Build automated benchmarking harness (Playwright)

> Enables hands-off measurement of loading + FPS/frame-time deltas.

- [x] Add Playwright to devDependencies + add configs (headed + headless)
- [x] Implement `FoundryLauncher` (start/stop + poll + timestamps)
- [x] Implement `MapShineTestHelper` standard gate sequence (goto → login → canvas ready → MapShine ready → stabilize → unpause)
- [x] Implement `RAFFrameSampler` in-page and JSON report writer
- [ ] Implement `PERF_MODE` selective runner:
  - [ ] `PERF_MODE=load` (only load milestones)
  - [x] `PERF_MODE=idle` (only idle baseline)
  - [x] `PERF_MODE=panzoom` (only pan/zoom)
  - [x] `PERF_MODE=effects` (A/B all effects) (via `perf-effects.spec.js`)
  - [x] `PERF_MODE=effect` + `PERF_EFFECT_ID=<id>` (A/B one effect) (via `perf-effects.spec.js`)

### Phase 4: Run and rank offenders (repeatable results)

- [ ] Define the “minimal viable stack” for solo-mode A/B (dependency allowlist)
- [ ] Run baseline capture and commit a baseline report (or summary)
- [ ] Run A/B for **every effect**:
  - [ ] disable-one matrix vs baseline
  - [ ] solo matrix vs minimal stack
- [ ] Produce an offender ranking table (by `Δp95`, `Δp99`, hitch counts)

### Phase 5: CI / workflow integration

- [ ] Add a script/command to run the perf suite locally with one command
- [ ] Add a CI job (optional) or “nightly perf run” guidance
- [ ] Add regression thresholds (warning-gate by default)

### Phase 6: Optimization backlog triage (measure-first)

> Once measurement is in place, optimization work becomes driven by ranked offenders rather than guesswork.

- [ ] Take top 5 offenders (CPU) and top 5 offenders (GPU/fill) and open tracking issues
- [ ] For each offender, add a “hypothesis + measurement” note:
  - suspected root cause
  - planned micro-optimization or algorithm change
  - expected metric improvement
- [ ] Re-run targeted `PERF_MODE=effect` to validate improvement

---

## Notes / invariants to respect

- Effects should use centralized `TimeManager` (already true).
- Avoid per-frame allocations in hot paths.
- Coordinate conversions: Foundry is top-left Y-down; Three is Y-up (base plane uses `scale.y = -1`).

