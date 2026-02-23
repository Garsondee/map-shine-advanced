# Floor Compositor Rebuild — Clean Room Implementation

## Why This Document Exists

The current per-floor rendering pipeline (Phase 2 of `PER-LEVEL-MESH-ARCHITECTURE.md`) was built by bolting floor isolation onto the existing single-pass effect system. After **26+ failed fix attempts** across two separate bugs, the evidence is conclusive: the system is too entangled to debug incrementally.

This document plans a **parallel clean-room rebuild** of the floor compositing system. The old system stays running as a reference. The new system starts from zero and adds one capability at a time, with validation gates between each step.

---

## Organisation

### Directory Structure

Effects and supporting code **physically move** into `compositor-v2/` subdirectories as they pass validation. This makes the codebase itself reflect what has been validated — if it's in `compositor-v2/`, it's cleared; if it's still in `scripts/effects/`, it hasn't been validated yet.

```
scripts/
  compositor-v2/                        ← NEW — the v2 system
    FloorCompositor.js                  ← Core render loop + RT management
    FloorLayer.js                       ← Per-floor state: geometry, masks, effect bindings
    CompositorMaterials.js              ← All shader materials (composite, blit, debug)
    AlphaValidator.js                   ← Debug tooling: readback checks, violation detection
    VALIDATION-REGISTRY.md              ← Single source of truth for validation status

    effects/                            ← Validated effects move here
      (empty at start)
      LightingEffect.js                 ← moved here after Step 3/4 validation
      SpecularEffect.js                 ← moved here after Step 5 validation
      WaterEffectV2.js                  ← moved here after Step 5 validation
      ...etc as each effect passes...

    scene/                              ← Floor-aware scene management (if needed)
      FloorLayerManager.js              ← Layer assignment, floor discovery (replaces FloorStack)

  effects/                              ← EXISTING — old system, frozen
    EffectComposer.js                   ← OLD compositor (setting gate delegates to v2)
    LightingEffect.js                   ← Original, untouched (reference copy)
    WaterEffectV2.js                    ← Original, untouched
    DistortionManager.js                ← Original, untouched
    ...all other effects...

  scene/
    FloorStack.js                       ← EXISTING — reused during transition
    tile-manager.js                     ← EXISTING — tile loading (reused by v2)
    composer.js                         ← EXISTING — SceneComposer (reused by v2)
```

### Migration Flow

When an effect passes validation:

1. **Copy** the effect from `scripts/effects/` to `scripts/compositor-v2/effects/`
2. **Apply any v2 fixes** (e.g., alpha contract enforcement) to the copy
3. The original in `scripts/effects/` stays untouched for the old system
4. `FloorCompositor` imports from `compositor-v2/effects/`, the old `EffectComposer` imports from `effects/`
5. Update `VALIDATION-REGISTRY.md`

Once ALL effects are migrated and the old compositor is retired (Step 7), the originals in `scripts/effects/` can be deleted.

### What Goes Where

| Location | Contents | Rule |
|---|---|---|
| `scripts/compositor-v2/` | All v2 code + validated effect copies | Self-contained. Imports from `scene/` for tile/scene management. Does not import from `effects/`. |
| `scripts/compositor-v2/effects/` | Validated, v2-compatible effect copies | Each file is a copy of the original with v2 fixes applied. The copy IS the v2 version. |
| `scripts/effects/` | Old system, frozen | No more fixes. Only touched to add the setting gate in `EffectComposer.js`. |

### Validation Registry

`scripts/compositor-v2/VALIDATION-REGISTRY.md` is the single source of truth for which effects are cleared for v2. An effect starts as **unvalidated** and moves through stages:

```
UNVALIDATED → REVIEWED → ALPHA-TESTED → INTEGRATED → VALIDATED
```

| Stage | Meaning |
|---|---|
| **UNVALIDATED** | Not yet examined for v2 compatibility |
| **REVIEWED** | Code reviewed for alpha handling, floor state, mask usage |
| **ALPHA-TESTED** | Connected to v2 pipeline in isolation; alpha contract verified with debug tools |
| **INTEGRATED** | Running in v2 pipeline alongside other validated effects |
| **VALIDATED** | Passed full visual + programmatic validation with multi-floor scenes. File moved to `compositor-v2/effects/`. |

Only **VALIDATED** effects are part of the production v2 pipeline.

---

## Three.js Features — What We're Not Using

Before building v2, we should audit what Three.js gives us for free. The current system was built incrementally and missed several features that directly solve the problems we've been fighting.

### Current Layer Usage (Audit)

Three.js provides **32 layers** (0–31). Each `Object3D` can be on multiple layers. Each camera has a layer mask — it only renders objects that share at least one enabled layer. We already use layers extensively:

| Layer | Constant | Purpose |
|---|---|---|
| 0 | (default) | All normal tile sprites, tokens, basePlaneMesh |
| 20 | `ROOF_LAYER` | Overhead/roof tiles |
| 21 | `WEATHER_ROOF_LAYER` | Tiles that block weather particles |
| 22 | `WATER_OCCLUDER_LAYER` | Water occluder meshes |
| 23 | `FLOOR_PRESENCE_LAYER` / `CLOUD_SHADOW_BLOCKER` | Dual use — collision! |
| 24 | `BELOW_FLOOR_PRESENCE_LAYER` / `CLOUD_TOP_BLOCKER` | Dual use — collision! |
| 25 | `ROPE_MASK_LAYER` | Physics rope mask pass |
| 29 | `GLOBAL_SCENE_LAYER` | Drawings, notes — rendered once, not per-floor |
| 30 | `BLOOM_HOTSPOT_LAYER` | Bloom hotspot meshes |
| 31 | `OVERLAY_THREE_LAYER` | Bypass-effects tiles, rendered after post-processing |

**Available:** Layers 1–19 and 26–28 = **22 free layers**. More than enough for floors.

**In the v2 system, layers 22–24 can be reclaimed.** WATER_OCCLUDER_LAYER, FLOOR_PRESENCE_LAYER, and BELOW_FLOOR_PRESENCE_LAYER are all workarounds for the single-pass architecture. Per-floor rendering eliminates them entirely.

### Feature 1: Layers for Floor Isolation ⭐ USE THIS

**Current approach:** `FloorStack.setFloorVisible()` walks every tile sprite and token, saves its `.visible` state, toggles it based on floor ownership, renders, then walks again to restore. This happens **every floor, every frame**.

**Better approach:** Assign each tile sprite to a **floor-specific layer** at creation time (once). Per-floor rendering becomes a single camera mask change:

```js
// At tile creation (once):
sprite.layers.set(FLOOR_LAYERS[floorIndex]);  // e.g., layer 1 for floor 0, layer 2 for floor 1

// At render time (per floor, per frame):
camera.layers.set(floorLayer);               // Only see this floor
camera.layers.enable(GLOBAL_SCENE_LAYER);    // Plus global objects if needed
renderer.render(scene, camera);
```

**Benefits:**
- **No per-frame visibility toggling.** No save/restore loop. No walking tile arrays.
- **Faster.** Three.js culls by layer at the frustum-check level, before any tree traversal.
- **No race conditions.** A tile's layer is set once. There's no mutable visibility state to corrupt.
- **basePlaneMesh** simply goes on the floor-0 layer. No special-casing.
- **Tokens** assigned to their floor's layer. No separate token visibility logic.
- **Clean.** The scene graph never changes during the render loop. Only the camera's view of it changes.

**Layer assignment plan:**

| Layer | Purpose |
|---|---|
| 1 | Floor 0 geometry (ground floor tiles + basePlaneMesh) |
| 2 | Floor 1 geometry |
| 3 | Floor 2 geometry |
| ... | ... |
| 10 | Floor 9 geometry (max 10 floors, more than enough) |
| 20–21 | ROOF_LAYER, WEATHER_ROOF_LAYER (existing, keep) |
| 25 | ROPE_MASK_LAYER (existing, keep) |
| 29 | GLOBAL_SCENE_LAYER (existing, keep) |
| 30 | BLOOM_HOTSPOT_LAYER (existing, keep) |
| 31 | OVERLAY_THREE_LAYER (existing, keep) |

Layers 22–24 are freed (floor-presence workarounds eliminated).

**Impact on FloorStack:** The current `setFloorVisible()`/`restoreVisibility()` pattern becomes unnecessary. `FloorLayerManager` (new) assigns layers at tile creation and provides the camera mask for each floor.

### Feature 2: Stencil Buffer for Alpha Protection ⭐ STRONGLY CONSIDER

**The problem it solves:** Requirement A2/E1 — effects add colour to alpha=0 pixels (transparent areas where no tile geometry exists). This non-zero RGB leaks through compositing. The current system tried to fix this with `c.rgb *= step(0.004, c.a)` in the compositor — a fragile workaround.

**The stencil approach:**

1. Create `_floorRT` with `stencilBuffer: true`
2. Tile materials configured with `stencilWrite: true, stencilRef: 1, stencilZPass: THREE.ReplaceStencilOp`
3. After geometry render: stencil = 1 where tiles exist, stencil = 0 where transparent
4. The **compositor material** uses `stencilFunc: THREE.EqualStencilFunc, stencilRef: 1` — it only composites pixels where geometry actually exists

**Why this is better than fixing each effect:** The stencil is a **hardware guardrail**. Effects don't need to be modified at all. Even if LightingEffect pumps ambient into every pixel, the compositor's stencil test prevents those alpha=0 pixels from ever reaching the accumulation buffer. The bug is structurally impossible.

**Why this might be simpler than it sounds:** Three.js has full stencil support on materials. No WebGL calls needed:

```js
// On tile SpriteMaterial (geometry pass):
material.stencilWrite = true;
material.stencilFunc = THREE.AlwaysStencilFunc;
material.stencilRef = 1;
material.stencilZPass = THREE.ReplaceStencilOp;

// On compositor material (composite pass):
compositorMat.stencilWrite = false;
compositorMat.stencilFunc = THREE.EqualStencilFunc;
compositorMat.stencilRef = 1;
```

**Limitation:** The stencil lives on `_floorRT`. Post-processing effects that ping-pong between `_floorPostA` and `_floorPostB` don't have the stencil. But this is fine — the stencil protects the **final composite step**, which is the only place leakage causes visible artefacts. Effects can do whatever they want internally; the compositor's stencil gate prevents leakage from reaching the accumulation.

**Alternative: `discard` in compositor shader.** Even simpler than stencil — one line in the compositor fragment shader:

```glsl
vec4 c = texture2D(tSrc, vUv);
if (c.a < 0.004) discard;  // Don't composite transparent pixels
gl_FragColor = c;
```

This achieves the same result with zero material configuration. The trade-off: `discard` has a small GPU cost (breaks early-Z), but for a single fullscreen quad it's negligible. And stencil provides a more robust contract for the future.

**Recommendation:** Use BOTH. Stencil on the compositor for structural safety, and `discard` as a belt-and-suspenders backup. Either one alone would work; both together make leakage truly impossible.

### Feature 3: MSAA on Floor Render Target — EVALUATE

**The problem it solves:** Tile edges are aliased (binary alpha: 0 or 1). Semi-transparent edge pixels get wrong alpha values, producing fringe during compositing.

```js
const floorRT = new THREE.WebGLRenderTarget(w, h, {
  samples: 4,  // 4x MSAA
  // ... other options
});
```

**Benefits:**
- Sub-pixel accurate alpha at tile edges. A pixel 50% covered by tile geometry gets alpha ≈ 0.5 instead of 0 or 1.
- Hardware-level — no shader changes needed.
- Could eliminate the white fringe problem entirely at the geometry level.

**Costs:**
- ~4x colour buffer memory per RT (but only `_floorRT` needs it, not the ping-pong or accumulation RTs).
- MSAA only applies to the geometry render, not post-processing fullscreen quads.
- Requires resolve when reading as texture (Three.js handles automatically).

**Recommendation:** Try it in Step 2. If it eliminates fringe at the geometry level, keep it. If not, it wasn't the problem. Easy to toggle.

### Feature 4: Separate Scenes Per Floor — PROBABLY NOT

**The idea:** Instead of one scene with layer masks, create a `THREE.Scene` per floor. Each floor's tiles live in their own scene.

**Pros:** Complete isolation. No layer management at all.

**Cons:**
- Tiles must be added to the right scene at creation time — changes `tile-manager.js` interface.
- Light sources must exist in each scene (or be shared).
- Moving a tile between floors = `scene.remove()` + `scene.add()`.
- Much more disruptive than layers for marginal benefit.

