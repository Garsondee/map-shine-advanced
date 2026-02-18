# Architectural Improvements Roadmap

**Purpose**: Non-feature architectural improvements to make Map Shine Advanced more logical, reliable, and maintainable.

---

## High-Impact Structural Improvements

### 1. Decompose `canvas-replacement.js` (224KB, 5770 lines)

**Status**: 🟡 In Progress  
**Impact**: High  
**Effort**: High

`canvas-replacement.js` is a god module handling hooks, initialization, teardown, effect wiring, manager creation, resize handling, mode switching, fog wrapping, weather syncing, UI initialization, and more.

**Proposed Split**:
- **`foundry/scene-lifecycle.js`** — `createThreeCanvas`, `destroyThreeCanvas`, `resetScene`, `onCanvasReady`, `onCanvasTearDown`
- **`foundry/effect-wiring.js`** — Effect construction, batch registration, base mesh wiring, graphics settings registration
- **`foundry/manager-wiring.js`** — Scene manager creation, sync, and cross-wiring (tokens, tiles, walls, map points, etc.)
- **`foundry/mode-manager.js`** — Gameplay/Map Maker mode switching, PIXI state capture/restore, select rect suppression
- **`foundry/resize-handler.js`** — Resize observer, debouncing, render resolution application
- **`foundry/canvas-replacement.js`** — Remains as a thin orchestrator calling into the above

**Benefits**:
- Initialization flow becomes testable and navigable
- Clear separation of concerns
- Easier to debug specific lifecycle phases

---

### 2. Decompose `interaction-manager.js` (287KB)

**Status**: ❌ Not Started  
**Impact**: High  
**Effort**: High

By far the largest file, handling every interaction type in one class.

**Proposed Split**:
- **`scene/token-interaction.js`** — Select, multi-select, drag-move, wall collision, HUD
- **`scene/wall-interaction.js`** — Wall drawing, endpoint dragging, snapping
- **`scene/light-interaction.js`** — Light placement, drag-to-create, preview ring
- **`scene/selection-box.js`** — Drag-select rectangle logic (separate from SelectionBoxEffect rendering)
- **`scene/interaction-manager.js`** — Thin coordinator that delegates to appropriate handlers based on active tool/layer

**Benefits**:
- Interaction handlers become unit-testable
- Clear ownership of interaction types
- Easier to extend with new interaction patterns

---

### 3. Decompose Large Effect Files

**Status**: ❌ Not Started  
**Impact**: High  
**Effort**: Medium

Several effects are disproportionately large, suggesting mixed responsibilities:

| File | Size | Proposed Decomposition |
|---|---|---|
| `WaterEffectV2.js` | 189KB | Separate shader generation, surface simulation, reflection pass, caustics, flow logic |
| `WindowLightEffect.js` | 145KB | Separate light pool calculation, specular glint, cloud dimming, shader chunks |
| `PlayerLightEffect.js` | 120KB | Separate flashlight cone, torch glow, token tracking, flag management |
| `DistortionManager.js` | 116KB | Separate per-source-type logic, noise library, composite pass |
| `CloudEffect.js` | 105KB | Separate shadow pass, cloud-top pass, procedural generation |
| `LightingEffect.js` | 104KB | Separate light source management, shader construction, roof occlusion pass |
| `WeatherParticles.js` | 306KB | Separate rain, snow, ash into individual subclasses; extract shared mask/wind logic |

**Benefits**:
- Each component becomes focused and testable
- Easier to reuse shader logic across effects
- Clearer performance profiling

---

### 4. Formalize the Effect Base Class Contract

**Status**: ❌ Not Started  
**Impact**: High  
**Effort**: Medium

Effects currently have an informal interface with inconsistent method signatures and EffectComposer needing defensive `typeof effect.X === 'function'` checks everywhere.

**Proposed Hierarchy**:
```javascript
EffectBase                    // Shared lifecycle: init, update, dispose, capabilities
├── SceneMeshEffect           // setBaseMesh, adds mesh to scene
├── PostProcessEffect         // setBuffers/setInputTexture, fullscreen pass
└── ParticleEffect            // setAssetBundle, particle system integration
```

**Benefits**:
- Enforced interface consistency
- Eliminates defensive programming in EffectComposer
- Clear distinction between effect types

---

## Medium-Impact Reliability Improvements

