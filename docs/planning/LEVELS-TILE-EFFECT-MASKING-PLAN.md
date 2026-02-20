# Levels-Aware Tile Effect Masking & Layering Plan

## Problem Statement

The current effect mask system treats masks as **scene-global singletons** — one `_Fire`, one `_Water`, one `_Windows`, one `_Outdoors` texture per scene (or per floor when Levels is active). This was designed for the simple case where a single large battlemap image spans the scene and its suffix masks cover everything.

This breaks down when:
- **Foreground/overhead tiles sit above the background** and have their own suffix masks
- **Multiple floors exist** (Levels) and each floor's tile has different masks
- **Tiles overlap** and the upper tile should mask or override effects from the lower one
- **Tile resolution differs** from the scene-level composite resolution

### Observed Symptoms

| Symptom | Root Cause |
|---|---|
| Tile above background shows lower resolution | Mask composition downscales to fit scene composite canvas (capped at 2048px for data masks, 8192px hard cap for composites) |
| Fire effect appears everywhere instead of white areas of `_Fire` mask | Wrong tile selected for mask source; mask from wrong floor/tile covers the full scene |
| Water effect appears everywhere on upper floor | `_Water` mask from ground floor persists or wrong tile's mask is loaded for upper floor |
| `_Windows` effect not working on foreground tile | Per-tile mask loading only exists for `_Water`, `_Specular`, and `_Fluid` — not for `_Windows`, `_Fire`, `_Outdoors`, etc. |
| Upper tile effects bleed into lower tile regions | No per-tile mask scoping; effects use a single scene-wide mask with no Z/layer awareness |

---

## Current Architecture Analysis

### How Masks Flow Today

```
Scene Load
  │
  ├── SceneComposer._probeBestMaskBasePath()
  │     └── Finds the largest tile that spans the scene → extracts basePath
  │
  ├── assetLoader.loadAssetBundle(basePath)
  │     └── Probes for _Fire, _Water, _Windows, _Outdoors, _Specular, etc.
  │     └── Returns bundle.masks[] — one texture per suffix
  │
  ├── Effects receive bundle via setBaseMesh/setAssetBundle:
  │     ├── FireSparksEffect.setAssetBundle(bundle)     → reads masks.find(type=='fire')
  │     ├── WaterEffectV2.setBaseMesh(mesh, bundle)     → reads masks.find(type=='water')
  │     ├── WindowLightEffect.setBaseMesh(mesh, bundle) → reads masks.find(type=='windows')
  │     ├── LightingEffect.setBaseMesh(mesh, bundle)    → reads masks.find(type=='outdoors')
  │     ├── SpecularEffect.setBaseMesh(mesh, bundle)    → reads masks.find(type=='specular')
  │     └── ... (dust, ash, building shadows, etc.)
  │
  └── Level Switch (mapShineLevelContextChanged)
        ├── SceneComposer.rebuildMasksForActiveLevel(ctx)
        │     └── _getLargeSceneMaskTiles(scene, ctx)
        │           └── Finds largest tile in active level band → loads masks from its basePath
        │           └── Caches per floor key "${bottom}:${top}"
        └── Redistributes new masks to all effects (same setBaseMesh/setAssetBundle calls)
```

### Key Architectural Gaps

#### Gap 1: Only "Large Scene-Spanning Tiles" Contribute Masks
`_getLargeSceneMaskTiles()` requires tiles to:
- Cover ≥20% of scene area
- Be Y-aligned with the scene rect (same height + same Y position)

**Consequence**: A foreground building tile (say 800×600px) placed on top of a 4096×4096 terrain background will NEVER be found as a mask source. Its `_Fire`, `_Windows`, `_Water` masks are completely ignored.

#### Gap 2: Scene-Level Masks Are Singletons
Each effect gets exactly ONE mask texture for the whole scene. There's no concept of "this region of the scene uses tile A's `_Fire` mask and that region uses tile B's `_Fire` mask."

#### Gap 3: Per-Tile Mask Loading Is Inconsistent
`TileManager` has per-tile mask loading for:
- ✅ `_Water` (via `loadTileWaterMaskTexture`) → used by water occluder meshes
- ✅ `_Specular` (via `loadTileSpecularMaskTexture`) → used by SpecularEffect overlays
- ✅ `_Fluid` (via `loadTileFluidMaskTexture`) → used by FluidEffect overlays
- ❌ `_Fire` — no per-tile loading
- ❌ `_Windows` — no per-tile loading
- ❌ `_Outdoors` — no per-tile loading
- ❌ `_Dust` / `_Ash` — no per-tile loading

#### Gap 4: No Tile-Space → Scene-Space Composition
When effects that operate in scene-space (fire particles, water post-process, lighting) need masks, they need a single scene-space texture. There's no compositor that takes per-tile masks and blits them into the correct position/scale/rotation within a scene-space composite.

#### Gap 5: Level Switch Mask Composition Is Fragile
`rebuildMasksForActiveLevel` finds tiles in the active band and loads masks from the "primary" (largest) tile's basePath. If the wrong tile is selected, or if multiple tiles contribute different masks at different positions, the result is incorrect.

#### Gap 6: Mask Resolution Is Capped Too Low for Tiles
Data masks (fire, water, outdoors, dust, ash) are capped at `MASK_MAX_SIZE = 2048`. For a 4096×4096 scene background this is adequate (50% resolution), but when a smaller foreground tile has its own detailed mask, the downscale can destroy the authored detail.

---

## Proposed Architecture

### Design Principle: Per-Tile Masks Composited into Scene-Space

Instead of finding ONE tile and loading its masks, we should:

1. **Load masks per-tile** — every visible tile that has suffix masks gets them loaded
2. **Composite into scene-space** — blit each tile's mask into the correct position within a scene-sized canvas, respecting tile transform (position, scale, rotation, flip)
3. **Layer by Z-order** — upper tiles' masks overwrite/composite over lower tiles' masks
4. **Scope by level band** — only tiles on the active floor contribute to the composite
5. **Distribute composites to effects** — effects still receive a single scene-space texture, but it now correctly represents all contributing tiles

### Architecture Diagram

```
Per-Tile Mask Loading (TileManager)
  │
  ├── Tile A (background, z=0, elev=0):  _Fire_A, _Water_A, _Windows_A, _Outdoors_A
  ├── Tile B (foreground, z=1, elev=0):  _Fire_B, _Windows_B
  ├── Tile C (overhead/roof, elev=10):   _Outdoors_C
  └── Tile D (upper floor, elev=10):     _Fire_D, _Water_D, _Windows_D
      │
      ▼
Scene Mask Compositor (NEW)
  │
  ├── Input: all per-tile masks for the active floor
  ├── For each mask type (_Fire, _Water, _Windows, _Outdoors, ...):
  │     1. Create scene-sized canvas (or render target)
  │     2. Sort contributing tiles by Z-order (lowest first)
  │     3. For each tile:
  │     │     a. Skip if not on active floor (level band check)
  │     │     b. Skip if not visible
  │     │     c. Blit tile's mask into scene-space position
  │     │        (apply tile x/y/width/height/scaleX/scaleY/rotation)
  │     │     d. Use appropriate composite mode:
  │     │        - _Fire, _Dust, _Ash: additive (lighten) — more sources = more effect
  │     │        - _Outdoors: replace (upper tile defines indoor/outdoor)
  │     │        - _Water: lighten (more water sources = more water)
  │     │        - _Windows: replace (upper tile's windows override)
  │     │        - _Specular, _Normal, _Roughness: replace (upper tile's PBR data wins)
  │     3. Output: one scene-space texture per mask type
  │
  └── Output bundle.masks[] → distributed to effects as today
```

### Key Design Decisions

#### D1: Composition Modes Per Mask Type

| Mask | Composite Mode | Rationale |
|---|---|---|
| `_Fire` | **Lighten** (max) | Multiple tiles can have fire; union of all fire regions |
| `_Water` | **Lighten** (max) | Multiple tiles can have water; union of all water regions |
| `_Outdoors` | **Source-over** (replace) | Upper tile determines indoor/outdoor; building on terrain overrides terrain's outdoors |
| `_Windows` | **Source-over** (replace) | Upper tile's window layout overrides lower tile |
| `_Specular` | **Source-over** (replace) | Upper tile's PBR data is authoritative |
| `_Normal` | **Source-over** (replace) | Upper tile's normal map is authoritative |
| `_Roughness` | **Source-over** (replace) | Upper tile's roughness is authoritative |
| `_Dust` / `_Ash` | **Lighten** (max) | Union of particle spawn regions |
| `_Fluid` | **Source-over** (replace) | Upper tile's fluid flow overrides |
| `_Iridescence` / `_Prism` | **Source-over** (replace) | Upper tile's effect data wins |

**Source-over for _Outdoors is critical**: If a building tile sits on top of outdoor terrain, the building's `_Outdoors` mask (mostly black = indoor) must replace the terrain's `_Outdoors` mask (white = outdoor) in the overlapping region. Without this, the building interior appears "outdoor" because the terrain mask bleeds through.

#### D2: Tile Eligibility for Mask Composition

A tile contributes masks to the composite if:
1. It is **visible** (passes `updateSpriteVisibility` checks)
2. It is on the **active level band** (passes `_isTileInLevelBand`)
3. It is **not hidden** (`!tileDoc.hidden`, or GM mode allows it)
4. It has at least one suffix mask file alongside its texture

We remove the old "must cover ≥20% of scene area" requirement. Any visible tile with masks contributes.

#### D3: Resolution Strategy

The composite canvas resolution should be:
- **Width/Height**: `min(maxSceneDimension, GPU_MAX_TEX_SIZE)`
- **Scale factor**: `compositeSize / sceneDimension`
- For **visual detail masks** (specular, normal): target 4096px max
- For **data masks** (fire, water, outdoors): target 2048px max (sufficient for spawn/threshold logic)
- Per-tile masks should be loaded at their **native resolution** (no premature downscale) and blitted into the composite at the correct scale

#### D4: Per-Tile Mask Loading Extension

Extend `TileManager` to load ALL suffix masks per tile, not just Water/Specular/Fluid:

```
_tileEffectMasks: Map<tileId, Map<maskType, THREE.Texture>>
```

This cache is keyed by tile ID and mask type. Loading reuses the existing `_deriveMaskPath` / `_fileExistsViaFilePicker` / `loadTileTexture` infrastructure.

#### D5: Level-Aware Compositor Replaces `rebuildMasksForActiveLevel`