**Recommendation:** Layers are sufficient and far less disruptive. Separate scenes add complexity without clear value.

### Feature 5: `renderer.readRenderTargetPixels()` — USE FOR VALIDATION

Essential for `AlphaValidator`. Reads pixel data from any render target:

```js
const buf = new Float32Array(4);
renderer.readRenderTargetPixels(floorRT, x, y, 1, 1, buf);
// buf = [R, G, B, A] — check for premultiplied violations
```

### Feature 6: `renderer.compile()` — USE FOR PRE-WARMING

Pre-compiles all shaders for a scene + camera combination during loading:

```js
renderer.compile(scene, camera);
```

Prevents shader compilation stalls on first render. Call after all materials are created.

### Summary of Three.js Feature Decisions

| Feature | Decision | Impact |
|---|---|---|
| **Layers for floor isolation** | ⭐ USE | Replaces FloorStack visibility toggling. Tile layer assigned once at creation. Camera mask swapped per floor. |
| **Stencil buffer on compositor** | ⭐ USE | Hardware guardrail: prevents compositing alpha=0 pixels. Eliminates entire class of ambient-leakage bugs. |
| **`discard` in compositor shader** | ⭐ USE | Belt-and-suspenders backup for stencil. One line of GLSL. |
| **MSAA on `_floorRT`** | EVALUATE | Try in Step 2. May eliminate tile-edge fringe at hardware level. Easy to toggle. |
| **Separate scenes per floor** | SKIP | Layers are sufficient. Separate scenes are too disruptive for marginal benefit. |
| **`readRenderTargetPixels`** | USE | Essential for AlphaValidator programmatic checks. |
| **`renderer.compile()`** | USE | Pre-warm shaders during loading. Prevent first-frame stalls. |

### How These Features Change the Architecture

The combination of **layers + stencil + discard** transforms the problem space:

1. **Floor isolation becomes trivial.** No visibility management. Just change the camera mask. One line of code per floor.

2. **Alpha contamination becomes structurally impossible.** Effects can be sloppy with alpha=0 pixels. The compositor's stencil + discard gate prevents leakage. This eliminates the need to audit every effect's alpha handling — though we still validate for correctness.

3. **The compositor shader is truly a pass-through.** No premultiply, no step(), no smoothstep, no clip. Just `texture2D(tSrc, vUv)` with `discard` for safety. All the complexity that caused 6+ failed fix attempts is gone.

4. **FloorStack becomes FloorLayerManager.** Instead of save/toggle/restore, it assigns layers at tile creation and provides `getLayerMask(floorIndex)` for the camera.

---

## Dependent Systems Audit

Every system that touches floor rendering, mask distribution, or the render loop. Each entry states what v2 does with it.

### Systems V2 Directly Replaces or Eliminates

| System | File | What It Does Now | V2 Disposition |
|---|---|---|---|
| **FloorStack** | `scripts/scene/FloorStack.js` | `setFloorVisible()` / `restoreVisibility()` — per-frame visibility toggling of tiles/tokens/basePlaneMesh per floor. | **Replaced by `FloorLayerManager`**. Layers assigned once at tile creation. No per-frame toggling. FloorStack kept for `getVisibleFloors()` / `rebuildFloors()` / floor discovery, but visibility methods become unused. |
| **`_compositeMaterial` (shared)** | `scripts/effects/EffectComposer.js` | Single material shared between floor→accumulation and accumulation→screen blits, with runtime blend mode swaps. | **Eliminated.** Two separate materials in `CompositorMaterials.js` with fixed blend settings. |
| **`_applyFloorAlphaClip`** | `scripts/effects/EffectComposer.js` | Screen-space alpha clip pass using outdoorsTarget to mask upper floor transparency. | **Eliminated.** Tile WebP alpha IS the clip (A6). Stencil + discard handle any residual. |
| **Floor ID texture** | `scripts/masks/GpuSceneMaskCompositor.js` | `buildFloorIdTexture()` — world-space texture encoding which floor owns each pixel. Used by water/fog for per-pixel floor gating. | **Eliminated (F8).** Per-floor rendering makes this unnecessary. Each floor's effects only see their own RT. |
| **`preserveAcrossFloors` policy** | `scripts/assets/EffectMaskRegistry.js` | Binary keep/replace per mask type during `transitionToFloor()`. Water = preserve, outdoors = don't. | **Eliminated (F6).** Each floor permanently owns its masks via `_floorMeta`. No cross-floor mask sharing. |
| **Floor-presence render targets** | `scripts/scene/tile-manager.js`, `scripts/effects/DistortionManager.js` | `FLOOR_PRESENCE_LAYER` (23), `BELOW_FLOOR_PRESENCE_LAYER` (24), `floorPresenceTarget`, `belowFloorPresenceTarget` — screen-space tile coverage for cross-floor suppression. | **Eliminated (F7).** Per-floor rendering removes the need. Layers 22–24 freed. |
| **Water occluder meshes** | `scripts/scene/tile-manager.js`, `scripts/effects/DistortionManager.js` | `waterOccluderMesh`, `aboveFloorBlockerMesh`, `WATER_OCCLUDER_LAYER` (22), `waterOccluderScene` — screen-space water suppression under upper floor tiles. | **Eliminated (T6).** Water only runs on its own floor's RT. No cross-floor suppression needed. |
| **`_patchWaterMasksForUpperFloors`** | `scripts/masks/GpuSceneMaskCompositor.js` | Post-hoc patching of ground floor water mask to exclude upper floor tile footprints. | **Eliminated (M3, T7).** Each floor's water mask comes directly from `_floorMeta`. No patching. |

### Systems V2 Reuses (Possibly Modified)

| System | File | What It Does Now | V2 Interaction |
|---|---|---|---|
| **EffectMaskRegistry** | `scripts/assets/EffectMaskRegistry.js` | Central mask state manager. Effects subscribe to mask types. `transitionToFloor()` atomically swaps masks with per-type policies. `beginTransition()`/`endTransition()` locks. | **Simplified.** V2 bypasses `transitionToFloor()` entirely — `FloorCompositor` calls `effect.bindFloorMasks(floorMeta, floorKey)` directly for each floor in the render loop. The registry is still useful for initial mask seeding and effect subscription discovery, but the floor-transition protocol and `preserveAcrossFloors` policies are unused. Consider whether effects should still subscribe to the registry or receive masks directly from `FloorLayer`. |
| **GpuSceneMaskCompositor** | `scripts/masks/GpuSceneMaskCompositor.js` | `composeFloor()` — GPU-composites per-tile masks into per-floor RTs. `preloadAllFloors()` — pre-warms all floor caches. `_floorMeta` — per-floor mask bundles. `_floorCache` — per-floor GPU RTs. | **Reused for mask data.** V2 reads `_floorMeta` to get per-floor mask bundles. `preloadAllFloors()` still called during loading. `buildFloorIdTexture()` no longer called. `_patchWaterMasksForUpperFloors()` no longer called. The compositor itself is unchanged — v2 consumes its output differently. |
| **MaskManager** | `scripts/masks/MaskManager.js` | Texture registry for derived masks (depth texture, etc.). Effects discover some textures through `maskManager.getTexture()`. | **Unchanged.** Still needed for depth texture publication from DepthPassManager and any non-floor-scoped mask discovery. |
| **DepthPassManager** | `scripts/scene/depth-pass-manager.js` | `captureForFloor()` — per-floor depth capture. Copies `mainCamera.layers.mask` to `depthCamera.layers.mask`. Publishes depth texture to MaskManager. | **Reused with automatic compatibility.** Since `captureForFloor()` copies `mainCamera.layers.mask`, and v2 sets the camera's layer mask per floor, the depth camera automatically gets the correct floor's layer mask. No code changes needed. Called inside the v2 floor loop. |
| **TileEffectBindingManager** | `scripts/scene/TileEffectBindingManager.js` | Per-tile overlay routing for Specular, Fluid, Tree, Bush, Iridescence. `TileManager` calls it at tile create/update/remove lifecycle. | **Reused, no changes.** Per-tile bindings are orthogonal to floor compositing. Effects that use per-tile overlays (Specular sampling building shadow RT, Tree sway, etc.) get their per-tile data through this manager regardless of which floor the tile is on. The v2 floor loop ensures only the correct floor's tiles are visible during rendering. |
| **TileMotionManager** | `scripts/scene/tile-motion-manager.js` | Animated tile UV scrolling/panning. Registered as `addUpdatable()` on EffectComposer. | **Unchanged.** Floor-independent. Updates tile UVs globally; v2 layer masks ensure only the right floor's animated tiles are visible. |
| **canvas-replacement.js level-change handler** | `scripts/foundry/canvas-replacement.js` | `mapShineLevelContextChanged` hook handler. Triggers: registry transition locks, FloorStack rebuild, `composeFloor()`, `transitionToFloor()`, floor ID texture build, MaskManager redistribution, depth invalidation, render request. | **Needs v2 branch.** When `useNewCompositor` is on: skip `transitionToFloor()`, skip `buildFloorIdTexture()`, skip floor-presence mesh updates. Still call `composeFloor()` (to populate `_floorMeta`), `FloorStack.rebuildFloors()` (for floor discovery), and `FloorLayerManager.reassignLayers()` (to update tile layer assignments when floor bands change). Add `renderLoop.requestRender()` to trigger a re-render. |
| **WeatherController** | `scripts/core/WeatherController.js` | Gets `_Outdoors` roof map via `setRoofMap()` at scene load. Rain/snow/puddles use it to suppress precipitation under roofs. | **Unchanged.** Weather is visually global (rain falls everywhere on screen). The roof map determines where precipitation is blocked. Uses the active floor's outdoor mask, set once during level changes. Not per-floor — precipitation is a screen-space overlay. |

### Systems V2 Does Not Touch

| System | File | Why Unaffected |
|---|---|---|
| **RenderLoop** | `scripts/core/render-loop.js` | Just calls `effectComposer.render()`. The setting gate in EffectComposer delegates to FloorCompositor. |
| **FrameCoordinator / FrameState** | `scripts/core/frame-coordinator.js`, `frame-state.js` | Frame timing and state tracking. Not floor-aware. |
| **LayerVisibilityManager** | `scripts/foundry/layer-visibility-manager.js` | Controls **PIXI** layer visibility (Foundry canvas overlays). Has nothing to do with Three.js layers. Name collision with our "floor layers" is cosmetic only. |
| **Vision / Fog system** | `scripts/vision/VisionManager.js`, `FogManager.js`, `VisibilityController.js` | Fog of war, vision polygons, wall-height filtering. Always from the player's perspective (single viewpoint). Responds to `mapShineLevelContextChanged` for token visibility. Not involved in floor compositing — renders as a global overlay. |
| **Levels compatibility layer** | `scripts/foundry/levels-*.js`, `elevation-context.js` | Determines which level the player is on, fires `mapShineLevelContextChanged`. V2 consumes this event the same way. |
| **scene-mask-compositor.js** | `scripts/masks/scene-mask-compositor.js` | CPU fallback mask compositor (non-GPU path). Rarely used. Unaffected by v2. |
| **SceneComposer** | `scripts/scene/composer.js` | Asset bundle loading, background image, `basePlaneMesh`. V2 reuses `basePlaneMesh` (assigns to floor 0 layer) and `currentBundle`. No changes. |

### Pre-Warming During Loading

Currently in `canvas-replacement.js` after `preloadAllFloors()`:

1. All `_floorMeta` entries are iterated
2. Every floor-scoped effect gets `bindFloorMasks(meta, floorKey)` called
3. This pre-builds water SDFs, fire particle maps, lighting states, etc.

**V2 equivalent:** Same pattern, but additionally:
- **All floors must be pre-warmed and pre-loaded**:
  - All floor-scoped effects must be pre-warmed with `bindFloorMasks(meta, floorKey)` for every floor key in `_floorMeta`.
  - All floor RTs must be allocated and sized.
  - All compositor materials must be created.
  - All shaders must be pre-compiled with `renderer.compile(scene, camera)` for at least one representative camera mask.