### 5. Replace Module-Scope Singletons with Dependency Container

**Status**: ❌ Not Started  
**Impact**: Medium  
**Effort**: Medium

`canvas-replacement.js` has ~40 `let` variables at module scope that create implicit ordering dependencies and hard-to-trace null reference bugs during teardown.

**Implementation**:
- Create `SceneContext` object holding all manager/effect references
- Pass context explicitly rather than relying on module-scope closures
- On teardown, dispose entire context atomically

**Benefits**:
- Explicit dependency graph
- Easier unit testing of individual managers
- Cleaner scene lifecycle management

---

### 6. Extract Weather State Replication

**Status**: ❌ Not Started  
**Impact**: Medium  
**Effort**: Low

The `onUpdateScene` handler (lines 521–661) contains deeply nested flag-checking logic for replicating weather/time state.

**Implementation**:
- Create `WeatherSync` module that parses `changes.flags['map-shine-advanced']`
- Dispatch to appropriate controllers (weatherController, stateApplier, controlPanel)
- Handle transition commands, dynamic state, snapshots

**Benefits**:
- Weather replication logic becomes testable
- Clear separation of network sync from local state
- Easier to extend with new syncable properties

---

### 7. Eliminate `initializeUI`'s 30+ Positional Parameters

**Status**: ❌ Not Started  
**Impact**: Medium  
**Effort**: Low

Function signature at line 2467 takes every effect as a positional argument, making it extremely fragile.

**Before**:
```javascript
async function initializeUI(specularEffect, iridescenceEffect, colorCorrectionEffect, /* ... 27 more ... */)
```

**After**:
```javascript
async function initializeUI(effectMap, { sceneComposer, effectComposer, weatherController })
```

**Benefits**:
- No more parameter ordering issues
- Easier to add/remove effects
- Cleaner function signature

---

### 8. Remove Dead Code

**Status**: ❌ Not Started  
**Impact**: Medium  
**Effort**: Low

**Files to Remove**:
- `FogEffect.js` and `FogEffect.old.js` — superseded by `WorldSpaceFogEffect.js`
- `FoundryFogBridge.js` — marked deprecated in memories
- `camera-controller.js` — superseded by `CameraFollower` + `PixiInputBridge`
- `camera-sync.js` — superseded by `CameraFollower`
- `docs/Stale/` — 55+ stale planning documents

**Benefits**:
- Reduced bundle size
- Eliminates confusion for new developers
- Cleaner codebase navigation

---

### 9. Consistent Error Handling Strategy

**Status**: ❌ Not Started  
**Impact**: Medium  
**Effort**: Low

Three different patterns exist:
- `try { ... } catch (_) { }` (silent swallow)
- `try { ... } catch (e) { log.warn(...) }` (logged warning)
- `try { ... } catch (e) { log.error(...); throw e }` (rethrow)

**Implementation**:
- Define categories: **critical** (rethrow), **degraded** (log.warn + continue), **cosmetic** (silent OK)
- Add `safeCall(fn, context, severity)` utility
- Reserve empty catch blocks for truly optional features only

**Benefits**:
- Consistent error handling patterns
- Better debugging experience
- Clear distinction between expected vs unexpected failures

---

## Lower-Impact Maintainability Improvements

### 10. Add Unit Tests for Core Logic

**Status**: ❌ Not Started  
**Impact**: Low  
**Effort**: Medium

No unit tests exist, only Playwright perf benchmarks. Target pure-logic modules:

- `coordinates.js` — Foundry↔Three.js conversion (critical correctness)
- `WeatherController` — State transitions, preset interpolation, dynamic evolution
- `MaskManager` — Derived mask computation, boost/blur operations
- `VisionPolygonComputer` — Raycasting correctness
- `scene-settings.js` — Three-tier override resolution
- `time.js` — Pause transitions, scaling, frame counting

**Benefits**:
- Catch regressions early
- Document expected behavior
- Enable confident refactoring

---

### 11. Reduce `window.MapShine` Surface Area

**Status**: ❌ Not Started  
**Impact**: Low  
**Effort**: Low

Everything is exposed globally for debugging, but systems also *read* from `window.MapShine` in production code, creating implicit coupling.

**Implementation**:
- Keep `window.MapShine` for debugging/console access only
- In production code, pass dependencies explicitly
- Add lint rule: `window.MapShine` access only in debug/console-helper code

