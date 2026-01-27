# Map Shine Advanced – Performance Investigation (Entrypoint → Outwards)

## Scope

This document is a **slow, code-driven performance investigation** starting at the module entrypoint (`scripts/module.js`) and working outward through initialization and runtime wiring.

Goals:

- Identify **performance-risk areas** (CPU, GPU, memory/VRAM, GC pressure).
- Highlight where Three.js best practices apply (allocation avoidance, draw call minimization, render target discipline, resize handling, etc.).
- Provide **actionable follow-ups** (what to profile, what to refactor, and why).

Non-goals:

- This document does **not** implement fixes.
- Detailed deep-dives into specific effects are deferred unless they are reached naturally in the “outwards” traversal.

Related docs:

- `docs/PERFORMANCE-PROFILING-PLAN.md` (existing, broad and deep coverage)

---

## 0) Three.js Performance Best Practices (Quick Reference)

- **Avoid allocations in hot paths**
  - No `new Vector2/Vector3/Color/...` inside per-frame `update()` loops, per-particle loops, or per-pointer-move handlers.
  - Prefer cached temp objects (`this._tmpVec2`, etc.).
- **Minimize render target passes**
  - Fullscreen effects are fill-rate heavy. Prefer half/quarter resolution when acceptable.
  - Avoid GPU→CPU readback (`readRenderTargetPixels`) except as a last resort.
- **Keep post-processing predictable**
  - Ping-pong buffers are fine; ensure the chain always renders something to avoid pipeline breakage.
- **Manage VRAM explicitly**
  - Ensure every `WebGLRenderTarget`, `DataTexture`, `CanvasTexture`, and dynamically created texture is disposed on teardown.
  - Avoid “cache growth forever” patterns across scene switches.
- **Avoid redundant work**
  - Ensure per-frame managers don’t do O(N) scans unless necessary.
  - Prefer event-driven invalidation + throttling.

---

## 1) Entrypoint: `scripts/module.js`

### What it does

- Defines `window.MapShine` global state object and reuses an existing instance if it already exists.
- Registers Foundry hooks:
  - `Hooks.once('init', ...)`
    - Shows loading overlay (UI)
    - Registers settings (`sceneSettings.registerSettings()`, `registerUISettings()`)
    - Registers UI hooks:
      - `getSceneControlButtons`
      - `renderTileConfig`
    - Calls `canvasReplacement.initialize()`
  - `Hooks.once('ready', ...)`
    - Calls `bootstrap({ verbose: false })`
    - `Object.assign(MapShine, state)`

### Performance relevance

- Mostly **not hot-path** code; the main runtime cost is indirect via `canvasReplacement.initialize()`.
- The hook `getSceneControlButtons` can run multiple times (whenever Foundry rerenders controls).

### Potential performance issues / watchlist

- **UI rerender duplication**:
  - `rerenderControls()` calls `ui?.controls?.render?.(true)` twice.
  - This is not a per-frame cost, but can cause unnecessary synchronous UI work during tool interactions.
- **`getSceneControlButtons` work**:
  - Builds multiple tool definitions and closures each invocation.
  - Likely acceptable, but if Foundry rerenders controls frequently, this is measurable.

### Suggested profiling

- Count how often `getSceneControlButtons` fires per minute during normal play.
- Measure the cost of `ui.controls.render(true)` (especially when called twice).

---

## 2) Bootstrap: `scripts/core/bootstrap.js`

### What it does

- Dynamically loads Three.js: `import('../vendor/three/three.custom.js')` and sets `window.THREE`.
- Detects GPU capability via `scripts/core/capabilities.js`.
- Creates a renderer via `scripts/core/renderer-strategy.js`.
- Initializes `GameSystemManager`.
- Creates a minimal scene/camera (optional; can be skipped).

### Performance relevance

- **One-time cost** on load.
- The key performance implication is that the renderer is created once and reused; therefore **teardown must correctly dispose per-scene resources**, or memory/VRAM will grow over time.

### Potential performance issues / watchlist

- `window.THREE` global usage is fine for debugging but makes it easy for other modules/snippets to retain references and unintentionally prevent GC.

---

## 3) Renderer Strategy: `scripts/core/renderer-strategy.js`

### What it does

- Chooses WebGL2 if possible; falls back to WebGL1.
- Configures:
  - `setSize(width, height)`
  - `setPixelRatio(Math.min(devicePixelRatio, 2))`
  - `outputColorSpace = SRGBColorSpace` (if supported)
  - `toneMapping = NoToneMapping`

### Performance relevance

- The current DPR cap at 2 is a strong baseline.

### Potential performance issues / watchlist

- WebGL2 path uses `antialias: true`.
  - MSAA can be expensive at high resolutions. This is a quality/perf tradeoff.
  - Graphics Settings appears to provide render resolution scaling later; that mitigates.

---

## 4) Canvas Replacement Wiring: `scripts/foundry/canvas-replacement.js`

### 4.1 Hook registration: `initialize()`

Registers:

- `canvasConfig` – makes PIXI canvas transparent
- `canvasReady` → `onCanvasReady`
- `canvasTearDown` → `onCanvasTearDown`
- `updateScene` → `onUpdateScene`
- `pauseGame` → forwards pause to TimeManager
- Wraps `foundry.canvas.Canvas.prototype.tearDown` to fade during scene transitions

Performance relevance:

- Hook registration itself is not expensive, but **duplicate registration** can cause exponential work.

Watchlist:

- `initialize()` is guarded by module-level `isHooked`.
  - This prevents duplicate registrations in a normal lifecycle.
  - If the file is re-evaluated in a hot-reload scenario, the guard may reset and hooks could duplicate.

### 4.2 `onCanvasReady(canvas)`

Key behavior:

- Waits (polling up to 15s) for `window.MapShine.initialized`.
- If scene is not enabled, it runs **UI-only mode** for GM (and dismisses overlay for players).
- If scene enabled, shows staged loading overlay and calls `await createThreeCanvas(scene)`.

Performance relevance:

- Poll loop uses `setTimeout(100ms)` and `Date.now()`; negligible.
- UI-only mode is safe; it avoids starting the Three render loop.

### 4.3 `createThreeCanvas(scene)` (early portion)

Observed setup:

- Ensures old canvas is destroyed (`destroyThreeCanvas()`)
- Provides a “lazy bootstrap” recovery path if renderer missing
- Creates/injects Three canvas alongside PIXI `#board`
- Hides PIXI-rendered layers while keeping token hit-testing alive via transparent meshes
- Sizes renderer using `_applyRenderResolutionToRenderer(rect.width, rect.height)` and `renderer.setSize(..., false)`
- Adds WebGL context loss/restored handlers
- Initializes:
  - `SceneComposer.initialize(...)` (loads assets + creates scene/camera)
  - `MaskManager` registry and derived masks
  - `WeatherController.initialize()` then registers as an EffectComposer updatable
  - `EffectComposer.initialize()`
- Initializes a large set of effects (many in `Promise.all`) and then wires base mesh.
- Initializes scene managers (Grid, Tokens, Tiles, Walls, Doors, etc.) and registers several as updatables.

Performance relevance:

- This is the **main load-time hotspot** and where many long-lived per-frame updatables get registered.

Watchlist (early findings):

- **Parallel effect initialization burst**
  - `Promise.all(independentPromises)` can create many render targets/textures concurrently.
  - This can cause load spikes and peak VRAM usage during init.
- **Token transparency loop**
  - Iterates `canvas.tokens.placeables` and sets alpha on `mesh/icon/border`.
  - Not hot-path, but should remain bounded and only run on init.

---

## Next steps (continuing “outwards”)

- Continue reading through the remainder of `createThreeCanvas(scene)`:
  - confirm RenderLoop start
  - confirm teardown cleanup (`destroyThreeCanvas`) disposes all textures, render targets, and removes hooks/intervals
  - list all `effectComposer.addUpdatable(...)` registrations and inspect their `update()` methods for allocations or O(N) scans

---

## 5) Steady-state render loop: `scripts/core/render-loop.js`

### What it does

- Runs a single `requestAnimationFrame` loop.
- Computes `deltaTime` and increments internal FPS counters.
- If an `EffectComposer` exists, it delegates to `effectComposer.render(deltaTime)`.

### Performance relevance

- This is the top of the per-frame call stack.
- The loop is minimal and doesn’t allocate noticeably (no per-frame object creation).

### Watchlist

- **No explicit `deltaTime` clamp** here.
  - If a tab is backgrounded or the browser stutters, `deltaTime` can become very large.
  - It’s likely downstream systems clamp `timeInfo.delta`, but this file does not.

---

## 6) Per-frame pipeline core: `scripts/effects/EffectComposer.js`

### What it does (high level)

Per frame in `render(deltaTime)`:

1. Resolves enabled effects and sorts them (`resolveRenderOrder()`).
2. Advances `TimeManager` (authoritative time source): `timeManager.update()`.
3. Updates global frame state snapshot (`getGlobalFrameState().update(...)`).
4. Updates all registered **updatables** (`for (const updatable of this.updatables) updatable.update(timeInfo)`).
5. Splits enabled effects into:
   - Scene effects (rendered as part of the main scene render)
   - Post-processing effects (fullscreen passes)
6. Updates and optionally renders all scene effects.
7. Renders the Three scene exactly once:
   - To `sceneRenderTarget` (HDR FloatType) if post effects exist
   - Otherwise directly to screen