The current `rebuildMasksForActiveLevel` (which finds ONE large tile and loads its masks) is replaced by:
1. Collect all visible tiles on the active floor
2. For each tile, ensure its per-tile masks are loaded (from cache or disk)
3. Run the compositor to produce scene-space mask textures
4. Distribute to effects as before

This naturally handles:
- Single-tile scenes (one tile contributes all masks — same as today)
- Multi-tile scenes (compositor blits each tile's contribution)
- Level switches (different tile set on each floor)
- Foreground tiles (included regardless of size, positioned correctly)

---

## Implementation Plan

### Phase 0: Diagnostic & Validation Groundwork

**Goal**: Understand what's actually happening in the user's scene before changing code.

- [ ] **P0.1**: Add diagnostic logging to `_getLargeSceneMaskTiles` showing which tiles are found/rejected and why (area check, Y-alignment, level band)
- [ ] **P0.2**: Add diagnostic logging to `rebuildMasksForActiveLevel` showing the selected basePath, cache key, loaded mask types, and their resolutions
- [ ] **P0.3**: Add a "Mask Debug" panel to Tweakpane showing:
  - Active mask source tile(s) and their basePaths
  - Per-mask-type: resolution, source tile ID, whether composite or single-tile
  - Per-tile: which suffix masks were found on disk

### Phase 1: Per-Tile Mask Discovery & Loading

**Goal**: Every tile can have suffix masks loaded and cached.

- [ ] **P1.1**: Extend `TileManager` with a generic `_resolveTileMaskUrl(tileDoc, suffix)` method
  - Reuses existing `_splitUrl`, `_getMaskCandidates`, `_fileExistsViaFilePicker` pattern
  - Supports all suffix types, not just `_Water`/`_Specular`/`_Fluid`
  - Returns resolved URL or null
- [ ] **P1.2**: Add `_tileEffectMasks` map: `Map<tileId, Map<maskType, {url, texture}>>`
  - Populated lazily per tile when `updateSpriteTransform` runs
  - Cleared when tile is removed or texture changes
- [ ] **P1.3**: Add `loadAllTileMasks(tileDoc)` that probes all suffix types for a given tile
  - Batch-loads in parallel
  - Updates `_tileEffectMasks` cache
  - Only probes suffix types that the scene actually uses (check scene settings / active effects)
- [ ] **P1.4**: Wire `loadAllTileMasks` into the tile creation/update flow
  - On `createTile` / `refreshTile`: trigger mask loading
  - On `deleteTile`: clear cache entry
  - On level switch: trigger reload for newly visible tiles

### Phase 2: Scene Mask Compositor

**Goal**: Composite per-tile masks into scene-space textures.

- [ ] **P2.1**: Create `SceneMaskCompositor` class (new file: `scripts/masks/scene-mask-compositor.js`)
  - Input: `TileManager._tileEffectMasks`, active level context, scene dimensions
  - Output: `Map<maskType, THREE.Texture>` — one composited scene-space texture per mask type
  - Uses 2D canvas compositing (same approach as existing `_buildCompositeSceneMasks`)
- [ ] **P2.2**: Implement per-mask-type composite modes (see D1 table above)
  - `lighten` for additive masks (fire, water, dust, ash)
  - `source-over` for replace masks (outdoors, windows, specular, normal, roughness)
- [ ] **P2.3**: Implement tile→scene-space blitting
  - Transform tile mask pixels to scene coordinate space using tile's x/y/width/height/scaleX/scaleY/rotation
  - Handle Y-flip between Foundry coords and texture coords
  - Handle tile transparency (alpha channel gating)
- [ ] **P2.4**: Implement Z-order sorting
  - Tiles composited in sort-key order (lowest first, highest last)
  - Higher tiles' masks overwrite/blend with lower tiles' masks
- [ ] **P2.5**: Implement level band filtering
  - Only tiles passing `_isTileInLevelBand` contribute to the composite
  - Reuse existing boundary logic (exclusive: `tileTop <= bandBottom || tileBottom >= bandTop`)
- [ ] **P2.6**: Output resolution management
  - Separate resolution targets for data masks vs visual masks
  - Scale factor computed per composite based on scene dimensions and max texture size

### Phase 3: Integration — Replace Scene-Level Mask Pipeline

**Goal**: Wire the compositor into the existing effect distribution pipeline.

- [ ] **P3.1**: Replace `SceneComposer.rebuildMasksForActiveLevel` internals
  - Instead of finding one large tile and loading its masks:
    1. Collect all visible tiles on active floor
    2. Ensure per-tile masks are loaded (via TileManager)
    3. Run `SceneMaskCompositor.compose()`
    4. Return composite masks in the same `{masks, basePath, masksChanged}` format
  - Existing callers (canvas-replacement.js hook) work unchanged
- [ ] **P3.2**: Replace `SceneComposer.initialize` mask loading
  - Initial scene load uses the same compositor path
  - No more `_probeBestMaskBasePath` as the sole source — compositor handles all tiles
  - Fallback: if no tiles have suffix masks, fall back to scene background basePath (backwards compat)
- [ ] **P3.3**: Update `preloadMasksForAllLevels`
  - Preload per-tile masks for all floor bands (not just one basePath per floor)
  - Compositor can pre-compose each floor's masks in background
- [ ] **P3.4**: Update the `mapShineLevelContextChanged` redistribution hook
  - Compositor produces new scene-space masks for the new floor
  - Distribution to effects remains identical (same setBaseMesh/setAssetBundle calls)
  - `masksChanged` detection based on tile set difference, not just basePath difference

### Phase 4: Per-Tile Effect Overlays (Existing Pattern Extension)

**Goal**: Effects that already support per-tile overlays get the new mask types.

- [ ] **P4.1**: Extend SpecularEffect's per-tile overlay to use compositor data
  - Currently loads `_Specular` per tile independently
  - Should also respect the composite for lighting interaction (outdoors gating)
- [ ] **P4.2**: Extend FluidEffect's per-tile overlay similarly
- [ ] **P4.3**: Consider per-tile fire particle emission
  - Instead of one global fire particle system from the scene-wide `_Fire` mask:
  - Option A: Use the composited scene-space `_Fire` mask (simpler, same approach)
  - Option B: Spawn per-tile fire systems (more complex, better for animated/moving tiles)
  - **Recommendation**: Option A for v1 (compositor handles it), Option B later if needed
- [ ] **P4.4**: Consider per-tile window light overlays
  - WindowLightEffect currently uses scene-space `_Windows` mask
  - With compositor, it gets the correct composite that includes foreground tiles' windows
  - No per-tile overlay needed unless tiles move (tile-motion)

### Phase 5: Cache & Performance

**Goal**: Ensure the new system doesn't regress load times or runtime performance.

- [ ] **P5.1**: Per-tile mask cache management
  - Cache per-tile masks by `tileId + textureUrl` (invalidate on texture change)
  - Limit total cached mask textures (LRU eviction if memory pressure)
  - Dispose textures when tiles are removed
- [ ] **P5.2**: Compositor output caching
  - Cache composed scene-space masks per floor key (`${bottom}:${top}`)
  - Invalidate when any contributing tile changes (texture, transform, visibility)
  - Use the same `_levelMaskCache` pattern but store compositor outputs
- [ ] **P5.3**: Lazy mask probing
  - Don't probe for suffix masks on tiles that are too small to matter
  - Don't probe for mask types that no active effect uses
  - Batch FilePicker directory listings per directory (already implemented)
- [ ] **P5.4**: Background preloading
  - Same pattern as existing `preloadMasksForAllLevels`
  - Preload per-tile masks for other floors during idle time
  - Compositor pre-composes non-active floors in background

### Phase 6: Quality & Polish

- [ ] **P6.1**: Handle tile transform edge cases
  - Rotated tiles: mask must be rotated to match
  - Flipped tiles (negative scaleX/scaleY): mask must be flipped
  - Tiles extending beyond scene rect: clip to scene bounds
- [ ] **P6.2**: Handle mask resolution mismatches
  - Tile mask is smaller than tile display size → scale up (bilinear)
  - Tile mask is larger than tile display size → scale down during blit
  - Different tiles have different mask resolutions → each blitted at native scale
- [ ] **P6.3**: Handle missing masks gracefully
  - Tile A has `_Fire`, Tile B does not → only Tile A contributes to fire composite
  - No tile has `_Fire` → fire effect disabled (same as today)
  - Partial mask coverage → effects only apply where masks exist
- [ ] **P6.4**: Diagnostic overlay
  - Debug render mode that visualizes which tile contributed each region of each mask
  - Color-coded tile boundaries in the mask composite
  - Accessible via Tweakpane debug panel

---

## Migration & Backwards Compatibility

### Single-Tile Scenes (No Change)
- Scene has one background image with suffix masks
- Compositor finds one tile, loads its masks, produces identical output to today
- Zero behavioral change

### Multi-Tile Horizontally Segmented Scenes (Improved)
- Scene has 2-3 tiles side-by-side covering the scene
- Today: `_buildCompositeSceneMasks` handles this with the "segments" layout
- New: Compositor handles this naturally (each tile blitted at its position)
- Same visual result, more general implementation

### Foreground Tiles With Masks (NEW — Previously Broken)
- Building tile placed on terrain background, both with suffix masks
- Today: Only terrain's masks used; building's masks ignored
- New: Building's masks composited on top of terrain's masks in the overlap region
- Fire from the building and fire from the terrain both render correctly

### Levels Multi-Floor (Improved)
- Today: `rebuildMasksForActiveLevel` finds ONE tile per floor
- New: Compositor composes ALL tiles on the active floor
- Correctly handles floors with multiple tiles at different positions

### Existing Per-Tile Effects (Preserved)
- SpecularEffect, FluidEffect per-tile overlays continue working
- They optionally also benefit from compositor data (e.g., outdoors gating)

---

## Risk Assessment

| Risk | Impact | Likelihood | Mitigation |
|---|---|---|---|
| Performance regression from loading more masks | Medium | Medium | Lazy loading, skip tiles with no masks, cache aggressively |
| Memory pressure from per-tile mask textures | Medium | Low | LRU eviction, dispose on tile removal, don't load unused mask types |
| Compositor output differs from current single-tile output | High | Low | Fallback path: if scene has only 1 large tile, use fast path (load directly) |
| Canvas 2D compositing artifacts (rotation, anti-aliasing) | Low | Medium | Use GPU render target composition if CPU canvas quality is insufficient |
| Breaking existing single-tile scenes | High | Very Low | Fast path produces identical output; regression tests on known scenes |
| Tile transform math errors (flip, rotation, Y-inversion) | Medium | Medium | Unit test per-tile blit with known transform inputs |

---

## Open Questions

1. **GPU vs CPU composition**: Should the compositor use 2D canvas (CPU) or WebGL render targets (GPU)?
   - CPU (canvas 2D): simpler, proven (used today for composite), handles rotation via `ctx.transform`
   - GPU (render target): faster for many tiles, native texture format, but more complex setup
   - **Recommendation**: Start with CPU, switch to GPU if performance demands it

2. **When to re-compose**: On every frame? On tile change? On level switch only?
   - **Recommendation**: On level switch + on tile CRUD/transform change (debounced). NOT per-frame.

3. **Per-tile mask authoring UX**: Should map makers be able to toggle which masks a tile contributes?
   - Already have `bypassEffects` flag per tile
   - Could add per-mask-type flags if needed
   - **Recommendation**: `bypassEffects` is sufficient for v1; per-mask-type gating is v2

4. **_Outdoors mask authority**: When a building's `_Outdoors` mask (black=indoor) sits on terrain's `_Outdoors` (white=outdoor), should the building FULLY replace the terrain, or should it only paint in its occupied area?
   - **Recommendation**: Source-over with alpha: building mask paints over terrain only where the building tile has non-transparent albedo. If the building tile has transparent pixels (gaps), the terrain's outdoors mask shows through.

---

## Execution Order

| Phase | Priority | Estimated Effort | Dependencies |
|---|---|---|---|
| Phase 0 (Diagnostics) | P0 | Small | None |
| Phase 1 (Per-tile loading) | P0 | Medium | None |
| Phase 2 (Compositor) | P0 | Large | Phase 1 |
| Phase 3 (Integration) | P0 | Medium | Phase 2 |
| Phase 4 (Overlay extension) | P1 | Medium | Phase 3 |
| Phase 5 (Cache & Perf) | P1 | Medium | Phase 3 |
| Phase 6 (Polish) | P2 | Small | Phase 3 |

**Immediate next steps**:
1. Phase 0 diagnostics to confirm root causes in the user's actual scene
2. Phase 1 per-tile mask loading (extend existing TileManager patterns)
3. Phase 2 compositor (core of the fix)
4. Phase 3 integration (wire into existing effect pipeline)

---

## Files Affected

### New Files
- `scripts/masks/scene-mask-compositor.js` — Core compositor class

### Modified Files (Major Changes)
- `scripts/scene/tile-manager.js` — Per-tile mask loading for all suffix types
- `scripts/scene/composer.js` — Replace `rebuildMasksForActiveLevel` internals, wire compositor
- `scripts/foundry/canvas-replacement.js` — Wire compositor into init + level switch hooks

### Modified Files (Minor Changes)
- `scripts/assets/loader.js` — Expose `EFFECT_MASKS` registry for compositor use
- `scripts/effects/FireSparksEffect.js` — May need to regenerate particles when composite changes
- `scripts/effects/WaterEffectV2.js` — May need to rebuild SDF when composite changes
- `scripts/effects/WindowLightEffect.js` — Benefits from corrected composite (no code change needed)
- `scripts/effects/LightingEffect.js` — Benefits from corrected outdoors composite (no code change needed)

### Unchanged Files
- `scripts/effects/SpecularEffect.js` — Already has per-tile overlay; benefits from compositor for gating
- `scripts/effects/FluidEffect.js` — Already has per-tile overlay
- `scripts/particles/FireSparksEffect.js` — Receives compositor output via same API

---

## Appendix A: Complete Mask Consumer Inventory

Every system that reads mask data is listed below with the exact mask type(s) it consumes, how it receives them, and what changes are needed.

### A1. Scene-Space Post-Processing Effects (receive masks via `setBaseMesh(mesh, bundle)`)

These effects operate on the full-scene framebuffer. They sample scene-space mask textures in their fragment shaders using UVs derived from screen position + scene bounds.

| Effect | File | Masks Consumed | How It Uses Them | Change Needed |
|---|---|---|---|---|
| **LightingEffect** | `effects/LightingEffect.js` | `_Outdoors` | Samples in shader to gate indoor/outdoor ambient light blending. Calls `_rebuildOutdoorsProjection()` to create a CPU-side lookup for light classification. | Receives composited `_Outdoors` — **no code change** needed if compositor produces correct scene-space texture. |
| **WindowLightEffect** | `effects/WindowLightEffect.js` | `_Windows` (or `_Structural`), `_Outdoors`, `_Specular` | `_Windows` defines where window glow appears. `_Outdoors` is used to build a rain flow map (`_ensureRainFlowMap`). `_Specular` adds wet-surface reflections on windows. | Receives composited masks — **no code change**. But `_Windows` is the critical one that's currently broken for foreground tiles. |
| **WaterEffectV2** | `effects/WaterEffectV2.js` | `_Water` | `setBaseMesh` extracts `_Water` mask, calls `_rebuildWaterDataIfNeeded` which builds SDF via `WaterSurfaceModel.buildFromMaskTexture`. Also stores `_waterRawMask` for floating foam. Registers mask with DistortionManager as water distortion source. | Receives composited `_Water` — **no code change**. SDF rebuild is expensive; compositor must cache to avoid redundant rebuilds. |
| **SpecularEffect** | `effects/SpecularEffect.js` | `_Specular`, `_Roughness`, `_Normal` | Scene-wide: creates PBR material on base plane with specular/roughness/normal maps. Per-tile: `bindTileSprite()` loads individual tile `_Specular` masks for overlay meshes (already works per-tile). | Scene-wide composited masks — **no code change**. Per-tile path already works. |
| **BuildingShadowsEffect** | `effects/BuildingShadowsEffect.js` | `_Outdoors` | Builds a world-pinned shadow mesh from the `_Outdoors` mask. Indoor regions (dark areas) cast directional shadows outward. | Receives composited `_Outdoors` — **no code change**. |
| **OverheadShadowsEffect** | `effects/OverheadShadowsEffect.js` | `_Outdoors` | Creates shadow projection mesh from `_Outdoors`. Similar to BuildingShadowsEffect but for overhead tile shadows. | Receives composited `_Outdoors` — **no code change**. |
| **CloudEffect** | `effects/CloudEffect.js` | `_Outdoors` | Stores `outdoorsMask` for indoor/outdoor gating of cloud shadows. Shader samples it to suppress clouds over indoor areas. | Receives composited `_Outdoors` — **no code change**. |
| **IridescenceEffect** | `effects/IridescenceEffect.js` | `_Iridescence` | Creates overlay mesh with iridescence shader. Samples mask to define effect regions. | Receives composited `_Iridescence` — **no code change**. |
| **PrismEffect** | `effects/PrismEffect.js` | `_Prism` | Creates overlay mesh with refraction shader. Also stores `baseTexture` for refraction sampling. | Receives composited `_Prism` — **no code change**. |
| **TreeEffect** | `effects/TreeEffect.js` | `_Tree` | Creates a world-pinned mesh with wind-animated tree canopy. `_Tree` is an RGBA color texture (not a binary mask). | Receives composited `_Tree` — **no code change**. Note: this is a color texture, so composition mode must preserve RGBA, not just luminance. |
| **BushEffect** | `effects/BushEffect.js` | `_Bush` | Same pattern as TreeEffect. RGBA color texture for animated bush foliage. | Receives composited `_Bush` — **no code change**. Same RGBA preservation note. |

### A2. Particle Effects (receive masks via `setAssetBundle(bundle)`)

These effects scan mask pixels on the CPU to build spawn-point lookup tables.

| Effect | File | Masks Consumed | How It Uses Them | Change Needed |
|---|---|---|---|---|
| **FireSparksEffect** | `particles/FireSparksEffect.js` | `_Fire` | `setAssetBundle` finds `type=='fire'` mask. Calls `_generatePoints()` to CPU-scan the mask image, collecting (u,v,brightness) triples above a luminance threshold. These become the static spawn lookup table for `FireMaskShape`. Also registers the `_Fire` mask with DistortionManager as a heat distortion source (via `_registerHeatDistortion`). | Receives composited `_Fire` — **no code change to FireSparksEffect**. But the compositor MUST produce a texture with a valid `.image` property (ImageBitmap or HTMLCanvasElement) since `_generatePoints` reads pixels via `ctx.drawImage + getImageData`. |
| **DustMotesEffect** | `particles/DustMotesEffect.js` | `_Dust`, `_Structural`, `_Outdoors` | `setAssetBundle` finds all three. `_generatePoints()` CPU-scans `_Dust` mask, cross-references `_Structural` (window positions) and `_Outdoors` (indoor/outdoor) to classify spawn points. | Receives composited masks — **no code change**. Same `.image` requirement. |
| **AshDisturbanceEffect** | `particles/AshDisturbanceEffect.js` | `_Ash` | `setAssetBundle` finds `type=='ash'`. `_generatePoints()` CPU-scans mask. `_cacheMaskData()` stores pixel data for per-frame sampling during token movement. Falls back to full-scene spawn if no mask. | Receives composited `_Ash` — **no code change**. Same `.image` requirement. |

### A3. Downstream Systems (receive masks indirectly)

| System | File | Masks Consumed | How It Receives Them | Change Needed |
|---|---|---|---|---|
| **WeatherController** | `core/WeatherController.js` | `_Outdoors` (as "roof map") | `setRoofMap(texture)` called from `mapShineLevelContextChanged` hook. Extracts pixel data via `_extractRoofMaskData()` into `roofMaskData` (Uint8Array). Used by `getRoofMaskIntensity(u,v)` for CPU-side indoor/outdoor sampling (fire guttering, rain suppression). Also builds a `_roofDistanceMap` for distance-from-edge queries. | Receives composited `_Outdoors` — **no code change**. Same `.image` requirement for `_extractRoofMaskData`. |
| **DistortionManager** | `effects/DistortionManager.js` | `_Fire` (as heat source), `_Water` (as water source) | Sources registered via `registerSource(id, layer, mask, params)`. Heat: registered by `FireSparksEffect._registerHeatDistortion()` with a boosted/blurred version of `_Fire` mask. Water: registered by `WaterEffectV2.update()` via `updateSourceMask('water', waterMask)`. Shader applies UV distortion weighted by mask intensity. | Receives masks indirectly from Fire/Water effects — **no code change**. Compositor output flows through Fire/Water effects naturally. |
| **MaskManager** | `masks/MaskManager.js` | All mask types (scene-level) | `mapShineLevelContextChanged` hook publishes each mask via `mm.setTexture('${maskId}.scene', texture, meta)`. MaskManager stores these as named textures that other systems can query (e.g., `getTexture('outdoors.scene')`). Also supports derived masks (invert, threshold, blur, min/max/mul operations) and blurred variants via `getOrCreateBlurredMask()`. | Receives composited masks via existing redistribution hook — **no code change**. |
| **TileManager (CPU mask sampling)** | `scene/tile-manager.js` | `_Windows`, `_Outdoors` | `_sampleWindowLight()` lazy-extracts pixel data from `windowLightEffect.windowMask` and `windowLightEffect.outdoorsMask` into `_windowMaskData` / `_outdoorsMaskData`. Used to tint overhead tiles based on window light at their position. Cleared on level switch. | Receives masks indirectly via WindowLightEffect — **no code change**. But compositor must ensure WindowLightEffect gets correct composited `_Windows` and `_Outdoors`. |
| **AtmosphericFogEffect** | `effects/AtmosphericFogEffect.js` | `_Outdoors` | Has `setOutdoorsMask(texture)` method, but **this is NOT called during level switch redistribution**. This is a gap — the outdoors mask update on level switch doesn't reach AtmosphericFogEffect. | **Bug found**: needs to be added to the `mapShineLevelContextChanged` redistribution hook. Not directly related to compositor but should be fixed alongside. |

### A4. Per-Tile Effects (already have per-tile mask loading)

These effects load masks independently per tile, not from the scene-wide bundle.

| Effect | File | Per-Tile Mask | How It Works | Change Needed |
|---|---|---|---|---|
| **SpecularEffect** | `effects/SpecularEffect.js` | `_Specular` per tile | `TileManager` calls `loadTileSpecularMaskTexture(tileDoc)` → resolves URL → loads texture → calls `specularEffect.bindTileSprite(tileDoc, sprite, specTex)`. Creates additive overlay mesh per tile with depth-based occlusion. | Already works. No change needed. |
| **FluidEffect** | `effects/FluidEffect.js` | `_Fluid` per tile | `TileManager` calls `loadTileFluidMaskTexture(tileDoc)` → resolves URL → calls `fluidEffect.bindTileSprite(tileDoc, sprite, fluidTex)`. Creates animated flow overlay per tile. | Already works. No change needed. |
| **Water Occluder** | `scene/tile-manager.js` | `_Water` per tile | `TileManager` calls `loadTileWaterMaskTexture(tileDoc)` → resolves URL → updates `waterOccluderMesh.material.uniforms.tWaterMask`. Used by `DistortionManager._renderWaterOccluders` to mask water distortion behind opaque tiles. | Already works. No change needed. |

---

## Appendix B: Full Mask Flow — Scene Load vs Level Switch

### B1. Initial Scene Load Flow

```
SceneComposer.initialize(foundryScene)
  │
  ├── 1. _resolveMaskSourceSrc(foundryScene)
  │     ├── Check for explicit maskSource flag on scene
  │     ├── Prefer scene background image (foundryScene.background.src)
  │     └── Fallback: _getLargeSceneMaskTiles → score candidates by coverage, naming, elevation
  │
  ├── 2. assetLoader.loadAssetBundle(bgPath, {skipBaseTexture: true})
  │     └── For EACH suffix in EFFECT_MASKS registry:
  │           ├── findMaskInFiles() or probeMaskUrl()
  │           └── loadMaskTextureDirect(url, {maxSize, isColorTexture})
  │                 ├── fetch() → createImageBitmap() (off-thread decode)
  │                 ├── Downscale if > maxSize (2048 for data, 4096 for visual)
  │                 └── Create THREE.Texture with correct colorSpace/flipY/mipmaps
  │
  ├── 3. Fallback: _probeBestMaskBasePath() (retries with 50ms delay, up to 6 attempts)
  │     └── Tries ALL tile basePaths, scores by mask count + key mask presence
  │
  ├── 4. Multi-tile composite check:
  │     ├── _getLargeSceneMaskTiles() → find Y-aligned tiles ≥ 20% scene area
  │     ├── _computeSceneMaskCompositeLayout() → build segment layout if ≥ 2 tiles
  │     └── _buildCompositeSceneMasks() → blit per-segment masks onto scene canvas
  │
  ├── 5. Build bundle: { baseTexture, masks[], basePath }
  │
  ├── 6. Setup camera, ground plane, base mesh
  │
  └── 7. Return bundle → canvas-replacement.js distributes to effects:
        ├── effectComposer.setBaseMesh(basePlaneMesh, bundle)  ← cascades to ALL registered effects
        │     ├── LightingEffect.setBaseMesh()
        │     ├── WindowLightEffect.setBaseMesh()
        │     ├── WaterEffectV2.setBaseMesh()
        │     ├── SpecularEffect.setBaseMesh()
        │     ├── BuildingShadowsEffect.setBaseMesh()
        │     ├── OverheadShadowsEffect.setBaseMesh()
        │     ├── CloudEffect.setBaseMesh()
        │     ├── TreeEffect.setBaseMesh()
        │     ├── BushEffect.setBaseMesh()
        │     ├── IridescenceEffect.setBaseMesh()
        │     └── PrismEffect.setBaseMesh()
        ├── fireSparksEffect.setAssetBundle(bundle)
        ├── dustMotesEffect.setAssetBundle(bundle)
        ├── ashDisturbanceEffect.setAssetBundle(bundle)
        ├── weatherController.setRoofMap(outdoorsMask)
        └── maskManager.setTexture() for each mask
```

### B2. Level Switch Flow

```
Hooks.on('mapShineLevelContextChanged')
  │
  ├── 1. composer.rebuildMasksForActiveLevel(ctx)
  │     ├── Cache check: _levelMaskCache.get("${bottom}:${top}")
  │     │     └── Hit: return cached masks + masksChanged flag
  │     ├── Cache miss:
  │     │     ├── _getLargeSceneMaskTiles(scene, ctx) ← level-band filtered
  │     │     ├── _computeSceneMaskCompositeLayout() ← multi-tile?
  │     │     ├── _buildCompositeSceneMasks() or loadAssetBundle() ← single tile
  │     │     └── Store in _levelMaskCache
  │     └── Return { masks, basePath, masksChanged, levelElevation }
  │
  ├── 2. If masksChanged === false → skip redistribution, just requestRender
  │
  ├── 3. Redistribute masks to effects:
  │     ├── WeatherController.setRoofMap(_Outdoors texture)
  │     ├── LightingEffect.setBaseMesh(mesh, bundle)
  │     ├── WindowLightEffect.setBaseMesh(mesh, bundle)
  │     ├── FireSparksEffect.setAssetBundle(bundle)
  │     ├── WaterEffectV2.clearCaches() + setBaseMesh(mesh, bundle)
  │     ├── DustMotesEffect.setAssetBundle(bundle)
  │     ├── AshDisturbanceEffect.setAssetBundle(bundle)
  │     ├── MaskManager.setTexture() for each mask
  │     ├── ❌ AtmosphericFogEffect — NOT updated (bug)
  │     ├── ❌ BuildingShadowsEffect — NOT updated (relying on EffectComposer cascade)
  │     ├── ❌ OverheadShadowsEffect — NOT updated (relying on EffectComposer cascade)
  │     └── ❌ CloudEffect — NOT updated (relying on EffectComposer cascade)
  │
  ├── 4. Clear TileManager stale cache:
  │     ├── _windowMaskData = null
  │     ├── _windowMaskExtractFailed = false
  │     ├── _outdoorsMaskData = null
  │     └── _outdoorsMaskExtractFailed = false
  │
  └── 5. Force render refresh (depthPassManager.invalidate, requestContinuousRender)
```

**Redistribution gaps found** (effects NOT updated on level switch):
- `AtmosphericFogEffect.setOutdoorsMask()` — never called
- `BuildingShadowsEffect` — only gets masks via initial `effectComposer.setBaseMesh()`, not on level switch
- `OverheadShadowsEffect` — same gap
- `CloudEffect` — same gap
- `IridescenceEffect` — same gap (if `_Iridescence` mask differs per floor)
- `PrismEffect` — same gap
- `TreeEffect` — same gap (if `_Tree` differs per floor)
- `BushEffect` — same gap (if `_Bush` differs per floor)

These gaps mean that on level switch, only a subset of effects receive the new floor's masks. The rest keep using the initial scene load masks. For single-floor scenes this doesn't matter, but for multi-floor scenes with different masks per floor, these effects will show the wrong floor's data.

---

## Appendix C: Compositor `.image` Requirement

Several downstream systems extract pixel data from mask textures via CPU-side canvas drawing:

1. **FireSparksEffect._generatePoints()** — draws mask `.image` to canvas, reads `getImageData`
2. **DustMotesEffect._generatePoints()** — same pattern
3. **AshDisturbanceEffect._generatePoints()** — same pattern  
4. **WeatherController._extractRoofMaskData()** — draws mask `.image` to canvas, reads pixel data
5. **TileManager._extractMaskData()** — lazy extracts from WindowLightEffect masks

The compositor MUST produce `THREE.Texture` objects whose `.image` property is a drawable source (`HTMLCanvasElement`, `HTMLImageElement`, or `ImageBitmap`). The current `_buildCompositeSceneMasks()` already does this correctly — it creates `new THREE.Texture(canvasEl)` where `canvasEl` is an `HTMLCanvasElement`. The new compositor must preserve this pattern.

**If we switch to GPU render-target composition**, we would need to add a `renderer.readRenderTargetPixels()` step to create a CPU-readable image for these consumers. This adds complexity and latency. **Recommendation: stay with CPU canvas composition** for data masks consumed by particle/weather systems.

---

## Appendix D: Resolution Pipeline Deep Dive

### D1. Current Resolution Caps

| Stage | Max Size | Applied To |
|---|---|---|
| `MASK_MAX_SIZE` (loader.js) | 2048 | Data masks: fire, water, outdoors, dust, ash |
| `VISUAL_MASK_MAX_SIZE` (loader.js) | 4096 | Visual masks: specular, roughness, normal, iridescence, prism |
| Color texture max (loader.js) | 4096 | Bush, tree (RGBA color textures) |
| Composite canvas (composer.js) | `min(8192, GPU maxTextureSize)` | Multi-tile composite output |

### D2. Resolution Problem for Foreground Tiles

A foreground building tile might be 1024×1024 pixels with a `_Fire` mask at the same resolution. Under the current system:
1. The scene background (e.g., 4096×4096) is selected as the mask source
2. Its `_Fire` mask (4096×4096) is loaded and downscaled to 2048×2048 (`MASK_MAX_SIZE`)
3. The foreground tile's `_Fire` mask is **never loaded at all**

Under the new compositor:
1. Both tiles' `_Fire` masks are loaded at native resolution
2. The scene background's mask: 4096×4096 → downscaled to 2048×2048
3. The foreground tile's mask: 1024×1024 → loaded at native resolution (under cap)
4. Compositor blits both into a 2048×2048 scene-space canvas
5. The foreground tile's mask occupies its correct region at the correct scale

### D3. Per-Tile Mask Resolution Strategy

For per-tile mask loading, we should NOT apply the scene-level `MASK_MAX_SIZE` cap. Instead:
- Load at native resolution (the artist authored it at that size for that tile)
- Only cap at GPU `maxTextureSize` (safety)
- Downscaling happens during compositor blit (canvas `drawImage` scales naturally)

This preserves detail for small, high-detail tiles while keeping the compositor output at a reasonable scene-space resolution.

---

## Appendix E: Refined Implementation Approach

Based on the comprehensive research above, the implementation strategy is refined:

### E1. Fix Redistribution Gaps First (Quick Win)

Before building the compositor, fix the level-switch redistribution to cover ALL effects:

```javascript
// In mapShineLevelContextChanged hook, add:
safeCall(() => {
  const ec = ms?.effectComposer ?? effectComposer;
  // Update ALL effects that consume _Outdoors
  const bse = ec?.effects?.get('building-shadows');
  if (bse && typeof bse.setBaseMesh === 'function') bse.setBaseMesh(bse.baseMesh, bundle);
  const ose = ec?.effects?.get('overhead-shadows');
  if (ose && typeof ose.setBaseMesh === 'function') ose.setBaseMesh(ose.baseMesh, bundle);
  const ce = ec?.effects?.get('clouds');
  if (ce && typeof ce.setBaseMesh === 'function') ce.setBaseMesh(ce.baseMesh, bundle);
  // AtmosphericFogEffect
  const afe = ec?.effects?.get('atmospheric-fog');
  if (afe && typeof afe.setOutdoorsMask === 'function') {
    const outdoors = result.masks.find(m => m.id === 'outdoors')?.texture || null;
    afe.setOutdoorsMask(outdoors);
  }
  // Effects that use non-outdoors masks that could differ per floor:
  const ie = ec?.effects?.get('iridescence');
  if (ie && typeof ie.setBaseMesh === 'function') ie.setBaseMesh(ie.baseMesh, bundle);
  const pe = ec?.effects?.get('prism');
  if (pe && typeof pe.setBaseMesh === 'function') pe.setBaseMesh(pe.baseMesh, bundle);
  const te = ec?.effects?.get('trees');
  if (te && typeof te.setBaseMesh === 'function') te.setBaseMesh(te.baseMesh, bundle);
  const be = ec?.effects?.get('bushes');
  if (be && typeof be.setBaseMesh === 'function') be.setBaseMesh(be.baseMesh, bundle);
}, 'levelMaskRebuild.additionalEffects', Severity.DEGRADED);
```

### E2. Compositor Design — CPU Canvas Approach

The compositor uses 2D canvas for composition. This is proven (already used by `_buildCompositeSceneMasks`) and produces textures with `.image` that CPU consumers can read.

**Key compositor responsibilities:**
1. Accept a list of `{tileDoc, masks: Map<maskType, THREE.Texture>}` entries
2. For each mask type present in any tile:
   a. Create a scene-sized canvas at the appropriate resolution
   b. Sort tiles by Z-order (sort key + elevation)
   c. For each tile, blit its mask into the correct scene-space region
   d. Use the appropriate composite mode per mask type
3. Output `Map<maskType, THREE.Texture>`

**Tile-to-scene-space transform:**
```javascript
// Convert tile rect (Foundry coords) to compositor canvas coords
const sceneRect = canvas.dimensions.sceneRect;
const canvasW = compositorCanvas.width;
const canvasH = compositorCanvas.height;

// Normalized position within scene rect
const u0 = (tileDoc.x - sceneRect.x) / sceneRect.width;
const v0 = (tileDoc.y - sceneRect.y) / sceneRect.height;
const uW = tileDoc.width / sceneRect.width;
const vH = tileDoc.height / sceneRect.height;

// Canvas pixel coordinates
const dx = Math.round(u0 * canvasW);
const dy = Math.round(v0 * canvasH);
const dw = Math.max(1, Math.round(uW * canvasW));
const dh = Math.max(1, Math.round(vH * canvasH));

// Handle scaleX/scaleY flip
ctx.save();
if (scaleX < 0 || scaleY < 0) {
  ctx.translate(dx + dw/2, dy + dh/2);
  ctx.scale(Math.sign(scaleX), Math.sign(scaleY));
  ctx.translate(-(dx + dw/2), -(dy + dh/2));
}

// Handle rotation
if (tileDoc.rotation) {
  ctx.translate(dx + dw/2, dy + dh/2);
  ctx.rotate(tileDoc.rotation * Math.PI / 180);
  ctx.translate(-(dx + dw/2), -(dy + dh/2));
}

ctx.drawImage(maskImage, 0, 0, maskImage.width, maskImage.height, dx, dy, dw, dh);
ctx.restore();
```

### E3. Tile Eligibility — No Size Minimum

Remove the 20% area and Y-alignment requirements. Instead:
- Any tile that is **visible** and on the **active floor** can contribute masks
- Tile must have at least one suffix mask file discovered alongside its texture
- Skip tiles with `bypassEffects` flag set

### E4. Per-Tile Mask Discovery

Extend `TileManager` with a generic mask resolver:

```javascript
async _resolveTileMaskUrl(tileDoc, suffix) {
  // Reuse existing pattern from _resolveTileWaterMaskUrl
  // but accept any suffix string
  const src = tileDoc?.texture?.src;
  const parts = this._splitUrl(src);
  if (!parts) return null;

  const key = `${parts.pathNoExt}|${suffix}`;
  // Check cache...
  // Construct candidates with suffix...
  // Probe via FilePicker or direct...
  // Return resolved URL or null
}

async loadAllTileMasks(tileDoc) {
  const registry = assetLoader.getEffectMaskRegistry();
  const results = new Map();
  const promises = [];

  for (const [maskId, def] of Object.entries(registry)) {
    promises.push(
      this._resolveTileMaskUrl(tileDoc, def.suffix).then(async (url) => {
        if (!url) return;
        const tex = await this.loadTileTexture(url, { role: 'DATA_MASK' });
        if (tex) results.set(maskId, { url, texture: tex });
      }).catch(() => {})
    );
  }

  await Promise.all(promises);
  return results;
}
```

### E5. Integration with Existing `rebuildMasksForActiveLevel`

The compositor replaces the internals of `rebuildMasksForActiveLevel` without changing its API:

```javascript
async rebuildMasksForActiveLevel(levelContext, options = {}) {
  // ... existing cache check logic ...
  
  // NEW: collect ALL visible tiles on active floor (not just large ones)
  const activeTiles = this._getActiveLevelTiles(scene, ctx);
  
  // NEW: ensure per-tile masks are loaded
  const tileManager = window.MapShine?.tileManager;
  const tileMaskEntries = [];
  for (const tile of activeTiles) {
    const masks = await tileManager.loadAllTileMasks(tile.tileDoc);
    if (masks.size > 0) {
      tileMaskEntries.push({ tileDoc: tile.tileDoc, masks });
    }
  }
  
  // NEW: compose scene-space masks
  const compositor = this._sceneMaskCompositor;
  const composited = compositor.compose(tileMaskEntries, scene);
  
  // Falls back to existing single-basePath logic if no per-tile masks found
  if (!composited && primaryBasePath) {
    // ... existing loadAssetBundle fallback ...
  }
  
  // ... existing cache storage and return logic ...
}
```

### E6. Backwards Compatibility — Fast Path

For scenes where only ONE tile has masks (the common case), the compositor detects this and takes a fast path:
- Single tile covering the scene → load its masks directly via `loadAssetBundle` (same as today)
- No compositor overhead, identical output
- Only activates the full per-tile composition when multiple mask-bearing tiles are detected

---

## Appendix F: Discovered Bugs (Not Compositor-Related)

During research, these bugs were found that should be fixed alongside or before the compositor work:

### F1. AtmosphericFogEffect Not Updated on Level Switch
**Location**: `canvas-replacement.js` `mapShineLevelContextChanged` hook
**Problem**: `AtmosphericFogEffect.setOutdoorsMask()` is never called during level switch redistribution
**Fix**: Add call to the redistribution block

### F2. Several Effects Not Updated on Level Switch
**Location**: `canvas-replacement.js` `mapShineLevelContextChanged` hook
**Problem**: `BuildingShadowsEffect`, `OverheadShadowsEffect`, `CloudEffect`, `IridescenceEffect`, `PrismEffect`, `TreeEffect`, `BushEffect` are not redistributed on level switch
**Fix**: Add calls for all effects that consume masks that could differ between floors
**Impact**: Low for most scenes (these masks rarely differ per floor), but architecturally incorrect

### F3. `_resolveMaskSourceSrc` Uses Undefined `elev` Variable
**Location**: `composer.js` line ~1039
**Problem**: `score -= elev * 0.01;` references `elev` which is not defined in that scope
**Fix**: Should be `const elev = Number(tileDoc?.elevation ?? 0);` before the scoring loop

---

## Appendix G: Resolution Strategy for 9000+ Pixel Textures

### G1. The Problem

Scene textures frequently exceed 9000×9000 pixels. The current resolution caps are far too aggressive:

| Constant | Current Value | Effect |
|---|---|---|
| `MASK_MAX_SIZE` (loader.js) | **2048** | Data masks (fire, water, outdoors, dust, ash) are downscaled to ≤2048. A 9000×9000 `_Fire` mask becomes 2048×2048 — losing 95% of its pixel data. Fire spawn positions become imprecise; thin water channels disappear. |
| `VISUAL_MASK_MAX_SIZE` (loader.js) | **4096** | Visual masks (specular, normal, roughness) are downscaled to ≤4096. A 9000×9000 `_Specular` mask becomes 4096×4096 — losing 79% of pixel data. Fine surface detail is smeared. |
| Composite `hardCap` (composer.js) | **8192** | Multi-tile composite output capped at 8192. For a 9000+ scene this forces downscaling of the final composite even when GPU supports larger textures. |

### G2. Revised Resolution Caps

The caps should be driven by:
1. **GPU `maxTextureSize`** — modern GPUs support 16384 (most) or 32768 (high-end)
2. **VRAM budget** — a single 9000×9000 RGBA texture is ~324 MB at full resolution; we need balance
3. **Mask purpose** — data masks for CPU scanning (fire, dust, ash) can tolerate modest downscale; visual masks rendered in shaders need higher fidelity

**Proposed caps:**

| Constant | New Value | Rationale |
|---|---|---|
| `MASK_MAX_SIZE` | **4096** | Data masks gain 4× the pixel area. 9000×9000 → 4096×4096 preserves thin features (rivers, fire lines). Cost: ~67 MB per mask (RGBA). Acceptable since few data masks exist per scene. |
| `VISUAL_MASK_MAX_SIZE` | **8192** | Visual masks need high fidelity for specular/normal. 9000×9000 → 8192×8192 preserves ~83% pixel area. Cost: ~268 MB per mask, but these are shared across all tiles in the composite. |
| Composite `hardCap` | **GPU `maxTextureSize`** (no artificial 8192 cap) | Let the GPU decide. If it supports 16384, use 16384. The `Math.min(cap, 8192)` on line 548 of composer.js is unnecessarily restrictive. |

### G3. Implementation

```javascript
// loader.js — raise caps
const MASK_MAX_SIZE = 4096;
const VISUAL_MASK_MAX_SIZE = 8192;

// composer.js — remove 8192 hard cap
const cap = Number.isFinite(maxTex) ? Math.max(256, Math.floor(maxTex)) : 8192;
const hardCap = cap; // Was: Math.min(cap, 8192)
```

### G4. Compositor Output Resolution

The compositor produces scene-space masks. For a 9000×9000 scene:
- **Data mask composites** (fire, water, outdoors): target `min(sceneSize, MASK_MAX_SIZE)` = 4096×4096
- **Visual mask composites** (specular, normal): target `min(sceneSize, VISUAL_MASK_MAX_SIZE)` = 8192×8192
- **Color texture composites** (bush, tree): target `min(sceneSize, VISUAL_MASK_MAX_SIZE)` = 8192×8192

Per-tile masks loaded into the compositor should NOT be pre-downscaled — load at native resolution and let `ctx.drawImage()` scale during blit. This preserves detail for tiles that cover a small scene region.

### G5. Memory Safety

With raised caps, we need memory guards:
- **VRAM estimation before loading**: `width × height × 4 bytes × mask_count`. If estimated total exceeds a configurable budget (default 1 GB), progressively reduce the highest masks until within budget.
- **Dispose aggressively on level switch**: Old floor's masks should be disposed (not just cached indefinitely) if the per-floor cache grows beyond budget.
- **Lazy loading for non-active effects**: If `_Iridescence` effect is disabled, skip loading its mask entirely.

---

## Appendix H: Water Effect — Strict Level Isolation

### H1. The Requirement

**Only tiles on the SAME level as the water effect should influence water rendering.** An upper floor tile must not occlude, distort, or suppress water on a lower floor. A lower floor's water must not leak up into an upper floor.

This is a stronger constraint than "compositor handles it" — it requires level isolation at every stage of the water pipeline.

### H2. Current Water Pipeline & Level Gaps

The water effect has 5 stages, each with its own level-isolation requirements:

#### Stage 1: `_Water` Mask Selection
**Current**: `WaterEffectV2.setBaseMesh()` receives a single scene-wide `_Water` mask from the bundle. On level switch, `rebuildMasksForActiveLevel` selects the mask from the largest tile on the active floor.
**Gap**: If the compositor composes masks from ALL visible tiles on the active floor, a tile that is classified as "active floor" but logically "above" the water (e.g., a bridge tile with rangeBottom matching the floor) could contribute black pixels to the `_Water` composite and suppress the river beneath it.
**Fix**: The compositor's `_Water` mask must use **lighten** composition (already specified in D1). Black pixels from a bridge tile's `_Water` mask won't suppress the river tile's white pixels because `lighten` takes the max. However, if the bridge tile has NO `_Water` mask at all, it should not contribute any pixels (transparent/skip), which lighten handles correctly.

#### Stage 2: Water SDF Generation
**Current**: `_rebuildWaterDataIfNeeded()` builds SDF from the scene-wide `_Water` mask. The SDF encodes distance-to-water-edge for foam, shoreline, and flow calculations.
**Gap**: None, as long as Stage 1 provides the correct floor-scoped mask. SDF is derived from the mask, so correct mask → correct SDF.
**Fix**: No additional change needed — correct compositor output fixes this.

#### Stage 3: Water Distortion (DistortionManager)
**Current**: `WaterEffectV2.update()` registers/updates the water mask as a distortion source via `distortionManager.updateSourceMask('water', waterMask)`. The DistortionManager's fragment shader samples this mask in scene UV space and applies UV distortion wherever `waterMask > 0`.
**Gap**: The distortion mask is the same scene-wide `_Water` mask. If it's wrong (wrong floor), distortion appears in wrong areas.
**Fix**: Correct compositor output fixes this — same as Stage 1.

#### Stage 4: Water Occluders (Tile-Level)
**Current**: Each tile gets a `waterOccluderMesh` on `WATER_OCCLUDER_LAYER` (22). The occluder's visibility is synced with the tile sprite's visibility (`occ.visible = !!sprite.visible`, line 3485 of tile-manager.js). `DistortionManager._renderWaterOccluders()` renders all visible occluder meshes to produce a screen-space alpha map. The water shader uses this to suppress water effects under opaque tile pixels.
**Gap**: **This is the critical level-isolation point.** The occluder visibility follows tile sprite visibility, which is correctly gated by `updateSpriteVisibility` (level band check). So:
- Tiles on OTHER floors are hidden → their occluders are hidden → they don't affect water ✅
- Tiles on the CURRENT floor are visible → their occluders are visible → they correctly occlude water ✅

**However**, there's a subtle issue: when viewing Floor 1, Floor 2's tiles are hidden. But Floor 2's `_Water` mask could still be in the scene-wide bundle if the compositor doesn't properly filter by level. The occluder handles the VISUAL suppression, but the SDF and distortion would still reference wrong-floor water.

**Fix**: The compositor must strictly filter tiles by level band BEFORE compositing. Only tiles passing `_isTileInLevelBand` contribute their `_Water` mask. Combined with occluder visibility gating, this gives complete isolation.

#### Stage 5: Water Interaction with Fire/Heat
**Current**: Heat distortion from fire uses the boosted `_Fire` mask. Water distortion uses the `_Water` mask. Both are independent in the DistortionManager.
**Gap**: If fire is on Floor 1 and we switch to Floor 2, the fire distortion source should be unregistered. Currently, `FireSparksEffect.setAssetBundle()` is called on level switch, which re-registers heat distortion from the new floor's `_Fire` mask. If the new floor has no `_Fire`, the old heat source persists until `dispose()`.
**Fix**: `FireSparksEffect.setAssetBundle()` should explicitly unregister the old heat distortion source BEFORE registering a new one (or when no fire mask exists on the new floor). Verify this path handles the `!fireMask` case.

### H3. Summary: Water Level Isolation Requirements

| Stage | Isolation Mechanism | Status |
|---|---|---|
| `_Water` mask selection | Compositor filters tiles by level band | **Needs compositor** |
| SDF generation | Derived from level-scoped mask | **Automatic** (once mask is correct) |
| Water distortion source | Updated by `setBaseMesh` on level switch | **Automatic** (once mask is correct) |
| Water occluders | Tile visibility gated by `updateSpriteVisibility` | **Already works** ✅ |
| Heat/fire interaction | `setAssetBundle` replaces fire source on level switch | **Verify unregister path** |

### H4. Cross-Level Water Leak Scenarios

| Scenario | Expected Behavior | Current Behavior | Fix |
|---|---|---|---|
| Floor 1 has river, Floor 2 has no water | When on Floor 2: no water effects visible | ✅ Correct (level switch provides empty `_Water` mask) | None |
| Floor 1 has river, Floor 2 has bathtub | When on Floor 1: only river. When on Floor 2: only bathtub. | ⚠️ Depends on compositor correctly selecting per-floor tiles | Compositor level-band filter |
| Floor 2 building tile sits above Floor 1 river | When on Floor 1: water flows under the building | ✅ Correct (Floor 2 tile is hidden; its occluder is hidden; water renders normally) | None |
| Same-floor bridge tile over water | When on Floor 1: bridge occludes water under it | ✅ Correct (bridge occluder is visible on same floor, blocks water distortion) | None |
| Floor 1 tile with `_Water` mask leaking to Floor 2 | When on Floor 2: Floor 1's water must NOT appear | ⚠️ Depends on compositor correctly filtering | Compositor level-band filter |

---

## Appendix I: Fire & Particle Occlusion by Upper Floor Tiles

### I1. The Requirement

**Fire (and other particles) spawned on one floor must NOT be visible when an upper floor's opaque tile covers that area.** If there's a campfire on the ground floor and the player switches to Floor 2, the fire should disappear wherever Floor 2 has opaque tiles.

### I2. Current Particle Occlusion System

Fire particles already have a roof-occlusion system (`_patchRoofMaskMaterial` in FireSparksEffect.js, lines 2557–2637):

1. **World-space classification**: Each particle's world position is mapped to `_Outdoors` mask UV. If the mask says "indoors" (`m < 0.5`), the particle is considered under a roof.

2. **Screen-space occlusion**: Indoor particles sample `uRoofAlphaMap` at their screen-space UV. This map is the pre-rendered alpha of all roof tiles (Layer 20). If a roof tile is opaque at that pixel, `roofAlpha = 1.0` and the particle's alpha becomes 0 (fully hidden).

3. **The flow**:
```
Per-fragment in particle shader:
  1. Map particle world XY to _Outdoors UV
  2. Sample _Outdoors: is this an indoor region?
  3. If indoor (m < 0.5):
     a. Sample uRoofAlphaMap at screen UV
     b. Multiply particle alpha by (1.0 - roofAlpha)
  → Result: particles under opaque roofs become invisible
```

### I3. Level-Isolation Gaps in Current System

#### Gap A: `_Outdoors` Mask Is Floor-Scoped, Roof Alpha Is Not
The `_Outdoors` mask comes from the active floor's bundle (correctly level-scoped after compositor). But the `uRoofAlphaMap` is rendered from ALL tiles on `ROOF_LAYER` (20) — including tiles from the ACTIVE floor that are overhead.

**Problem**: When on Floor 1, Floor 2's tiles are classified as overhead and rendered into the roof alpha map. Fire on Floor 1 correctly sees these as "roof above" and fades. This is the DESIRED behavior. ✅

**When on Floor 2**: Floor 1's fire should NOT exist at all. Since `setAssetBundle` is called on level switch, Floor 2's `_Fire` mask is used. If Floor 2 has no fire, no fire particles are spawned. ✅

#### Gap B: Fire Particles Persist During Level Transition
**Problem**: When switching from Floor 1 to Floor 2, existing fire particle systems from Floor 1 are destroyed and rebuilt by `setAssetBundle`. But particles already in-flight (mid-animation) may still be visible for a few frames.
**Severity**: Low — particles have short lifetimes (0.5–2s). A brief flash is unlikely to be noticeable.
**Fix (optional)**: On level switch, immediately set all in-flight fire particle alpha to 0 before the new `setAssetBundle` call.

#### Gap C: Fire on Active Floor Under Same-Floor Overhead Tile
**Problem**: A campfire on Floor 1 is under a building's overhead portion (also Floor 1). The overhead tile is on ROOF_LAYER. The fire correctly fades under the overhead roof. ✅ This is working as designed.

#### Gap D: Multi-Floor Particle Z-Position
**Current**: `FireMaskShape.initialize()` sets `p.position.z = groundZ + levelElevation` (line 180). The `levelElevation` is set from `window.MapShine._activeLevelElevation` on each level switch.
**This means**: Fire particles are spawned at the active floor's Z level. When on Floor 1, fire is at groundZ. When on Floor 2, fire would be at groundZ + floorHeight. Since `setAssetBundle` rebuilds all fire systems on level switch, particles are always at the correct Z for the active floor. ✅

### I4. The Real Occlusion Problem: Same-Floor Scenarios

The critical scenario is NOT cross-floor (that's handled by level-switch mask redistribution), but same-floor:

**Scenario**: Floor 1 has a campfire in an outdoor area AND a roofed building nearby. The user is on Floor 1.
- Fire should render in the outdoor area ✅ (outdoorFactor > 0.5, no roof alpha occlusion)
- Fire should NOT render under the building's roof ✅ (outdoorFactor < 0.5, roof alpha occlusion kicks in)
- Fire near the building edge should partially fade ✅ (roof alpha is semi-transparent at edges)

This is already working. The `_Outdoors` mask + roof alpha map combination handles same-floor occlusion correctly.

### I5. Summary: Particle Level Isolation Requirements

| Scenario | Isolation Mechanism | Status |
|---|---|---|
| Fire on Floor 1, viewing Floor 2 | `setAssetBundle` rebuilds from Floor 2's `_Fire` mask (no fire if Floor 2 has no fire) | **Already works** ✅ |
| Fire on Floor 1, Floor 2 tiles cover it | Floor 2 tiles are overhead when on Floor 1 → rendered into roof alpha → fire fades | **Already works** ✅ |
| Fire on Floor 1, same-floor roof covers it | `_Outdoors` mask says indoor → roof alpha occlusion applies | **Already works** ✅ |
| Fire on Floor 2, viewing Floor 1 | Floor 2 fire not spawned (Floor 1's `_Fire` mask is active) | **Already works** ✅ |
| Brief fire flash during level transition | In-flight particles may persist for a few frames | **Low severity** — optional fix |

### I6. Extension to Other Particle Effects

The same analysis applies to dust motes and ash:

| Effect | Level Isolation | Roof Occlusion |
|---|---|---|
| **DustMotesEffect** | `setAssetBundle` rebuilds from active floor's `_Dust` mask | Currently NO roof occlusion in shader. Dust particles render everywhere including under roofs. **Gap found.** |
| **AshDisturbanceEffect** | `setAssetBundle` rebuilds from active floor's `_Ash` mask | Currently NO roof occlusion in shader. Ash particles render everywhere including under roofs. **Gap found.** |

**Recommendation**: Apply the same `_patchRoofMaskMaterial` pattern (or equivalent) to DustMotesEffect and AshDisturbanceEffect so they respect roof occlusion. This is a separate enhancement from the compositor work but important for visual correctness.

### I7. Compositor's Role in Particle Occlusion

The compositor's primary contribution to particle correctness is **ensuring the right floor's mask is in the bundle**:

1. **`_Fire` mask**: Compositor composes `_Fire` masks from all tiles on the active floor. Fire only spawns where the composite says "bright pixels". If the ground floor has fire and the upper floor doesn't, switching floors gives the correct fire mask.

2. **`_Outdoors` mask**: Compositor composes `_Outdoors` from all tiles on the active floor. This feeds the indoor/outdoor classification that drives roof alpha occlusion. A building tile's `_Outdoors` (black = indoor) composited over terrain's `_Outdoors` (white = outdoor) correctly marks the building interior as "under roof".

3. **`_Dust` / `_Ash` masks**: Same pattern as fire — correct floor's mask drives correct spawn regions.

The compositor does NOT need to do anything special for particle occlusion beyond producing correct per-floor masks. The occlusion itself is handled by the existing roof alpha pipeline.

---

## Appendix J: Revised Execution Order (Updated)

Taking into account the new requirements:

| Priority | Task | Effort | Rationale |
|---|---|---|---|
| **P0-A** | Raise resolution caps (MASK_MAX_SIZE→4096, VISUAL→8192, remove 8192 hardCap) | Small | Immediate quality win for 9000+ scenes. No architectural change. |
| **P0-B** | Fix redistribution gaps (AtmosphericFog, BuildingShadows, etc.) | Small | Correct level-switch behavior for all effects. Quick win. |
| **P0-C** | Fix `elev` undefined bug in composer.js | Trivial | Prevents NaN scoring in mask source selection. |
| **P1-A** | Per-tile mask discovery & loading (Phase 1) | Medium | Foundation for compositor. |
| **P1-B** | Scene Mask Compositor (Phase 2) with strict level-band filtering | Large | Core fix for multi-tile + multi-level mask composition. Water isolation depends on this. |
| **P1-C** | Integration — replace scene-level mask pipeline (Phase 3) | Medium | Wire compositor into existing effect distribution. |
| **P2-A** | Verify fire heat distortion unregister path on level switch | Small | Ensure old-floor heat sources don't persist. |
| **P2-B** | Add roof occlusion to DustMotesEffect and AshDisturbanceEffect | Medium | Prevents dust/ash rendering under roofs. |
| **P2-C** | Memory budget guards for raised resolution caps | Medium | Prevents VRAM exhaustion on very large scenes with many masks. |
| **P3** | Cache, performance, polish (Phases 5–6) | Medium | Lazy loading, LRU eviction, diagnostic overlays. |

---

## Implementation Status

### Completed ✅

| Task | Files Modified | Summary |
|---|---|---|
| **P0-A**: Resolution caps | `loader.js` | `MASK_MAX_SIZE` 2048→4096, `VISUAL_MASK_MAX_SIZE` 4096→8192. Removed 8192 hardCap in `composer.js`. |
| **P0-B**: Redistribution gaps | `canvas-replacement.js` | Added level-switch redistribution for AtmosphericFogEffect, BuildingShadowsEffect, OverheadShadowsEffect, CloudEffect, IridescenceEffect, PrismEffect, TreeEffect, BushEffect. Fixed effect ID mismatches: `'clouds'→'cloud'`, `'trees'→'tree'`, `'bushes'→'bush'`. |
| **P0-C**: `elev` undefined bug | `composer.js` | Added `const elev = Number(tileDoc?.elevation ?? 0)` in `_resolveMaskSourceSrc`. |
| **P1-A**: Per-tile mask loading | `tile-manager.js` | Generic `_resolveTileMaskUrl`, `loadAllTileMasks`, `clearTileEffectMasks`. Caches in `_tileEffectMasks` Map. |
| **P1-B**: Scene Mask Compositor | `scene-mask-compositor.js` (NEW) | CPU canvas composition with per-mask-type modes, tile transforms, Z-sorting, level-band filtering. |
| **P1-C**: Compositor integration | `composer.js` | Integrated into `rebuildMasksForActiveLevel` with 3-level fallback: compositor → legacy horizontal → single basePath. |
| **P1.4**: Tile CRUD hooks | `tile-manager.js` | Wired `loadAllTileMasks` into `createTile`/`updateTile`/`deleteTile` for eager loading and cache cleanup. |
| **P2-A**: Fire heat distortion | `FireSparksEffect.js` | `_unregisterHeatDistortion` helper; `setAssetBundle` unregisters when no `_Fire` mask. |
| **P2-B**: Roof occlusion | `DustMotesEffect.js`, `AshDisturbanceEffect.js` | Added `_patchRoofMaskMaterial` + `_syncRoofOcclusionUniforms` (same pattern as FireSparksEffect). |
| **P2-C**: Memory budget | `tile-manager.js`, `composer.js` | `_tileEffectMaskVramBytes` tracker + 512MB budget cap. LRU eviction for level mask cache (max 8 floors). |
| **P3.2**: Initial scene load | (deferred) | `rebuildMasksForActiveLevel` already covers the first level context change. |
| **P3.3**: Preload update | `composer.js` | `preloadMasksForAllLevels` delegates to `rebuildMasksForActiveLevel` which uses compositor. |

### Bug Fixes (Post-Initial Implementation) ✅

| Bug | Root Cause | Fix | Files |
|---|---|---|---|
| **Water floods entire scene when switching to upper floor** | `rebuildMasksForActiveLevel` returned null for ground floor (scene background is NOT a tile, so no tiles match the ground band). Hook exited early, leaving upper floor masks active. Also, `loadAllTileMasks` skipped water/specular/fluid, so the compositor never produced scene-space water masks. | 1. Added Step 5: background basePath fallback for ground-floor bands (`bandBottom <= 0`). 2. Removed water/specular/fluid skip from `loadAllTileMasks` so compositor can compose them. 3. Derive `primaryBasePath` from first active tile when no "large" tile matched. | `composer.js`, `tile-manager.js` |
| **Fire persists on ground floor when switching back** | `FireSparksEffect.setAssetBundle` only cleaned up particle systems when a fire mask WAS found (to rebuild). When no fire mask existed, old systems kept emitting. Also, ground floor cache wasn't always seeded. | 1. Added full particle system cleanup (globalSystem, globalEmbers, all arrays) when no fire mask. 2. Fixed `preloadMasksForAllLevels` to collect bands from scene level flags (not just tile ranges). | `FireSparksEffect.js`, `composer.js` |
| **Windows effect not rendering on upper floor** | `_getLargeSceneMaskTiles` could reject the upper tile (below 20% area threshold), leaving `primaryBasePath` null. Without `primaryBasePath`, `baseBundleMasks` was never loaded, so masks the compositor missed (like `_Windows` if the per-tile resolver didn't find it) were lost. | Derive `primaryBasePath` from first active tile (via `allActiveTiles[0]`) when `tileCandidates` is empty. This ensures `loadAssetBundle` runs as a fallback to catch masks the per-tile resolver may miss. | `composer.js` |
| **`preloadMasksForAllLevels` missed ground floor** | Band collection only used tile range flags. With only 1 tile (upper floor), `bands.size <= 1` caused early return without preloading. Ground floor (scene background) was never discovered. | Now reads `readSceneLevelsFlag(scene)` first to collect all floor bands from the authoritative scene-level definitions. Tile range flags are still collected as a fallback. | `composer.js` |
| **Water turns off entirely after Step 5 fix** | The Step 5 background fallback caused the first `mapShineLevelContextChanged` hook to return masks (instead of null), triggering redistribution. The redistribution called `clearCaches()` + `setBaseMesh()` on WaterEffectV2, replacing the working water setup from `initialize()` with freshly loaded masks. The rebuild could fail or produce different results. | Set `_activeLevelBasePath = bgPath` during `initialize()` so the first hook for the ground floor sees `masksChanged = false` and skips redistribution. Water from init is preserved. Subsequent floor switches still trigger redistribution correctly because the upper floor's basePath differs from bgPath. | `composer.js` |
| **Water disappears when moving to upper floor** | The redistribution unconditionally replaced the water effect with the upper floor's masks. When the upper floor has no `_Water` mask, `setBaseMesh` received a bundle without water and cleared the effect entirely. But water is a ground-plane effect that remains visible from above — the lower floor's water should persist. | Made water redistribution conditional: only call `clearCaches()` + `setBaseMesh()` if the new floor's bundle actually contains a `_Water` mask. If it doesn't, the existing lower-floor water remains untouched. When switching back to a floor with water, the cached mask is applied normally. | `canvas-replacement.js` |
| **Water still vanishes on upper floor despite persistence fix** | Water shader depth-occlusion used an absolute world-height threshold (`aboveGround`) and treated high-elevation upper-floor BG/FG surfaces as hard occluders. On upper floors this drove `waterVisible` toward zero across most pixels, making lower-floor water appear gone. | Added `uActiveLevelElevation` and made the depth-occluder test floor-relative (`aboveActiveFloor = aboveGround - uActiveLevelElevation`). This preserves token/overhead occlusion behavior while preventing normal upper-floor tiles from fully hiding lower-floor water. | `WaterEffectV2.js` |
| **SpecularEffect y-flipped on upper level tile** | SpecularEffect was missing from the `mapShineLevelContextChanged` redistribution hook entirely. When moving to the upper floor, the scene-wide specular mask stayed stale (ground floor mask), causing a visual mismatch where the ground floor specular pattern appeared misaligned/flipped under the upper floor tile. | Added SpecularEffect to the level change redistribution in `canvas-replacement.js`. Now calls `se.setBaseMesh(se.mesh, bundle)` with the upper floor's compositor-produced bundle so the scene-wide specular mask updates correctly. | `canvas-replacement.js` |
| **WindowLightEffect doesn't work on upper tile despite valid _Windows mask** | `setBaseMesh` disabled the effect (`this.enabled = false`) when no `_Windows` mask was found, but never re-enabled it when a valid mask was later provided via redistribution. Also, existing material uniforms were never updated with new mask textures, and the overlay mesh was never created if it didn't exist yet. | 1. Added `this.enabled = true` when a valid mask is found. 2. Added material uniform updates (`uWindowMask`, `uOutdoorsMask`, `uSpecularMask`, `uHasOutdoorsMask`, `uHasSpecularMask`, `uWindowTexelSize`) for both main and light-pass materials. 3. Added overlay mesh creation if mesh doesn't exist yet. 4. Rain flow map rebuild via existing `_ensureRainFlowMap()`. | `WindowLightEffect.js` |
| **Water effect still turns off when moving to upper floor** | Two root causes: (a) The `hasWaterMask` conditional check only tested for mask entry existence (`m.id === 'water'`) without verifying the texture was non-null. A mask entry with `texture: null` would pass the check, triggering `clearCaches()` + `setBaseMesh()` which cleared the working water. (b) TileManager's debounced `_scheduleWaterCacheInvalidation` fires ~150ms after tile visibility changes during a level switch, destroying preserved ground-floor water data. | 1. Tightened `hasWaterMask` check to require `!!m.texture`. 2. Added `_suppressExternalCacheClear` flag on WaterEffectV2 that `clearCaches()` respects. Level-change hook sets this flag for 500ms when preserving water (no new floor water mask), suppressing tile-manager-triggered cache invalidation. | `canvas-replacement.js`, `WaterEffectV2.js` |
| **Rendering freeze after moving to upper floor** | The previous `clearCaches()` fallback attempted to restore `prevWaterData` if the rebuild failed, but `_surfaceModel.dispose()` had already destroyed the GPU texture referenced by `prevWaterData.texture`. Restoring a disposed texture handle gave the shader a dead GPU resource, causing WebGL errors and rendering breakdown. | Reverted the fallback preservation approach entirely. Replaced with the `_suppressExternalCacheClear` suppression flag mechanism described above, which prevents the problematic `clearCaches()` call from happening at all during level transitions. | `WaterEffectV2.js` |
| **Specular y-flip on per-tile overlay (TRUE root cause, 3rd attempt)** | The base plane mesh has `scale.y = -1` (set in `composer.js`) to reconcile Foundry's Y-down coordinate system with Three.js Y-up. All scene-space textures use `flipY=false` and rely on this Y-flip to render right-side up. The tile sprite's `matrixWorld` has POSITIVE Y scale (no flip). Copying it directly to the `PlaneGeometry` overlay inverts UV sampling relative to the base plane — causing the specular mask to appear y-flipped on the tile. Previous attempts to fix `flipY` on the texture were wrong because the issue is in the mesh transform, not the texture. | In `_syncTileOverlayTransform`, after decomposing the sprite's `matrixWorld`, negate the Y scale: `this._tileOverlayScale.y = -Math.abs(this._tileOverlayScale.y)`. This makes the overlay match the base plane's `scale.y=-1` convention. Reverted all texture `flipY` experiments — the specular mask correctly uses `flipY=false` via the shared `textureCache`. | `SpecularEffect.js` |
| **Water disappears immediately on floor switch (timing race)** | The `_suppressExternalCacheClear` flag was set inside the `safeCallAsync` block, AFTER `await rebuildMasksForActiveLevel()`. On a cache miss, this async call takes >150ms. The tile-manager's `_scheduleWaterCacheInvalidation` debounce (150ms) fires during that wait, before the flag is set, destroying the preserved water data. | Set the suppress flag **synchronously** at the very start of the `mapShineLevelContextChanged` hook, before the async block begins. | `canvas-replacement.js` |
| **`window.MapShine.waterEffect` was always null** | `GLOBAL_EFFECT_EXPOSURES` in `effect-wiring.js` did not include `'Water'`. `exposeEffectsEarly()` never assigned the live `WaterEffectV2` instance to `window.MapShine.waterEffect`. Every reference to `ms?.waterEffect` in the hook returned `undefined` — the suppress flag was being set on nothing. | Added `['Water', 'waterEffect']` to `GLOBAL_EFFECT_EXPOSURES`. | `effect-wiring.js` |
| **Water works briefly then breaks after ~1s on upper floor (ARCHITECTURAL ROOT CAUSE)** | Multiple code paths could destroy water data during floor transitions: `clearCaches()` via TileManager debounce, `setBaseMesh()` with empty bundle, `_rebuildWaterDataIfNeeded()` via render loop cache key changes. Previous attempts (suppress flags with timers, permanent flags, UUID guards, relevance filter changes) all failed because the problem was systemic — too many destruction paths to guard individually. | **Phase 0 architectural fix** (see `MULTI-LEVEL-RENDERING-ARCHITECTURE.md`): Added `_floorTransitionActive` lock on WaterEffectV2. When true, ALL water destruction paths are blocked: `clearCaches()`, `setBaseMesh()` no-water path, and `_rebuildWaterDataIfNeeded()`. The lock is set **synchronously** at `mapShineLevelContextChanged` hook entry (before any async work), and cleared in a `try/finally` block after all redistribution completes. No timers, no UUID matching — just a single boolean gate with well-defined lifecycle points. Additionally removed `flags` from water invalidation relevance filter in tile-manager.js and added Water to `GLOBAL_EFFECT_EXPOSURES`. | `WaterEffectV2.js`, `canvas-replacement.js`, `tile-manager.js`, `effect-wiring.js` |
| **Effect re-enable bug across multiple effects** | TreeEffect, BushEffect, IridescenceEffect, PrismEffect all set `this.enabled = false` when no mask found but never re-enabled when a valid mask was later provided via redistribution. Visiting a floor without a particular mask permanently disabled the effect for the session. | Added `this.enabled = true` when valid mask found. For Iridescence/Prism, also added material uniform update path to avoid full mesh rebuild during redistribution. | `TreeEffect.js`, `BushEffect.js`, `IridescenceEffect.js`, `PrismEffect.js` |

### Remaining / Future Work

| Task | Priority | Description |
|---|---|---|
| **Phase 6 polish** | Low | Diagnostic overlays, tile transform edge cases beyond flip/rotation. |
| **Phase 4 extensions** | Low | Per-tile effect overlay extensions (SpecularEffect/FluidEffect already work per-tile independently). |
| **GPU compositor** | Low | Switch from CPU canvas to WebGL render targets if performance demands it (current CPU approach is adequate). |
| **Per-mask-type tile gating** | Low | Allow map makers to toggle which masks a tile contributes (beyond existing `bypassEffects` flag). |
| **`_Window` singular suffix** | Low | Consider supporting `_Window` (singular) as an alias for `_Windows` to handle common naming variations. |
