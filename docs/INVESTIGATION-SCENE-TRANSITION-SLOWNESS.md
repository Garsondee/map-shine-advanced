# Investigation: Slow Scene Transitions / Long Black Screen (30s+)

## Symptom
When switching scenes (activating a new scene):
- A loading screen appears instantly.
- It fades to black.
- There is a long **black pause** (reported 30s+).
- Eventually the loading UI appears again, and the scene finishes loading.
- No console errors.

This is most noticeable when switching between two scenes, especially scenes with many/large assets.

## Current Understanding (From Code)
The scene transition experience is driven by a **combination** of:
- Foundry scene lifecycle (teardown → load → canvasReady)
- Map Shine’s transition wrapper and its own teardown/init steps

### 1) Fade-to-black occurs BEFORE Foundry tears down the old scene
File: `scripts/foundry/canvas-replacement.js`

Map Shine wraps `Canvas.prototype.tearDown`:
- `loadingOverlay.showLoading('Switching scenes…')`
- `await loadingOverlay.fadeToBlack(5000)`
- `loadingOverlay.setMessage('Loading…')`
- `loadingOverlay.setProgress(0, { immediate: true })`
- then calls Foundry’s original `tearDown`

Implication:
- Once `fadeToBlack` starts, the screen is expected to be black until the next scene initialization advances the overlay state.
- Any long synchronous stall during teardown or subsequent initialization will manifest as a “black gap”.

### 2) Map Shine teardown is triggered by Foundry `canvasTearDown` hook
File: `scripts/foundry/canvas-replacement.js`

Hook: `Hooks.on('canvasTearDown', onCanvasTearDown)`

`onCanvasTearDown()` does (high-level):
- Pause `effectComposer.timeManager`
- Dispose `frameCoordinator`
- Dispose `maskManager`
- Calls `destroyThreeCanvas()`
- Clears globals (`window.MapShine.* = null` for most systems)

### 3) `destroyThreeCanvas()` is a large synchronous cleanup routine
File: `scripts/foundry/canvas-replacement.js`

`destroyThreeCanvas()` disposes many systems sequentially:
- `uiManager.dispose()`
- `controlPanel.destroy()`
- `cameraFollower.dispose()`
- `pixiInputBridge.dispose()`
- `controlsIntegration.destroy()`
- `renderLoop.stop()`
- `dropHandler.dispose()`
- managers: `tokenManager.dispose()`, `tileManager.dispose()`, `wallManager.dispose()`, etc.
- `effectComposer.dispose()`
- `sceneComposer.dispose()`
- removes WebGL context listeners
- removes the Three canvas element
- calls `restoreFoundryRendering()`

Implication:
- If any of the above `.dispose()` calls do heavy synchronous GPU disposal, texture cleanup, or iterate large scene graphs, it can block the main thread.
- During that block, the overlay won’t update (because the browser can’t repaint).

### 4) Map Shine initialization for the new scene runs on `canvasReady`
File: `scripts/foundry/canvas-replacement.js`

Hook: `Hooks.on('canvasReady', onCanvasReady)`

If the scene is enabled, `onCanvasReady`:
- `loadingOverlay.showBlack('Loading <scene>…')`
- calls `await createThreeCanvas(scene)`

`createThreeCanvas()` then:
- destroys any existing canvas again (`destroyThreeCanvas()` at entry)
- creates / attaches renderer canvas
- creates and initializes:
  - `SceneComposer.initialize(...)` (with `onProgress` callback)
  - `MaskManager` setup
  - `WeatherController.initialize()`
  - `EffectComposer.initialize()`
  - registers many effects (awaited)
  - initializes all managers (tokens, tiles, walls, drawings, notes, etc.)
  - starts `RenderLoop`
  - waits for “proof of render” via `waitForThreeFrames(...)`
  - fades overlay in via `loadingOverlay.fadeIn(5000)`

Implication:
- A stall can happen either in Foundry’s own scene load or in Map Shine’s initialization.
- The symptom “black pause then loading UI comes back later” can happen if the browser is blocked during teardown or if `showBlack()` runs but progress updates can’t repaint.

## Why Scene Swaps Can Be Worse Than First Load
Some plausible reasons (hypotheses):