- **Swap latency target:** < 1 second to become visually stable after a floor change, including on the first swap after scene load.
- **What must be ready by the time the loading screen dismisses:**
  1. **All floors composed** (GPU mask compositor warm): `gpuSceneMaskCompositor.preloadAllFloors()` completed.
  2. **All tile sprites assigned to their floor layers**:
    - Call `FloorLayerManager.assignTileToFloor(sprite, tileDoc)` for all existing sprites.
    - Ensure overhead tiles have additive `ROOF_LAYER` / `WEATHER_ROOF_LAYER` enabled in addition to their floor layer.
  3. **basePlaneMesh layer assignment**: assign to floor 0 layer once.
  4. **All floor-scoped effect state pre-built**:
    - For every floor key in `_floorMeta`, call `effect.bindFloorMasks(meta, floorKey)` for every floor-scoped effect.
    - Immediately call one cheap `effect.update({ dt: 0 })` (if applicable) so any lazy one-time allocations happen during loading.
  5. **All render targets allocated and sized**:
    - `_floorRT`, `_floorPostA`, `_floorPostB`, `_accumulationRT` are created in Step 0/1 (no first-use allocation during play).
  6. **All compositor materials created**:
    - Create `CompositorMaterials` up-front so shader compilation happens during load.
  7. **Shader compilation warm-up**:
    - Call `renderer.compile(scene, camera)` for at least one representative camera mask.
    - Then do a single offscreen warm render per floor layer (render to a tiny RT) to force compilation of any material variants that depend on layer visibility.

**Floor switch must not do:**
- Re-run `preloadAllFloors()`.
- Rebuild SDFs/particle lookup maps.
- Allocate render targets/materials.
- Recompute large CPU caches.

**Floor switch may do (cheap):**
- Swap camera layer mask.
- Set “active floor key” for UI/state.
- Request one render (`renderLoop.requestRender()`).

### Key Wiring Changes in canvas-replacement.js

| Hook / Call Site | Current Behaviour | V2 Change |
|---|---|---|
| `mapShineLevelContextChanged` — registry transition | `reg.beginTransition()`, `reg.transitionToFloor()`, `reg.endTransition()` | Skip when `useNewCompositor` is on. V2 reads `_floorMeta` directly. |
| `mapShineLevelContextChanged` — floor ID texture | `compositor.buildFloorIdTexture(floorBundles)` | Skip when `useNewCompositor` is on. Eliminated. |
| `mapShineLevelContextChanged` — FloorStack rebuild | `floorStack.rebuildFloors(sceneLevels, context)` | Keep. V2 still uses `getVisibleFloors()` for floor discovery. |
| `mapShineLevelContextChanged` — MaskManager redistribution | `mm.setTexture(...)` for each mask | Keep. MaskManager is unrelated to floor compositing. |
| `mapShineLevelContextChanged` — depth invalidation | `depthPassManager.invalidate()` | Keep. Depth still needs refresh. |
| `preloadAllFloors()` — effect pre-warming | `eff.bindFloorMasks(meta, floorKey)` for all effects × floors | Keep + add `FloorLayerManager.assignTileToFloor()` for all tiles. |
| FloorStack init | `floorStack = new FloorStack(); floorStack.setManagers(...)` | Keep FloorStack for floor discovery. Add `FloorLayerManager` init after FloorStack. |
| Floor-presence scene wiring | `tileManager.setFloorPresenceScene(fpScene); distortionManager.setFloorPresenceScene(fpScene)` | Skip when `useNewCompositor` is on. Floor-presence eliminated. |
| Water occluder scene wiring | `tileManager.setWaterOccluderScene(distortionManager.waterOccluderScene)` | Skip when `useNewCompositor` is on. Occluders eliminated. |

---

## Comprehensive Requirements

Everything the new system must address, extracted from 26+ failed attempts across `LAYERING-FAILURE-RECORD.md`, `webp-border-fix-log.md`, `PER-LEVEL-MESH-ARCHITECTURE.md`, and `LEVELS-ARCHITECTURE-RETHINK.md`.

### Category 1 — Fundamental Architecture Failures

These are structural problems. No amount of patching fixes them in the current system.

| # | Requirement | Source | What Failed |
|---|---|---|---|
| F1 | **Per-floor rendering, not single-pass** | LAYERING-FAILURE Attempts 1–20 | A single global post-processing pass cannot distinguish which floor a pixel belongs to. Water, distortion, fog all run once for the entire screen. Both floors are visible simultaneously through transparency gaps, so no global toggle is correct. |
| F2 | **Effects must be floor-independent by construction** | LAYERING-FAILURE §Architectural Analysis | WaterEffectV2 and DistortionManager are global POST_PROCESSING effects — they run once per frame for the entire screen. Setting `waterMask = null` disables water for ALL pixels. There is no per-pixel floor discrimination. |
| F3 | **Same pixels need different behaviour depending on viewer's floor** | LAYERING-FAILURE Attempt 17 | From the ground floor: water must render everywhere including under upper floor tiles. From the upper floor: water must NOT render under upper floor tiles. Both apply to the same screen pixels. |
| F4 | **No shared mutable state between floors** | LAYERING-FAILURE Attempt 3 | `_activeFloorKey` points to the last floor the compositor processed, not the player's floor. Any state written during one floor's pass is stale when the next floor reads it. |
| F5 | **One mesh per floor, one scene render per floor** | PER-LEVEL-MESH §Problem 8 | The current system does a single `renderer.render()` with all geometry visible. Effects see all floors mixed together. |
| F6 | **No `preserveAcrossFloors` policy** | LAYERING-FAILURE Attempts 15–16, 19 | Binary keep/replace per mask type creates paradoxes. Water `preserveAcrossFloors:true` flooded upper floors; `false` killed water on ground floor visible through gaps. Each floor must permanently own its own masks. |
| F7 | **No floor-presence screen-space workarounds** | PER-LEVEL-MESH §Problem 12 | `floorPresenceTarget`, `belowFloorPresenceTarget` are screen-space, resolution-dependent, viewport-dependent, and require duplicating tile geometry as separate meshes. Eliminated by per-floor rendering. |
| F8 | **No Floor ID texture gating** | LAYERING-FAILURE Attempts 14, 17, 18 | Floor ID texture is world-space, not view-dependent. Cannot distinguish "upper floor tile seen from above" (suppress water) vs "seen from below" (show water). Every gate based solely on `floorIdR` fails. |

### Category 2 — Alpha and Blending Failures

These are the direct cause of the visual artifacts (white fringe, ambient leakage, grey canvas).

| # | Requirement | Source | What Failed |
|---|---|---|---|
| A1 | **Single alpha convention across entire pipeline** | webp-border-fix Attempts 3, 5, 6 | `SpriteMaterial` NormalBlending into a cleared RT produces premultiplied content. The compositor sometimes treated it as straight alpha (`SrcAlpha/OneMinusSrcAlpha`), sometimes as premultiplied (`One/OneMinusSrcAlpha`). Every mismatch creates artifacts. |
| A2 | **Effects must not add colour to alpha=0 pixels** | webp-border-fix Attempt 7 | LightingEffect adds ambient/darkness to ALL pixels including transparent ones (alpha=0). Produces `(0.1, 0.1, 0.1, 0)`. With `One/OneMinusSrcAlpha` compositing, the non-zero RGB adds to the layer below, washing it out to white/bright. |
| A3 | **Separate materials for separate blend stages** | webp-border-fix Attempts 5–6 | `_compositeMaterial` was shared between floor→accumulation composite and accumulation→screen blit. Changing blend mode for one broke the other. Temporary property swaps are error-prone. |
| A4 | **Fragment shader must not manipulate alpha** | webp-border-fix Attempts 3, 4 | Premultiplying in the fragment shader (`c.rgb * c.a`) was wrong when the content was already premultiplied. Smoothstep clip in the fragment shader used the wrong channel. Every shader "fix" introduced a new artefact. The compositor fragment shader should be a pure pass-through. |
| A5 | **Blit to screen must handle transparent pixels** | webp-border-fix Attempt 5 | `NoBlending` writes `(0,0,0,0)` directly, erasing the Foundry canvas in padding areas. `NormalBlending` with premultiplied content double-premultiplies. Must use `One / OneMinusSrcAlpha` for premultiplied content. |
| A6 | **Tile WebP alpha is the primary clip source** | webp-border-fix Attempt 4, PER-LEVEL-MESH §Phase 2c | The outdoors mask, floor alpha mask, and floor-presence mask are all indirect proxies for the tile's own alpha channel. The tile's native .webp transparency IS the clip. The new system should not need a separate clip pass for basic floor layering. |

### Category 3 — Mask and State Management Failures

These are problems with how masks, textures, and effect state are routed between floors.

| # | Requirement | Source | What Failed |
|---|---|---|---|
| M1 | **Each floor owns its masks permanently** | PER-LEVEL-MESH §Problem 3, LAYERING-FAILURE Attempt 16 | Single `_slots` Map in `EffectMaskRegistry` holds one mask per type for the entire scene. Floor transitions swap masks, creating race conditions and stale references. |
| M2 | **No three-way mask source confusion** | LAYERING-FAILURE Attempts 19–19c | `_floorCache` (GPU-composited RTs), `_floorMeta` (file-based textures from disk), and `EffectMaskRegistry._slots` (subscribed textures) are three different sources of the same mask data with different coordinate spaces and lifetimes. Ground floor is in `_floorMeta` but never in `_floorCache`. |
| M3 | **Water mask must not cover areas where there is no water** | LAYERING-FAILURE Attempts 10–13, 19–20 | The ground floor `_Water` mask covers the full scene including upper floor tile footprints because the map author painted it there. The SDF built from it extends water into areas that should be floor-excluded. Every attempt to patch the mask after the fact failed because the ground floor was never GPU-composited. |
| M4 | **Water dual-system sync must be eliminated or isolated** | LAYERING-FAILURE §Architectural Analysis | Water rendering is split between WaterEffectV2 (refraction, waves) and DistortionManager (tinting, caustics, murk). Every state change must propagate to both independently. Stale `waterSource.mask` in DistortionManager lags one frame behind WaterEffectV2. |
| M5 | **Effect subscriber callbacks must be complete** | LAYERING-FAILURE Attempt 15 | Registry subscriber's `!texture` branch cleared derived state but left `this.waterMask` intact. Downstream paths continued using the stale texture. Rebuilt the SDF from stale data, undoing the registry clear. |
| M6 | **No fast-path material property skipping** | webp-border-fix Attempt 4 | `bindFloorMasks` fast path updates `outdoorsMaterial.map` but does not call `_rebuildOutdoorsProjection`. Changes to `transparent` or `blending` properties never apply to subsequent floors. |
| M7 | **Coordinate space consistency** | webp-border-fix Attempt 2, LAYERING-FAILURE Attempt 17 | `outdoorsTarget` is screen-space. `floorAlpha` is scene-space. `_floorMeta` textures are tile-space. UV conversion between these spaces is fragile and has failed multiple times. The new system must use a single coordinate space per render target with documented conventions. |

### Category 4 — Depth and Occlusion Failures

These are problems with using the depth buffer for cross-floor decisions.

| # | Requirement | Source | What Failed |
|---|---|---|---|
| D1 | **No depth-based cross-floor isolation** | LAYERING-FAILURE Attempts 2, 5, 7, 8, 9 | Depth values vary per scene and elevation setting. The depth pass camera may have tight near/far bounds that clip upper-floor tiles. `aboveGround` values for upper-floor tiles are unpredictable (sometimes 200, sometimes clipped). Every smoothstep/step threshold is wrong for some scene. |
| D2 | **No screen-space occluder meshes for world-space problems** | LAYERING-FAILURE Attempts 10–12 | The water SDF is world-space, baked at composition time. Screen-space occluder meshes can only affect the screen-space apply pass, not the baked SDF. Even when occluder meshes worked in screen space, the SDF still extended water to the wrong areas. |
| D3 | **Overhead tiles vs cross-floor tiles must be distinguished** | LAYERING-FAILURE Attempt 10 | Upper floor tiles in the scene were overhead tiles of the current floor (`isOverhead=true, levelsAbove=false`), not tiles from a different floor. The `levelsAbove` approach was a complete misdiagnosis. The blocker mesh was invisible because the condition was wrong. |
| D4 | **Composite shader must not lag by one frame** | LAYERING-FAILURE Attempt 5 | Composite shader writes to an RT sampled next frame. Depth-based gates in the composite shader produce a one-frame-lagged rectangle that tracks camera movement. |

### Category 5 — Tile and Geometry Failures

Problems with how tiles, the background plane, and geometry are managed.