8. Ping-pong post stack through `post_1` / `post_2` render targets.
9. Renders overlay layer (Three layer 31) directly to screen.

### Strong choices (good for performance)

- **Single authoritative scene render** per frame.
- **Reused arrays** for effect sorting/splitting:
  - `_cachedRenderOrder`, `_sceneEffects`, `_postEffects`.
- **Reused `Vector2`** for drawing buffer size via `this._sizeVec2`.
- **Overlay isolation** via `OVERLAY_THREE_LAYER` to keep UI-ish elements out of post.

### Watchlist / potential performance issues

#### 6.1 `resolveRenderOrder()` sorts every frame

- Implementation rebuilds `_cachedRenderOrder` and calls `.sort(...)` every frame.
- Comment notes this is intentional to catch enabled state changes.

Risk:

- Sorting is `O(E log E)` every frame (`E` = enabled effect count).
- This is probably fine at current effect counts, but it’s one of the few always-on CPU costs in the pipeline.

Possible future optimization:

- Track “dirty” state more granularly:
  - Rebuild/sort only when effects are registered/unregistered or when `enabled` changes.
  - This requires a reliable “enabled changed” signal.

#### 6.2 Profiling overhead when enabled

- When `globalProfiler.enabled` is true:
  - `performance.now()` is called many times per frame.
  - It conditionally collects `renderer.info`, asset cache stats, frame coordinator metrics, and `performance.memory` (where supported).

Risk:

- This is expected and acceptable when profiling, but it can distort measurements and should remain disabled by default.

#### 6.3 FloatType render targets everywhere

- `sceneRenderTarget` uses `THREE.FloatType`.
- `getRenderTarget(...)` also always uses `THREE.FloatType`.

Risk:

- Float targets increase bandwidth and can be a major cost multiplier on some GPUs.
- This is often worth it for HDR correctness (especially with Bloom), but it is a global performance lever.

Follow-up idea:

- Consider a “precision tier” (HalfFloat/Float) depending on GPU tier, if you run into bandwidth bottlenecks.

#### 6.4 `getRenderTarget(name, w, h)` does not enforce size when already created

- If a target exists, it returns it without verifying dimensions.
- Resizing is expected to be handled by `EffectComposer.resize()`.

Risk:

- If pixel ratio changes without calling `effectComposer.resize(...)` (e.g. via Graphics Settings), cached RT sizes could drift.
- Result is either incorrect sampling (stretched) or implicit internal reallocations downstream.

Suggested audit:

- Confirm every path that changes `renderer.setPixelRatio(...)` also triggers `effectComposer.resize(...)`.

#### 6.5 Post chain safety relies on each effect rendering

- The composer clears output buffers and calls `effect.render(...)` for each post effect.

Risk:

- If an effect returns early without drawing (or throws), the chain can go black.
- There is a `handleEffectError` mechanism that disables the effect on exception, but it doesn’t guarantee a “pass-through blit”.

Suggested audit:

- Ensure all post effects implement pass-through behavior when disabled/unready.

### Three.js best-practice notes (specific to this pipeline)

- **Keep allocations out of updatables**: `EffectComposer` itself is mostly allocation-free, so the next biggest GC risks are inside `updatable.update(...)` and `effect.update(...)`.
- **Avoid redundant clears**:
  - Current design clears per-pass when rendering to intermediate targets (`renderer.clear()`), which is correct but can be expensive if overused.
  - Keep “extra passes” minimal and prefer half-res for heavy fullscreen shaders.

---

## 7) Per-frame updatables registered from `canvas-replacement.js`

### Where they’re registered

From `createThreeCanvas(scene)`:

- `weatherController`
- `gridRenderer`
- `tileManager`
- `doorMeshManager`
- `physicsRopeManager`
- `interactionManager`
- `overlayUIManager`
- `lightRingUI`
- `lightAnimDialog`
- `cameraFollower`

Separately:

- `TokenManager` self-registers as an updatable when `tokenManager.setEffectComposer(effectComposer)` and `tokenManager.initialize()` are called.

### Why this matters

This set is effectively your **baseline CPU cost per frame**, even when no effects are changing. Any O(N) work or allocation here scales directly with FPS.

---

## 8) Updatable audit (hot-path risks)

### 8.1 `TokenManager.update(timeInfo)`

Observed per-frame work:

- Iterates **every token sprite** each frame to push WindowLight uniforms (`tWindowLight`, `uHasWindowLight`, `uWindowLightScreenSize`).
- Advances active animations (iterates `activeAnimations`).
- Applies global tint to all tokens when tint changes.

Perf risks:

- **O(tokens) uniform updates per frame**.
  - This can be costly with many tokens, even if window lighting is off or unchanged.
- Uniform update loop does not appear to be gated by “texture/size changed”.

Three.js best-practice note:

- Prefer updating uniforms only when inputs change:
  - cache `lastWindowLightTex`, `lastW`, `lastH`, and early-out if unchanged
  - or push window light uniforms only when the WindowLightEffect target is (re)created/resized.

Good:

- The tint logic caches `THREE.Color` instances and uses a computed `tintKey` to avoid reapplying when unchanged.

### 8.2 `TileManager.update(timeInfo)`

Observed per-frame work:

- Computes a global tint each frame (but applies it only when tint changes).
- Iterates **all overhead tiles** each frame to:
  - apply overhead tint
  - evaluate occlusion state
  - potentially sample roof/outdoor mask (`weatherController.getRoofMaskIntensity(...)`) per overhead tile.

Perf risks:

- **O(overheadTiles) per frame** baseline, plus additional cost when occlusion is enabled.
- Occlusion checks can be **O(tokens × overheadTiles)** depending on how deep the logic goes (this function starts by building a `sources` list and later checks bounds).
- `alphaMaskCache` is populated via `getImageData()` for pixel-opaque tests. This is good for runtime speed but is a **CPU memory growth** risk if it isn’t cleared.

Three.js best-practice note:

- Prefer event-driven invalidation:
  - only recompute occlusion targets when relevant tokens move or selection changes
  - throttle expensive checks if token movement triggers frequent updates.

### 8.3 `InteractionManager.update(timeInfo)`

Observed per-frame work:

- If Token HUD is open, `updateHUDPosition()` runs every frame.
- Updates selection box visuals and light gizmo visuals.

Perf risks:

- `updateHUDPosition()` calls `cam.updateMatrixWorld()` per frame when HUD is open.
  - Not necessarily wrong, but it’s extra work and can become noticeable if other systems also force matrix updates.

Good:

- Uses `this._tempVec3HUD` and cached canvas rect (`_getCanvasRectCached`) to avoid per-frame allocations.
- Avoids redundant DOM style updates by caching previous `left/top/transform` values.

### 8.4 `PhysicsRopeManager` / `RopeInstance.update(timeInfo)`

Observed per-frame work:

- Verlet integration loop over rope nodes.
- Constraint iterations (default 6) over segments, plus bending constraints.
- Geometry update: recompute per-vertex ribbon positions, normals, and UVs.
- Uses roof mask sampling once per rope per frame (midpoint sample).

Perf risks:

- **Scales with rope count × node count × constraint iterations**.
- Uses `performance.now()` inside the update loop.
  - This violates the project invariant that effects/updatables should use the centralized `TimeManager` / `timeInfo`.
  - It also makes behavior less deterministic during pause/time-scale.

Major risk: GPU → CPU readback

- `_sampleWindowLightFromTarget` calls `renderer.readRenderTargetPixels(...)`.
  - This can cause pipeline stalls and is one of the most common sources of “random hitches” on certain drivers.

Three.js best-practice note:

- Avoid `readRenderTargetPixels` in steady-state runtime.
  - If ropes must respond to window lighting, prefer:
    - a GPU-side sampling approach in the rope shader (already samples `uWindowLight` via `gl_FragCoord`), and/or
    - a low-frequency CPU sampling approach (e.g. sample once per second, or only when the rope is selected / in view).
- Replace `performance.now()` with `timeInfo.elapsed`.

---

## 9) Teardown / leak audit: `destroyThreeCanvas()`

Good:

- Stops the RAF loop.
- Disposes managers and effects.
- Removes WebGL context loss/restored listeners.
- Calls `clearAssetCache()` at teardown (important for VRAM control across scene switches).

Watchlist:

- `TokenManager.dispose()`, `TileManager.dispose()`, and others must reliably unhook Foundry hooks and dispose all textures/materials.
  - Some managers already track hook IDs (`this._hookIds`), but this still needs verification for every manager.

---

## 10) Remaining updatables (baseline per-frame costs)

### 10.1 `WeatherController.update(timeInfo)`

Observed:

- Uses `timeInfo.delta` and `timeInfo.elapsed` (good).
- Has a frame guard (`_msLastUpdateFrame`) to avoid double-updates within the same frame (good defensive design).
- Does periodic persistence of weather snapshots to scene flags (timer-based, every 300s by default, and debounced).

Perf relevance:

- Generally modest per frame, but it is *upstream* of many GPU effects. If this update becomes heavy (e.g. dynamic weather planning), it impacts everything.

Watchlist:

- Some code paths use `Date.now()` when building persistence payloads or scene transition commands.
  - This is fine for persistence bookkeeping.
  - For animation/simulation, it correctly uses `timeInfo`.