**Benefits**:
- Explicit dependency graph
- Easier to test individual components
- Clear separation of debug vs production APIs

---

### 12. Standardize Effect Parameter Schemas

**Status**: ❌ Not Started  
**Impact**: Low  
**Effort**: Medium

Each effect defines parameters differently — class properties, `this.params` objects, or mixed.

**Implementation**:
- Define standard schema format for effect parameters
- Auto-generate Tweakpane UI from schema (reducing `tweakpane-manager.js` from 184KB)
- Automatic serialization/deserialization for scene flags
- Built-in parameter validation

**Benefits**:
- Consistent parameter handling across effects
- Reduced boilerplate in TweakpaneManager
- Automatic Graphics Settings integration

---

### 13. Extract Shader Chunks into Shared Library

**Status**: ❌ Not Started  
**Impact**: Low  
**Effort**: Low

Several effects contain duplicated GLSL (simplex noise, FBM, screen-space UV reconstruction, etc.).

**Implementation**:
- Create `shaders/chunks/` directory:
  - `noise.glsl` — simplex2D, FBM, Perlin
  - `coordinates.glsl` — World↔screen UV, scene bounds
  - `masks.glsl` — Roof sampling, outdoor check
  - `common.glsl` — Dithering, tonemapping, color space

**Benefits**:
- Reduced shader duplication
- Easier to maintain and optimize shader code
- Consistent mathematical operations across effects

---

### 14. Loading Profiler as Optional Dev Tool

**Status**: ❌ Not Started  
**Impact**: Low  
**Effort**: Low

`loading-profiler.js` and `profiler.js` are always imported, adding baseline memory and startup cost.

**Implementation**:
- Conditionally load behind `MapShine.debug.profiling = true` flag
- Keep APIs available but no-op when disabled
- Remove from production bundle via tree-shaking

**Benefits**:
- Reduced production memory footprint
- Faster startup times
- Cleaner production codebase

---

## Implementation Priority

### Phase 1 (Critical Path)
1. **Decompose `canvas-replacement.js`** — 🟡 In Progress
   - ✅ `foundry/resize-handler.js` extracted (ResizeHandler class)
   - ✅ `foundry/mode-manager.js` extracted (ModeManager class)
   - ✅ `initializeUI` 30+ positional params → single `effectMap` argument
   - ✅ `foundry/effect-wiring.js` extracted (effect defs, capabilities, settings wiring, base mesh, exposure)
   - ✅ `foundry/manager-wiring.js` extracted (map-points cross-wiring, global exposure)
2. **Formalize Effect Base Class Contract** — ✅ Done
   - `SceneMeshEffect` (world-space mesh overlays)
   - `PostProcessEffect` (screen-space shader passes)
   - `ParticleEffect` (particle system wrappers)
   - Opt-in migration: existing EffectBase subclasses unchanged
3. **Dependency Container** — ✅ `core/scene-context.js` created (SceneContext class)
4. **Error Handling Utility** — ✅ `core/safe-call.js` created (safeCall, Severity, safeDispose)
5. **Dead Code Removal** — ✅ Removed FogEffect.js, FogEffect.old.js, camera-controller.js

### Phase 2 (Reliability)
6. **Decompose `interaction-manager.js`** — ✅ Done (7366 → 4840 lines, −34%)
   - ✅ `scene/map-point-interaction.js` extracted — `MapPointDrawHandler` (970 lines)
     - Drawing, editing, previewing map point groups
     - Context menu, handle drag, point markers
   - ✅ `scene/light-interaction.js` extracted — `LightInteractionHandler` (870 lines)
     - Selected-light outline, placement preview (LOS polygon + shader)
     - Translate gizmo, radius rings gizmo, radius slider overlay
     - Light query helpers, radius commit/live-apply, UI hover label
   - ✅ `scene/selection-box-interaction.js` extracted — `SelectionBoxHandler` (500 lines)
     - 3D selection box mesh (fill + border)
     - Screen-space SVG overlay (patterns, border styles, animations)
     - World-space shadow mesh (shader-based soft edges)
   - All extractions use thin delegation wrappers for backward compatibility