## Water-heavy scenes: direction-dependent repro (new observation)
Repro pattern reported:
- **Start in a water-heavy scene** (lots of very large water areas / water masks) → transition to a non-water scene: overlay behaves normally.
- **Start in a non-water scene** → transition into a **water-heavy scene**: long black gap appears.

This pattern strongly suggests a **one-time cost** that is paid the first time the Water system is initialized on the client (or the first time a “large water” mask is processed), rather than a constant per-transition cost.

### What WaterEffectV2 does during init
Files:
- `scripts/foundry/canvas-replacement.js` registers `WaterEffectV2` and later calls `waterEffect.setBaseMesh(basePlane, bundle)`.
- `scripts/effects/WaterEffectV2.js` selects a `_Water` mask from the `assetBundle` and triggers a rebuild.
- `scripts/effects/WaterSurfaceModel.js` builds a derived `DataTexture` by CPU-processing the mask.

The key potentially-expensive step on water-heavy scenes is:
- `WaterEffectV2.setBaseMesh(...)` → `this._rebuildWaterDataIfNeeded(true)`
- which ultimately calls `WaterSurfaceModel.buildFromMaskTexture(maskTexture, ...)`

In `WaterSurfaceModel.buildFromMaskTexture`, we do synchronous CPU work:
- Create an offscreen `<canvas>` at `resolution x resolution` (default appears to be 512).
- `ctx.drawImage(img, 0, 0, w, h)` and `ctx.getImageData(...)`.
- Build a binary mask array.
- Run **two distance transforms** over the mask (`_distanceTransform` twice).
- Write an RGBA output buffer and upload it as a `THREE.DataTexture`.

Even though the processing resolution is fixed (typically 512), this is still a chunky synchronous block and can cause a noticeable freeze if it coincides with other work (Foundry scene init, GPU pipeline compilation, GC).

### Additional hypotheses specific to water
**H5: First-time shader compilation / pipeline compilation for WaterEffectV2**
`WaterEffectV2`’s fragment shader is relatively large and may trigger an expensive first compile/link on some GPUs/drivers.
- If you start in a non-water scene, the first time the water effect is enabled/has a water mask might be during a scene transition.
- If you start in the water-heavy scene first, that cost happens during initial load, making later transitions appear “fixed”.

**H6: Water data preprocessing + driver upload stalls the main thread**
The `DataTexture` upload (`tex.needsUpdate = true`) can cause WebGL driver work, and combined with other resource uploads during scene swap can create a long single-thread stall.

**H7: Water mask size indirectly increases cost via image decode / upload**
Even though we downsample to 512 for CPU processing, `maskTexture.image` still needs to exist (decoded image). Large source masks can:
- Increase decode time.
- Increase texture upload time.
- Increase memory pressure → GC.

### How to confirm (add measurements)
Add timing markers around these water-specific phases:
- In `createThreeCanvas(...)`, right before and after `waterEffect.setBaseMesh(basePlane, bundle)`.
- In `WaterEffectV2.setBaseMesh(...)`, right before and after `_rebuildWaterDataIfNeeded(true)`.
- In `WaterSurfaceModel.buildFromMaskTexture(...)`, measure:
  - `drawImage + getImageData`
  - each `_distanceTransform` pass
  - the final “out” write loop
  - `new THREE.DataTexture(...)` + `tex.needsUpdate = true`

Correlate those markers with:
- The timestamp gap between `Canvas.tearDown` wrapper and `canvasReady`.
- The timestamp gap between `onCanvasReady` and the first visible overlay update.

### Fast sanity checks (no fixes)
- Confirm whether the problem only occurs when a `_Water` mask exists (i.e., `assetBundle.masks` contains `id === 'water'`).
- Confirm whether the water-heavy scene has very large `_Water` mask dimensions (e.g. 8k x 4k).
- In a DevTools Performance recording, look specifically for a long task that includes `getImageData`, JS loops from `WaterSurfaceModel`, or WebGL program compilation.

### H1: Teardown path is expensive (dispose storm)
On a first load, there is no prior Three scene to dispose.
On a scene swap, we do a full disposal chain plus Foundry teardown.
If disposal triggers:
- massive texture/material disposal
- renderer internal cache flush
- scene graph traversal (many meshes/sprites)

…then we pay that cost only during transitions.

### H2: Asset discovery overhead scales with number of files
File: `scripts/assets/loader.js`

`loadAssetBundle()`:
- Calls `discoverAvailableFiles(basePath)` via Foundry `FilePicker`.
- Iterates mask definitions and loads only those present.