### 10.2 `GridRenderer.update(timeInfo)`

Observed:

- Very lightweight per-frame update that only updates `uResolution` when zoom changes enough.
- Uses `getGlobalFrameState()` rather than probing camera properties directly (good).

Good:

- Unregisters hooks in `dispose()`.
- Updates are gated by `_lastResolution` threshold.

### 10.3 `DoorMeshManager.update(timeInfo)`

Observed:

- Updates a global tint (with cached `THREE.Color` instances and a `tintKey` change detector).
- Iterates over all door meshes and advances animation state.

Perf relevance:

- Scales with number of doors, but doors are typically low count.

Good:

- Uses `timeInfo.delta` for animation.
- Tracks hook IDs and calls `Hooks.off` in `dispose()`.
- Disposes cached textures in `dispose()`.

### 10.4 `OverlayUIManager.update(timeInfo)`

Observed:

- Manages world-anchored DOM overlays.
- Uses cached vectors (`_tmpWorld`, `_tmpNdc`) and a cached canvas rect (`_rectCache`).

Perf relevance:

- Can become expensive if you have many overlays because each overlay requires a projection and DOM writes.

Watchlist:

- `_projectWorldToScreen` calls `camera.updateMatrixWorld()` and `camera.updateProjectionMatrix()`.
  - Confirmed: `OverlayUIManager.update()` iterates `for (const h of this.overlays.values())` and calls `_projectWorldToScreen(...)` once per overlay (when anchored).
  - That means camera matrix updates are currently executed **per overlay per frame**, which can scale poorly if many overlays are visible.

Follow-up recommendation:

- Move camera matrix updates out of `_projectWorldToScreen` and into `OverlayUIManager.update()` (once per frame), or guard with a per-frame flag.

### 10.5 `CameraFollower.update()`

Observed:

- Reads `canvas.stage.pivot` and `canvas.stage.scale` each frame.
- Early-outs if changes are below threshold.
- Updates camera position and updates projection matrix only when zoom changes.

Perf relevance:

- Very low; good “do nothing when unchanged” behavior.

---

## 12) Overlay UI updatables (light tools)

### 12.1 `LightRingUI.update(timeInfo)`

Observed:

- Called per-frame by `EffectComposer`.
- Only does work when a Foundry light is selected (`this.current?.type === 'foundry'`).

Watchlist:

- Uses `performance.now()` in `_applyField(..., {allowThrottle:true})` to throttle document updates during drags.
  - This is UI-only and not part of render simulation, so it’s acceptable.

### 12.2 `LightAnimDialog.update(timeInfo)`

Observed:

- Called per-frame by `EffectComposer`.
- Only does work when the dialog is open and tracking a Foundry light.
- Updates anchor world position via `Coordinates.toWorld(...)` and `overlayManager.setAnchorWorld(...)`.

Perf relevance:

- Low by default; the update is gated by `this.current`.

---

## 13) Priority shortlist: likely performance offenders (based on this traversal)

This is not a measured ranking; it’s a “where to look first” list.

### P0 (highest suspicion)

- **`PhysicsRopeManager` GPU readback**: `renderer.readRenderTargetPixels(...)`.
- **`TileManager.update` scaling**: overhead tile loop + occlusion checks (can approach O(tokens × overheadTiles)).
- **`TokenManager.update` scaling**: per-token uniform pushes every frame.

### P1 (medium suspicion)

- **OverlayUIManager camera matrix updates per overlay per frame** (scales with overlay count).
- **EffectComposer post stack bandwidth**: FloatType targets + heavy post effects (Bloom, etc.).
- **Any particle system with large counts** (depends on tier, weather, fire, etc.).

---

## 14) Recommended next measurements (quick, actionable)

- Measure per-frame CPU time for:
  - `TileManager.update`
  - `TokenManager.update`
  - `PhysicsRopeManager.update`
  - `OverlayUIManager.update`

- Track counts each frame or periodically:
  - token count (`tokenManager.tokenSprites.size`)
  - overhead tile count (`tileManager._overheadTileIds.size`)
  - rope count and rope nodes total (sum of `RopeInstance.count`)
  - overlay count (`overlayUIManager.overlays.size`)

- For hitch diagnosis:
  - temporarily disable GPU readbacks in `PhysicsRopeManager` and compare pan/zoom hitch frequency.


---

## 11) Confirmed cleanup patterns (good)

Based on code inspection:

- `TokenManager` registers hooks into an internal `this._hookIds` array and unregisters them in `dispose()`.
- `TileManager` unregisters hooks in `dispose()` and clears `alphaMaskCache` (large CPU buffers).
- `GridRenderer` unregisters hooks in `dispose()`.
- `DoorMeshManager` unregisters hooks in `dispose()`.

This is a strong sign that long-run “scene switch = slower and slower” issues are being actively prevented.




## 15) Fog/Vision Systems Performance Audit

### Overview

Map Shine manages fog of war and vision through multiple layers:
1. **FoundryFogBridge** - Bridges Foundry's native PIXI fog textures to Three.js (preferred, zero-copy).
2. **WorldSpaceFogEffect** - Renders fog as a world-space plane, accumulates exploration, persists to Foundry.
3. **Legacy systems** - `VisionManager` and `FogManager` (deprecated, but code still present).

### 15.1 FoundryFogBridge (preferred path)

**Location**: `scripts/vision/FoundryFogBridge.js`

**What it does**:
- Wraps Foundry's native PIXI vision and explored textures.
- Reuses Three.js `Texture` objects and updates their internal `__webglTexture` property to point to PIXI's WebGL texture handles.
- Avoids pixel copying; textures are shared at the WebGL level.

**Per-frame cost**:
- `sync()` called every frame by `BloomEffect.render()`.
- Updates `sceneWidth`, `sceneHeight` from `canvas.dimensions`.
- Calls `_extractVisionTexture()` and `_extractExploredTexture()` (both O(1) property updates, no copying).

**Watchlist**:
- **Fallback textures**: Creates white/black fallback textures if PIXI textures are unavailable. These are disposed on teardown.
- **No observed allocations or GPU readbacks** in the hot path.

**Assessment**: **Good** – Zero-copy bridge, minimal per-frame overhead.

### 15.2 WorldSpaceFogEffect (active, complex)

**Location**: `scripts/effects/WorldSpaceFogEffect.js`

**What it does**:
- Renders fog of war as a world-space plane mesh overlaid on the scene.
- Maintains two render targets: `visionRenderTarget` (current vision) and ping-pong `_explorationTargetA/_explorationTargetB` (accumulated exploration).
- Accumulates vision into exploration each frame using `MaxEquation` blending.
- Persists exploration state to Foundry's `FogExploration` document asynchronously (but with blocking GPU readbacks).

**Per-frame hot path** (`update(timeInfo)`):

1. **Camera movement detection** (`_detectCameraMovement()`):
   - Compares current camera position to last known position.
   - If moved significantly, sets `_needsVisionUpdate = true`.

2. **MapShine selection change detection**:
   - Checks if selected tokens/lights changed.
   - If changed, calls `frameCoordinator.forcePerceptionUpdate()` (forces Foundry to recompute vision).
   - Sets `_needsVisionUpdate = true`.

3. **Vision rendering** (`_renderVisionMask()` if `_needsVisionUpdate`):
   - Clears `visionScene`.
   - Iterates controlled tokens, gets Foundry's `visionSource.los` polygons.
   - For each polygon, converts PIXI points to `THREE.ShapeGeometry`, creates mesh, adds to scene.
   - **Hotspot**: Per-frame geometry creation for every vision polygon. No pooling observed.
   - Renders to `visionRenderTarget`.

4. **Exploration accumulation** (`_accumulateExploration()` if enabled):
   - Renders `visionRenderTarget` into `_explorationTargetB` using `MaxEquation` blending.
   - Swaps ping-pong targets.
   - **Cost**: One fullscreen render pass per frame (acceptable).

5. **Exploration persistence** (`_markExplorationDirty()` → debounced `_saveExplorationToFoundry()`):
   - Asynchronously reads pixels from `explorationRenderTarget` using `_readRenderTargetPixelsTiled()`.
   - **Hotspot**: `renderer.readRenderTargetPixels()` is a GPU→CPU sync point; even tiled, it can cause hitches.
   - Encodes to base64 using `OffscreenCanvas` or chunked canvas.
   - Updates Foundry's `FogExploration` document.

**Render target sizing**:
- Vision RT: capped at 2048px max dimension (line 484).
- Exploration RT: same cap (line 548).
- **Rationale**: Keeps `readRenderTargetPixels` cost bounded (4096^2 = 16M pixels = ~64MB read).

**Hook registrations** (`_registerHooks()`):
- Registers `controlToken`, `updateToken`, `sightRefresh`, `lightingRefresh` hooks.
- Each hook calls `frameCoordinator.forcePerceptionUpdate()` and sets `_needsVisionUpdate = true`.
- **Hotspot**: `forcePerceptionUpdate()` forces Foundry to recompute vision polygons (CPU-intensive).
- During token animation (60 fps), `updateToken` fires ~60x/sec → 60 perception recomputes/sec.

**Disposal** (`dispose()`):
- Unregisters all hooks.
- Disposes render targets, materials, geometries, fallback textures.
- **Assessment**: Cleanup looks complete.

**Watchlist**:

