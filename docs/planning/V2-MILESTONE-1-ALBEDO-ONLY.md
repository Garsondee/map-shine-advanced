# V2 Compositor — Planning & Progress

## Milestone 1 — Albedo-Only Floor Compositing ✅ COMPLETE

**Goal:** Render two floors as two images — opaque ground floor (scene background +
ground tiles) and upper floor with correct alpha — composited bottom-to-top with
Levels-compatible floor visibility. Nothing else.

**Status:** Complete as of 2025-02-23.

### What works
- `FloorRenderBus` owns a single `THREE.Scene` with all tiles as `MeshBasicMaterial`
  planes, Z-ordered by floor index.
- Textures loaded via `THREE.TextureLoader` (HTML `<img>`, straight alpha preserved —
  no canvas 2D intermediary, no premultiplied alpha corruption).
- `FloorCompositor.render()` calls `FloorRenderBus.renderToScreen()` — one
  `renderer.render()` call per frame directly to the screen framebuffer.
- No intermediate render targets for Milestone 1.
- Standard Three.js `NormalBlending` handles alpha compositing correctly.
- Floor visibility controlled by `setVisibleFloors(maxFloorIndex)` — tiles with
  `floorIndex > maxFloorIndex` are hidden via `mesh.visible = false`.
- `mapShineLevelContextChanged` hook drives visibility changes from Levels UI.
- Background colour plane + scene background image plane always visible.
- Camera pan/zoom works (shared perspective camera, renderer state saved/restored).
- Minimal UI re-enabled in V2 mode: TweakpaneManager, ControlPanelManager,
  CameraPanelManager, LevelsAuthoringDialog (GM only).
- Tile Inspector shows full filenames + tooltip with full texture path.

### Key files (current state)
| File | Role |
|---|---|
| `scripts/compositor-v2/FloorRenderBus.js` | Single scene, tile meshes, texture loading, visibility |
| `scripts/compositor-v2/FloorCompositor.js` | Lifecycle, render dispatch, floor visibility hook |
| `scripts/foundry/canvas-replacement.js` | `_v2Active` gates bypass V1 effects + minimal UI init |
| `scripts/effects/EffectComposer.js` | V2 breaker fuse delegates to FloorCompositor |

### Architecture (Milestone 1)
```
EffectComposer.render()
  └─ V2 breaker fuse (early return)
       ├─ Run updatables (camera, interaction, tokens, grid, doors)
       └─ FloorCompositor.render()
            ├─ Lazy populate: FloorRenderBus.populate(sceneComposer)
            │    ├─ _addSolidBackground() → full-world colour plane at Z=998
            │    ├─ _addBackgroundImage() → scene-rect image plane at Z=999
            │    └─ For each tile doc:
            │         ├─ _resolveFloorIndex() from Levels flags
            │         ├─ _addTileMesh() at Z=1000+floorIndex
            │         └─ THREE.TextureLoader.load() → async texture fill
            ├─ _applyCurrentFloorVisibility()
            └─ FloorRenderBus.renderToScreen(renderer, camera)
                 ├─ Save renderer state (autoClear, clearColor, renderTarget)
                 ├─ renderer.render(busScene, camera) → screen
                 └─ Restore renderer state
```

---

## Tidying Pass — Prepare for Effect Integration

Before adding any effects, the V2 compositor must be stripped of dead V1 scaffolding
so each new effect integrates into a clean, minimal system.

### What to remove from FloorCompositor

The following were allocated eagerly for the old per-floor RT compositor approach
(Attempts 1-4) and are **not used** by the Milestone 1 direct-to-screen path:

- `_floorRT`, `_floorPostA`, `_floorPostB`, `_accumulationRT` — 4 render targets
- `_materials` (`CompositorMaterials`) — compositor shader materials
- `_quadMesh`, `_quadScene`, `_quadCamera` — fullscreen quad infrastructure
- `_compositeFloor()`, `_blitToScreen()` — helper methods using above
- `_ensureSize()` — RT resize helper
- `preWarmShaders()` — warms the unused compositor shaders
- `setDepthPassManager()` / `_depthPassManager` — not used in Milestone 1
- `populateRenderBus()` — legacy TileManager-based populate (replaced by `populate(sceneComposer)`)
- `get renderBus` — exposed for TileManager direct registration (no longer used)

