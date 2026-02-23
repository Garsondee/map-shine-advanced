# Per-Level Mesh Architecture

## The Problem

We're trying to do everything in terms of rendering and layering complex effects onto a single mesh. This was fine when we started but now we have 'levels/floors' and the whole thing is starting to break under the strain.

## Problem Confirmation: The Evidence

The problem is **confirmed and extensively documented** across the codebase. Two existing documents record the damage in detail:

### LAYERING-FAILURE-RECORD.md — 20 Failed Attempts

The water-over-upper-floor bug alone consumed **20 separate fix attempts** spanning `WaterEffectV2`, `DistortionManager`, `GpuSceneMaskCompositor`, `tile-manager`, and `EffectMaskRegistry`. Every approach failed for the same structural reason: **a single global post-processing pass cannot distinguish which floor a pixel belongs to**.

The failure modes fell into three categories:

1. **State-level toggling (Attempts 1–16):** Enabling/disabling water masks at the effect level is binary — it kills water on ALL floors or none. Both floors are visible simultaneously through transparency gaps, so no global toggle is correct.

2. **Floor ID gating (Attempts 14, 17–18):** A world-space Floor ID texture encodes which floor owns each pixel, but it cannot distinguish "upper floor tile seen from above" (suppress water) from "upper floor tile seen from below" (show water). The same pixel needs different behavior depending on which floor the viewer is on — impossible with a single render pass.

3. **Compositor patching (Attempts 13, 19–19c):** `_patchWaterMasksForUpperFloors` tried to subtract upper-floor tile alpha from the ground-floor water mask before SDF construction. This failed because the ground floor is loaded via `_floorMeta` (file-based), never GPU-composited into `_floorCache`, so the patch function never found it.

**Root cause (from Attempt 16 conclusion):** "WaterEffectV2 and DistortionManager are both global POST_PROCESSING effects — they run once per frame for the entire screen. Setting `waterMask = null` disables water for ALL pixels. There is no per-pixel floor discrimination."

### LEVELS-ARCHITECTURE-RETHINK.md — 12 Structural Problems

The architecture rethink doc catalogues 12 root-cause problems in the current system, all flowing from the single-mesh/single-pass architecture:

| # | Problem | Root Cause |
|---|---------|-----------|
| 1 | Tile albedo capped at 4096 | Hard `TILE_MAX_DIM` in `loadTileTexture()` |
| 2 | Compositor masks capped at 4096/8192 | Hard `DATA_MAX`/`VISUAL_MAX` constants |
| 3 | No per-floor mask isolation | Single `_slots` Map in `EffectMaskRegistry` |
| 4 | Background ≠ tiles | Separate load/render paths, no shared layer abstraction |
| 5 | Only current + below tracked | `_activeFloorKey`/`_belowFloorKey` two-slot model |
| 6 | Cache eviction at 8 floors | `_maxCachedFloors = 8` with no dynamic sizing |
| 7 | Effects get single mask, not per-floor | `subscribe(type, cb)` returns one texture at a time |
| 8 | One scene render, not per-floor | `EffectComposer.render()` does a single `renderer.render()` |
| 9 | `preserveAcrossFloors` creates paradoxes | Global per-type policy vs per-floor-per-pixel need |
| 10 | Per-tile identity lost in composition | Single RT per mask type per floor |
| 11 | No unified layer model | Three disjoint systems (bg, tiles, masks) |
| 12 | Floor-presence gate is screen-space | Resolution-dependent, viewport-dependent, geometry-doubling |

### Current Architecture: Why It Breaks

The rendering pipeline today works like this:

```
1. SceneComposer creates ONE basePlaneMesh (background image)
2. TileManager adds tile sprites to the SAME scene
3. EffectComposer renders everything in ONE pass → sceneRenderTarget
4. Post-processing effects operate on that SINGLE composited image
5. Floor transitions swap masks in EffectMaskRegistry (one active set)
```