1. **`forcePerceptionUpdate()` spam during token animation**:
   - `updateToken` hook fires every animation frame.
   - Each call forces Foundry to recompute vision (CPU work).
   - **Mitigation**: Throttle `updateToken` hook or defer perception updates until animation ends.

2. **Per-frame `ShapeGeometry` creation in `_renderVisionMask()`**:
   - Creates new `THREE.ShapeGeometry` for every vision polygon every frame.
   - No pooling or caching of geometries.
   - **Mitigation**: Pool geometries or use a single dynamic mesh with instancing.

3. **GPU→CPU readback in exploration save**:
   - Even tiled, `readRenderTargetPixels()` is a sync point that can stall the GPU pipeline.
   - Happens asynchronously (debounced), but still blocks the main thread during the read.
   - **Mitigation**: Consider using `readPixels()` with a `Uint8Array` or offscreen canvas to avoid blocking.

4. **Exploration accumulation every frame**:
   - Even if exploration is not being saved, the ping-pong render happens every frame.
   - **Cost**: One fullscreen render pass per frame (acceptable, but measurable).

**Assessment**: **Medium risk** – Multiple hotspots (perception update spam, per-frame geometry creation, GPU readback).

---

### 15.3 Legacy systems (deprecated)

**VisionManager** (`scripts/vision/VisionManager.js`):
- Custom vision polygon computation using `VisionPolygonComputer`.
- Renders to `renderTarget`, triggers on `refreshToken` hook (~60x/sec during animation).
- **Status**: Likely deprecated in favor of `FoundryFogBridge` + `WorldSpaceFogEffect`.
- **Watchlist**: If still active, same hotspots apply (perception update spam, per-frame allocations).

**FogManager** (`scripts/vision/FogManager.js`):
- Accumulates exploration using `MaxEquation` blending.
- Persists via `renderer.readRenderTargetPixels()` + base64 encoding.
- **Status**: Likely deprecated.
- **Watchlist**: If still active, GPU readback is a known hitch source.

---

### 15.4 Integration with BloomEffect

**Location**: `scripts/effects/BloomEffect.js` (line 646-648)

**Observed**:
- `BloomEffect.render()` calls `this.fogBridge?.sync?.()` to update fog textures before rendering bloom.
- Retrieves vision texture via `this.fogBridge?.getVisionTexture?.()`.
- Uses vision texture as input to bloom threshold pass (if available).

**Watchlist**:
- `fogBridge.sync()` is called every frame by `BloomEffect`, which is itself called every frame.
- This is redundant if `WorldSpaceFogEffect` also calls `sync()`.
- **Mitigation**: Consolidate `sync()` calls to a single location (e.g., early in `EffectComposer.render()`).

---

### 15.5 Summary: Fog/Vision Performance Issues

| Issue | Severity | Location | Impact |
|-------|----------|----------|--------|
| `forcePerceptionUpdate()` spam during token animation | **High** | `WorldSpaceFogEffect._registerHooks()` | 60+ perception recomputes/sec during animation |
| Per-frame `ShapeGeometry` creation (no pooling) | **High** | `WorldSpaceFogEffect._renderVisionMask()` | GC pressure, CPU allocation overhead |
| GPU→CPU readback in exploration save | **Medium** | `WorldSpaceFogEffect._saveExplorationToFoundry()` | Async but still a sync point; can cause hitches |
| Redundant `fogBridge.sync()` calls | **Low** | `BloomEffect.render()` + `WorldSpaceFogEffect` | Minor overhead, easy fix |
| Exploration accumulation every frame | **Low** | `WorldSpaceFogEffect._accumulateExploration()` | One fullscreen pass/frame (acceptable) |

---

### 15.6 Recommended profiling / fixes

1. **Profile perception update frequency**:
   - Add a counter to `frameCoordinator.forcePerceptionUpdate()`.
   - Log it every 60 frames to see how many times/sec it's called during normal play and animation.

2. **Throttle `updateToken` hook**:
   - Defer perception updates until animation ends (e.g., use a timer or animation completion callback).
   - Or throttle the hook to 10 Hz instead of 60 Hz.

3. **Pool vision geometries**:
   - Reuse `ShapeGeometry` instances across frames.
   - Or use a single dynamic mesh with instancing.

4. **Consolidate `fogBridge.sync()` calls**:
   - Call once per frame in `EffectComposer.render()` before any effect that uses fog.
   - Remove redundant calls from `BloomEffect`.

5. **Measure exploration save impact**:
   - Profile `_readRenderTargetPixelsTiled()` and `_encodeExplorationBase64()` to quantify hitch duration.
   - Consider using `OffscreenCanvas` exclusively (if available) to avoid main-thread blocking.


---

## 16) Heavy effects audit (render passes, render targets, and hot-path risks)

This section focuses on effects with the highest likelihood of:

- Multiple full-screen render passes
- Full-resolution `WebGLRenderTarget` usage
- Work done unconditionally every frame (even when visually “inactive”)

### 16.1 `LightingEffect` (multi-pass, full-resolution mask pipeline)

**Location**: `scripts/effects/LightingEffect.js`

Observed patterns:

- Creates and/or maintains many full-resolution render targets:
  - `lightTarget` (HalfFloat)
  - `sunLightTarget` (HalfFloat)
  - `darknessTarget` (UnsignedByte)
  - `roofAlphaTarget` (UnsignedByte)
  - `weatherRoofAlphaTarget` (UnsignedByte)
  - `ropeMaskTarget` (UnsignedByte)
  - `tokenMaskTarget` (UnsignedByte)
  - `masksTarget` (UnsignedByte)
  - `outdoorsTarget` (UnsignedByte, optional)

- `render(renderer, scene, camera)` does multiple scene renders with layer filters (screen-space masks):
  - `ROOF_LAYER` → `roofAlphaTarget`
  - `WEATHER_ROOF_LAYER` → `weatherRoofAlphaTarget`
  - `ROPE_MASK_LAYER` → `ropeMaskTarget`
  - `TOKEN_MASK_LAYER` → `tokenMaskTarget`

Perf relevance:

- One of the most expensive “baseline” systems because it can:
  - Render multiple full-resolution targets per frame.
  - Render the scene multiple times (even if each pass is a subset of meshes).
  - Feed multiple downstream effects via `MaskManager` as `dynamicPerFrame` textures.

Watchlist / risks:

- Fill-rate and bandwidth pressure at high resolutions.
- HalfFloat targets increase bandwidth and can reduce low-end performance.
- “Effect enabled” gating may not imply “all internal passes disabled”.

Recommended measurements:

- GPU frame time with only `LightingEffect` enabled.
- Draw call count per mask pass (roof/rope/token).
- VRAM impact of the full set of lighting targets.

Recommended mitigations (design-level; not implementing here):

- Apply render invalidation for masks that change infrequently (roof alpha, outdoors projection).
- Consider running some masks at reduced resolution if tolerable.
- Consider consolidating passes (e.g., packing multiple masks into one target on WebGL2 paths).

### 16.2 `CloudEffect` (multi-target, but includes temporal slicing)

**Location**: `scripts/effects/CloudEffect.js`

Observed patterns:

- Maintains multiple render targets (density + shadows + raw shadow + optional cloud-top layers).
- Uses an internal resolution via `_getInternalRenderSize(width, height)`.
- Includes motion-aware temporal slicing:
  - When the camera/view is moving, updates every frame.
  - When stable, can skip heavy passes based on `updateEveryNFrames`.
- When weather is disabled, clears targets to neutral values and returns early.

Perf relevance:

- Still potentially heavy due to multiple targets/passes, but has explicit throttling and neutral-output fast paths.

Watchlist / risks:

- Ensure internal size calculation doesn’t thrash target sizes due to changing zoom/resolution inputs.
- Downstream sampling cost: multiple screen-space masks published to `MaskManager`.

Recommended measurements:

- GPU cost with `updateEveryNFrames = 1` vs. typical values.
- How often “camera moving” forces full-rate updates in real play.

### 16.3 `DistortionManager` (water occluder prepass + distortion composite)

**Location**: `scripts/effects/DistortionManager.js`

Observed patterns:

- Render path begins by rendering water occluders into `waterOccluderTarget`.
- Then checks for active distortion sources.
  - If none, it pass-through blits `readBuffer` → `writeBuffer`.
  - If active, it renders a composite distortion map (`distortionTarget`) then applies it.

Perf relevance:

- The water occluder pass appears to run even when there are no active sources.
- When active, this is at least:
  - 1 scene render (occluders)
  - 1 fullscreen composite
  - 1 fullscreen apply

Watchlist / risks:

- Unconditional occluder pass can be avoidable work if distortion is usually inactive.

Recommended mitigations (design-level):

- Gate `_renderWaterOccluders()` behind “distortion active” or “water enabled”.
- Add invalidation so occluders are only re-rendered when tiles/overheads change.

### 16.4 `WindowLightEffect` (additional full-res target)

**Location**: `scripts/effects/WindowLightEffect.js`

Observed patterns:

- Creates a dedicated `lightTarget` (`WebGLRenderTarget(width, height)`) to render window-light contribution.
- Samples cloud shadow textures when available.

Perf relevance:

- Adds another full-resolution render target and at least one extra pass when enabled.

Watchlist / risks:

- One code path allocates a `new THREE.Vector2()` while querying drawing buffer size; in hot paths this is GC pressure.
- Consider reduced resolution for this contribution (emissive/blur-like content is often tolerant).