| # | Requirement | Source | What Failed |
|---|---|---|---|
| T1 | **Background plane must only render on floor 0** | PER-LEVEL-MESH §Phase 2b | `basePlaneMesh` was rendering on EVERY floor pass, making every floor's `_floorRT` fully opaque. Upper floors produced no transparent pixels. Ground floor was invisible when viewing from upper floors. |
| T2 | **Background and tiles must share a unified layer model** | PER-LEVEL-MESH §Problem 4 | Background image has a separate load path, separate render path, and separate representation from tile sprites. No shared abstraction. The ground floor "tile" is actually a `basePlaneMesh` not a tile sprite. |
| T3 | **Per-tile identity preserved** | PER-LEVEL-MESH §Problem 10 | Masks are composited into a single RT per mask type per floor. Per-tile identity is lost. If two tiles on the same floor have different mask properties, they cannot be distinguished. |
| T4 | **Tile albedo resolution must not be capped** | PER-LEVEL-MESH §Problem 1 | Hard `TILE_MAX_DIM = 4096` cap in `loadTileTexture()`. High-res maps are downscaled losing detail. |
| T5 | **Mask resolution must not be capped** | PER-LEVEL-MESH §Problem 2 | Hard `DATA_MAX`/`VISUAL_MAX` constants at 4096/8192. Masks for large scenes are downscaled. |
| T6 | **Water occluder mesh management is too complex** | LAYERING-FAILURE Attempts 10–12 | `waterOccluderMesh` visibility depends on `levelsAbove`, `isOverhead`, `occludesWater`, and `_Water` mask presence. `setWaterOccluderScene` only migrated `waterOccluderMesh`, not `aboveFloorBlockerMesh`. Blocker mesh was in the wrong scene (`this.scene` vs `waterOccluderScene`). |
| T7 | **GPU compositor must handle ground floor** | LAYERING-FAILURE Attempts 19b–19c | `composeFloor` skip guard prevents re-composition of floors already seeded into `_floorMeta`. Ground floor is seeded from `currentBundle.masks` before `preloadAllFloors`. It never gets GPU-composited into `_floorCache`. The entire `_patchWaterMasksForUpperFloors` approach was built on a false premise. |

### Category 6 — Effect Pipeline Failures

Problems with how effects interact with each other and the compositor.

| # | Requirement | Source | What Failed |
|---|---|---|---|
| E1 | **Effects must not modify alpha of transparent pixels** | webp-border-fix Attempt 7 | LightingEffect adds ambient/darkness values to transparent pixels. The RGB becomes non-zero while alpha stays 0. This violates premultiplied-alpha invariant and leaks colour through compositing. |
| E2 | **POST_PROCESSING effects must run per-floor** | LAYERING-FAILURE §Architectural Analysis | Water and distortion were classified as POST_PROCESSING (global, after composite). They must run per-floor, before composite, so each floor's water operates on an isolated RT. |
| E3 | **Effect render order must be stable** | PER-LEVEL-MESH §Phase 3 | Floor-scoped POST_PROCESSING effects must run in the same priority order inside the per-floor loop as in the legacy pipeline. Currently relies on `resolveRenderOrder()` sorting. |
| E4 | **Stateful effects need per-floor state maps** | PER-LEVEL-MESH §Phase 3 | WaterEffectV2, FireSparksEffect, DustMotesEffect, AshDisturbanceEffect, BuildingShadowsEffect, TreeEffect, BushEffect all maintain state (SDFs, particle arrays, shadow RTs) that must be per-floor. |
| E5 | **Pre-warming must happen at load time** | PER-LEVEL-MESH §Phase 2b | WaterEffectV2 builds a CPU-side SDF on the first `bindFloorMasks()` call. Without pre-warming, the first render frame after a floor switch stalls. |
| E6 | **Effect output must be auditable** | New requirement | There is currently no way to inspect what an effect wrote to a render target at runtime. Debug views that show per-floor alpha, RGB, and premultiplied violations are essential for the incremental validation approach. |
| E7 | **Floor switching must be warm-start and sub-second** | New requirement | If switching floors triggers any heavy work (GPU mask recomposition, SDF rebuild, shader compile, RT allocation), swaps feel laggy and unpredictable. All floors, masks, effect state, and compositor resources must be prepared during scene loading. Floor change becomes: camera layer mask swap + render request. |

---

## Core Concept — Per-Mesh, Per-Floor, Floor-Independent Effects

### The Mental Model

Think of it like stacking transparent sheets of acetate on a lightbox:

1. **Each floor is one sheet.** It has artwork (tiles) and effects (lighting, water, shadows) painted onto it. The transparent parts of the sheet let the sheet below show through.

2. **Each sheet is prepared independently.** When you paint water on sheet 1, you don't worry about what's on sheet 2. The water stays on its sheet.

3. **Stacking order determines final image.** Sheet 0 goes down first. Sheet 1 on top. Where sheet 1 is transparent, you see sheet 0 through it. Where it's opaque, you see sheet 1.

4. **Global adjustments happen last.** Bloom, colour correction, film grain — these are applied to the entire lightbox after all sheets are stacked.

### Per-Mesh Architecture

The current system renders everything into a single Three.js scene and tries to sort it out after the fact with visibility toggling. The new system keeps all geometry in one scene but uses **Three.js layers** to isolate floors:

- **Floor 0 (Layer 1):** `basePlaneMesh` (scene background) + all ground-floor tile sprites + ground-floor tokens
- **Floor 1 (Layer 2):** Upper-floor tile sprites + upper-floor tokens only
- **Floor N (Layer N+1):** Same pattern — only this floor's geometry

Each floor is rendered by setting the camera's layer mask to that floor's layer. The scene graph never changes during the render loop. No visibility save/restore, no per-frame tile walks. Layer assignment happens once at tile creation.

### Why This Solves the Problems

| Problem | Current System | New System |
|---|---|---|
| Water floods upper floor | Global water pass sees all pixels | Water runs only on floor 0's RT. Floor 1's RT never touches the water SDF. |
| Same pixel needs different behaviour per viewer floor | Impossible in single pass | Each floor's effects are independent. The composite stack handles occlusion. |
| Ambient light leaks through alpha=0 | Lighting modifies transparent pixels, compositor can't clean up | Stencil + discard on compositor prevent alpha=0 pixels from ever reaching accumulation. Bug is structurally impossible. |
| White fringe at tile edges | Premultiplied/straight mismatch compounds through multiple stages | Single convention (premultiplied) enforced and validated at each step. |
| `preserveAcrossFloors` paradoxes | Binary keep/replace can't serve both floors | Each floor owns its masks. No sharing, no preserving, no paradoxes. |
| Water occluder complexity | 6 call sites, 3 mesh types, 2 scenes, migration bugs | No occluder needed. Water effect only sees its own floor's geometry. |
| Depth-based isolation failures | Depth values unpredictable across scenes/elevations | No depth-based cross-floor logic. Isolation is structural. |

---

## Design Principles

### 1. Start Empty, Prove Each Layer

The new system starts with **nothing** — just an empty render target. We add one capability at a time. Each step must produce a visually correct result before the next step begins. If step N is broken, we fix it before step N+1 exists.

### 2. No Shared Materials Between Stages

Every stage (floor composite, screen blit) gets its own dedicated material. No temporary property swaps, no shared uniforms, no runtime blend mode changes.

### 3. Explicit Alpha Convention

The entire pipeline uses **one** alpha convention, declared once, enforced by validation:
- **Premultiplied alpha** in all render targets
- **`One / OneMinusSrcAlpha`** for all alpha-over compositing
- Every shader that writes to an RT must output premultiplied RGBA
- Every shader that reads from an RT must expect premultiplied RGBA

### 4. Effects Are Black Boxes With a Contract

Each effect receives an input RT and produces an output RT. The contract:
- Input: premultiplied RGBA render target
- Output: premultiplied RGBA render target
- **Alpha preservation:** `output.a` must equal `input.a` at every pixel. Effects add/modify colour but do not invent or destroy coverage.
- **Premultiplied invariant:** Where `alpha = 0`, `RGB` must also be `0`.

If an effect violates this contract, **the effect is fixed**, not the compositor.

### 5. One Effect at a Time, Validated Before Integration

Effects are added to the pipeline one at a time. Before connection:
1. The pipeline is visually correct without the effect
2. The effect passes the alpha contract validation (programmatic check)
3. After connection, the pipeline is still visually correct

### 6. Old System Stays Running as Reference

A setting flag (`useNewCompositor`, default: false) switches between old and new. The old system is frozen — no more fixes are attempted on it.

---

## Architecture

### Core Components

```
scripts/compositor-v2/
  FloorCompositor.js       — Owns the render loop + all render targets
  FloorLayer.js            — Per-floor state bag (masks, effect bindings, cached state)
  FloorLayerManager.js     — Layer assignment at tile creation + camera mask helper
  CompositorMaterials.js   — All shader materials, each with fixed blend settings
  AlphaValidator.js        — Readback + debug views for contract enforcement
```

### Render Targets

| RT | Format | Depth | Stencil | MSAA | Purpose | Lifetime |
|---|---|---|---|---|---|---|
| `_floorRT` | RGBA HalfFloat | Yes | **Yes** | Optional (4x) | One floor's geometry + scene effects. Stencil marks tile coverage. | Cleared each floor |
| `_floorPostA` | RGBA HalfFloat | No | No | No | Ping-pong buffer A for floor post effects | Reused each floor |
| `_floorPostB` | RGBA HalfFloat | No | No | No | Ping-pong buffer B for floor post effects | Reused each floor |
| `_accumulationRT` | RGBA HalfFloat | No | No | No | All floors composited (premultiplied) | Cleared once, accumulates |

### Materials (all in `CompositorMaterials.js`)

| Material | Shader | Blend | Stencil | Purpose |
|---|---|---|---|---|
| `compositorMat` | `if (c.a < 0.004) discard; gl_FragColor = c;` | `One / OneMinusSrcAlpha` | `EqualStencilFunc, ref=1` | Floor RT → accumulation. Stencil + discard double-guard against alpha leakage. |
| `blitMat` | `gl_FragColor = texture2D(tSrc, vUv)` | `One / OneMinusSrcAlpha` | None | Accumulation → screen. Pure pass-through. |
| `debugAlphaMat` | `gl_FragColor = vec4(vec3(a), 1.0)` | `NoBlending` | None | Debug: show alpha as greyscale |
| `debugViolationMat` | `gl_FragColor = vec4(r>0&&a<0.01 ? 1:0, 0, 0, 1)` | `NoBlending` | None | Debug: red where premultiplied violated |

### Data Flow

```
┌─── Frame Start ───────────────────────────────────────────────────┐
│                                                                    │
│  Clear _accumulationRT to (0,0,0,0)                               │
│                                                                    │
│  For each visible floor (bottom → top):                           │
│  ┌─────────────────────────────────────────────────────────────┐  │
│  │ 1. camera.layers.set(FLOOR_LAYERS[floor.index])             │  │
│  │    - Camera now only sees this floor's geometry              │  │
│  │    - No visibility toggling, no save/restore                 │  │
│  │    - basePlaneMesh is on floor 0's layer by construction     │  │
│  │                                                             │  │
│  │ 2. Bind this floor's masks to all floor-scoped effects      │  │
│  │    - effect.bindFloorMasks(floor.masks, floor.key)          │  │
│  │    - Each effect loads its per-floor state                  │  │
│  │                                                             │  │
│  │ 3. Clear _floorRT (colour + depth + stencil)               │  │
│  │    renderer.render(scene, camera) → _floorRT                │  │
│  │    Tiles write stencil=1 where they have coverage           │  │
│  │    Result: premultiplied RGBA + stencil mask                │  │
│  │                                                             │  │
│  │ 4. Run floor-scoped SCENE effects (into _floorRT in-place) │  │
│  │    These modify the scene rendering (e.g. tree sway)        │  │
│  │                                                             │  │
│  │ 5. Run floor-scoped POST effects (ping-pong A↔B)           │  │
│  │    Input: _floorRT  → Output: _floorPostA or _floorPostB   │  │
│  │    Contract: premultiplied in → premultiplied out           │  │
│  │    Alpha preserved at every step                            │  │
│  │                                                             │  │
│  │ 6. Composite floor final RT → _accumulationRT              │  │
│  │    Material: compositorMat                                  │  │
│  │    - Stencil test: only composite where stencil=1 (tiles)  │  │
│  │    - Discard: skip pixels with alpha < 0.004               │  │
│  │    - Blend: One / OneMinusSrcAlpha (premultiplied over)    │  │
│  │    → Alpha leakage from effects is STRUCTURALLY BLOCKED    │  │
│  └─────────────────────────────────────────────────────────────┘  │
│                                                                    │
│  Restore camera.layers to full mask                               │
│                                                                    │
│  Run GLOBAL post effects on _accumulationRT (ping-pong)           │
│  - Bloom, colour correction, film grain, etc.                     │
│  - These see the fully composited multi-floor image               │
│                                                                    │
│  Blit final result → screen                                       │
│  Material: blitMat (One / OneMinusSrcAlpha)                       │
│  Transparent areas let Foundry canvas show through                │
│                                                                    │
└─── Frame End ─────────────────────────────────────────────────────┘
```