When floors are introduced, the system bolts on workarounds:
- **Screen-space floor-presence gates** (`floorPresenceTarget`, `belowFloorPresenceTarget`) — duplicate tile geometry as separate meshes to produce screen-space alpha masks
- **`preserveAcrossFloors` policies** — binary keep/replace per mask type (creates paradoxes with N floors)
- **`_belowFloorKey` tracking** — only tracks one floor below (breaks with 3+ floors)
- **Floor ID textures** — world-space per-pixel floor index (can't distinguish viewer perspective)

Each workaround adds complexity and creates new failure modes, because the **fundamental architecture assumes a single floor**.

### The Core Contradiction

The system has two conflicting requirements that cannot be satisfied by a single render pass:

1. **From the ground floor:** Water must render everywhere, including under upper floor tile footprints (the player sees through the upper floor's transparent gaps).
2. **From the upper floor:** Water must NOT render under upper floor tiles (the player is standing on those tiles).

Both requirements apply to the **same screen pixels**. A single global post-processing pass cannot satisfy both simultaneously.

---

## The Solution

**Each level gets its own mesh. We separate out the levels so that they cannot interact with each other. Each mesh will run its own system cleanly.**

This is the "Full Per-Floor Rendering" approach documented in Part 4 of the architecture rethink:

```
For each visible floor (bottom to top):
  1. Show ONLY this floor's tiles, tokens, and effect meshes
  2. renderer.render(scene, camera) → FloorSceneRT[i]
  3. Run this floor's scene effects on FloorSceneRT[i]
  4. Run this floor's post effects on FloorSceneRT[i]
  5. Alpha-composite FloorSceneRT[i] into AccumulationRT

Run floor-AGNOSTIC post effects on AccumulationRT:
  - Bloom, color correction, film grain, etc.

Output to screen.
```

### Why This Works

| Aspect | Current (Single Pass) | Per-Level Mesh |
|---|---|---|
| **Water on Floor 0** | Global mask floods upper floors | Floor 0's water renders only into Floor 0's RT |
| **Distortion** | UV-offset pulls in pixels from other floors | Each floor's distortion operates on isolated RT |
| **Mask ownership** | Global `_slots` swapped on transition | Each floor permanently owns its masks |
| **Floor-presence gates** | Screen-space workarounds | Eliminated — isolation by construction |
| **`preserveAcrossFloors`** | Creates paradoxes | Eliminated entirely |
| **Effect shader changes** | Every effect needs floor-awareness hacks | Effects need NO shader changes — just called per floor |
| **Semi-transparent floors** | Tricky dual floor-ID encoding | Handled naturally by alpha compositing |

### Why the GPU Cost Is Acceptable

VTT scenes are geometrically trivial: 20–100 textured quads per floor, 2 triangles each. With 4 visible floors, total geometry is ~800 triangles — modern GPUs render millions per millisecond.

The real cost is fullscreen post-processing passes. With 4 floors × ~5 floor-aware effects = 20 passes. At 1080p, each pass takes ~0.1–0.3ms. Total: **2–6ms** — well within frame budget.

Effect render targets (light, darkness, shadow, etc.) are **overwritten each floor pass** and consumed immediately. No VRAM multiplication. The only per-floor VRAM cost is load-time data (SDF, spawn point arrays) — small and bounded.

New render targets needed: 2 floor ping-pong RTs + 1 accumulation RT = **50 MB at 1080p, 200 MB at 4K**. Acceptable.

---

## What This Eliminates

### Removed Entirely

| System | Why |
|---|---|
| `EffectMaskRegistry._slots` (single-slot model) | Replaced by `Floor.masks` per-floor storage |
| `preserveAcrossFloors` policy | Each floor permanently owns its masks |
| `transitionToFloor()` replace/preserve/clear | Floor switch changes `activeFloorIndex` only |
| `_belowFloorKey` / `_activeFloorKey` tracking | Replaced by `FloorStack` index arithmetic |
| `_transitioning` lock flag | No global mutable state to protect |
| Screen-space `floorPresenceTarget` | Replaced by world-space `Floor.alpha` |
| Screen-space `belowFloorPresenceTarget` | Replaced by world-space `Floor[n-1].alpha` |
| Floor-presence mesh duplication | Floor alpha composed from tile alpha, no extra geometry |
| All `connectToRegistry()` subscriptions | Replaced by `bindFloorMasks()` per floor pass |
| Floor ID texture | Eliminated — per-floor rendering makes it unnecessary |
| `_patchWaterMasksForUpperFloors` | Eliminated — each floor has its own water mask |

### ~175 Lines Removed from DistortionManager Alone

- `floorPresenceScene`/`belowFloorPresenceScene` render passes
- `tFloorPresence`/`tBelowFloorPresence` uniforms + GLSL
- `tBelowWaterMask`/`uHasBelowWaterMask`
- `uWindowLightBelowFloor` gating
- `outdoorsScene` render pass (replaced by direct mask uniform)

---

## Key Design Decisions (Already Resolved)

These decisions were documented and confirmed in the architecture rethink:

| Decision | Resolution |
|---|---|
| **Max floors** | No hard limit. Design for ≤5 typical, tolerate more. |
| **Tile albedo resolution** | Full resolution always. Remove `TILE_MAX_DIM = 4096` cap. |
| **Overhead/roof tiles** | Per-floor overhead layers with mouse-hover fade. |
| **Per-tile vs per-floor masks** | Everything composited per-floor. No exceptions. |
| **Expensive per-floor work** | All heavy work during scene loading. No mid-game freezes. |
| **Simulation double-stepping** | `prepareFrame(timeInfo)` called once; `update()` per-floor for uniforms only. |
| **Global scene objects** | `GLOBAL_SCENE_LAYER = 29` — drawings, notes, fog plane render once after floor loop. |
| **Depth pass** | `captureForFloor()` per floor inside the loop, bypassing rate limiter. |

---

## Effect Classification (Complete)

Every effect is classified as either **FLOOR_PASS** (runs once per visible floor) or **GLOBAL_PASS** (runs once on final composite):

### FLOOR_PASS (17 effects)

`LightingEffect`, `WaterEffectV2`, `DistortionManager`, `AtmosphericFogEffect`, `SpecularEffect`, `FluidEffect`, `IridescenceEffect`, `PrismEffect`, `TreeEffect`, `BushEffect`, `WindowLightEffect`, `BuildingShadowsEffect`, `OverheadShadowsEffect`, `CandleFlamesEffect`, `FireSparksEffect`, `AshDisturbanceEffect`, `DustMotesEffect`

### GLOBAL_PASS (14 effects)

`WorldSpaceFogEffect`, `WeatherParticles`, `SkyColorEffect`, `BloomEffect`, `ColorCorrectionEffect`, `FilmGrainEffect`, `AsciiEffect`, `HalftoneEffect`, `DotScreenEffect`, `SharpenEffect`, `DetectionFilterEffect`, `MaskDebugEffect`, `PlayerLightEffect`, `DynamicExposureManager`

### Stateful Effects Requiring Per-Floor State Maps (7 effects)

`WaterEffectV2`, `FireSparksEffect`, `DustMotesEffect`, `AshDisturbanceEffect`, `BuildingShadowsEffect`, `TreeEffect`, `BushEffect`

---

## Implementation Phases (Summary)

Detailed implementation checklists exist in `LEVELS-ARCHITECTURE-RETHINK.md` Parts 5 and 12. The phases are:

| Phase | Items | Risk | Description |
|---|---|---|---|
| **Phase 0** | ~16 | Low | FloorStack class, `GLOBAL_SCENE_LAYER`, `captureForFloor()` — no rendering changes |
| **Phase 1** | ~20 | Medium | `prepareFrame()` lifecycle, `floorScope` classification, per-floor mask storage |
| **Phase 2** | ~40 | **High** | Per-floor rendering loop in EffectComposer — the core change |
| **Phase 3** | ~35 | **High** | Stateful effect adaptation (7 effects need per-floor state maps) |
| **Phase 4** | ~25 | Medium | Hook simplification, legacy removal, system integration |
| **Phase 5** | ~30 | Low | Testing, profiling, edge cases |

**Overall architecture confidence: 85%** after four complete deep-dive passes. No unknown unknowns remain. All risks are in execution details (effect state management, disposal correctness), not fundamental design.

---

## Implementation Progress

### Phase 0 — Complete ✅
All foundational items implemented:
- `FloorStack.js` with floor discovery, visibility toggling, `getVisibleFloors()`, `restoreVisibility()`
- `GLOBAL_SCENE_LAYER = 29` constant in `EffectComposer.js`
- `captureForFloor()` on `DepthPassManager` (bypasses rate limiter)
- `GLOBAL_SCENE_LAYER` assigned to `DrawingManager.group` and `NoteManager.group`
- `prepareFrame()` lifecycle and `floorScope` property on `EffectBase`
- `FloorStack` wired into `canvas-replacement.js`, exposed on `window.MapShine.floorStack`
- Multiple effects classified with `floorScope = 'global'` (WorldSpaceFog, PlayerLight, Lightning, Lensflare, Cloud, CandleFlames, ParticleSystem, SmellyFlies)

### Phase 1 — Complete ✅
- `prepareFrame()` called once per frame before floor loop
- `floorScope` drives floor-loop vs global-loop classification
- `bindFloorMasks()` called per-floor for scene effects

### Phase 2 — Core Per-Floor Rendering — Complete ✅
The core architectural change. Key implementation in `EffectComposer.render()`:

1. **New render targets** (lazily created by `_ensureFloorRenderTargets()`):
   - `_floorRT` — per-floor geometry RT with depth buffer (cleared to transparent each floor)
   - `_floorPostA` / `_floorPostB` — ping-pong buffers for floor-scoped post effects
   - `_accumulationRT` — alpha-composited floor stack

2. **Floor compositor** (`_compositeFloorToAccumulation()`):
   - Dedicated `_compositeScene` + `_compositeCamera` + `_compositeQuad`
   - `_compositeMaterial` with custom alpha-over blending (SrcAlpha, OneMinusSrcAlpha)
   - `_blitToScreen()` reuses compositor with NoBlending for final output when no global post effects

3. **Per-floor render loop** (when `experimentalFloorRendering` is enabled):
   - For each visible floor (bottom→top): isolate geometry → depth capture → bind masks (scene + post) → scene effects → geometry render into `_floorRT` → floor-scoped post effects ping-pong → alpha-composite into `_accumulationRT`
   - Global scene effects run once on accumulated image
   - Global post effects ping-pong from `_accumulationRT` → screen

4. **POST_PROCESSING exclusion removed**: `bindFloorMasks()` now called for ALL floor-scoped effects including water, distortion, fog, and lighting. Per-floor RT isolation prevents cross-floor bleed by construction.

5. **Legacy path preserved**: Falls through to existing PASS 2 when floor loop is disabled.

### Phase 2b — Critical Bug Fixes — Complete ✅
Fixes discovered during first runtime testing of the per-floor pipeline:

1. **basePlaneMesh opacity bug** (`FloorStack.js`):
   The scene background mesh (`basePlaneMesh`) was rendering on EVERY floor pass, making every floor's `_floorRT` fully opaque. This prevented alpha compositing from working — ground-floor water was invisible when viewing upper floors.
   - Fix: `setFloorVisible()` now manages `basePlaneMesh` visibility. It only renders on floor index 0 (ground floor). Upper floors produce transparent pixels where they have no geometry, allowing lower floors to show through.

2. **Water mask stripped from ground floor** (`GpuSceneMaskCompositor.js`):
   The `preserveAcrossFloors` filter in `composeFloor()` was stripping water from the base bundle for ALL floors — including the ground floor where the water mask originates. This meant `_floorMeta` for floor 0 had no water mask, so `bindFloorMasks()` cached a "no water" state.
   - Fix: Only strip `preserveAcrossFloors` masks on upper floors (`bandBottom > 0`). The ground floor keeps its own water mask in both Step 2 (GPU compositor merge) and Step 3 (fallback bundle load).

3. **Pre-warm per-floor effect states during loading** (`canvas-replacement.js`):
   WaterEffectV2 builds a CPU-side SDF on the first `bindFloorMasks()` call for each floor. Without pre-warming, this stalled the first render frame after a floor switch.
   - Fix: After `preloadAllFloors()` completes, iterate all cached `_floorMeta` entries and call `bindFloorMasks()` on every floor-scoped effect that implements it (WaterEffectV2, LightingEffect, SpecularEffect, etc.). This populates `_floorStates` caches (including SDF data) during the loading screen.

### Phase 2c — Upper-Floor Alpha Clip Pass — Complete ✅
Upper-floor tile images span the full scene rect but only have room artwork in certain areas — the rest is opaque grey/grid fill (alpha=1.0). Without clipping, upper floors composite as fully opaque, hiding the ground floor entirely.

**Fix** (`EffectComposer.js`):
- New method `_applyFloorAlphaClip(floorInputRT)` runs after post effects but before compositing for floors with index > 0.
- Reads LightingEffect's `outdoorsTarget` — a screen-space RT whose R channel is 1.0 for outdoor pixels (no roof at this elevation) and 0.0 for indoor.
- A lightweight fullscreen shader multiplies the floor RT's alpha by `(1.0 - outdoors)`, zeroing out outdoor areas so lower floors show through during alpha compositing.
- Uses the existing compositor quad/scene/camera with a temporary material swap (no additional scene objects).
- `_floorAlphaClipMaterial` is lazily created and disposed alongside other compositor resources.

### Phase 3 — Effect Pipeline Integration — In Progress
The per-floor RT pipeline and mask binding are working. Remaining integration work:

- **DistortionManager**: Does NOT have `bindFloorMasks()` but doesn't need one — it reads water mask from its registered "water" source, which WaterEffectV2 syncs every frame during `update()`. The per-floor loop ensures WaterEffectV2 runs before DistortionManager (priority 80 vs 85), so DistortionManager receives the correct per-floor water mask.
- **Effect render order validation**: Floor-scoped POST_PROCESSING effects must run in the same priority order inside the per-floor loop as they do in the legacy PASS 2 pipeline. Currently relies on `resolveRenderOrder()` sorting — needs runtime verification.
- **Alpha blending correctness**: The compositor uses non-premultiplied alpha-over blending. Need to verify that Three.js scene renders into `_floorRT` produce correct alpha values (transparent where no geometry exists).
- **WorldSpaceFogEffect**: Currently on `OVERLAY_THREE_LAYER` (31) with `floorScope='global'`. Its `fogPlane` should potentially be on `GLOBAL_SCENE_LAYER` (29) instead — needs evaluation.

### Phase 4–5 — Integration & Testing — Pending
- Full multi-floor scene testing with water, fire, lighting across 2+ floors
- Performance profiling of per-floor overhead (additional draw calls, RT switches)
- Edge case testing: single-floor scenes, scenes with no Levels data, basement floors

---

## Related Documents

- `docs/planning/LAYERING-FAILURE-RECORD.md` — 20 failed fix attempts documenting why single-pass rendering cannot solve cross-floor effects
- `docs/planning/LEVELS-ARCHITECTURE-RETHINK.md` — 3800-line comprehensive architecture analysis, proposed Floor Stack model, effect-by-effect deep dives, implementation checklists, and pre-implementation verification tasks