### What to keep in FloorCompositor

- `renderer`, `scene`, `camera` refs
- `_renderBus` (FloorRenderBus instance)
- `_busPopulated` flag
- `_initialized` flag
- `_levelHookId` + `_onLevelContextChanged` + `_applyCurrentFloorVisibility`
- `initialize()` (stripped to just bus init + hook registration)
- `render()` (populate + renderToScreen)
- `dispose()` (bus dispose + hook unregister)
- `onResize()` (forward to bus if needed later)
- `_sizeVec` (reusable)

### What to audit in canvas-replacement.js

Items still initialized under `_v2Active` that may not be needed:

- `TileManager` — still created + `syncAllTiles()`. Currently not used by V2 rendering
  (FloorRenderBus reads tile docs directly). May be needed for interaction/selection.
  **Decision: keep for now, evaluate when adding token/tile interaction.**
- `FloorLayerManager` — `reassignAllLayers()` still runs. FloorRenderBus resolves
  floor index independently. **Decision: can be removed if nothing else depends on it.**
- Dead `populateRenderBus()` call site — if present, remove.

---

## Milestone 2 — Effect Integration Plan

### Strategy
Add effects **one at a time** into `scripts/compositor-v2/effects/`. Each effect:

1. Gets a clean V2 implementation in `compositor-v2/effects/`
2. Integrates into FloorCompositor's render loop
3. Is validated visually before the next effect is added
4. V1 effect file remains untouched — V2 version is independent

### Directory structure
```
scripts/compositor-v2/
  FloorCompositor.js      — render loop orchestration
  FloorRenderBus.js       — tile scene management
  effects/
    .gitkeep
    (V2 effect implementations will go here)
```

### Effect integration order (tentative — simplest/most impactful first)
1. **Lighting** — ambient/darkness, most visible improvement over raw albedo
2. **Water** — world-space, mask-driven
3. **Fog** — screen-space post
4. **Specular** — world-space, mask-driven
5. **Shadows** — building/overhead
6. **Particles** — fire, dust, ash, smoke
7. **Post-processing** — bloom, color correction, film grain, etc.
8. **Distortion** — heat haze, water ripples

Each step may require:
- Render target infrastructure (add back to FloorCompositor when needed)
- Mask loading (from scene assets, not V1 EffectMaskRegistry)
- Uniform plumbing (time, camera, scene bounds)

### When to add RTs back
Intermediate render targets (`_floorRT`, `_accumulationRT`, etc.) will be re-introduced
**only when an effect requires them** (e.g. lighting needs to sample the albedo as input).
They will NOT be pre-allocated speculatively.

---

## Attempt Log (Milestone 1 — historical)

### Attempt 1 — Effect pipeline bypass
Added `_v2Active` flag gating all V1 effect construction. Ground floor worked, upper floor
showed wrong content (all tiles on floor 0).

### Attempt 2 — Fix floor index resolution
Removed broken `_spriteFloorMap` indirection. Added `_resolveFloorIndex()` reading Levels
flags directly. Tiles now land on correct floors.

### Attempt 3 — Fix async texture loading race
Removed `textureReady` guard, added `syncTextures()` per-frame method. All tiles registered
immediately, textures appear as they load.

### Attempt 4 — Fix floor-index overwrite + BgImage face culling
Removed TileManager async callback that re-registered tiles on floor 0. Changed BgImage
material to DoubleSide. Still broken — alpha corruption from canvas 2D premultiplication.

### Attempt 5 — Full rewrite: bypass TileManager textures entirely
Identified canvas 2D `drawImage()` as the premultiplied alpha corruption source.
Rewrote FloorRenderBus to load textures via `THREE.TextureLoader` (HTML `<img>`,
straight alpha), single scene, Z-ordered, direct-to-screen render. **This worked.**

### Attempt 6 — White screen / camera / visibility fixes
- `renderToScreen` now saves/restores renderer state (autoClear, clearColor, renderTarget)
- Background meshes stored in `_tiles` map so `setVisibleFloors` can manage them
- `setClearColor(0x000000, 1)` prevents white flash while textures load