---

## Build Steps

Each step is a self-contained milestone. The system must be visually correct after each step before proceeding. Steps are intentionally small.

### Step 0 — Scaffold + Setting Gate

**Goal:** Create the v2 directory and core files. Wire into `EffectComposer.render()` behind a `useNewCompositor` setting.

**Deliverables:**
- `scripts/compositor-v2/FloorCompositor.js` — class with `render()` method (empty body)
- `scripts/compositor-v2/CompositorMaterials.js` — all materials defined with fixed blend + stencil settings
- `scripts/compositor-v2/FloorLayerManager.js` — layer constants, `assignTileToFloor(sprite, floorIndex)`, `getCameraMask(floorIndex)`
- `scripts/compositor-v2/AlphaValidator.js` — stub with `validateFrame()` and `setDebugView(mode)`
- Setting: `useNewCompositor` (default: false)
- `EffectComposer.render()`: if setting is on, delegate to `FloorCompositor.render()`, skip old floor loop

**Validation:**
- Old system unchanged when setting is off
- New system produces black screen when setting is on (empty render method)
- No console errors
- `FloorLayerManager` constants don't collide with existing layers (audit layers 1–19)

---

### Step 1 — Ground Floor Only, No Effects

**Goal:** Render ONLY floor 0 geometry into `_floorRT`, blit to screen. No effects, no compositing. Just geometry → screen. Uses layers for floor isolation.

**Deliverables:**
- Create `_floorRT` (RGBA, HalfFloat, depth+stencil)
- Assign ground floor tiles + basePlaneMesh to floor 0 layer via `FloorLayerManager`
- `camera.layers.set(FLOOR_LAYERS[0])` — camera only sees floor 0
- Tile materials get `stencilWrite: true, stencilRef: 1` — writes stencil where tiles render
- `renderer.render(scene, camera)` → `_floorRT`
- Blit `_floorRT` → screen with `blitMat` (One/OneMinusSrcAlpha)
- Restore camera layers
- **Answer Q1:** Read back `_floorRT` pixels to determine if SpriteMaterial NormalBlending into cleared RT produces premultiplied or straight alpha

**Validation:**
- Ground floor visible (base plane + tiles)
- No effects (no lighting, water, shadows — raw geometry)
- Foundry canvas shows through transparent padding areas
- Stencil buffer populated (verify with AlphaValidator debug view)
- **Q1 answered:** Alpha convention documented based on readback results
- **Proves:** Layers work for floor isolation. Basic render → blit pipeline works.

---

### Step 2 — Two Floors, No Effects ⭐ CRITICAL

**Goal:** Render both floors sequentially, composite into `_accumulationRT`, blit to screen. No effects. Pure geometry layering with layers + stencil + discard.

**Deliverables:**
- Create `_accumulationRT` (RGBA, HalfFloat, no depth, no stencil)
- Assign upper floor tiles to floor 1 layer via `FloorLayerManager`
- Floor loop: for each visible floor:
  - `camera.layers.set(FLOOR_LAYERS[floorIndex])`
  - Clear `_floorRT` (colour + depth + stencil)
  - `renderer.render(scene, camera)` → `_floorRT` (tiles write stencil=1)
  - Composite `_floorRT` → `_accumulationRT` using `compositorMat`
    - Stencil test: only pixels where stencil=1
    - Discard: skip pixels with alpha < 0.004
    - Blend: One / OneMinusSrcAlpha
- Blit `_accumulationRT` → screen using `blitMat`
- Restore camera layers
- **Optional:** Try MSAA (samples: 4) on `_floorRT` — toggle and compare edge quality

**Validation:**
- Ground floor fully visible through upper floor's transparent gaps
- Upper floor artwork on top of ground floor
- **No white fringe, no ambient leakage, no grey canvas through gaps**
- **This is the gate.** If this fails, fix it HERE before any effects exist.
- Run `AlphaValidator.validateFrame()` — zero premultiplied violations expected (no effects = no contamination)

**Proves:** Multi-floor alpha compositing works with native tile alpha. Layers + stencil + discard + premultiplied convention correct end-to-end.

---

### Step 3 — Add LightingEffect (Ground Floor Only)

**Goal:** Connect LightingEffect to floor 0 only. Upper floor renders as raw geometry (no lighting).

**Validation:**
- Ground floor has lighting; upper floor has no lighting (expected)
- Ground floor visible through upper floor gaps (alpha preserved through lighting)
- **Alpha check at transparent pixels:** If `RGB > 0` with `alpha = 0` after LightingEffect, the effect violates the contract → fix LightingEffect, do NOT fix the compositor

---

### Step 4 — Add LightingEffect (All Floors)

**Goal:** LightingEffect runs on every floor.

**Validation:**
- Both floors correctly lit
- No ambient leakage through transparent areas
- No white fringe at tile edges
- **If ambient leaks:** Fix goes into LightingEffect (scale additive terms by alpha), NOT into compositor

---

### Step 5 — Add Effects One by One

**Goal:** Connect remaining floor-scoped effects one at a time. Each must pass validation before the next is added.

**Order** (existing priority system):

| Priority | Effect | Key Concern |
|---|---|---|
| 1 | `SpecularEffect` | Does it preserve alpha at transparent pixels? |
| 2 | `BuildingShadowsEffect` | World-space shadow RT — does sampling respect floor bounds? |
| 3 | `OverheadShadowsEffect` | Per-floor overhead geometry? |
| 4 | `WindowLightEffect` | Additive light — does it add to alpha=0 pixels? |
| 5 | `WaterEffectV2` | Per-floor SDF. Does water stay on its floor's RT? |
| 6 | `DistortionManager` | Reads from WaterEffectV2 — does sync work per-floor? |
| 7 | `AtmosphericFogEffect` | Does fog add colour to transparent pixels? |
| 8 | `FireSparksEffect` | Per-floor particle state? |
| 9 | `TreeEffect` / `BushEffect` | Per-floor vegetation state? |
| 10 | `FluidEffect` / `IridescenceEffect` / `PrismEffect` | Alpha preservation? |
| 11 | `CandleFlamesEffect` | Additive particles — alpha contamination? |
| 12 | `AshDisturbanceEffect` / `DustMotesEffect` | Per-floor particle state? |

**Per-effect validation checklist:**
- [ ] Pipeline visually correct BEFORE connecting this effect
- [ ] Effect connected to floor loop with `bindFloorMasks()` + `update()` + `render()`
- [ ] Ground floor rendering correct
- [ ] Upper floor rendering correct
- [ ] Alpha preserved: transparent tile areas still show lower floors
- [ ] No cross-floor bleed
- [ ] No white fringe, no ambient leakage, no colour bleeding at tile edges
- [ ] AlphaValidator programmatic check passes
- [ ] Pipeline visually correct AFTER connecting this effect
- [ ] Effect status updated to VALIDATED in `VALIDATION-REGISTRY.md`

**Rule:** If any effect fails validation, fix the effect (not the compositor).

---

### Step 6 — Global Post Effects

**Goal:** Connect global effects (bloom, colour correction, etc.) to run on `_accumulationRT` after all floors composited.

**Validation:**
- Global effects apply to full composited image
- No per-floor artifacts
- Performance within budget

---

### Step 7 — Retire Old Compositor

**Goal:** Remove old floor loop, setting gate, and all workaround code.

**Deliverables:**
- Delete old floor loop in `EffectComposer.render()`
- Delete `_applyFloorAlphaClip`, `_floorAlphaClipMaterial`
- Delete shared `_compositeMaterial`
- Delete `preserveAcrossFloors` logic in `EffectMaskRegistry`
- Delete `_patchWaterMasksForUpperFloors` in `GpuSceneMaskCompositor`
- Delete floor-presence render targets and meshes
- Delete Floor ID texture builder
- Update architecture docs

---

## Validation Tools

### AlphaValidator (scripts/compositor-v2/AlphaValidator.js)

Built-in debug tool, exposed on `window.MapShine.alphaValidator`.

**Programmatic checks (`validateFrame()`):**
1. Read back `_floorRT` pixels at known-transparent locations
2. **Premultiplied violation:** `RGB > 0 && alpha < 0.01` → FAIL (colour without coverage)
3. **Alpha leak:** `alpha > 0 && alpha < 0.05` at tile interior → WARN (semi-transparent where should be opaque)
4. **Coverage loss:** Compare input alpha to output alpha before/after an effect → FAIL if alpha decreased where it shouldn't
5. Log results to console with floor index and effect name

**Debug views (`setDebugView(mode)`):**

| Mode | View | Purpose |
|---|---|---|
| 0 | Normal | Production rendering |
| 1 | Floor alpha | `_floorRT.a` as greyscale per floor | Shows where floors are transparent |
| 2 | Accumulation alpha | `_accumulationRT.a` as greyscale | Shows composite coverage |
| 3 | Floor RGB (alpha=1) | `_floorRT.rgb` with forced alpha=1 | See what effects produce in transparent areas |
| 4 | Premultiplied violations | Red pixels where `RGB > 0 && alpha < 0.01` | Catch ambient leakage |
| 5 | Per-floor isolation | Each floor tinted a different colour | Verify floor isolation |

---

## Effect Validation Status (Initial)

All effects start as UNVALIDATED. This table will be mirrored in `scripts/compositor-v2/VALIDATION-REGISTRY.md` and updated as effects are validated.

### Floor-Scoped Effects (17)

| Effect | Status | Known Concerns |
|---|---|---|
| `LightingEffect` | UNVALIDATED | Adds ambient to alpha=0 pixels (A2). Fast-path material skip (M6). Screen-space outdoorsTarget (M7). |
| `WaterEffectV2` | UNVALIDATED | Per-floor SDF state (E4). Water mask covers wrong areas (M3). Dual sync with DistortionManager (M4). Pre-warming stall (E5). |
| `DistortionManager` | UNVALIDATED | Reads water state from WaterEffectV2 (M4). Stale mask reference (M5). Complex occluder mesh system (T6). |
| `AtmosphericFogEffect` | UNVALIDATED | May add colour to transparent pixels. |
| `SpecularEffect` | UNVALIDATED | Samples building shadow RT, weather state — cross-system dependencies. |
| `FluidEffect` | UNVALIDATED | Alpha preservation unknown. |
| `IridescenceEffect` | UNVALIDATED | Alpha preservation unknown. |
| `PrismEffect` | UNVALIDATED | Alpha preservation unknown. |
| `TreeEffect` | UNVALIDATED | Per-floor state needed (E4). |
| `BushEffect` | UNVALIDATED | Per-floor state needed (E4). |
| `WindowLightEffect` | UNVALIDATED | Additive light — may contaminate alpha=0 pixels (E1). |
| `BuildingShadowsEffect` | UNVALIDATED | World-space shadow RT — needs per-floor consideration. |
| `OverheadShadowsEffect` | UNVALIDATED | Per-floor overhead geometry. |
| `CandleFlamesEffect` | UNVALIDATED | Additive particles — alpha contamination risk (E1). |
| `FireSparksEffect` | UNVALIDATED | Per-floor particle state (E4). |
| `AshDisturbanceEffect` | UNVALIDATED | Per-floor particle state (E4). |
| `DustMotesEffect` | UNVALIDATED | Per-floor particle state (E4). |

### Global Effects (14) — Run After Composite

| Effect | Status | Known Concerns |
|---|---|---|
| `WorldSpaceFogEffect` | UNVALIDATED | fogPlane layer assignment. |
| `WeatherParticles` | UNVALIDATED | Should be floor-independent by nature. |
| `SkyColorEffect` | UNVALIDATED | Minimal risk. |
| `BloomEffect` | UNVALIDATED | Operates on full composite — should be safe. |
| `ColorCorrectionEffect` | UNVALIDATED | Minimal risk. |
| `FilmGrainEffect` | UNVALIDATED | Minimal risk. |
| `AsciiEffect` | UNVALIDATED | Minimal risk. |
| `HalftoneEffect` | UNVALIDATED | Minimal risk. |
| `DotScreenEffect` | UNVALIDATED | Minimal risk. |
| `SharpenEffect` | UNVALIDATED | Minimal risk. |
| `DetectionFilterEffect` | UNVALIDATED | Minimal risk. |
| `MaskDebugEffect` | UNVALIDATED | Debug tool — low priority. |
| `PlayerLightEffect` | UNVALIDATED | May need access to per-floor lighting state. |
| `DynamicExposureManager` | UNVALIDATED | Reads scene luminance — should work on composite. |