### 16.5 `WaterEffectV2` (single full-screen pass + occasional heavy rebuild)

**Location**: `scripts/effects/WaterEffectV2.js`

Observed patterns:

- Steady-state: a single full-screen quad shader in `render()`.
- Occasionally rebuilds derived `water.data` textures from the water mask (`_surfaceModel.buildFromMaskTexture`).
- Rebuild appears cached via a detailed cache key (mask + parameters).

Perf relevance:

- Per-frame cost is primarily shader/fill-rate.
- CPU cost spikes are expected when the derived data texture is rebuilt (parameter changes, mask changes).

Recommended measurements:

- Time spent in `_surfaceModel.buildFromMaskTexture()` when forcing rebuilds.
- GPU cost of the water pass at typical resolutions.

### 16.6 `OverheadShadowsEffect` (screen-space roof mask + derived shadow target)

**Location**: `scripts/effects/OverheadShadowsEffect.js`

Observed patterns:

- Maintains two full-resolution render targets:
  - `roofTarget` (UnsignedByte) – roof alpha mask
  - `shadowTarget` (UnsignedByte) – derived shadow factor

- `render(renderer, scene, camera)` performs at least two passes:
  - Pass 1: render `ROOF_LAYER` (20) into `roofTarget`
  - Pass 2: render `shadowScene` into `shadowTarget` using `roofTarget` sampled in screen space

- Per-frame scene traversal work:
  - Traverses `mainScene` to temporarily override roof sprite material opacity for the mask pass.
  - This is O(number of sprites/objects) and happens every render.

Perf relevance:

- Another multi-pass, full-resolution system feeding `LightingEffect`.
- The `mainScene.traverse(...)` override pass is a potential CPU hotspot on large scenes.

Good:

- Has a parameter hash (`_lastUpdateHash`) to skip uniform recompute work in `update()` when nothing changed.

Watchlist / risks:

- Even if `update()` early-outs, the render path still performs the two passes.
- Consider whether the roof mask/shadow target can be invalidated (camera stable, no roof changes).

Recommended measurements:

- CPU time spent in the roof-sprite traversal.
- GPU time for the two passes at typical resolution.

### 16.7 `TreeEffect` / `BushEffect` (full-resolution shadow targets)

**Locations**:

- `scripts/effects/TreeEffect.js`
- `scripts/effects/BushEffect.js`

Observed patterns:

- Each effect maintains a full-resolution `shadowTarget` and renders a shadow scene into it every frame when enabled.
- Both reuse a cached `Vector2` for drawing-buffer size queries (good).

Perf relevance:

- Adds more full-resolution targets and at least one additional render per effect.
- These targets are then sampled by `LightingEffect` during composition.

Watchlist / risks:

- If trees/bushes are common and always enabled, this is “baseline GPU tax” similar to other mask effects.
- Consider invalidation (only redraw when time-of-day/sun/zoom changes beyond threshold).

### 16.8 `BuildingShadowsEffect` (world-space bake + screen-space target)

**Location**: `scripts/effects/BuildingShadowsEffect.js`

Observed patterns:

- Uses a two-stage approach:
  - World-space bake into a fixed-resolution `worldShadowTarget` (2048x2048) when `needsBake` is true.
  - Screen-space render into `shadowTarget` for final sampling/composition.

- Uses a hash (`lastBakeHash`) so the expensive bake only reruns when parameters change (good).

Perf relevance:

- Baking at 2048 can be expensive, but it is not expected to happen every frame.
- Screen-space pass still contributes a steady per-frame cost when enabled.

Watchlist / risks:

- `render()` contains a per-frame allocation:
  - `const size = new THREE.Vector2();` before `renderer.getDrawingBufferSize(size)`.
  - This is small but avoidable GC pressure in a hot path.

Recommended mitigations (design-level):

- Cache and reuse the drawing buffer size vector like other effects (`this._tempSize`).

### 16.9 `BloomEffect` (multi-pass post effect + extra masking passes)

**Location**: `scripts/effects/BloomEffect.js`

Observed patterns:

- Uses `UnrealBloomPass` (multi-pass, multi-mip) plus additional passes:
  - Mask input pre-pass into `_maskedInputTarget` (to zero padding outside `sceneRect`).
  - Composite/bloom output into a dedicated `_bloomTarget` to avoid read/write hazards.

- Computes view bounds per-frame (including perspective-camera reconstruction) and updates multiple uniforms.

- Calls `fogBridge.sync()` per-frame when fog RT is not available (potential redundancy with other fog users).

Perf relevance:

- Bloom is typically one of the highest GPU costs in a post stack (fill-rate + multiple blur mips).
- The extra masking and composite steps add more full-screen passes.

Watchlist / risks:

- Ensure bloom is not running “effectively disabled” (strength ~0) while still doing full work.
- Consider a resolution scale (half/quarter res) for bloom targets.
- Consider centralizing `fogBridge.sync()` calls once-per-frame.

Recommended measurements:

- GPU time with bloom enabled vs disabled.
- GPU time at multiple resolution scales (if supported).


---

## 17) Particle systems audit (three.quarks + mask-driven spawn)

This section covers the particle stack as implemented today:

- `scripts/particles/ParticleSystem.js` (Three.js EffectComposer effect + quarks BatchedRenderer owner)
- `scripts/particles/WeatherParticles.js` (rain/snow + foam/splashes; mask + tile-driven spawn)
- `scripts/particles/FireSparksEffect.js`, `DustMotesEffect.js`, `SmellyFliesEffect.js` (additional quarks-based effects)

### 17.1 `ParticleSystem` (Quarks BatchedRenderer integration)

**Location**: `scripts/particles/ParticleSystem.js`

Observed patterns:

- Owns a single `BatchedRenderer` and calls `batchRenderer.update(dt)` every frame.
- Uses a delta clamp (`Math.min(deltaSec, 0.1)`) to prevent runaway spawns after stalls (good).
- Maintains a custom frustum culling pass (`_applyQuarksCulling()`) and toggles:
  - `emitter.visible`
  - `ps.pause()` / `ps.play()`

Hot-path risks:

- **Per-system object allocation in culling**:
  - Writes `ud._msLastCullCenter = { x: ..., y: ..., z: ... }` once per system per frame.
  - With many systems (weather + fire + dust + flies + misc), this can generate steady GC pressure.
  - Mitigation: store scalars (`_msLastCullCenterX/Y/Z`) or reuse a single object reference.

- **Camera matrix updates**:
  - Calls `camera.updateMatrixWorld(true)` and computes frustum every frame.
  - This is expected, but if other systems already do the same work, consider centralizing (FrameState).

Watchlist:

- Debug timings path (`debugQuarksTimings`) logs to console periodically; OK when off, but ensure it remains off in production.

Recommended measurements:

- Track: number of quarks systems and number of batches (`batchRenderer.batches.length`).
- Profile CPU time for:
  - `WeatherParticles.update()`
  - `_applyQuarksCulling()`
  - `batchRenderer.update(dt)`

### 17.2 `WeatherParticles` (mask + tile-driven spawn)

**Location**: `scripts/particles/WeatherParticles.js`

Observed patterns:

- Uses many quarks `ParticleSystem` instances:
  - Rain, snow
  - Multiple splash atlas systems
  - Water-hit splashes
  - Foam plumes, foam flecks, shoreline foam

- Has explicit performance work:
  - Cached `this._tempWindDir` (Vector3) to avoid per-frame allocations.
  - Uses view-dependent emission bounds (camera-visible rectangle) rather than full-map spawning.

Key CPU hotspot class: mask→point extraction

- Uses a CPU readback path for mask textures:
  - `_getMaskPixelData(maskTexture)` does `ctx.drawImage(image)` and `ctx.getImageData(...)`.
  - This is expensive and allocates large `Uint8ClampedArray` buffers.
- To mitigate, it keeps an LRU cache:
  - `this._maskPixelCache` with `this._maskPixelCacheMaxEntries = 48`.

Watchlist / risks:

- **Memory pressure risk**: caching up to 48 full-resolution RGBA buffers can be very large on big maps.
  - Example order-of-magnitude: a 2048x2048 RGBA buffer is ~16MB; 48 of those is hundreds of MB.
  - Even though it is bounded and cleared on `dispose()`, this can create mid-session memory churn.

- **Point generation churn**:
  - Functions like `_generateWaterHardEdgePoints(...)` allocate new `Float32Array(...)` outputs.
  - Many of these are rebuild-driven (good), but when map/tile masks change frequently, rebuilds can create spikes.

- **Tile mask sampling** (as seen in `_generateTileLocalWaterHardEdgePoints`):
  - Per-tile local sampling includes extra `tileAlphaMask` gating.
  - This is correct for visuals, but it is CPU-heavy if recomputed often.

- **Dual CPU readbacks on first-time tile scans**:
  - Tile water foam generation can trigger:
    - `WeatherParticles._getMaskPixelData(maskTexture)` → `canvas.getImageData(...)` for the tile's `_Water` mask.
    - Tile alpha mask build (inside the tile loop) → `canvas.getImageData(...)` for the tile's base texture alpha, cached in `tileManager.alphaMaskCache`.
  - Worst-case: many tiles become ready in the same frame (async loads resolve), causing a burst of canvas readbacks + full-image scans.

