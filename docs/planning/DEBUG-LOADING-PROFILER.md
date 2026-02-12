# Debug Loading Profiler

## High-Level Goal

Identify which elements, textures, effects, and managers are slowing down scene loading so we can target optimizations. The current loading pipeline runs many tasks in parallel, which obscures individual task costs. This feature provides a **sequential-only debug mode** with granular timing, resource metrics, and a persistent log overlay.

## Problem Statement

- The loading pipeline in `createThreeCanvas()` runs effect initialization in parallel batches (concurrency=4) and manager initialization via `Promise.all()`.
- Existing `_sectionTimings` are coarse-grained (5-6 buckets) and only logged to console.
- No way to see per-effect, per-manager, per-texture timing in a single view.
- Loading overlay auto-fades, making it impossible to capture timing data.
- No resource usage metrics (memory, texture count, GPU memory estimates).

## Feature Design

### 1. Debug Mode Toggle

- **Location**: `scripts/core/loading-profiler.js` (extend existing `LoadingProfiler`)
- **Flag**: `LoadingProfiler.debugMode` — when `true`, activates all debug features
- **Default**: `true` for development (will be toggled off for release)
- **Effect**: When debug mode is active during a scene load:
  - All parallel loading is forced sequential (one task at a time)
  - Every task is individually timed with start/end/delta
  - The loading overlay shows a scrollable, selectable text log
  - The overlay does NOT auto-fade; a manual "Dismiss" button is shown instead

### 2. Sequential Loading Enforcement

When `debugMode` is `true`, the following parallel sections in `createThreeCanvas()` are converted to sequential:

| Section | Normal Behavior | Debug Behavior |
|---|---|---|
| `registerEffectBatch()` | Concurrency = 4 | Concurrency = 1 |
| Lightweight manager `Promise.all()` | 7 managers in parallel | Sequential `for` loop |
| `wireBaseMeshes()` | Already sequential | No change |

### 3. Granular Timing Instrumentation

Every discrete loading task gets a `profiler.begin(id)` / `profiler.end(id)` pair. The profiler records:

- **id**: Human-readable task name (e.g., `"effect.Specular.initialize"`)
- **start**: `performance.now()` timestamp
- **end**: `performance.now()` timestamp  
- **durationMs**: `end - start`
- **category**: One of `cleanup`, `setup`, `texture`, `effect`, `manager`, `sync`, `finalize`
- **meta**: Optional metadata (texture dimensions, byte sizes, effect class name)

#### Tasks to Instrument

**Phase: Cleanup & Setup**
- `cleanup` — `destroyThreeCanvas()`
- `waitForFoundryCanvas` — `_waitForFoundryCanvasReady()`
- `canvas.create` — DOM element creation and insertion
- `renderer.attach` — Renderer canvas swap and sizing

**Phase: Scene Composer**  
- `sceneComposer.initialize` — Full scene composer init (already timed)
- `gpu.textureWarmup` — GPU texture upload (already timed)
- `maskManager.register` — Registering bundle masks

**Phase: Weather**
- `weatherController.initialize` — Weather system init

**Phase: Independent Effects (one entry per effect)**
- `effect.<Name>.construct` — Constructor call
- `effect.<Name>.initialize` — `initialize()` call
- `effect.<Name>.setBaseMesh` — `setBaseMesh()` / `setAssetBundle()` call

**Phase: Dependent Effects (sequential)**
- `effect.ParticleSystem.register`
- `effect.FireSparks.register`
- `effect.DustMotes.register`
- `effect.AshDisturbance.register`
- `effect.LightEnhancementStore.init`
- `effect.Lighting.register`
- `effect.CandleFlames.register`

**Phase: Graphics Settings**
- `graphicsSettings.init`
- `graphicsSettings.wire`

**Phase: Scene Managers**
- `manager.Grid.init`
- `manager.TokenManager.init`
- `manager.TokenManager.syncAll`
- `manager.VisibilityController.init`
- `manager.DetectionFilter.init`
- `manager.DynamicExposure.init`
- `manager.TileManager.init`
- `manager.TileManager.syncAll`
- `manager.SurfaceRegistry.init`
- `manager.WallManager.init`
- `manager.DoorMesh.init`
- `manager.Drawing.init`
- `manager.Note.init`
- `manager.Template.init`
- `manager.LightIcon.init`
- `manager.EnhancedLightIcon.init`
- `manager.MapPoints.init`
- `manager.PhysicsRope.init`

**Phase: Interaction & UI**
- `manager.Interaction.init`
- `manager.OverlayUI.init`
- `manager.LightEditor.init`
- `manager.DropHandler.init`
- `manager.CameraFollower.init`
- `manager.PixiInputBridge.init`
- `manager.ControlsIntegration.init`
- `manager.ModeManager.init`