---

## Risk Assessment

| Risk | Severity | Mitigation |
|---|---|---|
| An effect doesn't preserve alpha | High | AlphaValidator catches this before integration. Fix is localised to the offending effect, not the compositor. |
| SpriteMaterial produces unexpected alpha convention | High | Step 2 validates raw geometry compositing with zero effects. If alpha is wrong here, we fix the tile material once. |
| LightingEffect contaminates transparent pixels | High | Step 3 tests lighting in isolation on one floor. Alpha readback detects violations programmatically. |
| WaterEffectV2 SDF extends to wrong areas per-floor | Medium | Per-floor rendering eliminates this entirely — water only sees its own floor's RT. The SDF is irrelevant to other floors. |
| DistortionManager stale state from WaterEffectV2 | Medium | Per-floor `bindFloorMasks()` + `update()` order ensures sync. Validated in Step 5. |
| Performance regression from N×effects render passes | Low | VTT scenes are geometrically trivial. 4 floors × 5 effects = 20 passes at ~0.2ms each = 4ms. Well within budget. |
| Old system diverges while new is built | Low | Old system is frozen. No more fixes attempted. |
| Semi-transparent tile edges cause fringe regardless | Medium | Validated in Step 2 with zero effects. If fringe exists at this stage, it's a tile material issue (alphaTest), not a compositor issue. |

---

## Open Questions

These need answers during implementation. They don't block planning.

| # | Question | When to Answer | Status |
|---|---|---|---|
| Q1 | Does `SpriteMaterial` with `NormalBlending` into a cleared `(0,0,0,0)` RT produce premultiplied or straight alpha content? | Step 1 — readback test | OPEN |
| Q2 | Does LightingEffect's composite shader output preserve alpha at transparent pixels? | Step 3 — readback test | OPEN |
| Q3 | Should the new compositor manage its own Three.js scene, or reuse the existing scene with layer masks? | Step 0 — design decision | **RESOLVED: Reuse existing scene with layer masks.** |
| Q4 | How does depth capture (`DepthPassManager.captureForFloor()`) interact with the new floor loop? | Step 2 or 3 — when effects need depth | **RESOLVED: See A2 below.** |
| Q5 | Should `DistortionManager` be made floor-aware via `bindFloorMasks()`, or continue reading from WaterEffectV2's sync? | Step 5 — when DistortionManager is validated | OPEN |
| Q6 | Can the `_floorStates` caching pattern in effects handle rapid floor switching without leaking memory? | Step 5 — stress test | OPEN |
| Q7 | What happens to the global scene layer (drawings, notes, fog plane) in the new loop? | Step 6 — when global effects are connected | **RESOLVED: See A6 below.** |
| Q8 | Does the stencil buffer survive MSAA resolve? | Step 2 — when MSAA is evaluated | **RESOLVED: See A3/A8 below.** |
| Q9 | Do existing effects (especially LightingEffect) render fullscreen quads that need the depth buffer from `_floorRT`? If so, ping-pong to `_floorPostA` loses depth. | Step 3 — when LightingEffect is connected | **RESOLVED: See A2 below.** |
| Q10 | How does tile-manager assign layers? Does it need a callback from FloorLayerManager, or does FloorLayerManager scan existing tiles on init? | Step 1 — implementation | **RESOLVED: See A4 below.** |

### Resolved Architectural Questions

#### A1 — Stencil Buffer vs. Effect Expansion (Glow/Blur)

**Concern:** If tiles write stencil=1 during the geometry pass and the compositor clips on stencil, effects that expand beyond tile bounds (glow, blur) would get hard-clipped.

**Resolution: Not a problem.** The stencil operates in a different stage than the compositor.

The pipeline is:
1. **Geometry pass into `_floorRT`** — tiles write stencil=1 and color+depth. Stencil lives here.
2. **Floor-scoped post effects** — ping-pong between `_floorPostA` / `_floorPostB`. These are SEPARATE RTs with NO stencil attachment. Effects like blur/glow read `_floorRT`'s output and write expanded results freely. A blur kernel sampling bright pixels near tile edges WILL bleed color+alpha into the surrounding transparent area — this is correct behavior for glow.
3. **Compositor** — reads the post-processed floor image (from `_floorPostA/B`, NOT `_floorRT`) and composites into `_accumulationRT`. The compositor uses `discard` on alpha ≈ 0.0 — not stencil. Glow pixels with alpha > 0 survive compositing.

**Key insight:** Stencil is used during the geometry render (step 1) to prevent depth-fighting artifacts between tile layers on the same floor. It is NOT used during compositing (step 3). The compositor's safety gate is `discard` on alpha=0.0 in the fragment shader, which preserves intentional soft expansion from post effects.

**Decision:** No mechanism needed for effects to "expand" stencil. Effects expand alpha naturally during post-processing; the compositor respects any alpha > 0.

#### A2 — Post-Processing Effects and the Depth Buffer

**Concern:** `_floorPostA/B` don't share `_floorRT`'s depth buffer. Effects like AtmosphericFogEffect and WaterEffectV2 need depth.

**Resolution: Effects already use a separate depth pass. Not an issue.**

`DepthPassManager` renders a dedicated depth pass into its own `_depthTarget` with an attached `DepthTexture` (32-bit float). This texture is published to `MaskManager`, and effects bind it as a uniform (`uDepthTexture`). Effects NEVER read `_floorRT`'s depth attachment.

From `depth-pass-manager.js` line 515:
```js
depthCamera.layers.mask = mainCamera.layers.mask;
```

`captureForFloor()` copies `mainCamera.layers.mask`, so in v2 the depth camera automatically captures only the current floor's geometry. Effects sample the resulting `DepthPassManager._depthTexture` uniform — they don't care which RT the depth lives in.

**Decision:** `_floorPostA/B` do NOT need depth attachments. `DepthPassManager.captureForFloor()` is called per-floor inside the v2 loop (before floor scene effects), automatically inheriting the floor's layer mask. No changes needed to depth infrastructure.

#### A3 — MSAA `_floorRT` and Shader Sampling

**Concern:** MSAA render targets can't be directly sampled as `sampler2D` without a resolve blit.

**Resolution: MSAA is deferred. When added, Three.js handles resolve automatically.**

The current `_floorRT` is created WITHOUT MSAA (`samples` parameter not set). The plan's Three.js features analysis explicitly deferred MSAA:
> "MSAA: Available via `samples: N` on WebGLRenderTarget. Not essential for v2 launch — can be added later as a polish pass."

If MSAA is added later:
- **WebGL2 backend:** Three.js automatically calls `blitFramebuffer()` to resolve the MSAA buffer when the RT's `.texture` property is bound as a uniform. The resolve is implicit and handled internally by `WebGLTextures`.
- **Performance cost:** One resolve blit per floor per frame (~0.1ms on modern GPUs at 1080p). For 4 floors = ~0.4ms. Acceptable.
- **Stencil after resolve:** Stencil does NOT survive the auto-resolve (`blitFramebuffer` with `GL_COLOR_BUFFER_BIT` only). This reinforces the decision to use `discard` in the compositor rather than stencil-based compositing. (Resolves original Q8.)

**Decision:** Launch without MSAA. If added later, no code changes needed — Three.js resolves automatically. Stencil remains geometry-pass only; compositor uses `discard`.

#### A4 — FloorLayerManager and Dynamic Asset Creation

**Concern:** How does `FloorLayerManager` assign layers to tiles created after initial scene load?

**Resolution: No monkey-patching needed. Hook into existing `updateSpriteProperties()`.**

All tile creation paths flow through `TileManager.createTileSprite()`, which calls `updateSpriteProperties()`:
- **Initial load:** `loadTiles()` → `createTileSprite()` → `updateSpriteProperties()`
- **Dynamic creation:** `createTile` Foundry hook → `createTileSprite()` → `updateSpriteProperties()`
- **Update fallback:** `updateTile` when sprite doesn't exist → `createTileSprite()` → `updateSpriteProperties()`

`updateSpriteProperties()` already handles multi-layer assignment (ROOF_LAYER, WEATHER_ROOF_LAYER, CLOUD_SHADOW_BLOCKER, etc.). V2 adds ONE call:

```js
if (useNewCompositor) {
  FloorLayerManager.assignTileToFloor(sprite, tileDoc);
}
```

This covers all creation and update paths. `FloorLayerManager.assignTileToFloor()` reads the tile's elevation/Levels range from `tileDoc` to determine which floor it belongs to, then calls `sprite.layers.enable(FLOOR_LAYERS[floorIndex])`.

**Decision:** Single call site in `updateSpriteProperties()`, gated by `useNewCompositor`. Covers initial load, dynamic creation, and tile updates.

#### A5 — ROOF_LAYER (20) / WEATHER_ROOF_LAYER (21) and Floor Layers

**Concern:** If overhead tiles only get ROOF_LAYER, the per-floor camera (which enables only `FLOOR_LAYERS[i]`) won't see them.

**Resolution: Overhead tiles get BOTH their floor layer AND ROOF_LAYER.**

Current tile layer assignment in `updateSpriteProperties()` (tile-manager.js:3841):
```js
if (isOverhead) sprite.layers.enable(ROOF_LAYER);
if (isWeatherRoof) sprite.layers.enable(WEATHER_ROOF_LAYER);
```

This uses `enable` (additive), not `set` (exclusive). The tile keeps layer 0 AND gets ROOF_LAYER.

In v2, the same pattern applies. `FloorLayerManager.assignTileToFloor()` calls `sprite.layers.enable(FLOOR_LAYERS[floorIndex])`. Then `updateSpriteProperties()` additionally calls `sprite.layers.enable(ROOF_LAYER)` for overhead tiles. The tile ends up on multiple layers:
- `FLOOR_LAYERS[i]` — renders during its floor's pass
- `ROOF_LAYER` (20) — captured by LightingEffect/OverheadShadowsEffect roof passes
- `WEATHER_ROOF_LAYER` (21) — captured by weather roof passes

The per-floor camera mask enables only `FLOOR_LAYERS[i]` (not ROOF_LAYER), so overhead tiles render as normal floor geometry during their floor's pass. LightingEffect's roof capture sets camera to ROOF_LAYER specifically, capturing ALL overhead tiles globally — correct, because roofs block sunlight regardless of which floor is being viewed.

**Decision:** Additive layer assignment. Overhead tiles = floor layer + ROOF_LAYER + WEATHER_ROOF_LAYER. No conflict between per-floor rendering and global roof capture passes.

#### A6 — Non-Tile Canvas Objects (Grid, Rulers, Templates, Drawings)

**Concern:** Do non-tile objects need aggressive layer management to avoid rendering on wrong floor passes?

**Resolution: Already handled by existing layer assignments. No changes needed.**

Current layer assignments for non-tile Three.js objects:
- **Grid** → `OVERLAY_THREE_LAYER` (31) — renders in overlay pass after all compositing
- **Measured Templates** → `OVERLAY_THREE_LAYER` (31) — overlay pass
- **Notes** → `GLOBAL_SCENE_LAYER` (29) — renders once after floor loop
- **Token indicators** → `OVERLAY_THREE_LAYER` (31) — overlay pass
- **Light icons** → `OVERLAY_THREE_LAYER` (31) — overlay pass
- **Map point interaction** → `OVERLAY_THREE_LAYER` (31) — overlay pass
- **Rulers** → PIXI objects (not in Three.js scene at all)
- **Drawings** → PIXI objects (not in Three.js scene at all)

The per-floor camera mask enables only `FLOOR_LAYERS[i]`. Since all non-tile objects are on layer 29 or 31 (never on any `FLOOR_LAYERS[i]`), they are automatically excluded from per-floor renders. They render exactly once — either in the global scene pass (layer 29) or the overlay pass (layer 31).

**Decision:** No additional layer management needed. Existing assignments already prevent non-tile objects from appearing in floor passes.

#### A7 — basePlaneMesh Alpha and Premultiplication