If FilePicker directory listing is slow (many files / remote storage / network / module packs), it can add large latency.

### H3: Waiting on Foundry before `canvasReady`
We fade to black inside `Canvas.tearDown` wrapper.
If Foundry takes a long time between `tearDown` and the next `canvasReady` (scene data, texture fetch, compendium references, large scene, modules), we will be black with no updates.

### H4: Overlay update starvation (browser can’t repaint)
Even if we call `loadingOverlay.showLoading/showBlack`, the DOM won’t visibly update if:
- the main thread is blocked (sync loops)
- GC is running long
- WebGL driver calls block the JS thread

This would explain “it fades to black then nothing for 30s, then UI appears”.

## Immediate Suspects (Based on Code)
- `Canvas.prototype.tearDown` wrapper awaiting `fadeToBlack(5000)` followed immediately by Foundry teardown.
- `onCanvasTearDown → destroyThreeCanvas()` doing extensive synchronous disposal.
- `effectComposer.dispose()` and `sceneComposer.dispose()` (unknown internal cost yet).
- `restoreFoundryRendering()` (unknown internal cost yet).
- `assetLoader.discoverAvailableFiles()` via FilePicker.

## What We Need To Measure (Before Fixing)
We need timestamps around each major phase to determine if the 30s is:
- mostly Foundry (between `tearDown` and `canvasReady`)
- mostly Map Shine teardown (inside `destroyThreeCanvas`)
- mostly Map Shine init (inside `createThreeCanvas` / `SceneComposer.initialize` / effect registration)

### A) Timeline Markers to Add
(Implementation later; this doc is just the plan.)

Add `performance.now()` stamps (or `console.time/timeEnd`) at:

**Transition wrapper** (`Canvas.tearDown` wrapper):
- before `showLoading`
- before/after `fadeToBlack`
- just before calling original `tearDown`
- just after original `tearDown` resolves

**Hooks:**
- start/end of `onCanvasTearDown`
- start/end of `destroyThreeCanvas`
- start/end of `onCanvasReady`

**Create path:**
- start/end of `createThreeCanvas`
- start/end of `sceneComposer.initialize`
- start/end of `effectComposer.initialize`
- per-effect registration duration (optional)
- start/end of token/tile sync (`syncAllTokens`, `syncAllTiles`)
- start/end of `waitForThreeFrames`

### B) DevTools Performance Capture
Steps:
1. Open Chrome DevTools → Performance tab.
2. Start recording.
3. Trigger scene switch that reproduces the issue.
4. Stop recording after scene fully renders.

What to look for:
- a single long task (10s+)
- repeated medium tasks that add to 30s
- heavy GC (purple bars)
- network idle vs busy

### C) Confirm whether the gap is “before canvasReady”
We can determine if Foundry is the bottleneck by comparing:
- timestamp when original `Canvas.tearDown` starts/ends
- timestamp when `Hooks.on('canvasReady')` fires

If the gap is mostly between those, it’s likely Foundry’s scene load, not Map Shine’s init.

## Reproduction Checklist
Capture these details for a reliable repro:
- Scene A name + estimated texture count/size
- Scene B name + estimated texture count/size
- Storage type for assets (local, Forge, S3, etc.)
- Whether the assets live in module packs (module `assets/`) vs user data
- Foundry version + browser
- Whether the issue occurs when switching to a “small” scene

## Next Actions
- Add timing markers as above and reproduce to determine where the 30s is spent.
- If teardown dominates: inspect which `.dispose()` is worst.
- If Foundry load dominates: explore whether the black overlay should remain “Loading…” rather than plain black during the gap, and whether we can surface Foundry progress.
- If init dominates: break init into yield points, or defer non-critical systems until after first render.

## Code References
- `scripts/foundry/canvas-replacement.js`
  - `installCanvasTransitionWrapper()` wraps `Canvas.prototype.tearDown`
  - `onCanvasTearDown()`
  - `destroyThreeCanvas()`
  - `onCanvasReady()`
  - `createThreeCanvas(scene)`
- `scripts/ui/loading-overlay.js`
  - `showLoading()`, `showBlack()`, `fadeToBlack()`, `fadeIn()`
- `scripts/assets/loader.js`
  - `loadAssetBundle()`, `discoverAvailableFiles()`