Good cleanup:

- `dispose()` removes quarks systems, removes emitters from scene, disposes textures, and clears `_maskPixelCache`.

Recommended measurements:

- Count and log when rebuilds happen:
  - Water mask uuid/version changes
  - Tile foam revision changes (`_tileFoamRevision`)
- Profile the worst-case cost of:
  - `_getMaskPixelData()`
  - `_generateWaterHardEdgePoints()` and tile-local point generation

Recommended mitigations (design-level; not implementing here):

- Consider lowering `_maskPixelCacheMaxEntries` on constrained devices or large maps.
- Prefer “lookup map” techniques when adding new mask-driven particle effects:
  - Precompute a compact position list once, store in a `DataTexture`, sample on GPU (avoids repeated CPU scans).

### 17.3 Other particle effects (leak vectors + rebuild patterns)

#### 17.3.1 `SmellyFliesEffect`

**Location**: `scripts/particles/SmellyFliesEffect.js`

- Uses `setTimeout(..., 0)` in `_queueRebuildSystems()` to coalesce rebuild requests.
- `dispose()` removes the MapPoints change listener and disposes systems/textures.

Watchlist / leak vector:

- A queued timeout is not explicitly cleared on dispose.
  - Low risk (0ms), but it can still fire after dispose and attempt `_rebuildSystems()` with cleared refs.
  - Mitigation: store timeout id and `clearTimeout` in `dispose()`.

#### 17.3.2 `FireSparksEffect`

**Location**: `scripts/particles/FireSparksEffect.js`

- Uses a debounced flame atlas regeneration via `setTimeout(..., 50)`.

- Heat distortion registration can generate an expanded/blurred heat mask:
  - `_createBoostedHeatMask(...)` uses `ctx.getImageData(...)` and mutates pixels, then runs a CPU blur.
  - `_applyBoxBlur(...)` performs two full passes over the image (horizontal + vertical) and allocates a `Uint8ClampedArray` temp buffer.
  - There is also a separate `_generatePoints(...)` path that reads the `_Fire` mask via `ctx.getImageData(...)`.

Watchlist / leak vector:

- Timeout handle (`_flameAtlasRegenerateTimeout`) is cleared when rescheduling, but not explicitly cleared in `dispose()`.
  - If the effect is disposed while a regen is queued, it may run after teardown.

#### 17.3.3 `DustMotesEffect` (brief)

**Location**: `scripts/particles/DustMotesEffect.js`

- Actively tears down its system when disabled (`update()` calls `_disposeSystem()`), which is good for perf testing.
- Disposes its particle texture in `dispose()`.

Watchlist / risks:

- `_generatePoints(...)` uses `getImageData(...)` for up to three masks:
  - dust mask (required)
  - structural mask (optional)
  - outdoors mask (optional)
  - This can be a large CPU hit during initialization or when swapping asset bundles.

#### 17.3.4 `ParticleBuffers` (GPU buffer helper)

**Location**: `scripts/particles/ParticleBuffers.js`

Watchlist / leak vector:

- `initialize()` creates a `THREE.DataTexture` (`this.emitterTexture`) but `dispose()` does not dispose or null it.
  - If this class is reintroduced/reinitialized in the future, it could retain GPU resources longer than intended.

### 17.4 Summary: particle-system performance risks

| Issue | Severity | Location | Impact |
|------|----------|----------|--------|
| Per-system allocations during quarks culling (`_msLastCullCenter = { ... }`) | **Medium** | `ParticleSystem._applyQuarksCulling()` | Steady GC pressure proportional to number of systems |
| Mask pixel readbacks (`getImageData`) | **High** | `WeatherParticles._getMaskPixelData()` | Large CPU time + large transient memory allocations |
| Tile alpha mask CPU readbacks (`getImageData`) | **Medium** | `WeatherParticles` tile foam loop (`tileManager.alphaMaskCache`) | Burst CPU time on first encounter with many transparent tiles |
| Large mask pixel cache bound (48 entries) | **Medium** | `WeatherParticles` | Potential high RAM use on large maps |
| Rebuild spikes (tile foam revision, mask changes) | **Medium** | `WeatherParticles` | Burst CPU cost during edits/scene changes |
| Un-cleared queued timeouts | **Low** | `SmellyFliesEffect`, `FireSparksEffect` | Potential post-dispose work / subtle leaks |
| Heat distortion mask CPU blur (`getImageData` + box blur) | **Medium** | `FireSparksEffect` | Large CPU burst when registering heat distortion / changing relevant params |
| Dust mask CPU sampling (`getImageData`) | **Medium** | `DustMotesEffect._generatePoints()` | CPU burst when rebuilding spawn points |
| DataTexture not disposed | **Low** | `ParticleBuffers` | Possible GPU resource retention if reused |

### 17.5 Recommended next measurements (practical)

- Add a lightweight counter for:
  - total quarks systems
  - total quarks batches
  - number of `WeatherParticles` rebuilds per minute
- Profile a worst-case map (large resolution masks + many tiles) and measure:
  - `WeatherParticles.update()`
  - time inside `_getMaskPixelData()`
  - total JS heap growth over 5 minutes with weather enabled

## 18) Mask systems audit (production, caching, derived masks)

This section focuses on the module-wide “mask ecosystem”, because masks are used both as:

- GPU textures sampled in shaders (`sampler2D` inputs)
- CPU-side pixel lookups (`getImageData` / `readPixels` style paths)

### 18.1 `MaskManager` (registry + derived masks)

**Location**: `scripts/masks/MaskManager.js`

What it does:

- Provides a central registry (`this._masks`) of textures by id string.
- Can define derived masks via recipes (`this._recipes`) and render them via fullscreen quad into internal `THREE.WebGLRenderTarget`s (`this._derived`).

Performance characteristics:

- Derived masks are created using *GPU fullscreen passes*:
  - `_evaluateDerived()` does `renderer.setRenderTarget(rt.a); renderer.render(quadScene, quadCamera)`.
  - `getOrCreateBlurredMask()` does at least:
    - 1 boost pass
    - `blurPasses` times: horizontal + vertical blur passes (2 draws per pass)
  - This is *fast compared to CPU scans*, but it is still extra render work and extra render targets.

Watchlist / risks:

- **Render target footprint**:
  - `_getOrCreateDerivedTargets()` always allocates 3 render targets per derived id (`a`, `b`, `boost`), even when an operation only needs one.
  - Derived mask sizes default to the full input texture size; for screen-space inputs that typically means full drawing buffer size.

- **Resize churn**:
  - On resize, `setSize()` is called on derived render targets.
  - This can cause GPU allocation churn if resizes happen frequently (window resizing, devicePixelRatio changes).

- **Derived mask re-evaluation semantics** (correctness + perf implication):
  - `getTexture(id)` returns an existing record from `this._masks` without re-validating recipe dependencies.
  - Once a derived mask has been computed and inserted via `setTexture(id, outTex, { source: 'derived', ... })`, subsequent `getTexture(id)` calls will *not* re-run `_evaluateDerived()`.
  - If a derived mask is intended to track dynamic inputs (e.g. derived from `roofAlpha.screen`), it will not update unless something explicitly clears or overwrites that id.
  - If this behavior is changed in the future to re-evaluate more often, it becomes a performance risk: a derived mask could add one or more fullscreen renders per frame.

Recommended measurements:

- Count how many derived ids are ever realized at runtime (i.e. present in `maskManager._masks` with `source: 'derived'`).
- Track how many times per second any derived-mask recipe is evaluated (if/when re-evaluation is implemented).
- Track total derived RT memory usage:
  - `sum(width * height * bytesPerPixel)` for all `_derived` targets.

### 18.2 Screen-space mask publishers (render targets registered in `MaskManager`)

#### 18.2.1 `LightingEffect` → `MaskManager`

**Location**: `scripts/effects/LightingEffect.js`

Publishes these dynamic render-target textures:

- `roofAlpha.screen` (channels: `a`)
- `weatherRoofAlpha.screen` (channels: `a`)
- `ropeMask.screen` (channels: `a`)
- `tokenMask.screen` (channels: `a`)
- `outdoors.screen` (channels: `r`)

Notable pattern:

- The `setTexture(...)` call is guarded by `if (tex && tex !== this._publishedX)`.
  - This means the registry update happens when the texture object identity changes (typically creation / resize), not every frame.
  - The underlying GPU work is still done every frame because these targets are rendered every frame by `LightingEffect.render()`.

#### 18.2.2 `CloudEffect` → `MaskManager`

**Location**: `scripts/effects/CloudEffect.js`

Publishes these dynamic render-target textures:

- `cloudShadow.screen`
- `cloudShadowRaw.screen`
- `cloudDensity.screen`
- `cloudShadowBlocker.screen`
- `cloudTopBlocker.screen`

Risk note:

- These targets are not “free”: each additional mask is a render target allocation plus (potentially) extra render passes.
- Their `MaskManager` metadata marks them `lifecycle: 'dynamicPerFrame'`, so any future derived-mask systems that depend on them should be careful about re-evaluation frequency.

### 18.3 CPU-side mask caches / readbacks

#### 18.3.1 `WeatherController` roof/outdoors CPU extraction + distance field

**Location**: `scripts/core/WeatherController.js`

What happens when `_Outdoors` is set (via `weatherController.setRoofMap(texture)`):