**Concern:** If `basePlaneMesh` uses straight alpha and the compositor uses premultiplied blending, colors could wash out.

**Resolution: Not an issue. basePlaneMesh is fully opaque.**

From `composer.js` line 830:
```js
material = new THREE.MeshBasicMaterial({
    map: texture,
    side: THREE.FrontSide,
    transparent: false  // ← always opaque
});
```

`transparent: false` means Three.js treats the material as fully opaque. `MeshBasicMaterial` with `transparent: false` outputs alpha = 1.0 unconditionally, regardless of the texture's alpha channel. When rendered into `_floorRT` (cleared to `(0,0,0,0)`), it writes `(r, g, b, 1.0)`.

The compositor's premultiplied blend: `rgb * a = rgb * 1.0 = rgb`. Fully opaque content composes identically under both straight and premultiplied conventions. No color shift possible.

For the blank-map fallback (solid color, no texture): same `transparent: false`, same alpha=1.0 output. Also safe.

**Decision:** No changes needed. `basePlaneMesh` is unconditionally opaque. Premultiplied compositing produces identical results to straight compositing when alpha=1.0.

#### A8 — renderer.clear() and Stencil Buffer Between Floors

**Concern:** Does `renderer.clear()` wipe stencil between floors, or does floor 0's stencil persist into floor 1?

**Resolution: Yes, `renderer.clear()` clears stencil — but `_floorRT` must be created with `stencilBuffer: true`.**

Two things need to happen:

1. **RT creation:** `_floorRT` must be created with `{ depthBuffer: true, stencilBuffer: true }`. Currently `stencilBuffer` defaults to `false` in Three.js's `WebGLRenderTarget`. Without this, there's no stencil to write or clear.

2. **Explicit clear:** `renderer.clear()` calls `gl.clear(COLOR_BIT | DEPTH_BIT | STENCIL_BIT)` when all `autoClear*` flags are true (which is the default). However, v2 should use the explicit form for clarity and safety:

```js
renderer.setRenderTarget(this._floorRT);
renderer.clear(true, true, true); // color, depth, stencil — explicit
```

This guarantees floor 0's stencil=1 pixels don't persist into floor 1's pass. Each floor starts with a clean `(0,0,0,0)` color, depth=1.0, stencil=0.

**Decision:** Create `_floorRT` with `stencilBuffer: true`. Use `renderer.clear(true, true, true)` explicitly at the start of each floor pass. Document this in `FloorCompositor.js` with a comment explaining why all three buffers must be cleared.

---

## Files

| File | New/Existing | Role |
|---|---|---|
| `scripts/compositor-v2/FloorCompositor.js` | New | Core render loop + RT management |
| `scripts/compositor-v2/FloorLayer.js` | New | Per-floor state bag |
| `scripts/compositor-v2/FloorLayerManager.js` | New | Layer assignment at tile creation + camera mask helper |
| `scripts/compositor-v2/CompositorMaterials.js` | New | All materials with fixed blend + stencil settings |
| `scripts/compositor-v2/AlphaValidator.js` | New | Debug readback + violation detection |
| `scripts/compositor-v2/VALIDATION-REGISTRY.md` | New | Tracks effect validation status |
| `scripts/compositor-v2/effects/` | New (empty) | Validated effect copies accumulate here |
| `scripts/effects/EffectComposer.js` | Existing | Setting gate delegates to new compositor |
| `scripts/scene/FloorStack.js` | Existing | Floor visibility isolation (reused) |
| `scripts/scene/tile-manager.js` | Existing | Tile loading + sprite creation (reused) |
| `scripts/scene/composer.js` | Existing | SceneComposer (reused) |
| `docs/planning/FLOOR-COMPOSITOR-REBUILD.md` | New | This document |

---

## Current Status

### Step 0 — Scaffold ✅

Created `scripts/compositor-v2/` directory with all core files:

| File | Purpose | Syntax Check |
|---|---|---|
| `FloorCompositor.js` | Core render loop + RT management (eager allocation, per-floor layer-mask rendering, composite, blit) | ✅ |
| `FloorLayer.js` | Per-floor state bag (index, band, compositorKey, maskBundle, warmed flag) | ✅ |
| `FloorLayerManager.js` | Layer assignment at tile creation + camera mask helpers. `FLOOR_LAYERS[0..18]` = Three.js layers 1–19. | ✅ |
| `CompositorMaterials.js` | Two separate materials with FIXED blend settings: `floorToAccumulation` (One/OneMinusSrcAlpha + discard), `blitToScreen` (One/OneMinusSrcAlpha). Plus `debugAlpha`. | ✅ |
| `AlphaValidator.js` | GPU readback debug tool: checks premultiplied invariant (alpha≈0 → RGB≈0), reports violations per floor. | ✅ |
| `VALIDATION-REGISTRY.md` | Effect validation tracking (empty — effects validated starting Step 3). | ✅ |
| `effects/.gitkeep` | Empty directory for validated effect copies. | ✅ |

### Step 1 — Wiring ✅

Integrated v2 compositor into the existing system:

| Change | File | Detail |
|---|---|---|
| **Setting registered** | `scripts/settings/scene-settings.js` | `useCompositorV2` (Boolean, default: false). Requires `experimentalFloorRendering` to also be on. |
| **Setting gate + delegation** | `scripts/effects/EffectComposer.js` | `_checkCompositorV2Enabled()` checks both settings. `_getFloorCompositorV2()` lazily creates + initializes + pre-warms. Delegation block before legacy floor loop calls `FloorCompositor.render()` then returns. Dispose path cleans up `_floorCompositorV2`. |
| **Tile layer assignment** | `scripts/scene/tile-manager.js` | `updateSpriteProperties()` calls `window.MapShine.floorLayerManager.assignTileToFloor(sprite, tileDoc)` after existing ROOF_LAYER/WEATHER_ROOF_LAYER assignments. Runs for every tile on creation and update. |
| **Token layer assignment** | `scripts/scene/token-manager.js` | `createTokenSprite()` calls `floorLayerManager.assignTokenToFloor(sprite, tokenDoc)` after `sprite.layers.set(0)`. `updateTokenSprite()` reassigns on elevation change. |
| **Manager init + teardown** | `scripts/foundry/canvas-replacement.js` | `FloorLayerManager` created after `FloorStack`, wired with `setFloorStack()`, exposed on `window.MapShine.floorLayerManager`. Disposed and nulled in teardown. |
| **Pre-warm during loading** | `scripts/foundry/canvas-replacement.js` | After `preloadAllFloors()` + effect pre-warming, calls `floorLayerManager.reassignAllLayers(tileManager, tokenManager)` which assigns all existing tiles/tokens to their floor layers and assigns `basePlaneMesh` to floor 0. |
| **Level change handler** | `scripts/foundry/canvas-replacement.js` | `mapShineLevelContextChanged` hook calls `floorLayerManager.reassignAllLayers()` right after `FloorStack.rebuildFloors()` to update layer assignments when floor bands change. |
| **Resize handler** | `scripts/effects/EffectComposer.js` | `resize()` calls `_floorCompositorV2.onResize(renderW, renderH)` to keep v2 RTs sized correctly. |

All modified files pass `node --check`: EffectComposer.js ✅, tile-manager.js ✅, token-manager.js ✅, scene-settings.js ✅, canvas-replacement.js ✅.

### Step 2 — Breaker Fuse + Raw Geometry (IN PROGRESS)

**Problem discovered:** Even with FloorCompositor stripped to raw geometry, the EffectComposer was still running ALL updatables (weather, ropes, particles, tile motion), ALL effect.prepareFrame() calls, and _renderOverlayToScreen() which rendered OVERLAY_THREE_LAYER (31) to screen after V2. This caused ropes, weather particles, cloud overlays, and other meshes to render on top of the V2 output — completely defeating the "start from nothing" principle.

**Fix — Breaker Fuse architecture:**

The V2 check was moved to the **absolute top** of `EffectComposer.render()`, immediately after time/profiler setup but **before** any updatables, effects, overlay, or other systems run. When V2 is active:

| What | Status | Rationale |
|---|---|---|
| `updatable.update()` loop | **RUNS** | Camera sync, interaction, movement still needed. Meshes created by visual updatables (ropes, weather) are harmless — camera mask excludes layer 0 and OVERLAY (31) |
| Effect sorting (scene/post) | **SKIPPED** | Not needed — no effects run |
| `effect.prepareFrame()` loop | **SKIPPED** | Advances simulations that have no business running |
| `_renderOverlayToScreen()` | **SKIPPED** | Renders OVERLAY_THREE_LAYER (31) — ropes, cloud overlay mesh |
| `_renderDepthDebugOverlay()` | **SKIPPED** | Debug visualization |
| `FloorCompositor.render()` | **RUNS** | Sole renderer — only raw tile geometry |

**Additional fixes applied:**
- `renderer.autoClear` bug fixed: was `true` (default), causing `_compositeFloor()` to erase the accumulation buffer before each composite. Floor 0's content was destroyed before floor 1 composited on top. Now explicitly set to `false` during the floor loop, re-enabled for the final blit.
- Render target format corrected to `HalfFloatType` per spec.
- `CompositorMaterials.js` blend modes confirmed: `One / OneMinusSrcAlpha` (premultiplied) throughout.
- `_floorRT` explicitly cleared to `(0,0,0,0)` with `setClearColor(0x000000, 0)` before each floor.

**Second problem discovered — effect material contamination:**

Even with the breaker fuse suppressing all effects and overlay rendering, the basePlaneMesh was still showing specular highlights, outdoors mask shadows, and other effect artifacts. Root cause:

1. **`SpecularEffect.setBaseMesh()` replaces `basePlaneMesh.material`** with a full PBR ShaderMaterial (includes specular, roughness, normal maps, outdoors mask sampling). This happens during `wireBaseMeshes()` at scene load.
2. **`basePlaneMesh` is on floor layer 1** (assigned by `FloorLayerManager.assignBasePlane()`).
3. **FloorCompositor renders it** — camera mask selects floor layer → picks up the PBR material → specular highlights, outdoors mask, normals all render into the "raw geometry" pass.
4. **`_backgroundMesh`** (solid canvas background color) was on layer 0 (default) → excluded from floor rendering → areas with no tile coverage showed through as white WebGL canvas.

**Fix — material override in FloorCompositor:**

- `SceneComposer.createBasePlane()` now saves `this._albedoMaterial` and `this._albedoTexture` before effects replace the material.
- `FloorCompositor.render()` swaps `basePlaneMesh.material` to the saved albedo `MeshBasicMaterial` before the floor loop, restores the PBR material afterwards.
- `_backgroundMesh` is temporarily assigned to floor 0 layer during rendering so the canvas background colour shows behind tiles.

**This is the first use of what will become the Central Rendering Bus pattern** — the compositor explicitly controlling what material each mesh uses during each render pass, rather than rendering whatever material effects have installed.

**Validation pending:**
- [ ] Ground floor visible (base plane + tiles)
- [ ] Upper floor transparent gaps show ground floor (not white)
- [ ] No effects visible (no lighting, water, shadows, ropes, weather, clouds)
- [ ] No white fringe, no ambient leakage
- [ ] Scene is "flat" — raw geometry only
- [ ] Canvas background colour visible where no tiles exist

---

## Central Rendering Bus — Design

### Problem Statement

The current architecture has no central authority over rendering. Multiple systems compete to control what appears on screen:

| Problem | Where | Consequence |
|---|---|---|
| **Material replacement** | `SpecularEffect.setBaseMesh()` replaces basePlaneMesh.material with PBR shader | "Raw geometry" pass renders with specular/normals/outdoors |
| **Mesh injection** | Effects add meshes to the main scene (iridescence, bush, tree, cloud overlay) | Extra geometry appears in passes that didn't request it |
| **Texture binding** | `LightingEffect.bindFloorMasks()` swaps outdoors mask per floor | Stale masks leak across floor boundaries |
| **Stray renderer.render()** | VisionManager, FogManager, DistortionManager, CloudEffect call renderer.render() independently | RT state corruption, unintended screen output |
| **Overlay bleed** | `_renderOverlayToScreen()` renders OVERLAY layer after compositor | Ropes, weather, cloud top mesh appear on top of V2 output |

**Core insight:** The scene graph is a *shared mutable resource*. Every system modifies it (materials, meshes, layers, textures) and expects their changes to persist. There is no isolation between "what effects want to show" and "what the compositor wants to render."

### Design Principles