7. **Consistent Error Handling** — ✅ `canvas-replacement.js` + `interaction-manager.js` fully adopted
   - **`canvas-replacement.js`**: Converted **~80 ad-hoc try/catch blocks** → `safeCall` / `safeCallAsync` / `safeDispose`
     - Every call site tagged with a descriptive context string and severity level:
       - **CRITICAL**: `lazyBootstrap` — rethrows, aborts scene init
       - **DEGRADED**: `MaskManager.registerBundleMasks`, `weatherController.setRoofMap`,
         `DynamicExposureManager.init`, `graphicsSettings.initAndWire`, `LightEnhancementStore.init`,
         `registerEffectCapabilities`, `wrapFogManager`, `initializeUI`, etc.
       - **COSMETIC**: All overlay progress calls, UI refresh, windvane, timer logging,
         PIXI suppression, fog overrides, wall transparency, etc.
     - 4 structural `try/catch` blocks intentionally preserved:
       - `initialize()` outer — returns `false` on fatal hook registration failure
       - `_waitForFoundryCanvasReady` polling loop — swallows to keep polling
       - `createThreeCanvas` outer — aborts session and calls `destroyThreeCanvas`
       - `resetScene` outer — ensures `sceneResetInProgress` flag is cleared
     - `onError` / `fallback` options used where callers need recovery values
   - **`interaction-manager.js`**: Converted **~130 ad-hoc try/catch blocks** → `safeCall` / `safeDispose`
     - Coverage across all major methods:
       - **Debug**: `setOverheadHoverDebug`, `_ensureOverheadHoverDebugObjects`, `_updateOverheadHoverDebug`, `_updateOverheadHoverDebugIdle`
       - **Input Routing**: `_isEventFromUI`, `_isTextEditingEvent`, `_consumeKeyEvent`, `initialize` (token movement wiring)
       - **Drag Previews**: `createDragPreviews` (transform copy, radius metadata, material cloning)
       - **Double Click**: `onDoubleClick` (light editor show, raycaster layers)
       - **Wheel**: `onWheel` (full handler body)
       - **Pointer Down**: `onPointerDown` (light override check, forceThree, gizmo layers, icon select, setDragging, radius layers, right-click toggle, token ray layers)
       - **Pointer Move**: `onPointerMove` (pointer tracking, radius slider hide, selection box overlay, shadow, enhanced light drag uniforms with nested dedupe/restore)
       - **Hover**: `handleHover` (camera/scene matrix, gizmo hover, radius hover, roof layers, occlusion check, UV opaque, world Z, wall clear, token layers)
       - **Pointer Up**: `onPointerUp` (light editor show, hover label, light/wall/map-point creation, selection shadow/illumination, grid snap, enhanced light update, gizmo resync, token/light position updates, emergency cleanup)
       - **Keyboard**: `onKeyDown` (copy serialization, paste position/creation, delete enhanced lights)
       - **Selection**: `selectObject` (token control, tint, scale, editor show, inspector hide), `clearSelection` (release, reset tint/scale, deselect, hide editor)
       - **Dispose**: Light outline cleanup, `safeDispose` for SelectionBoxEffect
     - Severity assignments:
       - **DEGRADED**: `forceThree`, Foundry token sync, document creation/update/delete, wall updates, map point commits
       - **COSMETIC**: All UI affordances, debug viz, gizmo layers, serialization fallbacks, hover states, selection visuals
     - 5 structural `try/catch` blocks intentionally preserved as top-level error boundaries:
       - `onDoubleClick` outer — logs and continues
       - `onPointerDown` outer — logs and continues
       - `onPointerMove` outer — logs and continues
       - `onPointerUp` outer — logs, cleans up drag state via `safeCall`
       - `onKeyDown` delete handler — catches "does not exist" race conditions
   - Next: extend adoption to effect classes and other core modules

### Phase 3 (Maintainability)
8. **Decompose Large Effect Files** — Makes effects testable
9. **Standardize Effect Parameter Schemas** — Reduces boilerplate
10. **Add Unit Tests for Core Logic** — Prevents regressions

### Phase 4 (Polish)
11. **Extract Shader Chunks** — Reduces duplication
12. **Reduce `window.MapShine` Surface Area** — Cleaner architecture
13. **Loading Profiler as Optional** — Production optimization
14. **Extract Weather State Replication** — Cleaner sync logic

---

## Notes

- All improvements are **purely architectural** — no user-facing features
- Focus on making the codebase more maintainable for the development team
- Each improvement should be implemented independently to minimize merge conflicts
- Consider creating feature branches for each major decomposition effort