- `_extractRoofMaskData(image)` does:
  - `document.createElement('canvas')`
  - `ctx.getImageData(...)` (with `willReadFrequently: true`)
  - Downscales to max 1024px on the longer dimension.
  - Packs red channel into `Uint8Array(w*h)` (`this.roofMaskData`) for cheap CPU sampling.
- `_buildRoofDistanceMap()` builds a chamfer distance transform:
  - Allocates `Int32Array(w*h)` and produces an RGBA8 `Uint8Array(w*h*4)`.
  - Uploads a `THREE.DataTexture` (`this.roofDistanceMap`).
  - Disposes the previous `roofDistanceMap` before replacing.

Perf assessment:

- This is a deliberate CPU readback, but it’s bounded (<=1024x1024) and should be a “scene load spike” rather than a per-frame cost.

Watchlist / leak vector:

- `WeatherController` is a long-lived singleton. If it never receives a subsequent `setRoofMap(null)` and has no explicit `dispose()`, `roofDistanceMap` can persist until reload.
  - It is disposed on replacement, but teardown semantics should be confirmed (module disable / scene swap).

#### 18.3.2 `TileManager.alphaMaskCache` (tile base texture alpha lookup)

**Location**: `scripts/scene/tile-manager.js`

- `alphaMaskCache` stores `{width, height, data: Uint8ClampedArray}` for tile base textures.
- Cache is populated lazily via:
  - `canvas.getContext('2d')`
  - `ctx.getImageData(...)`
- The cache is cleared in `TileManager.dispose(clearCache=true)`.

Watchlist / risks:

- **Unbounded cache growth**:
  - There is no eviction policy. Scenes with many unique tile textures can accumulate large RGBA buffers.
- **Burst CPU on first-time scans**:
  - When many tile images become ready around the same time, the first-time `getImageData` scans can cluster into a single frame burst.

Recommended measurements:

- Track `alphaMaskCache.size` and approximate bytes held:
  - `sum(width * height * 4)`.
- Track count and timing of alpha mask builds per minute.

### 18.4 Summary: mask-system risks

| Issue | Severity | Location | Impact |
|------|----------|----------|--------|
| Derived masks allocate 3 RTs per id (`a`, `b`, `boost`) | **Medium** | `MaskManager._getOrCreateDerivedTargets()` | VRAM usage scales with derived ids + resolution |
| Derived masks do fullscreen render(s) when evaluated | **Medium** | `MaskManager._evaluateDerived()` | Extra GPU passes; can become per-frame work if re-evaluated often |
| Derived mask update semantics may become expensive if fixed | **Medium** | `MaskManager.getTexture()` + recipes | Risk of “accidental per-frame recompute” if multiple consumers query derived masks |
| Roof/outdoors CPU extraction + distance transform | **Low** | `WeatherController.setRoofMap()` | Scene-load CPU spike; bounded to 1024px |
| Unbounded tile alpha cache | **Medium** | `TileManager.alphaMaskCache` | Potential high RAM and burst `getImageData` costs |

## 19) Render targets audit (ownership, resizing, disposal)

This section focuses on GPU-side memory and allocation churn driven by `THREE.WebGLRenderTarget` usage.

### 19.1 `EffectComposer` shared render targets (post stack)

**Location**: `scripts/effects/EffectComposer.js`

Key targets:

- `sceneRenderTarget`:
  - Created via `ensureSceneRenderTarget()`.
  - Full drawing-buffer size.
  - `type: THREE.FloatType`, `format: RGBA`, `depthBuffer: true`.
- Post-processing ping-pong targets:
  - `post_1` and `post_2` created via `getRenderTarget(name, w, h, depthBuffer=false)`.
  - Full drawing-buffer size.
  - `type: THREE.FloatType`, `format: RGBA`, `depthBuffer: false`.

Watchlist / risks:

- **VRAM pressure**:
  - Full-res `FloatType` RGBA targets are expensive. If WebGL falls back to 32-bit float textures (or emulation paths), VRAM use can be very high.
- **Always-on cost when any post effect is enabled**:
  - The full scene render goes through `sceneRenderTarget` whenever *any* post-processing effect is enabled.
- **Resize behavior**:
  - `EffectComposer.resize()` calls `setSize()` for `sceneRenderTarget` and all named targets.
  - This is generally preferable to dispose+recreate, but still reallocates GPU storage under the hood.

Recommended measurements:

- Measure VRAM usage / `renderer.info.memory.textures` when toggling post FX on/off.
- Confirm whether `FloatType` is actually supported on target devices or whether it triggers fallback performance penalties.

### 19.2 `LightingEffect` (multi-target full-resolution mask + light buffers)

**Location**: `scripts/effects/LightingEffect.js`

Observed targets:

- Full-res HDR buffers:
  - `lightTarget` (`HalfFloatType`, RGBA)
  - `sunLightTarget` (`HalfFloatType`, RGBA)
- Full-res 8-bit masks (RGBA8):
  - `darknessTarget`, `roofAlphaTarget`, `weatherRoofAlphaTarget`, `ropeMaskTarget`, `tokenMaskTarget`, `masksTarget`
  - `outdoorsTarget` when outdoors projection is active

Resize behavior (notable inconsistency):

- `onResize(width, height)` explicitly `dispose()`s and recreates at least:
  - `lightTarget`, `sunLightTarget`, `darknessTarget`
- The main `render()` path also uses `getDrawingBufferSize()` and does `setSize()` on most targets when dimensions change.

Watchlist / risks:

- **High target count at full resolution**:
  - Many full-res render targets means high VRAM use even before other effects allocate their own targets.
- **Dispose+recreate on resize**:
  - Disposing and allocating new targets is usually more likely to cause allocation spikes/hitches than `setSize()` alone.
  - If Foundry/MapShine triggers multiple resize events (UI scale changes, browser zoom, DPR changes), this can be disruptive.

### 19.3 `CloudEffect` (internal-resolution render targets)

**Location**: `scripts/effects/CloudEffect.js`

Key optimization:

- Uses `internalResolutionScale` (default `0.5`) via `_getInternalRenderSize()`.
- Allocates multiple cloud-related targets (density, shadow, tops, blockers), all sized to the internal resolution.

Watchlist / risks:

- **Target count still high**:
  - Even at half res, there are many RTs (cloud density, shadow density, shadow, raw shadow, top density, top, two blockers).
- **Resize always calls `setSize()`**:
  - The code calls `setSize(iW, iH)` without checking if the size actually changed.
  - Likely low impact, but if resize is called frequently it can still trigger redundant work.

### 19.4 `DistortionManager` (distortion + blur + occluder targets)

**Location**: `scripts/effects/DistortionManager.js`

Targets:

- `distortionTarget`: full-res `HalfFloatType` RGBA
- `waterOccluderTarget`: scaled `UnsignedByteType` RGBA (scale factor `this._waterOccluderScale`)
- `blurTargetA/B`: 0.5 scale `HalfFloatType` RGBA ping-pong

Positive pattern:

- Uses `setSize()` in `onResize()` rather than dispose+recreate.

### 19.5 `WorldSpaceFogEffect` (vision/exploration render targets + readback coupling)

**Location**: `scripts/effects/WorldSpaceFogEffect.js`

Targets:

- `visionRenderTarget`: RGBA8 (vision mask)
- `_explorationTargetA/B`: RGBA8 ping-pong accumulation targets

Resize behavior:

- `resize(width, height)` explicitly disposes and recreates:
  - `visionRenderTarget`, `_explorationTargetA`, `_explorationTargetB`
- Also rebuilds fog plane geometry.

Watchlist / risks:

- **Dispose+recreate on resize**: potential allocation spikes.
- **Readback cost tied to RT size**:
  - Exploration persistence uses `renderer.readRenderTargetPixels(...)` (tiled), and the cost scales with the RT pixel count.
  - This effect already caps targets (2048) to bound readback cost.

### 19.6 `BloomEffect` (extra full-res post targets)

**Location**: `scripts/effects/BloomEffect.js`

- Uses at least two full-res `WebGLRenderTarget`s:
  - `_bloomTarget`
  - `_maskedInputTarget`
- Uses `setSize()` on resize and disposes on `dispose()`.

### 19.7 Shadow effects (screen targets + fixed bake targets)

**Locations**:

- `scripts/effects/OverheadShadowsEffect.js`:
  - `roofTarget` + `shadowTarget` (screen-sized)
- `scripts/effects/BuildingShadowsEffect.js`:
  - `shadowTarget` (screen-sized)
  - `worldShadowTarget` fixed `2048x2048` bake target

Watchlist / risks:

- Fixed-size bake targets are predictable and stable, but they add a baseline VRAM cost.

### 19.8 Summary: render-target risks

| Issue | Severity | Location | Impact |
|------|----------|----------|--------|
| Full-res `FloatType` post buffers | **High** | `EffectComposer` | High VRAM usage when post FX enabled |
| Many full-res targets (masks + lighting) | **High** | `LightingEffect` | High VRAM + many per-frame passes |
| Dispose+recreate on resize | **Medium** | `LightingEffect.onResize`, `WorldSpaceFogEffect.resize` | Allocation spikes / stutter on resize events |
| Many RTs even at internal res | **Medium** | `CloudEffect` | VRAM + extra passes; mitigated by scaling |
| Additional full-res post targets | **Medium** | `BloomEffect` | VRAM + bandwidth |
| Fixed 2048 bake RTs | **Low** | `BuildingShadowsEffect` | Constant VRAM budget |