1. **Single Owner of renderer.render()** — Only FloorCompositor calls `renderer.render(scene, camera)` for floor passes. All other rendering (vision, fog, clouds) happens into off-screen RTs managed by the bus.

2. **Material Slots** — Each mesh has a *material slot table*: `{ albedo, pbr, depth, mask }`. The bus selects which slot to use for each pass. Effects populate slots but never directly set `mesh.material`.

3. **Pass Declaration** — Each render pass is declared with:
   - **Target RT** — where the output goes
   - **Camera mask** — which layers are visible
   - **Material slot** — which material variant to use (albedo, pbr, etc.)
   - **Clear policy** — how the RT is cleared before rendering

4. **Effect Integration Protocol** — Effects don't render themselves. Instead they:
   - Register material slots on meshes (e.g., SpecularEffect registers a `pbr` slot on basePlaneMesh)
   - Register render passes with the bus (e.g., "I need a lighting pass after floor geometry")
   - Receive pass results (e.g., "here's the floor RT after geometry, modify it")

5. **Strict Layer Discipline** — Meshes are on exactly one layer category:
   - **Floor layers 1–19** — tiles, tokens, basePlaneMesh, _backgroundMesh (per floor)
   - **Layer 0** — NEVER USED by floor rendering (default Three.js layer, too easy to pollute)
   - **Layer 20** — Roof/overhead tiles
   - **Layer 31** — Overlay (ropes, weather, UI) — rendered in a separate pass ONLY when bus permits

### Implementation Phases

**Phase 0 (current):** Manual material swap in FloorCompositor + breaker fuse in EffectComposer. Proves the concept works.

**Phase 1:** Extract material slot table into a `RenderPassManager` class:
```
RenderPassManager.registerMaterialSlot(mesh, slotName, material)
RenderPassManager.setActiveSlot(slotName) // swaps all registered meshes
RenderPassManager.restoreSlot()           // restores original materials
```

**Phase 2:** Formalize render passes:
```
bus.declarePass({ name: 'floor-geometry', target: floorRT, cameraMask, materialSlot: 'albedo', clear: TRANSPARENT_BLACK })
bus.declarePass({ name: 'floor-lighting', target: floorRT, cameraMask, materialSlot: 'pbr', clear: NONE })
bus.declarePass({ name: 'overlay', target: null, cameraMask: OVERLAY_MASK, materialSlot: 'default', clear: NONE })
```

**Phase 3:** Effects register with the bus instead of directly modifying the scene:
```
specularEffect.registerWithBus(bus) {
  bus.registerMaterialSlot(basePlaneMesh, 'pbr', this.pbrMaterial);
  bus.requestPass('floor-lighting', { after: 'floor-geometry', effect: this });
}
```

### Files

| File | Purpose |
|---|---|
| `scripts/compositor-v2/RenderPassManager.js` | Material slot table + pass declaration + execution |
| `scripts/compositor-v2/FloorCompositor.js` | Uses RenderPassManager for floor loop |
| `scripts/compositor-v2/PassRegistry.js` | Static pass definitions (geometry, lighting, overlay, etc.) |

### Immediate Next Steps

1. ✅ Validate raw geometry with material override (current fix)
2. Extract material swap into `RenderPassManager` (Phase 1)
3. Move effect integration to pass-based model (Phase 2-3)
4. Each step validated independently before proceeding

---

### Step 2b — Floor Transition Sanitisation (IN PROGRESS)

**Problem discovered:** When the user changes floors (via Levels UI), the `mapShineLevelContextChanged` hook fires. This triggers a massive chain of work that is entirely V1 effect infrastructure — unnecessary and harmful when V2 is active:

#### V1 visibility conflict (Root Cause of specular/_Outdoors on upper floors)

`TileManager._refreshAllTileElevationVisibility()` sets floor 0 tiles to `sprite.visible = false` when the user navigates to floor 1 (and vice versa). This is V1's floor isolation mechanism. V2 uses Three.js **layer masks** instead — all tiles must remain `visible = true`, and the camera mask selects which floor renders in each pass.

**What happened:** Floor 0 tiles were hidden → FloorCompositor rendered floor 0 with only `basePlaneMesh` visible → basePlaneMesh had the PBR material from SpecularEffect (material swap should fix this, but floor 0 tiles being invisible means the background image is the only content) → specular/outdoors artifacts showed through floor 1's transparent gaps.

**Fix:** Added V2 early-return in `_refreshAllTileElevationVisibility()`. When V2 is active, all tiles are forced `visible = true` and `basePlaneMesh.visible = true`. No elevation-based visibility toggling runs.

#### Heavy async hook work (Root Cause of slow floor transitions)

The `mapShineLevelContextChanged` hook in `canvas-replacement.js` triggers an async block that:

| Step | What it does | Cost |
|---|---|---|
| `compositor.composeFloor()` | Loads ALL tile mask textures from disk, GPU-composites into scene-space RTs | **200-500ms+ (disk IO + GPU)** |
| `assetLoader.loadAssetBundle()` | Loads base bundle masks for merging | **50-200ms (disk IO)** |
| `reg.transitionToFloor()` | Notifies ALL effect subscribers (Specular, Lighting, Water, etc.) with new masks | **10-50ms (CPU + GPU material updates)** |
| `compositor.buildFloorIdTexture()` | Renders floor ID texture | **5-10ms (GPU)** |
| `MaskManager` redistribution | Sets textures on mask manager | **5ms** |
| `depthPassManager.invalidate()` | Triggers depth pass rebuild | **varies** |

**Total: 300-800ms+ per floor transition** — all for V1 effect infrastructure that V2 doesn't use.

**Fix:** Added V2 early-return in the async block. When V2 is active, the entire mask compositing + effect redistribution pipeline is skipped. Only `renderLoop.requestRender()` runs. The `finally` block still clears transition locks (`waterEffect._floorTransitionActive`, `reg.endTransition()`).

#### What V2 DOES need during floor transitions (kept)

| Step | Why |
|---|---|
| `FloorStack.rebuildFloors()` | Updates floor band data for the new level context |
| `FloorLayerManager.reassignAllLayers()` | Re-evaluates which tiles belong to which floor layer (cheap — just layer mask bit operations) |
| `renderLoop.requestRender()` | Triggers a render frame so the compositor picks up the new floor state |

#### What V2 does NOT need (skipped)

Everything else: mask loading, GPU compositing, effect subscriber notification, floor ID textures, MaskManager redistribution, depth pass invalidation.

#### Complete list of `mapShineLevelContextChanged` listeners (18 total)

| Listener | Status under V2 | Notes |
|---|---|---|
| `canvas.sounds.refresh()` | **RUNS** | Audio, not visual |
| `FloorStack.rebuildFloors()` | **RUNS** | Needed for V2 floor discovery |
| `FloorLayerManager.reassignAllLayers()` | **RUNS** | Needed for V2 layer assignment |
| Async mask compositing block | **SKIPPED** | V1 effect infrastructure |
| `TileManager._refreshAllTileElevationVisibility()` | **V2 EARLY-RETURN** | Forces all tiles visible=true |
| `LightingEffect._applyFoundryOverrides()` | **RUNS** (harmless) | Updates internal state, no rendering |
| `WorldSpaceFogEffect` vision update | **RUNS** (harmless) | Sets a flag, no rendering |
| `WallManager.updateVisibility()` | **RUNS** | Wall visibility for controls |
| `DrawingManager.refreshVisibility()` | **RUNS** | Drawing visibility |
| `NoteManager.refreshVisibility()` | **RUNS** | Note visibility |
| `TemplateManager.refreshVisibility()` | **RUNS** | Template visibility |
| `LightIconManager._refreshPerLightVisibility()` | **RUNS** | Light icon visibility |
| `GridRenderer.setLevelContextPayload()` | **RUNS** | Grid updates |
| `LevelsPerspectiveBridge` | **RUNS** | Foundry Levels compat sync |
| `ControlsIntegration` wall filter | **RUNS** | Wall editor UI |
| `VisibilityController._queueBulkRefresh()` | **RUNS** | Token visibility |
| `LevelNavigatorOverlay` | **RUNS** | UI update |
| `LevelsAuthoringDialog` | **RUNS** | UI update |

**Validation (Step 2b iteration 1):**
- [x] Floor transition is instant (no delay) ✅
- [ ] Ground floor: clean albedo (no specular, no outdoors mask)
- [ ] Upper floor: clean albedo of upper tiles over clean floor 0
- [ ] All tiles remain visible when switching floors
- [ ] Camera panning/zooming works on both floors
- [x] Levels UI responsive ✅

#### Step 2b Iteration 2: `updateSpriteVisibility()` multi-path leak

**Problem:** The V2 guard in `_refreshAllTileElevationVisibility()` only protected the bulk refresh path. But `updateSpriteVisibility()` is called from **5+ independent code paths**:

1. **Tile texture load** (`textureReady` callback, line ~3211) — async, runs at any time
2. **`updateTile` hook** (Foundry tile doc changes, line ~3511) — fires when Levels updates tile flags
3. **`refreshTile` hook** (Foundry tile refresh, line ~3570)
4. **Hover-hide restore** (line ~3820) — overhead tile UX
5. **`_refreshAllTileElevationVisibility()`** (line ~4330) — already guarded

Each of these calls `updateSpriteVisibility()` → runs elevation-based visibility logic → sets `sprite.visible = false` for tiles outside the active elevation band. When the user is on floor 1, floor 0 tiles get hidden → FloorCompositor renders floor 0 with only basePlaneMesh → PBR material artifacts (specular, _Outdoors) show through floor 1's transparent gaps.

**Fix:** Added V2 guard **inside `updateSpriteVisibility()` itself** (wrapping the elevation-based visibility block at lines ~4104-4194). When V2 is active, the entire Levels elevation visibility logic is skipped. Tiles keep their basic Foundry visibility (hidden/GM state) but are never hidden by elevation checks. Floor isolation is handled purely by Three.js layer masks.

**Files modified:**
- `scripts/scene/tile-manager.js` — V2 guard in `updateSpriteVisibility()` elevation block

**Validation (iteration 2) — visibility guard alone insufficient:**
- [x] Floor transition instant ✅
- [x] Ground floor: clean albedo on initial load ✅
- [ ] Upper floor: still shows effect artifacts ❌

#### Step 2b Iteration 3: SpecularEffect overlay mesh contamination

**Problem:** SpecularEffect creates per-tile overlay meshes (`colorMesh`, `occluderMesh`) and adds them to the **main scene** via `this._scene.add()`. The method `_syncTileOverlayLayers()` copies each tile sprite's `layers.mask` directly to its overlay meshes:

```js
colorMesh.layers.mask = sprite.layers.mask;   // line 1536
occluderMesh.layers.mask = spriteMaskU;        // line 1535
```

When `FloorLayerManager.assignTileToFloor()` puts a tile on floor layer 2, the specular overlay mesh is synced to layer 2 as well. FloorCompositor's camera then renders these PBR ShaderMaterial meshes alongside the clean tile sprites, producing specular/_Outdoors artifacts on the upper floor.

This sync happens:
1. During `bindTileSprite()` (line 1403) — initial binding
2. During per-frame `render()` via `_syncTileOverlayTransform()` (line 1703) — suppressed by V2 breaker fuse, but bind path is not

**Fix:** Added a **scene sanitisation pass** in `FloorCompositor.render()` before the floor loop. It traverses the entire scene and temporarily hides (`visible = false`) every object that:
- Is on ANY floor layer (1–19)
- Is NOT a `Sprite` (tile/token)
- Is NOT `basePlaneMesh`
- Is NOT `_backgroundMesh`

This catches SpecularEffect overlays, IridescenceEffect meshes, and any other effect geometry that may have been assigned to floor layers. Objects are restored to `visible = true` after the floor loop.

A one-shot log reports all hidden meshes for debugging (names, types, layer masks, material classes).

**Files modified:**
- `scripts/compositor-v2/FloorCompositor.js` — scene sanitisation traversal + restore
- `scripts/scene/tile-manager.js` — V2 guard in `updateSpriteVisibility()` (iteration 2, retained)

**Validation pending (iteration 3):**
- [ ] Floor transition instant
- [ ] Ground floor: clean albedo on initial load
- [ ] Upper floor: clean albedo after pressing + (no specular/outdoors artifacts)
- [ ] Console log shows hidden effect meshes (confirms sanitisation working)
- [ ] All tiles remain visible when switching floors
- [ ] Camera panning/zooming works on both floors