**Phase: Finalization**
- `fin.initializeUI` — Tweakpane UI setup (already timed)
- `fin.effectReadiness` — Waiting for effect readiness promises
- `fin.waitForTiles` — Tile texture decoding
- `fin.waitForThreeFrames` — First render confirmation
- `fin.timeOfDay` — Time-of-day application
- `fin.fadeIn` — Overlay fade (skipped in debug mode)

### 4. Resource Metrics

Collected at key points during loading and appended to the log:

- **Texture count**: `renderer.info.memory.textures`
- **Geometry count**: `renderer.info.memory.geometries`
- **Draw calls**: `renderer.info.render.calls` (snapshot after first frame)
- **Triangles**: `renderer.info.render.triangles`
- **JS Heap** (if available): `performance.memory.usedJSHeapSize` / `totalJSHeapSize`
- **GPU memory estimate**: Sum of texture dimensions × bytes-per-pixel for all loaded masks
- **Texture inventory**: List of all loaded textures with dimensions and format

### 5. Debug Loading Overlay UI

Additions to the existing `LoadingOverlay` when debug mode is active:

#### Log Panel
- Scrollable `<pre>` element below the progress bar
- Monospace font, dark background, light text
- **Selectable text** — user can click and drag to select, Ctrl+A to select all
- Each line format: `[+0.000s] [category] taskId — 123.4ms`
- Auto-scrolls to bottom as new entries appear
- Max height ~40vh with overflow scroll

#### Dismiss Button
- Replaces auto-fade behavior in debug mode
- Large, obvious button: "Dismiss Loading Log"
- Positioned below the log panel
- Clicking it triggers the normal `fadeIn()` dismissal

#### Copy Button  
- Small "Copy Log" button in the top-right of the log panel
- Copies full log text to clipboard via `navigator.clipboard.writeText()`

### 6. Log Format

```
═══════════════════════════════════════════════════
  MAP SHINE — DEBUG LOADING PROFILE
  Scene: "My Battle Map"
  Date: 2025-02-11T13:19:00.000Z
═══════════════════════════════════════════════════

[+0.000s] [cleanup]  cleanup — 12.3ms
[+0.012s] [setup]    waitForFoundryCanvas — 45.1ms
[+0.057s] [setup]    canvas.create — 2.1ms
[+0.059s] [setup]    renderer.attach — 8.4ms
[+0.068s] [texture]  sceneComposer.initialize — 1234.5ms
[+1.302s] [texture]  gpu.textureWarmup — 89.2ms
[+1.391s] [texture]  maskManager.register — 3.1ms
[+1.394s] [effect]   effect.Specular.initialize — 45.2ms
[+1.440s] [effect]   effect.Iridescence.initialize — 12.1ms
...
[+4.521s] [manager]  manager.TokenManager.syncAll — 23.4ms
...
[+6.789s] [final]    fin.waitForThreeFrames — 456.7ms

═══════════════════════════════════════════════════
  SUMMARY
═══════════════════════════════════════════════════

Total Load Time: 7245.1ms

By Category:
  texture:  1326.8ms (18.3%)
  effect:   2345.6ms (32.4%)  ← BOTTLENECK
  manager:   987.3ms (13.6%)
  sync:      543.2ms  (7.5%)
  final:    1456.7ms (20.1%)
  other:     585.5ms  (8.1%)

Top 10 Slowest Tasks:
  1. sceneComposer.initialize    1234.5ms
  2. fin.waitForThreeFrames       456.7ms
  3. effect.Fog.initialize        234.5ms
  ...

Resource Snapshot:
  Textures: 47
  Geometries: 23
  JS Heap: 128.4 MB / 512.0 MB
  Est. GPU Textures: ~312 MB
  Draw Calls (frame 1): 34
  Triangles (frame 1): 12,456
```

## Implementation Plan

### Files to Create
- `scripts/core/debug-loading-profiler.js` — Enhanced profiler with log generation, sequential enforcement, and resource metrics

### Files to Modify
- `scripts/ui/loading-overlay.js` — Add debug log panel, dismiss button, copy button
- `scripts/foundry/canvas-replacement.js` — Instrument all tasks, use sequential mode when debug active
- `scripts/core/loading-profiler.js` — Add `debugMode` flag

## Success Criteria

- Loading with debug mode produces a complete, selectable text log
- Every effect, manager, and texture load has individual timing
- Log persists on screen until manually dismissed
- Parallel loading is disabled so timings are accurate
- Resource metrics are collected and displayed
- Log can be copied to clipboard with one click
- Toggling debug mode off restores normal parallel loading and auto-fade