### 19.9 Recommended next measurements (practical)

- Log render target dimensions and count (per effect) after scene load and after a resize.
- Record `renderer.info.memory.textures` and `renderer.info.render.calls` with:
  - post-processing disabled vs enabled
  - clouds enabled vs disabled
  - lighting enabled vs disabled
- Stress-test resizes (window resize / UI scale / DPR change) and record:
  - peak frame time
  - whether WebGL context loss or long stalls occur

## 20) Lighting system deep dive (LightingEffect + light sources)

This section focuses on the *lighting system as a whole*: CPU work (light lifecycle, geometry rebuilds, animation updates), GPU work (multi-pass accumulation into multiple render targets), and leak vectors.

### 20.1 `LightingEffect` pipeline overview

**Location**: `scripts/effects/LightingEffect.js`

High-level pipeline:

- **Per-frame CPU update** (`update(timeInfo)`):
  - Updates animations for every active light:
    - `for (const light of this.lights.values()) light.updateAnimation(timeInfo, this.params.darknessLevel)`
    - Same for `mapshineLights`
    - Updates animations for `darknessSources` and `mapshineDarknessSources`
  - Pushes composite shader uniforms (darkness, outdoor brightness, sun gain/blur, lightning flash params, and shadow opacities).

- **Per-frame GPU render** (`render(renderer, scene, camera)`):
  - Allocates/resizes a significant set of full-resolution targets (see Section 19.2).
  - Produces screen-space masks:
    - `roofAlphaTarget` (ROOF_LAYER)
    - `weatherRoofAlphaTarget` (WEATHER_ROOF_LAYER)
    - `ropeMaskTarget` (ROPE_MASK_LAYER)
    - `tokenMaskTarget` (TOKEN_MASK_LAYER)
    - `outdoorsTarget` (if outdoors projection active)
  - Packs masks into a single `masksTarget` (RGBA pack: outdoorsR, ropeA, tokenA, roofA).
  - Accumulates:
    - `lightScene` → `lightTarget` (HalfFloat)
    - `sunLightScene` → `sunLightTarget` (HalfFloat)
    - `darknessScene` → `darknessTarget` (RGBA8)
  - Composites everything in a full-screen shader (`compositeMaterial`) over the base scene texture.

Assessment:

- This is expected to be one of the highest GPU-cost systems in the module due to:
  - many full-res targets
  - multiple full-scene renders per frame
  - heavy fragment shader work in the final composite

### 20.2 Hook-driven rebuild triggers (CPU spikes)

`LightingEffect` registers Foundry hooks during `initialize()` and removes them in `dispose()` (good cleanup).

Key spike sources:

- `lightingRefresh` → `onLightingRefresh()`:
  - Forces `updateData(doc, true)` for every Foundry light and every MapShine-native light.
  - This can be extremely expensive if it triggers wall-clipped polygon rebuilds (see 20.3).

- Wall/door edits → `forceRebuildLightGeometriesFromWalls()`:
  - Also calls `updateData(doc, true)` across the light set.
  - Expected to be rare, but it is a worst-case “rebuild everything” path.

- Scene flag updates (`Hooks.on('updateScene', ...)`) → `_reloadMapshineLightsFromScene()`:
  - Can rebuild MapShine-native lights and toggle suppression of Foundry lights.
  - Mostly a low-frequency event, but can cause many disposes/rebuilds if a large light set is edited.

### 20.3 `ThreeLightSource` geometry rebuild cost drivers

**Location**: `scripts/effects/ThreeLightSource.js`

The heaviest single-light CPU work is inside `rebuildGeometry(...)`:

- Computes a wall-clipped visibility polygon using `VisionPolygonComputer`:
  - `_lightLosComputer.compute(centerF, computeRadiusPx, ..., { sense: 'light' })`
- Converts points into `THREE.Vector2` instances (allocations proportional to polygon vertex count).
- Applies an inset using `ClipperLib.ClipperOffset` when available (also CPU-heavy).
- Builds a new `THREE.ShapeGeometry(shape)`; falls back to `CircleGeometry(radiusPx, 128)` if polygon fails.
- Disposes the previous geometry (good), removes from parent to avoid duplicates (good).

Key rebuild triggers:

- `updateData(doc, true)` explicitly.
- `updateData()` will rebuild when:
  - radius changes, or
  - the authored anchor position changes.
- `updateAnimation()` may call `updateData(doc, true)` due to:
  - **zoom-driven wallInset changes** (throttled to ~10Hz):
    - because wall inset is specified in screen pixels and converted to world units by zoom.
  - **circle fallback upgrade path** (see next).

High-risk behavior:

- **Circle fallback upgrade can become “rebuild every frame”**:
  - If `_usingCircleFallback` stays true, `updateAnimation()` calls `updateData(this.document, true)`.
  - If the wall polygon never becomes available (or always fails), this becomes a per-frame geometry rebuild loop.
  - This is a major CPU + GC risk in scenes where lights frequently fail LOS polygon generation.

### 20.4 Light animation update costs

**Locations**:

- `LightingEffect.update()` loops over every light/darkness source and calls `updateAnimation(...)`.
- `ThreeLightSource.updateAnimation()` does:
  - many math ops (fine)
  - potentially expensive `game.audio.getMaxBandLevel(...)` calls for `reactivepulse` (audio-driven) lights.
  - cable swing simulation for `cableswing` (spring integration + noise), but mostly allocation-free.

Perf assessment:

- With many lights, the animation loop cost becomes roughly O(N lights).
- The real danger is when animation updates *trigger geometry rebuilds* (zoom/inset or fallback upgrade).

### 20.5 Cookie (gobo) textures: lifecycle & leak risk

**Location**: `scripts/effects/ThreeLightSource.js` (`_updateCookieFromConfig`)

- Cookie textures are loaded asynchronously with `loadTexture(path, { suppressProbeErrors: true })`.
- Per-light fields:
  - `this._cookieTexture`, `this._cookiePath`, `this._cookieLoadVersion`

Watchlist / leak vector:

- When a cookie path changes or is disabled:
  - `this._cookieTexture` is nulled and the uniform is cleared, but the previous texture is not disposed.
- `dispose()` only disposes `mesh.geometry` and `mesh.material`.
  - It does not dispose `this._cookieTexture`.
- If `loadTexture` returns globally cached textures, disposing here might be incorrect.
  - But if it returns unique textures (or if cookies are frequently swapped with unique URLs), this can behave like a VRAM retention vector.

Recommended mitigation direction (design-level; not implementing here):

- Confirm whether `loadTexture` is globally cached/ref-counted.
- If not ref-counted, implement ref counting for cookie textures or a shared cache keyed by `path`, and dispose on last release.

### 20.6 Darkness sources (`ThreeDarknessSource`)

**Location**: `scripts/effects/ThreeDarknessSource.js`

- Geometry rebuild uses Foundry’s LOS polygon when available (`placeable.lightSource.los`), else circle fallback.
- No explicit throttling for zoom/inset; rebuilds only on `updateData(forceRebuild)`.

### 20.7 Render targets and resize semantics (lighting-specific)

**Location**: `scripts/effects/LightingEffect.js`

- `render()` uses `setSize()` when the drawing buffer size changes.
- `onResize()` disposes and recreates several targets.

Watchlist / risks:

- The combination of:
  - EffectComposer calling `effect.onResize(renderW, renderH)`
  - plus `LightingEffect.render()` doing its own size checks
  can lead to “double work” on resize events.

### 20.8 Summary: lighting system risks

| Issue | Severity | Location | Impact |
|------|----------|----------|--------|
| Many full-res render passes and targets | **High** | `LightingEffect.render()` | High GPU time + VRAM footprint |
| `lightingRefresh` rebuilds all lights | **High** | `LightingEffect.onLightingRefresh()` | Large CPU spike; can hitch hard on big scenes |
| Zoom/inset-driven rebuilds (10Hz per light while zooming) | **Medium** | `ThreeLightSource.updateAnimation()` | Stutter during zoom with many lights |
| Circle-fallback upgrade potentially causes per-frame rebuild loop | **High** | `ThreeLightSource.updateAnimation()` | Catastrophic CPU + GC if LOS never resolves |
| Cookie texture lifecycle unclear | **Medium** | `ThreeLightSource._updateCookieFromConfig()` | Potential VRAM retention when swapping cookies |
| Audio-reactive animation calls into `game.audio` | **Low/Medium** | `ThreeLightSource.animateSoundPulse()` | CPU cost scales with number of reactive lights |

### 20.9 Recommended next measurements (practical)

- Track counts:
  - total Foundry lights, total MapShine lights
  - number of `updateData(..., true)` calls per minute
  - number of `rebuildGeometry(...)` calls per minute
  - how many lights are `_usingCircleFallback === true` and for how long
- Time the expensive paths:
  - `VisionPolygonComputer.compute(...)` per rebuild
  - `ClipperOffset.Execute(...)` per rebuild (if ClipperLib present)
  - total time in `LightingEffect.update()` and `LightingEffect.render()`
- VRAM/renderer stats:
  - `renderer.info.render.calls` and `renderer.info.memory.textures` with lighting enabled vs disabled
  - scene with many lights vs few lights
