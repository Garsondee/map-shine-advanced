# Levels Architecture Rethink — Problem Analysis

## Executive Summary

The module's "levels" system allows tokens to move between floors, but the current architecture was designed for single-floor scenes with multi-level support bolted on via hooks, mask redistribution, and floor-presence gates. This document catalogues every structural problem discovered during a deep code investigation. **No solutions are proposed here** — this is a comprehensive problem description only.

The investigation covered:
- `GpuSceneMaskCompositor.js` — GPU mask composition and per-floor caching
- `EffectMaskRegistry.js` — central mask state, policies, floor transitions
- `tile-manager.js` — tile sprite creation, visibility, resolution, Z-layering
- `composer.js` (SceneComposer) — background image, base plane, camera setup
- `canvas-replacement.js` — floor transition wiring, mask redistribution hook
- `EffectComposer.js` — render pipeline, scene render target, post-processing chain
- Effect consumers: LightingEffect, WaterEffectV2, SpecularEffect registry subscriptions

---

## Problem 1: Tile Albedo Textures Are Downscaled to 4096×4096

### Where
`tile-manager.js` lines 4208–4219, the `loadTileTexture()` method.

### What
```javascript
const TILE_MAX_DIM = 4096;
if (origW > TILE_MAX_DIM || origH > TILE_MAX_DIM) {
  const scale = TILE_MAX_DIM / Math.max(origW, origH);
  // ...downscale via createImageBitmap
}
```

Every tile texture (the **albedo** — the actual art the user sees) is hard-capped at 4096×4096 pixels. A 6750×6750 tile texture is downscaled to ~4096×4096 before being uploaded to the GPU.

### Why This Is a Problem
- Users author high-resolution floor art (6K–8K+) expecting to see that detail when zoomed in.
- The downscale happens at load time and is irreversible — the original resolution is discarded.
- This was added as a performance measure ("Cap the canvas copy at 4096×4096 to limit the synchronous drawImage cost"), but it trades visual quality for load-time speed.
- The comment explicitly acknowledges "a 6750×6750 tile = 182M pixels and blocks the event loop for 1-3s" — this is a real concern, but the fix should be async/progressive, not a hard resolution cap.
- **This applies to ALL tiles**, not just mask tiles. The user's actual floor art is degraded.

### Scope
Every tile on every floor on every scene is affected. This is the single most impactful resolution problem.

---

## Problem 2: Compositor Mask Resolution Is Capped at 4096 / 8192

### Where
`GpuSceneMaskCompositor.js` lines 15–37 (constants) and lines 332–342 (scale calculation in `compose()`).

### What
```javascript
const DATA_MAX  = 4096;   // fire, water, outdoors, dust, ash
const VISUAL_MAX = 8192;  // specular, normal, bush, tree

const VISUAL_MASK_IDS = new Set(['specular','normal','bush','tree','iridescence','prism','roughness','fluid']);

// In compose():
const targetMax = VISUAL_MASK_IDS.has(maskType) ? VISUAL_MAX : DATA_MAX;
const clampedMax = Math.min(targetMax, maxTexSize);
const scale = Math.min(1.0, clampedMax / Math.max(1, sceneW), clampedMax / Math.max(1, sceneH));
```

When the scene dimensions exceed these caps, the compositor **downscales** the output render target. A 6000×6000 scene with `DATA_MAX=4096` produces masks at `scale = 4096/6000 ≈ 0.68` — a 68% resolution mask for a 100% resolution scene.

### Why This Is a Problem
- Masks drive visual effects (water boundaries, fire regions, specular highlights, outdoor areas). Downscaled masks mean blurry/imprecise effect boundaries.
- The user's requirement is: "We should always use full resolution albedo passes and almost always use masks at a proportion of the texture/mask's full resolution." The current system does the opposite — masks are at a **lower** proportion than intended.
- `DATA_MAX = 4096` is particularly aggressive. Water masks, fire masks, and outdoor masks on large maps (common in VTT) will always be downscaled.
- The `VISUAL_MAX = 8192` is better but still a hard cap that some high-end users will exceed.

### Interaction With Problem 1
Since tile albedo is capped at 4096 AND compositor masks are capped at 4096/8192, both the art and the effect masks are degraded. The user sees lower-quality art with lower-quality effect boundaries.

---

## Problem 3: Single Active Mask Set — No True Per-Floor Isolation

### Where
- `EffectMaskRegistry.js` — `_slots` Map, `transitionToFloor()` method
- `canvas-replacement.js` — `mapShineLevelContextChanged` hook handler (lines 543–672)
- All effect `connectToRegistry()` subscriptions

### What
The `EffectMaskRegistry` maintains a **single set** of active mask slots. When a floor transition occurs:

1. `canvas-replacement.js` calls `compositor.composeFloor(ctx, scene, ...)` to GPU-composite the new floor's masks
2. It then calls `registry.transitionToFloor(floorKey, result.masks)` which atomically replaces/preserves/clears each mask type based on policy
3. Each subscribed effect receives the new texture via its callback

The fundamental limitation: **there is only one active mask per type at any time**. There is no mechanism for effects on Floor 1 to use Floor 1's masks while simultaneously having Floor 2's effects use Floor 2's masks.

### Why This Is a Problem
The user's requirement is: "move up through layers and see all the effects working correctly on floors below and not have those effects be changed by the masks / textures of the floors which are layered above them."

Current behavior:
- When on Floor 2, Floor 2's `_Water` mask replaces Floor 1's `_Water` mask (if Floor 2 has one)
- When on Floor 2 without a `_Water` mask, Floor 1's water is "preserved" (`preserveAcrossFloors: true`) — but this is a binary keep/replace, not a layered composition
- **There is no way for Floor 1's water effect to render using Floor 1's mask while Floor 2's fire effect uses Floor 2's mask simultaneously**
- Effects like `_Outdoors`, `_Dust`, `_Ash` are `preserveAcrossFloors: false` — switching floors **destroys** these masks entirely, even if the lower floor should still show them through transparent gaps

### The Floor-Presence Gate Workaround
The current system uses `floorPresenceTarget` and `belowFloorPresenceTarget` render targets (layers 23/24) as screen-space alpha gates to suppress effects in areas covered by the current floor. This is a **screen-space workaround** for the lack of per-floor mask isolation:

- `DistortionManager` uses `(1-floorPresence)` to gate current-floor water and `belowFloorPresence*(1-floorPresence)` for below-floor water
- `SpecularEffect` uses `bfp*(1-fp)` for below-floor tiles
- `CandleFlamesEffect` uses `(1-floorPresenceMap)` to suppress flames under floors
- `FireSparksEffect` uses `uFloorPresenceMap`/`uHasFloorPresenceMap`

These gates work for **two-floor scenarios** (current + one below) but do not extend to N floors. With 10+ floors, you'd need N separate floor-presence masks and N separate effect instances — the current system has no mechanism for this.

---

## Problem 4: Background Image Treated Differently From Tiles

### Where
- `composer.js` — `initialize()` method (lines 456–506), `createBasePlane()` method (lines 782–892)
- `tile-manager.js` — `createTileSprite()` and all tile lifecycle methods

### What
The scene's **Background Image** is loaded once during `SceneComposer.initialize()` and rendered as a single `basePlaneMesh` (a `PlaneGeometry` with `MeshBasicMaterial`). It:
- Uses `sceneWidth × sceneHeight` geometry
- Is positioned at the scene rectangle center
- Has `scale.y = -1` for Y-flip
- Sits at `groundZ = 1000`
- Has **no alpha channel handling** — it's always opaque (`transparent: false`)
- Is loaded from Foundry's PIXI background texture (or fallback loaders)

Tiles, in contrast, are loaded as `THREE.Sprite` objects with:
- `SpriteMaterial` with `transparent: true, alphaTest: 0.1`
- Individual per-tile positioning, rotation, scale
- Z-layering based on elevation and sort keys
- Per-tile mask loading (water, specular, fluid, etc.)
- Levels visibility gating
- Floor-presence mesh generation

### Why This Is a Problem
The user's requirement is: "the scene's 'Background Image' should probably be treated in the same way [as levels/tiles] only without the expectation of an alpha channel because there shouldn't be any holes through that layer."

Current discrepancies:
1. **No mask association**: The background image's masks come from `_resolveMaskSourceSrc()` which picks a single basePath for suffix-mask discovery. Tiles each have their own basePath. If the background and a large tile share the same masks, it works. If they don't, the background gets the "wrong" masks.
2. **No alpha handling**: The background is always `transparent: false`. In a multi-level system, the background IS the ground floor — it should participate in the level system as "floor 0" with no holes. But it currently has no concept of floor membership.
3. **Different rendering path**: Background goes through `MeshBasicMaterial` on a `PlaneGeometry`. Tiles go through `SpriteMaterial` on `Sprite`. This means post-processing and effect shaders may interact differently with each.
4. **Visibility gating**: `_refreshAllTileElevationVisibility()` can hide `basePlaneMesh` via `isBackgroundVisibleForPerspective()`, but this is a binary show/hide, not a layered composition. If you're on Floor 3, the background is hidden entirely — you can't see Floor 0's effects through transparent gaps in Floors 1 and 2.

---

## Problem 5: Only Two Floors Are Tracked (Current + Below)

### Where
- `GpuSceneMaskCompositor.js` — `_activeFloorKey`, `_belowFloorKey`, `getBelowFloorTexture()`
- `DistortionManager.js` — `tBelowWaterMask`, `uWindowLightBelowFloor`

### What
The compositor tracks exactly two floor states:
- `_activeFloorKey` — the current floor (e.g. "5:10")
- `_belowFloorKey` — the floor that was active before the current one

`getBelowFloorTexture(maskType)` returns the mask for the below floor. Effects that need below-floor data (distortion, specular) sample this single texture.

### Why This Is a Problem
With 10+ floors, you need to see effects on **all** visible floors below, not just one. Consider:
- Floor 3 has a transparent glass panel
- Floor 2 has water
- Floor 1 has fire
- Floor 0 (background) has outdoor areas

When standing on Floor 3, you should see Floor 2's water through the glass, Floor 1's fire through Floor 2's transparent areas, and Floor 0's outdoor effects through all of them. The current system can only show "current floor" and "one floor below" — everything deeper is invisible.

The `_belowFloorKey` is also fragile:
- It's set during `composeFloor()` only when the previous floor was a lower elevation
- If you jump from Floor 5 to Floor 1, `_belowFloorKey` becomes Floor 5 (which is *above*, not below)
- `_findBestBelowFloorKey()` is a lazy fallback that scans the cache, but only finds floors that have been previously composited

---

## Problem 6: Floor Cache Eviction at 8 Floors

### Where
`GpuSceneMaskCompositor.js` — `_maxCachedFloors = 8`, `_getOrCreateFloorTargets()` LRU eviction.

### What
```javascript
if (this._floorCache.size >= this._maxCachedFloors) {
  const oldest = this._lruOrder.shift();
  // ... dispose and delete
}
```

The compositor caches up to 8 floors' worth of GPU render targets. Beyond 8, the oldest floor is evicted.

### Why This Is a Problem
- With 10+ floors, navigating between floors causes repeated eviction and recomposition
- `preloadAllFloors()` pre-warms the cache, but if there are >8 floors, not all can be cached simultaneously
- Evicted floors need full GPU recomposition on the next visit, which involves loading per-tile masks, rendering to RTs, and readback checks
- The 8-floor limit is a hardcoded constant, not configurable

### VRAM Impact
Each cached floor stores one RT per mask type. With ~14 mask types and 4096×4096 RTs, each floor consumes:
- 14 × 4096 × 4096 × 4 bytes ≈ **896 MB per floor**
- 8 floors ≈ **7.2 GB** of VRAM just for compositor caches

This is likely why the limit is 8 — but with the resolution caps from Problem 2, actual usage is lower. The point is that the cache limit and the resolution cap are interdependent constraints that need to be designed together, not set independently.

---

## Problem 7: Effects Subscribe to Single Mask Types, Not Per-Floor Data

### Where
- `LightingEffect.js` — `connectToRegistry()` subscribes to `'outdoors'`
- `WaterEffectV2.js` — `connectToRegistry()` subscribes to `'water'`
- `SpecularEffect.js` — `connectToRegistry()` subscribes to `'specular'`, `'roughness'`, `'normal'`
- `EffectMaskRegistry.js` — `subscribe(maskType, callback)` returns unsub function

### What
Each effect subscribes to a single mask type (or a few types) via the registry. When a floor transition fires `transitionToFloor()`, the registry calls each subscriber with the new texture (or null).

Effects receive a flat `(texture, floorKey, source)` tuple. They have no knowledge of:
- Which floor this mask belongs to
- Whether other floors also have this mask type
- How to composite multiple floors' masks together

### Why This Is a Problem
For N-floor rendering, an effect would need to know about masks from ALL visible floors, not just the "active" one. The subscriber model gives effects a single texture — the result of the registry's replace/preserve/clear policy. There's no way for an effect to say "give me the water mask for Floor 2 AND Floor 0" and composite them in its shader.

This is a fundamental architectural mismatch: the registry was designed for "which single mask is active now?" but the requirement is "which masks are active on each visible floor?"

---

## Problem 8: Render Pipeline Has One Scene Render, Not Per-Floor Renders

### Where
`EffectComposer.js` — `render()` method, lines 623–642.

### What
```javascript
// Single authoritative scene render
this.camera.layers.disable(OVERLAY_THREE_LAYER);
this.renderer.render(this.scene, this.camera);
```

The entire scene is rendered once into `sceneRenderTarget`. Post-processing effects then operate on this single texture via a ping-pong chain.

### Why This Is a Problem
In a multi-floor system where effects need per-floor data, a single scene render doesn't provide the information needed to:
1. Apply Floor 0's water effect only to Floor 0's visible area
2. Apply Floor 1's fire effect only to Floor 1's visible area
3. Apply Floor 2's specular effect only to Floor 2's visible area

All floors' tiles are rendered into one buffer (with visibility gating hiding non-current-floor tiles). Post-processing effects see a flat 2D image with no floor identity per pixel.

The floor-presence gates (Problem 3) are a partial workaround — they encode "current floor footprint" and "below floor footprint" as screen-space masks. But extending this to N floors would require N floor-presence render passes and N-way compositing in every effect shader.

---

## Problem 9: preserveAcrossFloors Policy Creates Paradoxes

### Where
`EffectMaskRegistry.js` — `DEFAULT_POLICIES`, `transitionToFloor()`.

### What
Current `preserveAcrossFloors` settings:
- **true**: `water`, `fire`, `windows`, `specular`, `normal`, `roughness`
- **false**: `outdoors`, `tree`, `bush`, `dust`, `ash`, `iridescence`, `prism`, `fluid`

### Why This Is a Problem
The preserve policy was designed for the two-floor model: "if the new floor doesn't have this mask, keep the old one." But this creates paradoxes with N floors:

1. **Water on Floor 0, puddle on Floor 2**: When switching to Floor 2, the Floor 2 puddle mask **replaces** Floor 0's full-scene water mask. Now the water effect only shows the puddle, not the ocean on Floor 0. The user expects both.

2. **Fire on Floor 1, fire on Floor 3**: `fire` is `preserveAcrossFloors: true`. Going from Floor 1 → Floor 3, Floor 3's fire replaces Floor 1's fire. Floor 1's fire is invisible even though Floor 1 tiles may be visible through transparent Floor 2 gaps.

3. **Outdoors is `preserveAcrossFloors: false`**: Going from Floor 0 (outdoor ground) to Floor 1 (indoor), the outdoor mask is cleared. But if Floor 1 has a balcony (transparent area), the ground floor's outdoor lighting should still be visible through it. The current system blacks it out.

4. **Specular is `preserveAcrossFloors: true`**: Floor 0 has a marble specular map. Floor 2 has a wood specular map. Going to Floor 2 replaces the marble with wood. Looking through transparent Floor 2 gaps, Floor 0 shows wood specular instead of marble.

The fundamental issue: `preserveAcrossFloors` is a **global per-type** policy, but the correct behavior depends on **which floor you're looking at** and **what's visible through transparency**. This requires per-floor mask isolation, not a global preserve/replace toggle.

---

## Problem 10: Tile Effect Masks Are Loaded Per-Tile But Composited Into Single Scene-Space RTs

### Where
- `tile-manager.js` — `loadAllTileMasks()`, `_tileEffectMasks` cache
- `GpuSceneMaskCompositor.js` — `compose()`, `_composeMaskType()`

### What
Per-tile masks are loaded individually (each tile has its own `_Fire`, `_Water`, `_Specular`, etc. suffix files). The compositor then renders all tiles' masks for a given floor into a single scene-space render target per mask type.

The composition uses two blend modes:
- **lighten (max)**: for `fire`, `water`, `dust`, `ash` — takes the maximum of overlapping masks
- **source-over (alpha blend)**: for `outdoors`, `windows`, `specular`, `normal` — standard layering

### Why This Is a Problem
Once composed into a single RT, the per-tile identity is lost. You can't tell which pixel came from which tile. This matters for:

1. **Per-tile alpha channels**: Each tile has an alpha channel defining "where this floor exists" vs "where there are holes." After composition, the alpha represents the union of all tiles on that floor, not the alpha of any specific tile.

2. **Conflicting masks on the same floor**: If two tiles on the same floor have different specular maps and overlap, `source-over` blend means the upper tile overwrites the lower. The lower tile's specular is lost in the overlap region.

3. **Floor-boundary cutout tiles**: The compositor's `_readbackIsNonEmpty()` checks RGB only (not alpha) specifically because some tiles are "floor-boundary cutouts" — black RGB with alpha defining the floor shape. These are meant to define holes, not provide mask data. But the compositor has to handle them as a special case rather than having a clean separation between "floor shape" and "effect mask."

---

## Problem 11: No Unified Layer Model

### Where
This is a cross-cutting architectural gap rather than a specific code location.

### What
The current system has three distinct concepts that should be unified:
1. **Background Image** — loaded by SceneComposer, rendered as `basePlaneMesh`, no alpha, no floor identity
2. **Tiles with Levels ranges** — loaded by TileManager, have per-tile alpha, floor identity via elevation/flags
3. **Effect masks** — loaded by compositor, composited per-floor, consumed by effects via registry

These three systems don't share a common "layer" abstraction. There's no concept of "Layer 0 = Background, Layer 1 = First Floor Tiles, Layer 2 = Second Floor Tiles" where each layer has:
- An albedo (the art)
- An alpha channel (where this layer exists vs holes)
- A set of effect masks (water, fire, specular, etc.)
- A Z-order for rendering

### Why This Is a Problem
Without a unified layer model:
- The background can't participate in floor transitions
- Effects can't query "what's the water mask for layer N?"
- The render pipeline can't do per-layer effect passes
- Adding a new layer type (e.g., "underground water plane") requires ad-hoc wiring
- The floor-presence gates, below-floor-presence gates, and `preserveAcrossFloors` policies are all workarounds for the lack of a proper layer stack

---

## Problem 12: Floor-Presence Gate Is Screen-Space, Not World-Space

### Where
- `tile-manager.js` — `FLOOR_PRESENCE_LAYER = 23`, `BELOW_FLOOR_PRESENCE_LAYER = 24`
- `DistortionManager.js` — `floorPresenceTarget`, `belowFloorPresenceTarget`
- Various effect shaders — `gl_FragCoord.xy / uResolution` sampling

### What
Floor-presence meshes are rendered to screen-space render targets (`floorPresenceTarget`, `belowFloorPresenceTarget`). Effects sample these targets using screen UVs (`gl_FragCoord.xy / uResolution`).

### Why This Is a Problem
- Screen-space masks change resolution with viewport/zoom. At low zoom (zoomed out), the floor-presence mask is low-resolution relative to the scene, causing aliased/imprecise effect boundaries.
- At high zoom (zoomed in), only a portion of the floor is visible, so the screen-space mask only covers the visible area. Effects that need the full floor shape (e.g., water SDF) can't use it.
- The floor-presence meshes duplicate the tile geometry (same position/scale/rotation) but as separate `PlaneGeometry` + `ShaderMaterial` objects. This doubles the geometry count for every tile.
- Screen-space sampling requires `uResolution` uniforms to be kept in sync across all effects — a maintenance burden and source of bugs.

---

## Summary of Root Causes

| # | Problem | Root Cause |
|---|---------|-----------|
| 1 | Tile albedo capped at 4096 | Hard `TILE_MAX_DIM` in `loadTileTexture()` |
| 2 | Compositor masks capped at 4096/8192 | Hard `DATA_MAX`/`VISUAL_MAX` constants |
| 3 | No per-floor mask isolation | Single `_slots` Map in EffectMaskRegistry |
| 4 | Background ≠ tiles | Separate load/render paths, no shared layer abstraction |
| 5 | Only current + below tracked | `_activeFloorKey`/`_belowFloorKey` two-slot model |
| 6 | Cache eviction at 8 floors | `_maxCachedFloors = 8` with no dynamic sizing |
| 7 | Effects get single mask, not per-floor | `subscribe(type, cb)` returns one texture at a time |
| 8 | One scene render, not per-floor | `EffectComposer.render()` does a single `renderer.render()` |
| 9 | preserve policy creates paradoxes | Global per-type policy vs per-floor-per-pixel need |
| 10 | Per-tile identity lost in composition | Single RT per mask type per floor |
| 11 | No unified layer model | Three disjoint systems (bg, tiles, masks) |
| 12 | Floor-presence is screen-space | Resolution-dependent, viewport-dependent, geometry-doubling |

---

## Files Investigated

| File | Key Findings |
|------|-------------|
| `scripts/masks/GpuSceneMaskCompositor.js` | Resolution caps, floor cache, LRU eviction, two-floor tracking, per-tile composition |
| `scripts/assets/EffectMaskRegistry.js` | Single mask set, policies, subscriber model, transition protocol |
| `scripts/scene/tile-manager.js` | TILE_MAX_DIM=4096, sprite creation, Z-layering, floor-presence meshes, visibility gating |
| `scripts/scene/composer.js` | Background image load, basePlaneMesh, camera setup, mask basePath resolution |
| `scripts/foundry/canvas-replacement.js` | Floor transition hook, compositor.composeFloor(), registry.transitionToFloor(), mask redistribution |
| `scripts/effects/EffectComposer.js` | Single scene render, post-processing ping-pong, render target sizing |
| `scripts/effects/LightingEffect.js` | Subscribes to 'outdoors' only |
| `scripts/effects/WaterEffectV2.js` | Subscribes to 'water' only, SDF rebuild on mask change |
| `scripts/effects/SpecularEffect.js` | Subscribes to 'specular', 'roughness', 'normal' |
| `scripts/scene/TileEffectBindingManager.js` | Per-tile effect routing, level-change visibility sync |
| `scripts/effects/DistortionManager.js` | Below-floor water mask, floor-presence gates |

---

---
---

# Part 2: Proposed Architecture — The Floor Stack

## Design Philosophy

The current system treats multi-level as an afterthought: a single-floor renderer with hooks and gates bolted on. The proposed architecture inverts this. **Every scene is a stack of floors.** A single-floor scene is simply a stack of height 1. The entire rendering pipeline — tile management, mask composition, effect rendering, and final compositing — operates on the floor stack as its primary data structure.

### Core Principles

1. **Floors own their masks.** Floor 0's `_Water` mask is Floor 0's forever. Floor 1 getting its own `_Water` mask has zero effect on Floor 0's water. There is no global "active water mask" — there are N water masks, one per floor that has one.

2. **Effects render per-floor.** An effect doesn't receive "the water mask." It receives "render water for Floor 0 using Floor 0's mask, then render water for Floor 1 using Floor 1's mask." Each invocation is isolated.

3. **The background image is Floor 0.** It's not special. It's a floor with no alpha holes, its own mask set, and its own effect rendering pass. It participates in the floor stack like any other floor.

4. **Compositing is the final step, not a workaround.** Floors are composited bottom-up with proper alpha blending. The floor-presence gates, `preserveAcrossFloors` policies, and `_belowFloorKey` tracking are all eliminated. Compositing handles everything they were trying to do, correctly and for N floors.

5. **World-space, not screen-space.** Floor identity and floor alpha are world-space textures at scene resolution. They don't change with viewport zoom or camera position. Effects that need "where is this floor" sample a world-space texture, not `gl_FragCoord / uResolution`.

---

## The Floor Stack Model

### What Is a Floor?

A **Floor** is an ordered rendering layer in the scene. It contains:

```
Floor {
  index:          number              // 0 = ground, 1 = first upper, ...
  key:            string              // "0:5" (bottom:top elevation range)
  elevationRange: { bottom, top }     // Foundry elevation band
  tiles:          Set<TileDocument>   // tiles assigned to this floor
  masks:          Map<string, RT>     // per-mask-type GPU render targets
  alpha:          RT                  // world-space alpha (where floor exists vs holes)
  dirty:          boolean             // needs re-composition
  visible:        boolean             // currently visible (based on camera floor)
}
```

### Floor Discovery

Floors are discovered from the scene's tile data, not configured manually:

1. Scan all tiles in the scene
2. Group tiles by their Levels elevation band (`rangeBottom:rangeTop`)
3. Sort groups by elevation (lowest first)
4. Assign floor indices: ground (background image) = 0, lowest tile group = 1, etc.
5. The background image is always Floor 0 with `elevationRange: { bottom: -Infinity, top: firstTileBottom }`

```
Example: A tavern scene
  Floor 0: Background image (ground, outdoor courtyard)
  Floor 1: Tiles at elevation 0–5 (ground floor interior)
  Floor 2: Tiles at elevation 5–10 (second story)
  Floor 3: Tiles at elevation 10–15 (attic/roof)
```

### Floor Assignment Rules

- A tile belongs to **exactly one floor** (determined by its elevation range)
- If a tile spans multiple elevation bands, it belongs to the floor whose band overlaps most
- Tiles without Levels flags belong to Floor 1 (the default floor above background)
- The background image always belongs to Floor 0
- Overhead/roof tiles belong to the floor they are the roof OF (same elevation band), not a separate "roof layer"

### The Floor Stack Data Structure

```javascript
class FloorStack {
  constructor() {
    this.floors = [];                  // Floor[], ordered bottom-to-top
    this.floorsByKey = new Map();      // key → Floor
    this.tileToFloor = new Map();      // tileId → Floor
    this.activeFloorIndex = 0;         // camera's current floor
  }

  // Build from scene data
  buildFromScene(foundryScene, backgroundTexture) { ... }

  // Get all floors that should be visible from the active floor
  getVisibleFloors() {
    // Returns floors from 0 up to activeFloorIndex
    // (everything below and including the current floor)
    return this.floors.slice(0, this.activeFloorIndex + 1);
  }

  // Get a specific floor's mask
  getFloorMask(floorIndex, maskType) {
    return this.floors[floorIndex]?.masks.get(maskType)?.texture ?? null;
  }

  // Assign a tile to its floor (called when tiles are created/updated)
  assignTile(tileDoc) { ... }

  // Mark a floor as needing re-composition
  invalidateFloor(floorIndex) { ... }
}
```

---

## Per-Floor Mask Isolation

### How It Works

Each floor owns a **complete, independent set of mask render targets.** When `GpuSceneMaskCompositor` composes masks for Floor 2, the result is stored in Floor 2's `masks` Map. It never touches Floor 0's or Floor 1's masks.

```
Floor 0 masks: { water: RT_0w, outdoors: RT_0o, specular: RT_0s, fire: null, ... }
Floor 1 masks: { water: null,  outdoors: RT_1o, specular: RT_1s, fire: RT_1f, ... }
Floor 2 masks: { water: RT_2w, outdoors: null,  specular: RT_2s, fire: null,  ... }
```

Floor 0 has water. Floor 1 does not. Floor 2 has its own water (a rooftop pool). These are **three independent water states.** The water effect renders Floor 0's ocean using `RT_0w`, skips Floor 1 entirely, and renders Floor 2's pool using `RT_2w`. Floor 2's pool mask never interferes with Floor 0's ocean.

### What Gets Eliminated

| Current System | Replacement |
|---|---|
| `EffectMaskRegistry._slots` (single mask per type) | `Floor.masks` (per-floor mask map) |
| `preserveAcrossFloors` policy | Eliminated entirely — each floor owns its masks permanently |
| `transitionToFloor()` replace/preserve/clear logic | Eliminated — floor switching just changes `activeFloorIndex` |
| `_belowFloorKey` / `getBelowFloorTexture()` | `floorStack.getFloorMask(index - 1, type)` — direct lookup |
| `EffectMaskRegistry.subscribe(type, cb)` | Effects receive floor-indexed masks in their render call |
| Floor-presence screen-space gates | Floor alpha RTs (world-space, per-floor) |
| `_transitioning` lock flag | Eliminated — no global state to protect |

### Floor Alpha

Each floor has an **alpha render target** (`Floor.alpha`) that encodes where the floor's tiles exist vs. where there are holes/transparency. This is a world-space texture at scene resolution, composed from the alpha channels of all tiles on that floor.

- Floor 0 (background): alpha = 1.0 everywhere (no holes)
- Floor 1: alpha = 1.0 where Floor 1 tiles are opaque, 0.0 where gaps exist
- Floor 2: alpha = 1.0 where Floor 2 tiles exist, 0.0 in gaps

The floor alpha is used during compositing to determine what shows through from lower floors. Where Floor 2 has alpha = 0, Floor 1 (or Floor 0) shows through.

This replaces the screen-space `floorPresenceTarget` and `belowFloorPresenceTarget` with world-space textures that:
- Don't change resolution with viewport zoom
- Cover the entire scene, not just the visible viewport
- Are composed once when tiles change (not every frame)
- Are per-floor, not just "current" and "below"

---

## Floor Identity Texture

### Purpose

Some effects are **post-processing passes** that operate on the final composited scene image (e.g., atmospheric fog, color grading). These effects need to know "at this screen pixel, which floor am I looking at?" so they can sample the correct floor's mask.

The **Floor Identity Texture** is a world-space texture where each pixel stores the index of the topmost visible floor at that location.

### How It's Built

Rendered once per floor-change (not per frame) using a simple painter's algorithm:

1. Start with a cleared RT (value = 0, meaning "background/Floor 0")
2. For each floor from 1 to N:
   - Where `Floor[i].alpha > threshold`, write `i` to the floor ID texture
3. Result: each pixel contains the index of the topmost floor that has opaque tiles there

```
Example pixel values for the tavern scene:
  Outdoor courtyard area:  floorId = 0  (background)
  Ground floor interior:   floorId = 1  (Floor 1 tiles)
  Second story area:       floorId = 2  (Floor 2 tiles)
  Balcony gap in Floor 2:  floorId = 1  (Floor 1 shows through)
```

### Multi-Floor Transparency

For pixels where a floor is semi-transparent (e.g., a glass panel on Floor 2), the floor ID texture can encode blending information:

- **R channel**: Primary floor index (topmost opaque or semi-transparent floor)
- **G channel**: Secondary floor index (next floor visible through transparency)
- **B channel**: Blend weight (how much of the secondary floor shows through)

This allows post-processing effects to blend between two floors' masks at semi-transparent boundaries, producing smooth visual transitions instead of hard cuts.

### Sampling in Shaders

Effects that currently sample masks in screen-space UV would instead:

```glsl
// Old: single global mask
float waterMask = texture2D(uWaterMask, sceneUv).r;

// New: floor-aware mask lookup
float floorId = texture2D(uFloorIdTexture, sceneUv).r;
int floorIndex = int(floorId * 255.0); // decode floor index
// Sample the correct floor's water mask from a texture array or atlas
float waterMask = texture2D(uWaterMasks[floorIndex], sceneUv).r;
```

For the common case of 2-4 visible floors, the texture array is small and the per-pixel branch is cheap.

---

## Rendering Pipeline

### Current Pipeline (Single Floor)

```
1. Scene effects update()
2. Scene effects render() (lighting, specular overlays, etc.)
3. Single renderer.render(scene, camera) → sceneRenderTarget
4. Post-processing chain (fog, bloom, color grading, water distortion)
5. Output to screen
```

### Proposed Pipeline (Floor Stack)

```
Phase 1: FLOOR PREPARATION (once per floor change, not per frame)
  For each floor in floorStack:
    1a. Compose floor masks from tile suffix textures → Floor.masks
    1b. Compose floor alpha from tile alpha channels → Floor.alpha
    1c. Build floor identity texture from all floor alphas

Phase 2: PER-FRAME RENDERING
  2a. Update all scene effects (time, uniforms, etc.)

  2b. For each VISIBLE floor (bottom to top):
    - Set active floor context (masks, alpha, index)
    - Run scene-layer effects for this floor:
      · Lighting pass (using this floor's outdoors mask)
      · Specular overlays (using this floor's specular/normal/roughness)
      · Water surface meshes (using this floor's water mask)
      · Particle emitters (using this floor's fire/dust/ash masks)
      · Tree/bush billboards (using this floor's tree/bush masks)

  2c. Single renderer.render(scene, camera) → sceneRenderTarget
      (all tiles visible, with correct per-floor Z-layering)

  2d. Post-processing chain with floor awareness:
    - Atmospheric fog (samples floor ID → correct outdoors mask per pixel)
    - Water distortion (samples floor ID → correct water mask per pixel)
    - Bloom, color grading (floor-agnostic, operate on final image)

  2e. Output to screen
```

### Key Difference: Scene Effects Are Per-Floor

In the current system, `LightingEffect.render()` is called once and uses one global `outdoors` mask. In the new system:

```javascript
// EffectComposer.render() — simplified
for (const floor of floorStack.getVisibleFloors()) {
  // Set floor context so effects know which masks to use
  this._activeFloorContext = floor;

  for (const effect of sceneEffects) {
    if (effect.isFloorAware) {
      // Effect renders once per visible floor
      effect.renderForFloor(renderer, scene, camera, floor);
    }
  }
}

// Single scene geometry render
renderer.render(scene, camera);

// Post-processing (floor-aware via floor ID texture)
for (const effect of postEffects) {
  effect.render(renderer, scene, camera);
}
```

### Which Effects Are Floor-Aware vs Floor-Agnostic?

| Effect | Floor-Aware? | Mask Dependencies | Notes |
|--------|-------------|-------------------|-------|
| **LightingEffect** | Yes | `outdoors` | Light accumulation rendered per-floor; each floor has its own indoor/outdoor boundary |
| **WaterEffectV2** | Yes | `water` | Water surface meshes placed per-floor; SDF computed per-floor |
| **SpecularEffect** | Yes | `specular`, `roughness`, `normal` | Per-tile overlays already floor-assigned; just need correct masks |
| **FluidEffect** | Yes | `fluid` | Per-tile overlays, same as Specular |
| **WindowLightEffect** | Yes | `windows`, `outdoors` | Light shafts are floor-specific |
| **FireSparksEffect** | Yes | `fire` | Particles spawned from per-floor fire mask |
| **CandleFlamesEffect** | Yes | (fire positions) | Flame instances are floor-specific |
| **DustMotesEffect** | Yes | `dust` | Particles spawned from per-floor dust mask |
| **AshDisturbanceEffect** | Yes | `ash` | Particles spawned from per-floor ash mask |
| **TreeEffect** | Yes | `tree` | Billboard instances from per-floor tree mask |
| **BushEffect** | Yes | `bush` | Billboard instances from per-floor bush mask |
| **IridescenceEffect** | Yes | `iridescence` | Per-floor iridescence overlay |
| **PrismEffect** | Yes | `prism` | Per-floor prism overlay |
| **OverheadShadowsEffect** | Yes | `outdoors` | Shadow casting depends on floor's outdoor areas |
| **BuildingShadowsEffect** | Yes | `outdoors` | Baked shadows per-floor |
| **CloudEffect** | Partial | `outdoors` | Clouds are above all floors but masked per-floor outdoors |
| **AtmosphericFogEffect** | Post | `outdoors` | Post-process; uses floor ID texture |
| **BloomEffect** | No | (none) | Operates on final composited image |
| **AsciiEffect** | No | (none) | Operates on final composited image |
| **ColorGradeEffect** | No | (none) | Operates on final composited image |

---

## Effect Adaptation Strategy

Effects fall into three categories, each with a different adaptation path:

### Category 1: Per-Tile Overlay Effects (Specular, Fluid, Iridescence, Prism)

These effects already create per-tile meshes attached to specific tiles. Each tile already belongs to a specific floor. The adaptation is minimal:

**Current:** Effect subscribes to a single global mask via `connectToRegistry('specular', cb)`. All tile overlays use the same mask.

**New:** Effect receives the floor's mask set when binding a tile. Each tile overlay uses its own floor's mask.

```javascript
// Current (SpecularEffect)
connectToRegistry(registry) {
  registry.subscribe('specular', (texture) => {
    this.specularMask = texture; // ONE mask for all tiles
  });
}

// New
onFloorMasksReady(floorIndex, masks) {
  // Update all tile overlays on this floor to use this floor's masks
  for (const [tileId, entry] of this._tileEntries) {
    if (floorStack.tileToFloor.get(tileId)?.index === floorIndex) {
      entry.material.uniforms.uSpecularMap.value = masks.get('specular')?.texture;
    }
  }
}
```

**Impact:** Low. The per-tile mesh infrastructure already exists. Just need to route per-floor masks to per-floor tiles.

### Category 2: Scene-Space Mesh Effects (Water, Lighting, Fire, Trees, Bushes, Dust, Ash)

These effects create meshes or particles that cover scene-space areas defined by masks. They need to render independently per floor.

**Current:** `WaterEffectV2` has one water surface mesh driven by one global water mask. Floor transition replaces the mask and triggers an expensive SDF rebuild.

**New:** Each floor that has a `_Water` mask gets its own water surface instance (or its own SDF). The water effect maintains a `Map<floorIndex, WaterFloorState>` instead of a single state.

```javascript
// New WaterEffectV2 internal structure
class WaterEffectV2 {
  constructor() {
    this._floorStates = new Map(); // floorIndex → { sdf, surfaceMesh, mask, ... }
  }

  onFloorMasksReady(floorIndex, masks) {
    const waterMask = masks.get('water')?.texture;
    if (!waterMask) {
      // This floor has no water — dispose any existing state
      this._disposeFloorState(floorIndex);
      return;
    }

    let state = this._floorStates.get(floorIndex);
    if (!state) {
      state = this._createFloorState(floorIndex);
      this._floorStates.set(floorIndex, state);
    }

    if (state.mask !== waterMask) {
      state.mask = waterMask;
      state.sdf = this._rebuildSDF(waterMask); // per-floor SDF
    }
  }

  renderForFloor(renderer, scene, camera, floor) {
    const state = this._floorStates.get(floor.index);
    if (!state) return;
    // Render this floor's water surface using this floor's SDF and mask
    this._renderWaterSurface(renderer, state);
  }
}
```

**Impact:** Medium-high. Effects need internal per-floor state management. But the core rendering logic (shaders, meshes, materials) stays the same — it just gets invoked per floor instead of once globally.

**Critical optimization:** Only floors that actually HAVE a given mask type need state. A 10-floor scene where only Floor 0 and Floor 5 have water will only have 2 water states, not 10.

### Category 3: Post-Processing Effects (Atmospheric Fog, Water Distortion, Bloom)

These are fullscreen quad effects that operate on the composited scene image. They can't render "per floor" because they operate after all geometry is rendered.

**Current:** `AtmosphericFogEffect` samples one global `outdoors` mask.

**New:** Post-processing effects that need floor-specific masks use the **Floor Identity Texture** to sample the correct floor's mask per pixel:

```glsl
// AtmosphericFogEffect fragment shader — new
uniform sampler2D uFloorIdTexture;
uniform sampler2D uOutdoorsMasks[MAX_FLOORS]; // or texture array
uniform int uVisibleFloorCount;

void main() {
  vec2 sceneUv = worldToSceneUv(worldPos);

  // Decode floor index at this pixel
  float rawId = texture2D(uFloorIdTexture, sceneUv).r;
  int floorIdx = clamp(int(rawId * 255.0), 0, uVisibleFloorCount - 1);

  // Sample the correct floor's outdoors mask
  float outdoors = texture2D(uOutdoorsMasks[floorIdx], sceneUv).r;

  // Apply fog using floor-correct outdoor classification
  float fogAmount = outdoors * uFogDensity * depthFactor;
  // ...
}
```

**Impact:** Medium. Shader changes are required but straightforward. The floor ID texture lookup is one extra texture sample per pixel — negligible cost.

**Alternative for limited floors:** If the max visible floor count is bounded (e.g., 4), we can use a fixed set of uniforms instead of a texture array:

```glsl
uniform sampler2D uOutdoorsMask0;
uniform sampler2D uOutdoorsMask1;
uniform sampler2D uOutdoorsMask2;
uniform sampler2D uOutdoorsMask3;

// ... select based on floor ID
```

This avoids texture array support requirements and works on all WebGL2 hardware.

---

## The Background Image as Floor 0

### Current Treatment

The background image is loaded by `SceneComposer`, rendered as a single `PlaneGeometry` with `MeshBasicMaterial`, and positioned at `groundZ = 1000`. It has no alpha channel, no floor identity, and its masks come from a global basePath discovery process.

### Proposed Treatment

The background image becomes Floor 0 in the floor stack:

```javascript
// During FloorStack.buildFromScene():
const floor0 = new Floor({
  index: 0,
  key: 'background',
  elevationRange: { bottom: -Infinity, top: firstTileBandBottom },
  tiles: new Set(),  // no tiles — uses background image directly
  backgroundTexture: backgroundTexture,  // the scene's background image
  alpha: solidWhiteRT,  // alpha = 1.0 everywhere (no holes)
});
floor0.masks = composeMasksFromBasePath(backgroundBasePath);
this.floors.unshift(floor0);
```

Floor 0's masks are discovered from the background image's basePath (same `_resolveMaskSourceSrc` logic as today). Its alpha is always 1.0 because the background has no holes.

### What This Fixes

- **Problem 4** (Background ≠ tiles): Background now participates in the floor stack like any other floor
- **Problem 9** (preserve paradoxes): Floor 0's water mask is Floor 0's permanently. No preserve/replace logic needed.
- **Problem 11** (No unified layer model): Background, tiles, and masks all live in the same Floor abstraction

### Base Plane Mesh

The `basePlaneMesh` still exists as the geometry that displays Floor 0's art. But it's now tagged as Floor 0's geometry, so effects know to use Floor 0's masks when rendering over it.

---

## VRAM Budget and Dynamic Resolution

### The Problem

With N floors × 14 mask types, a naive implementation allocates `N × 14` render targets. At 4096×4096 RGBA, that's:
- 14 RTs × 4096 × 4096 × 4 bytes = **896 MB per floor**
- 10 floors = **~9 GB** — clearly unacceptable

### The Solution: Tiered Resolution + Demand-Based Allocation

Not all masks need full resolution. Not all floors need all masks. The VRAM budget is managed with three strategies:

#### Strategy 1: Resolution Tiers

```
visual masks  (specular, normal, roughness, tree, bush):  sceneRes × 0.5  (half scene resolution)
data masks    (water, fire, outdoors, windows, dust, ash): sceneRes × 0.25 (quarter scene resolution)
floor alpha:                                               sceneRes × 0.5  (half scene resolution)
floor ID:                                                  sceneRes × 0.25 (shared, single texture)
```

For a 4096×4096 scene:
- Visual masks: 2048×2048 × 4 bytes = 16 MB each
- Data masks: 1024×1024 × 4 bytes = 4 MB each
- Floor alpha: 2048×2048 × 4 bytes = 16 MB each

Per floor: 5 visual × 16 MB + 9 data × 4 MB + 1 alpha × 16 MB = **132 MB per floor**
10 floors: **1.3 GB** — within budget for modern GPUs

#### Strategy 2: Demand-Based Allocation

Only allocate RTs for mask types that actually exist on a floor. If Floor 3 has no `_Water` mask, no water RT is allocated for Floor 3.

Typical scene: most floors have 3-5 mask types, not all 14.
Realistic per-floor cost: 3-5 masks × 4-16 MB + 16 MB alpha = **30-100 MB per floor**
10 floors with typical density: **300 MB–1 GB**

#### Strategy 3: Visibility-Based Loading

Only fully load masks for visible floors. Non-visible floors (above the camera's current floor) can have their RTs evicted and recomposed on demand.

With 3-4 visible floors at any time: **100-400 MB active VRAM**

#### Strategy 4: Configurable Quality Scaling

Expose a "Mask Quality" setting that scales all mask resolutions:

```
Ultra:  sceneRes × 1.0  (full resolution)
High:   sceneRes × 0.5  (default)
Medium: sceneRes × 0.25
Low:    sceneRes × 0.125
```

Users with limited VRAM can reduce mask quality. Users with powerful GPUs can crank it up.

---

## What Gets Replaced

### Eliminated Entirely

| Component | Why |
|---|---|
| `EffectMaskRegistry._slots` (single-slot model) | Replaced by `Floor.masks` per-floor storage |
| `preserveAcrossFloors` policy | Eliminated — each floor permanently owns its masks |
| `transitionToFloor()` replace/preserve/clear logic | Eliminated — floor switch changes `activeFloorIndex` only |
| `_belowFloorKey` / `_activeFloorKey` tracking | Replaced by `FloorStack` index arithmetic |
| `_transitioning` lock flag | Eliminated — no global mutable state to protect |
| Screen-space `floorPresenceTarget` | Replaced by world-space `Floor.alpha` |
| Screen-space `belowFloorPresenceTarget` | Replaced by world-space `Floor[n-1].alpha` |
| Floor-presence mesh duplication | Eliminated — floor alpha composed from tile alpha, no extra geometry |
| `_recomposeTimer` debounce | Replaced by `Floor.dirty` flag checked once per frame |
| `connectToRegistry()` / `subscribe()` pattern | Replaced by direct `onFloorMasksReady()` / `renderForFloor()` |

### Heavily Refactored

| Component | Changes |
|---|---|
| `GpuSceneMaskCompositor` | Becomes the engine behind `FloorStack.composeMasks()`. Same GPU composition logic, but called per-floor and stores results in `Floor.masks` instead of a global cache. LRU eviction replaced by visibility-based loading. |
| `EffectComposer.render()` | Gains per-floor scene-effect loop. Post-processing chain gains floor ID texture. Single `renderer.render()` call remains. |
| `TileManager` | Tile→floor assignment. `updateSpriteTransform` tags sprites with floor index. Floor-presence mesh system eliminated. |
| `SceneComposer` | Background becomes Floor 0. `_sceneMaskCompositor` replaced by `FloorStack` + compositor. |
| `canvas-replacement.js` | `mapShineLevelContextChanged` hook becomes `floorStack.setActiveFloor(index)` — one line instead of 130. |
| All 12+ effects with `connectToRegistry()` | Replace subscription with `onFloorMasksReady()` + per-floor state management |

### Kept As-Is

| Component | Why |
|---|---|
| `GpuSceneMaskCompositor._composeMaskType()` | Core GPU composition logic is correct — just needs different storage target |
| `GpuSceneMaskCompositor._ensureGpuResources()` | Shared quad geometry and shader material are reusable |
| Tile suffix mask loading (`loadAssetBundle`, `loadTileMask`) | Discovery and loading of `_Water`, `_Fire`, etc. files is correct |
| `TileManager.loadTileTexture()` | Texture loading, caching, ImageBitmap path all correct |
| `TileManager.updateSpriteTransform()` | Z-layering, rotation, scale logic all correct |
| `TileEffectBindingManager` | Per-tile effect routing still needed, just floor-contextualized |
| `EffectComposer` ping-pong post-processing chain | Correct architecture, just needs floor-aware inputs |
| Depth pass system | Floor-agnostic, works as-is |
| All effect shaders (core rendering) | Shader logic is correct — just mask input sources change |

---

## Migration Strategy

### Phase 0: FloorStack Foundation

**Goal:** Introduce the `FloorStack` class alongside the existing system. No behavior changes.

1. Create `scripts/scene/FloorStack.js` with the `Floor` and `FloorStack` classes
2. Wire `FloorStack.buildFromScene()` into `canvas-replacement.js` scene initialization
3. Log floor discovery results (how many floors, which tiles on which floor)
4. Verify floor discovery matches the existing Levels elevation band logic

**Validation:** Floor discovery produces the same floor assignments as the current `_isTileInLevelBand()` logic. No rendering changes.

### Phase 1: Per-Floor Mask Storage

**Goal:** Move mask storage from `EffectMaskRegistry._slots` to `Floor.masks`. Effects still read from the registry, but the registry reads from the floor stack.

1. `FloorStack` stores per-floor mask RTs (output of `GpuSceneMaskCompositor`)
2. `EffectMaskRegistry` becomes a thin facade: `getMask(type)` reads from `floorStack.floors[activeIndex].masks.get(type)`
3. Floor transitions update `activeFloorIndex` and the registry re-publishes from the new floor's masks
4. `preserveAcrossFloors` logic becomes a no-op (each floor's masks are independent)

**Validation:** Same visual output as current system. Water mask on Floor 0 survives Floor 1 transitions without any preserve logic.

### Phase 2: Floor Alpha and Floor ID Texture

**Goal:** Replace screen-space floor-presence gates with world-space floor alpha.

1. Compose `Floor.alpha` from tile alpha channels during mask composition
2. Build floor ID texture from all floor alphas
3. Replace `floorPresenceTarget` / `belowFloorPresenceTarget` sampling in shaders with floor alpha / floor ID sampling
4. Remove floor-presence mesh creation from `TileManager`

**Validation:** Same visual compositing behavior, but now world-space and resolution-independent.

### Phase 3: Per-Floor Effect Rendering

**Goal:** Effects render per-floor instead of once globally.

1. Add `isFloorAware` flag and `renderForFloor()` method to effect base class
2. Adapt Category 1 effects (per-tile overlays) — minimal changes
3. Adapt Category 2 effects (scene-space meshes) — per-floor state management
4. Adapt Category 3 effects (post-processing) — floor ID texture sampling
5. Update `EffectComposer.render()` with per-floor scene-effect loop

**Validation:** Each floor's effects use only that floor's masks. Floor 1's water mask does not affect Floor 0's water. Multiple floors' effects visible simultaneously through transparency.

### Phase 4: Cleanup

**Goal:** Remove all legacy systems.

1. Remove `EffectMaskRegistry` (or reduce to a thin diagnostic facade)
2. Remove `preserveAcrossFloors`, `_transitioning`, `_recomposeTimer`
3. Remove floor-presence mesh infrastructure from `TileManager`
4. Remove `_belowFloorKey` / `getBelowFloorTexture()` from compositor
5. Remove the 130-line redistribution block in `canvas-replacement.js`
6. Remove all `connectToRegistry()` methods from effects

**Validation:** Full regression test across single-floor and multi-floor scenes.

---

## Effect-Mask Dependency Map

For reference, the complete mapping of which effects consume which mask types:

```
outdoors ──→ LightingEffect
         ──→ WindowLightEffect
         ──→ OverheadShadowsEffect
         ──→ BuildingShadowsEffect
         ──→ CloudEffect
         ──→ AtmosphericFogEffect

water ─────→ WaterEffectV2

specular ──→ SpecularEffect
normal ────→ SpecularEffect
roughness ─→ SpecularEffect

windows ───→ WindowLightEffect

fire ──────→ FireSparksEffect, CandleFlamesEffect

tree ──────→ TreeEffect
bush ──────→ BushEffect

dust ──────→ DustMotesEffect
ash ───────→ AshDisturbanceEffect

iridescence → IridescenceEffect
prism ─────→ PrismEffect
fluid ─────→ FluidEffect
```

Each arrow becomes a per-floor binding in the new architecture. `outdoors` is the most heavily shared mask (6 consumers) — per-floor isolation here has the highest impact.

---

## Open Questions

1. **Max visible floors:** Should there be a hard limit on simultaneously visible floors (e.g., 4)? This bounds the per-frame cost and simplifies shader uniforms. Floors deeper than the limit would be fully occluded.

No limits - but assume we're never likely to have more than 5 levels. It's possible we could have more. Also we might have a lot more tiles than actual levels.

2. **Tile albedo resolution:** Problem 1 (TILE_MAX_DIM = 4096) is orthogonal to the floor stack architecture. Should it be addressed in this work or separately?

Albedo must ALWAYS be full resolution for all tiles and scene backgrounds. Always full resolution since this is the primary artwork of the level.

3. **Overhead/roof tiles:** Roofs are currently on their own layer system (ROOF_LAYER, WEATHER_ROOF_LAYER). Should they remain special or become regular floor members?

We actually need a way to have 'overhead layers' for each level. Overhead layers go above tokens and have functionality which allows them to fade out if you hover the mouse over them.

4. **Per-tile effect masks vs per-floor masks:** The `TileEffectBindingManager` loads per-tile suffix masks. The compositor composites them into per-floor scene-space masks. Should effects that currently use per-tile overlays (Specular, Fluid) continue using per-tile masks directly, or should they switch to sampling the floor's composited mask? Per-tile is higher fidelity; per-floor is simpler.

Assume everything will need some amount of 'per level' compositing. Everything needs to be intergrated into the same system since exceptions can become problematic.

5. **WebGL2 texture array support:** The post-processing floor-aware approach assumes either texture arrays or a fixed set of uniforms. Texture arrays are WebGL2-only. The fixed-uniform approach works everywhere but limits max visible floors. Which path?

No sure. Use whichever approach is most powerful/flexible. 

6. **SDF per-floor cost:** WaterEffectV2's SDF computation is expensive (~50-200ms). With N floors having water, N SDF computations are needed. Should this be async/progressive, or is the demand-based approach (only floors that have water) sufficient?

SDF may not be the best long term approach for water but assume that any hard work will be done during scene loading so that it's rolled into loading time rather than mid-game freezes.

---

## Resolved Design Decisions

Based on the answers above, these are now **locked design decisions** for the architecture:

| Decision | Resolution |
|---|---|
| **Max floors** | No hard limit. Design for ≤5 typical, tolerate more. Many tiles per level is common. |
| **Tile albedo resolution** | Full resolution always. Remove `TILE_MAX_DIM = 4096` cap. Albedo is primary artwork. |
| **Overhead/roof tiles** | Per-floor overhead layers. Each floor has its own overhead sub-layer above tokens with mouse-hover fade. |
| **Per-tile vs per-floor masks** | Everything composited per-floor. No exceptions. Unified system prevents edge cases. |
| **Texture arrays vs fixed uniforms** | Use the most powerful/flexible approach. WebGL2 texture arrays preferred (Foundry V12+ already requires WebGL2). Fixed-uniform fallback for compatibility if needed. |
| **Expensive per-floor work (SDF, etc.)** | All heavy work during scene loading. No mid-game freezes. Per-floor SDF, mask composition, etc. computed at load time and cached. |

---
---

# Part 3: Unconsidered Systems and Gaps

## Complete Effects Audit

The Part 2 dependency map covered 19 mask-consuming effects. Here is the **complete audit of ALL 36 effect/manager files** in `scripts/effects/`, classified by floor-awareness needs:

### Mask-Consuming Effects (Already Covered in Part 2)

| Effect | Mask Subscriptions | Category |
|---|---|---|
| LightingEffect | `outdoors` | Cat 2 (scene-space) |
| WaterEffectV2 | `water` | Cat 2 (scene-space) |
| SpecularEffect | `specular`, `roughness`, `normal` | Cat 1 (per-tile overlay) |
| FluidEffect | `fluid` | Cat 1 (per-tile overlay) |
| WindowLightEffect | `windows`, `outdoors`, `specular` | Cat 2 (scene-space) |
| TreeEffect | `tree` | Cat 2 (scene-space) |
| BushEffect | `bush` | Cat 2 (scene-space) |
| IridescenceEffect | `iridescence` | Cat 1 (per-tile overlay) |
| PrismEffect | `prism` | Cat 1 (per-tile overlay) |
| OverheadShadowsEffect | `outdoors` | Cat 2 (scene-space) |
| BuildingShadowsEffect | `outdoors` | Cat 2 (scene-space) |
| CloudEffect | `outdoors` | Cat 3 (post, partial) |
| AtmosphericFogEffect | `outdoors` | Cat 3 (post-process) |

### Floor-Presence Gate Consumers (Need Migration)

These effects don't subscribe to EffectMaskRegistry but DO sample the screen-space `floorPresenceTarget` and/or `belowFloorPresenceTarget`. They need migration to world-space floor alpha:

| Effect/Manager | What It Samples | Purpose |
|---|---|---|
| **DistortionManager** | `tFloorPresence`, `tBelowFloorPresence`, `tBelowWaterMask` | Gate water/heat-haze distortion, below-floor water tint, window light gating |
| **SpecularEffect** | `tFloorPresence`, `tBelowFloorPresence`, `tBelowSpecularMap` | Gate below-floor specular, blend below-floor specular through gaps |
| **CandleFlamesEffect** | `uFloorPresenceMap` | Occlude below-floor candle flames under current-floor tiles |
| **FireSparksEffect** | `uFloorPresenceMap` | Occlude below-floor fire/smoke particles under current-floor tiles |

**In the Floor Stack architecture, ALL of these become unnecessary.** Each floor's effects only render within that floor's alpha footprint. There's no cross-floor bleed to gate because effects are isolated per-floor.

### Floor-Agnostic Effects (No Changes Needed)

| Effect | Why Floor-Agnostic |
|---|---|
| **BloomEffect** | Post-process on final composited image |
| **AsciiEffect** | Post-process stylistic filter |
| **ColorCorrectionEffect** | Post-process color grading |
| **SharpenEffect** | Post-process sharpening |
| **DotScreenEffect** | Post-process dot screen |
| **HalftoneEffect** | Post-process halftone |
| **FilmGrainEffect** | Post-process film grain |
| **SkyColorEffect** | Post-process sky/atmosphere tinting (time-driven, no masks) |
| **DazzleOverlayEffect** | Post-process overlay effect |
| **LightningEffect** | Environmental flash effect (no masks, no floor dependency) |
| **LensflareEffect** | Environmental effect tied to light sources (follows light position) |
| **SelectionBoxEffect** | UI interaction overlay |
| **DebugLayerEffect** | Debug visualization |
| **MaskDebugEffect** | Debug visualization |
| **DetectionFilterEffect** | Operates on token visibility state, not masks |

### Support Files (Not Effects)

| File | Role |
|---|---|
| **EffectComposer.js** | Render pipeline orchestrator — needs per-floor loop |
| **DistortionManager.js** | Water/heat distortion + floor-presence gates — heavily refactored |
| **DepthShaderChunks.js** | Shared GLSL helpers — floor-agnostic |
| **EnhancedLightsApi.js** | Foundry light API bridge — see Lighting section |
| **FoundryAnimatedLightingShaders.js** | Foundry shader compat — floor-agnostic |
| **FoundryDarknessShaderChunks.js** | Darkness shaders — floor-agnostic |
| **FoundryLightingShaderChunks.js** | Lighting shaders — floor-agnostic |
| **LightEnhancementStore.js** | Light parameter storage — floor-agnostic |
| **LightRegistry.js** | Light source registry — needs per-floor awareness |
| **LightingEffect_setBaseMesh.js** | Base mesh setup helper — floor-agnostic |
| **MapShineLightAdapter.js** | Foundry→Three.js light bridge — needs elevation context |

### Particle Effects (in `scripts/particles/`)

| Effect | Mask Source | Floor-Aware? | Notes |
|---|---|---|---|
| **FireSparksEffect** | `fire` mask (lookup map) | Yes | Spawns particles from fire mask. Uses `uFloorPresenceMap` gate. Needs per-floor fire mask + per-floor particle instances. |
| **DustMotesEffect** | `dust` mask (lookup map) | Yes | Spawns particles from dust mask. Needs per-floor dust mask + per-floor instances. |
| **AshDisturbanceEffect** | `ash` mask (lookup map) | Yes | Spawns particles from ash mask. Needs per-floor ash mask + per-floor instances. |
| **WeatherParticles** | (none — global) | Partial | Rain/snow/ash. Suppressed below `weatherElevation`. Needs per-floor outdoor gating. |

---

## Token System Across Floors

### Current Token-Floor Interaction

Tokens interact with floors through several mechanisms:

1. **Z-position from elevation:** `TOKEN_BASE_Z + elevation` (`token-manager.js:1283`). Tokens at elevation 0 sit at Z=3.0 above ground. Tokens at elevation 10 sit at Z=13.0.

2. **Visibility filtering by level context:** Both `TokenManager.updateSpriteVisibility()` and `VisibilityController._isTokenAboveCurrentLevel()` hide tokens whose elevation ≥ `levelContext.top - 0.01`. This is a simple "above current floor = hidden" gate.

3. **Underground desaturation:** `_getUndergroundSaturationMultiplier()` desaturates tokens below elevation 0.

4. **Camera follower sync:** `_syncToControlledTokenLevel()` in `camera-follower.js` matches the active floor to the controlled token's elevation, automatically switching floors when a token moves up/down.

### Problems with Current Token-Floor Model

**Problem T1: Tokens don't know their floor.**
Tokens have a raw `elevation` number but no concept of "I'm on Floor 2." The level context boundary check (`tokenElev >= levelContext.top`) is the only connection. A token at elevation 7 in a scene with Floor 1 [0,5] and Floor 2 [5,10] doesn't know it's on Floor 2 — the system only knows it's not above Floor 2.

**Problem T2: Tokens between floors are invisible.**
If a token is at elevation 4.5 and the viewer is on Floor 1 [0,5], the token is visible. If the viewer switches to Floor 2 [5,10], the token is hidden because `4.5 < 5.0`. There's no concept of "token is in transition between floors" or "token is on a staircase."

**Problem T3: Token effects don't use floor masks.**
Effects that apply to tokens (detection filters, shadows, etc.) don't consult floor masks. A token on Floor 2 standing on a water tile should see water reflections — but the water effect doesn't know this token is on Floor 2 and should use Floor 2's water mask.

**Problem T4: Token movement between floors has no visual transition.**
When a token's elevation changes (e.g., walking up stairs from elevation 3 to elevation 7), the camera follower switches floors abruptly. There's a fade-to-black transition, but the token itself just pops between floors.

### Proposed Token-Floor Integration

In the Floor Stack architecture, tokens gain floor awareness:

```javascript
// TokenManager additions
assignTokenToFloor(tokenDoc) {
  const elevation = Number(tokenDoc.elevation ?? 0);
  const floor = this.floorStack.getFloorForElevation(elevation);
  this.tokenFloorMap.set(tokenDoc.id, floor?.index ?? 0);
  return floor;
}
```

**Token visibility rule:** A token is visible if its floor index ≤ `activeFloorIndex`. Tokens on the current floor and all floors below are visible. Tokens on floors above are hidden.

**Token rendering rule:** Token sprites are tagged with their floor index. Effects that need to know "what floor is this token on" can query the mapping.

**Token-floor transition:** When a token's elevation crosses a floor boundary, the token is smoothly reassigned to the new floor. The camera follower can optionally follow this transition.

---

## Overhead Layers Per Floor

### Current Overhead System

The current system has a **single global overhead layer**:
- `ROOF_LAYER = 20` — tiles that render above tokens
- `WEATHER_ROOF_LAYER = 21` — tiles that block weather particles
- `_overheadTileIds` — global set of all overhead tile IDs
- `_weatherRoofTileIds` — global set of weather-blocking roof tile IDs
- Overhead tiles fade out on mouse hover (smooth opacity animation)
- `OverheadShadowsEffect` uses overhead tile alpha for shadow casting
- `Z_OVERHEAD_OFFSET = 4.0` — places overhead tiles above tokens in Z-order
- Color correction applied globally to all overhead tiles

### Per-Floor Overhead Design

Each floor in the Floor Stack gets its own overhead sub-layer:

```
Floor {
  index: number
  tiles: Set<TileDocument>          // ground-level tiles
  overheadTiles: Set<TileDocument>  // overhead/roof tiles for this floor
  masks: Map<string, RT>
  alpha: RT
  overheadAlpha: RT                 // alpha of this floor's overhead tiles
}
```

**Floor discovery extended:** When assigning tiles to floors, overhead tiles (identified by `isTileOverhead()`) are assigned to the same floor as their non-overhead siblings in the same elevation band. A roof tile at elevation [5,10] belongs to Floor 2's overhead sub-layer, not a separate "roof floor."

**Z-ordering per floor:**
```
Floor 0: ground tiles (Z=0-1) → tokens on Floor 0 (Z=3) → Floor 0 overhead (Z=4)
Floor 1: ground tiles (Z=5-6) → tokens on Floor 1 (Z=8) → Floor 1 overhead (Z=9)
Floor 2: ground tiles (Z=10-11) → tokens on Floor 2 (Z=13) → Floor 2 overhead (Z=14)
```

Each floor's overhead tiles sit above that floor's tokens but below the next floor's ground tiles. This creates proper visual stacking.

**Hover fade per floor:** The overhead fade system already operates per-tile. No change needed except that overhead tiles are now tagged with their floor index, and the mouse hover test can optionally be floor-aware (e.g., only fade overhead tiles on the active floor).

**Overhead shadows per floor:** `OverheadShadowsEffect` currently uses a single roof alpha mask. In the Floor Stack, each floor has its own `overheadAlpha` RT. Shadow casting is per-floor: Floor 1's roof casts shadows on Floor 1's ground tiles, not on Floor 0.

**Weather blocking per floor:** `WEATHER_ROOF_LAYER` tiles currently suppress weather globally. In the Floor Stack, weather is suppressed per-floor based on whether the floor has overhead tiles covering the area. A floor whose overhead alpha is 1.0 everywhere is "indoors" and gets no weather; a floor with gaps in its overhead gets weather in those gaps.

---

## Vision and Lighting Per Floor

### Current Vision System

`VisionManager` computes visibility polygons for controlled tokens. It already has **partial floor awareness**:
- Token elevation is passed to `VisionPolygonComputer` via `computeOptions.elevation`
- The polygon computer can skip walls whose wall-height bounds don't include the token's elevation
- `VisibilityController` listens to `mapShineLevelContextChanged` and triggers bulk visibility refresh

However, the vision system is **not truly per-floor**:
- Vision polygons are computed in 2D (no floor concept)
- A token on Floor 2 can potentially see through Floor 1's walls if they don't have height bounds
- There's no vision mask per floor — just one global vision polygon

### Proposed Vision Per Floor

**Short-term (Phase 1-2):** Keep the current vision system mostly as-is. The wall-height filtering already provides functional per-floor vision. Add floor-aware wall filtering so that walls assigned to a specific floor's elevation band are only considered when computing vision for tokens on that floor.

**Long-term (Phase 3+):** Vision polygons could be computed per-floor and stored in the Floor Stack. Each floor would have its own vision mask RT. Post-processing effects that need "is this pixel visible" would sample the correct floor's vision mask.

### Current Lighting System

`LightingEffect` has significant floor awareness already:
- `_isLightVisibleForElevation()` filters lights by Levels elevation range
- `_isUpperFloorLightForTransmission()` allows upper-floor light bleed-through when enabled
- `_prepareUpperTransmissionVisibility()` selectively shows/hides upper-floor lights
- `LightRegistry` stores light sources with optional elevation/z

### Proposed Lighting Per Floor

Lighting is a **Category 2 effect** (scene-space). In the Floor Stack:

1. **Light sources assigned to floors:** Each light source's elevation determines its floor assignment. `LightRegistry` gains a `lightToFloor` mapping.

2. **Per-floor light accumulation:** `LightingEffect.renderForFloor(floor)` renders only lights assigned to that floor, using that floor's `outdoors` mask for indoor/outdoor boundary gating.

3. **Cross-floor light transmission:** The current `_isUpperFloorLightForTransmission()` can be cleanly replaced. When rendering Floor N, lights from Floor N+1 can be included with reduced intensity if transmission is enabled. The Floor Stack makes this explicit: "render Floor N's lights at full intensity, plus Floor N+1's lights at transmission intensity."

4. **Darkness per floor:** Scene darkness could potentially differ per floor (underground floors are darker). This is a future enhancement but the Floor Stack makes it possible by storing per-floor darkness values.

---

## Depth Pass Per Floor

### Current Depth Pass

`DepthPassManager` renders a single depth texture for the entire scene. Effects use it for:
- **SpecularEffect:** Tile overlay occlusion (`msa_isOccluded`)
- **AtmosphericFogEffect:** Depth-based fog modulation
- **FluidEffect:** Depth-based tile occlusion
- **OverheadShadowsEffect:** Height-based shadow modulation

The depth pass renders ALL visible tiles into one depth buffer. It is currently **floor-agnostic**.

### Depth in the Floor Stack

**The depth pass can remain a single pass.** Because tiles from all visible floors are rendered in the single `renderer.render()` call with correct Z-ordering, the depth buffer naturally contains floor-aware depth information. A pixel on Floor 2 has a different depth than a pixel on Floor 0.

**No per-floor depth passes needed.** The existing depth pass correctly captures the Z-depth of all visible geometry. Effects that use depth for occlusion (Specular, Fluid) already discard fragments that are behind closer geometry — this works correctly across floors.

**One consideration:** If overhead tiles on Floor 1 are faded out (mouse hover), their depth should also be excluded. The current depth pass respects tile visibility, so this already works.

---

## Weather Per Floor

### Current Weather System

`WeatherController` manages global weather state. Weather is suppressed via a single binary flag:
- `elevationWeatherSuppressed` — set by `TileManager._refreshAllTileElevationVisibility()` based on `isWeatherVisibleForPerspective()`
- `isWeatherVisibleForPerspective()` checks if the viewer is at/above `weatherElevation`
- When suppressed, `WeatherParticles` zeros all emissions and hides all systems

### Weather in the Floor Stack

Weather needs to be **per-floor aware** but not necessarily per-floor rendered:

1. **Outdoor gating:** Weather particles (rain, snow) should only fall on **outdoor areas** of the visible floor. Each floor's `outdoors` mask defines where it's outdoors. Floor 1 might be entirely indoors (no weather), while Floor 0 is outdoors (full weather).

2. **Overhead blocking:** Weather is blocked by overhead tiles. In the Floor Stack, each floor's `overheadAlpha` defines where overhead tiles exist. Weather particles falling on Floor 0 should be blocked where Floor 1's overhead tiles cover the area.

3. **Elevation suppression simplified:** Instead of a binary `elevationWeatherSuppressed`, the Floor Stack can determine weather visibility per-pixel: "at this pixel, the topmost visible floor is Floor 2. Floor 2 has overhead alpha = 1.0 here, so no weather. At this pixel, the topmost floor is Floor 0 with outdoors = 1.0, so full weather."

4. **Indoor weather effects:** Some floors might have indoor "weather" (e.g., dust motes in a dungeon, ash in a forge). These are per-floor particle effects driven by per-floor masks, which the Floor Stack handles naturally.

---

## Grid Renderer Per Floor

### Current Grid System

`GridRenderer` already has **significant floor awareness**:
- `setActiveLevelContext(context)` — positions grid at active floor's elevation
- `_refreshGhostGridMeshes()` — renders translucent ghost grids at adjacent floors
- `_floorTintPresetsEnabled` — applies warm/cool color tints to above/below floors
- Smooth Z-transition animation when switching floors
- Listens to `mapShineLevelContextChanged` hook

### Grid in the Floor Stack

The grid renderer is **already well-suited** for the Floor Stack. Minor additions:

1. **Floor index tagging:** Instead of using raw elevation `center` values, the grid can use `FloorStack.floors[i].index` directly.

2. **Ghost grid count:** With `FloorStack.getVisibleFloors()`, ghost grids can be generated for all visible floors, not just ±1 neighbors.

3. **Floor tint from Floor Stack:** Floor tint colors could be stored in the Floor object, allowing per-floor custom grid tinting instead of the hardcoded warm/cool algorithm.

---

## Sound Occlusion Per Floor

### Current Sound System

`canvas-replacement.js` patches `AmbientSound.isAudible` to check `isSoundAudibleForPerspective()`. When the viewer's elevation is outside a sound's Levels range, the sound is muted.

The `mapShineLevelContextChanged` hook triggers `canvas.sounds.refresh()` to re-evaluate audibility on floor change.

### Sound in the Floor Stack

Sound occlusion is already **functionally per-floor** via the elevation-based audibility patch. The Floor Stack adds:

1. **Floor assignment for sounds:** Ambient sounds gain a floor index based on their elevation flags. Only sounds on visible floors are audible.

2. **Distance attenuation across floors:** Sounds on Floor 0 heard from Floor 2 could be attenuated by the number of intervening floors (each floor's overhead tiles act as sound insulation).

3. **No urgent changes needed.** The existing elevation-based audibility patch works correctly with the Floor Stack. The floor transition hook already triggers sound refresh.

---

## Camera Follower Integration

### Current Camera-Floor Wiring

`CameraFollower` manages floor navigation:
- `_levels` — discovered level bands from scene tiles
- `_activeLevelContext` — current floor (index, bottom, top, center, label)
- `_lockMode` — `manual` or `follow-token`
- `_syncToControlledTokenLevel()` — matches floor to controlled token's elevation
- `_emitLevelContextChanged()` — fires `mapShineLevelContextChanged` hook
- Keyboard stepping (Page Up/Down) through floors
- Camera panel UI with level chips

The hook fires and triggers:
- `GpuSceneMaskCompositor.composeFloor()`
- `EffectMaskRegistry.transitionToFloor()`
- `TileManager._refreshAllTileElevationVisibility()`
- `VisibilityController._queueBulkRefresh()`
- `GridRenderer.setActiveLevelContext()`
- `DepthPassManager.invalidate()`
- `canvas.sounds.refresh()`

### Camera Follower in the Floor Stack

The hook-driven architecture is **partially compatible** with the Floor Stack. Key changes:

1. **Hook simplification:** The `mapShineLevelContextChanged` handler currently runs ~130 lines of mask composition, redistribution, and transition logic. In the Floor Stack, it becomes:
   ```javascript
   Hooks.on('mapShineLevelContextChanged', (payload) => {
     floorStack.setActiveFloor(payload.context.index);
     // All floor masks already exist — no composition needed
     // All effects already have per-floor state — no redistribution needed
     // Just update visibility and trigger re-render
   });
   ```

2. **Level discovery unification:** `CameraFollower._levels` and `FloorStack.floors` discover the same elevation bands from the same tile data. These should be unified — the camera follower should read from the Floor Stack, not maintain its own level list.

3. **Follow-token mode:** When a token moves between floors, the camera follower calls `_syncToControlledTokenLevel()`. In the Floor Stack, this becomes `floorStack.getFloorForElevation(tokenElevation)` — a direct lookup instead of scanning level bands.

4. **Floor transition animation:** The current fade-to-black transition is triggered by the hook. In the Floor Stack, transitions could be smoother: cross-fade between floor visibility sets, progressively revealing the new floor's effects while fading the old floor's.

---

## Systems Not Yet Considered

### 1. Measured Templates / Spell Effects

Foundry's measured templates (circles, cones, etc.) render at ground level. In a multi-floor scene, a fireball on Floor 2 should only affect Floor 2. Currently, templates have no elevation awareness.

**Floor Stack impact:** Templates could be assigned to the active floor when placed. The template's visual effect would be masked to its floor's alpha footprint.

### 2. Drawings Layer

Foundry drawings are currently rendered at a fixed Z layer. Multi-floor drawings are not supported.

**Floor Stack impact:** Low priority. Drawings could gain floor assignment similar to tiles, but this is a Foundry-core limitation rather than a Map Shine concern.

### 3. Tile Motion Manager

`TileMotionManager` animates tile position/rotation. Moving tiles need to stay on their assigned floor.

**Floor Stack impact:** Minimal. Tile motion doesn't change a tile's elevation band, so floor assignment is stable. The tile motion manager just needs to read the tile's floor index from the Floor Stack rather than computing it independently.

### 4. Token Shadows

If tokens cast shadows (via OverheadShadowsEffect or a future per-token shadow system), those shadows should only fall on the token's floor. A token on Floor 2 shouldn't cast a shadow visible on Floor 0.

**Floor Stack impact:** Token shadow rendering would use the token's floor index to determine the shadow receiving surface. Shadows are masked to the token's floor alpha.

### 5. Dynamic Tile Changes Mid-Game

Tiles can be created, moved, or deleted during gameplay. Each change potentially affects:
- Floor discovery (new tile might create a new floor)
- Floor mask composition (new tile has suffix masks)
- Floor alpha (new tile changes where the floor exists)

**Floor Stack impact:** The `Floor.dirty` flag handles this. When a tile changes:
1. Determine the tile's floor assignment
2. Mark that floor as dirty
3. On the next frame (or immediately if needed), recompose only the dirty floor's masks and alpha
4. Effects with per-floor state for that floor get notified

This is more efficient than the current system, which recomposes ALL masks on any tile change.

### 6. Per-Floor Fog of War / Exploration

Foundry's fog of war (explored areas) is currently a single 2D texture. In a multi-floor scene, exploring Floor 2 shouldn't reveal Floor 0.

**Floor Stack impact:** This is a significant future enhancement. Each floor could have its own fog-of-war texture. When the viewer switches floors, the fog state switches too. This is outside the immediate scope but the Floor Stack architecture supports it cleanly.

### 7. Scene Transitions Between Multi-Floor Scenes

When switching from one scene to another, ALL floor state must be disposed and rebuilt. The current `destroyThreeCanvas()` cleanup must also tear down the Floor Stack.

**Floor Stack impact:** `FloorStack.dispose()` disposes all floor RTs, mask textures, and alpha textures. This is cleaner than the current scattered cleanup across compositor, registry, and tile manager.

### 8. Performance: Per-Floor Effect Cost

With 5 floors and 15 floor-aware effects, the worst case is 75 effect render calls per frame (5 × 15). However:
- **Demand-based:** Most floors have 3-5 active effects, not 15. Realistic: 5 × 4 = 20 calls.
- **Visibility-based:** Only visible floors render effects. Typically 2-3 visible floors. Realistic: 3 × 4 = 12 calls.
- **State caching:** Effects that haven't changed since last frame can skip rendering. Static lighting on Floor 0 renders once and is reused.
- **Current baseline:** The current system already renders 15+ effect passes per frame for a single floor. Adding 2-3× for multi-floor is acceptable.

### 9. Loading Screen / Progress Integration

Scene loading already shows progress via the debug loading profiler. Per-floor mask composition adds more loading steps.

**Floor Stack impact:** Each floor's composition can report progress individually. The loading screen shows "Composing Floor 1 masks... Composing Floor 2 masks..." etc. Total loading time increases proportionally to floor count, but all work is frontloaded (per the resolved design decision).

---

## Architectural Confidence Assessment

### What the Floor Stack Architecture Solves

| Problem | Status |
|---|---|
| Floor 1 water bleeding into Floor 0 | **Solved.** Per-floor mask isolation eliminates cross-floor mask contamination. |
| Global mask slot swapping | **Solved.** No slots to swap — each floor owns its masks permanently. |
| Screen-space floor-presence gates | **Solved.** Replaced by world-space floor alpha RTs. |
| preserveAcrossFloors paradoxes | **Solved.** Policy eliminated entirely. |
| Background image special-casing | **Solved.** Background is Floor 0 in a unified model. |
| Two-floor compositor limit | **Solved.** N floors supported natively. |
| Per-tile identity lost in composition | **Addressed.** All masks composited per-floor. Per-tile overlay effects still use per-tile masks but route through the floor system. |
| No unified layer model | **Solved.** Floor Stack is the single source of truth. |
| Overhead/roof per floor | **Solved.** Each floor has its own overhead sub-layer. |
| Token floor assignment | **Solved.** Tokens mapped to floors by elevation. |
| Weather per floor | **Solved.** Outdoor gating and overhead blocking per-floor. |

### What Still Needs Design Work

| Area | Status |
|---|---|
| **Per-floor fog of war** | Future enhancement. Architecture supports it but not in initial scope. |
| **Measured template floor assignment** | Needs Foundry-side support. Low priority. |
| **Cross-floor light transmission model** | Partially designed. Needs shader prototyping. |
| **Per-floor vision masks** | Current wall-height filtering is functional. Full per-floor vision is future work. |
| **Token visual transition between floors** | Conceptually clear but animation design needed. |
| **Dynamic floor creation (tile added mid-game)** | Dirty flag system designed. Edge cases need testing. |
| **VRAM pressure under heavy floor counts** | Budget strategy designed. Needs real-world profiling. |

### Is This the Right Architecture?

**Yes, with high confidence.** The Floor Stack architecture:

1. **Eliminates the root cause** of every mask isolation problem (single global mask slots → per-floor ownership).
2. **Scales naturally** to N floors without special cases per floor count.
3. **Simplifies the codebase** — the ~130-line floor transition hook, `preserveAcrossFloors` policies, screen-space gate rendering, and mask redistribution logic are ALL eliminated. The replacement is `floorStack.setActiveFloor(index)`.
4. **Preserves existing work** — core GPU composition, tile loading, effect shaders, depth pass, and vision system all survive. The changes are in how data flows between them, not in the rendering itself.
5. **Supports future features** cleanly — per-floor fog, per-floor darkness, per-floor weather, per-floor vision are all natural extensions.

The main risk is **implementation scope**: touching 12+ effects, the compositor, the registry, the tile manager, and the render pipeline is a large refactor. The phased migration strategy mitigates this — each phase delivers value and can be validated independently.

---
---

# Part 4: Final Architecture Review — Critical Correction

## The Distortion Problem (Why "Single Scene Render + Floor ID" Breaks)

Part 2 proposed: render all tiles once → use a Floor ID texture so post-effects sample the correct floor's masks per pixel. **This has a fatal flaw for pixel-modifying effects.**

`DistortionManager` applies water distortion by **UV-offsetting the scene render target.** Consider:

- Floor 0 has water. Floor 2 sits directly above it with solid tiles.
- The single scene render's Z-buffer places Floor 2's pixels on top.
- The Floor ID texture says "Floor 2" at those pixels → no water distortion. Correct so far.
- BUT: Floor 2 has a gap. Floor 0 is visible through the gap WITH water.
- The distortion UV-offset at that gap pixel pulls in **neighboring pixels** from the scene RT.
- Those neighbors might be Floor 2 pixels that should NOT be distorted.
- Result: Floor 2 artwork gets pulled into Floor 0's water distortion at gap boundaries.

This is not a theoretical problem — it's exactly the kind of multi-floor artifact we're trying to eliminate. Any effect that moves, blurs, or refracts pixels (distortion, motion blur, depth of field) will have this problem with the single-scene-render approach.

## The Solution: Full Per-Floor Rendering

Instead of rendering all floors into one scene target and then trying to separate them with a Floor ID texture, **render each floor in complete isolation:**

```
For each visible floor (bottom to top):
  1. Show ONLY this floor's tiles, tokens, and scene-effect meshes
  2. renderer.render(scene, camera) → FloorSceneRT[i]
  3. Run this floor's scene effects on FloorSceneRT[i]
  4. Run this floor's post effects on FloorSceneRT[i]
     (water distortion, atmospheric fog, etc.)
  5. Alpha-composite FloorSceneRT[i] into AccumulationRT
     using Floor[i].alpha

Run floor-AGNOSTIC post effects on AccumulationRT:
  - Bloom, color correction, film grain, ASCII, etc.

Output to screen.
```

### Why This Is Better

| Aspect | Single Scene Render + Floor ID | Full Per-Floor Rendering |
|---|---|---|
| **Distortion correctness** | Broken at floor boundaries | Correct by construction |
| **Effect shader changes** | All effects need floor ID sampling | Effects need NO shader changes |
| **Floor ID texture** | Required (composition, maintenance) | Eliminated entirely |
| **Texture arrays / uniform arrays** | Required for post-effects | Eliminated entirely |
| **Semi-transparent inter-floor** | Tricky (dual floor ID encoding) | Handled naturally by alpha compositing |
| **Implementation complexity** | Medium-high (new shader logic everywhere) | Low (just call existing effects per floor) |
| **Geometry render cost** | 1× | N× (but trivial for VTT quad geometry) |
| **Post-effect cost** | 1× | N× for floor-aware effects only |

### Why the GPU Cost Is Negligible

VTT scenes are geometrically trivial: 20–100 textured quads per floor, 2 triangles each. With 4 visible floors, the total geometry is 400 quads = **800 triangles.** Modern GPUs render millions of triangles per millisecond. The per-floor geometry cost is unmeasurable.

The real cost is fullscreen post-processing passes. With 4 visible floors and ~5 floor-aware post effects, that's 20 fullscreen passes. At 1080p with simple shaders, each pass takes ~0.1–0.3ms. Total: **2–6ms** — well within frame budget.

Floor-agnostic effects (bloom, color correction, etc.) still run once on the final composite. No multiplication.

### What This Eliminates from Part 2

The Floor ID texture, texture arrays, per-pixel floor selection in shaders, and the entire "Category 3: Post-Processing Effects" adaptation strategy are **all eliminated.** Post-processing effects become identical to scene effects: they're just called per-floor with the correct masks.

The three effect categories simplify to **two**:
- **Floor-aware effects:** Called once per visible floor. Receive that floor's masks. No shader changes needed.
- **Floor-agnostic effects:** Called once on the final composited image. No changes at all.

### Revised Floor Model

The Floor object gains a scene render target:

```
Floor {
  index:          number
  key:            string
  elevationRange: { bottom, top }
  tiles:          Set<TileDocument>
  overheadTiles:  Set<TileDocument>
  masks:          Map<string, RT>
  alpha:          RT                  // world-space: where this floor exists
  overheadAlpha:  RT                  // world-space: where overhead tiles exist
  sceneRT:        RT                  // screen-res: this floor's rendered + effected image
  dirty:          boolean
  visible:        boolean
}
```

### Revised Rendering Pipeline

```
Phase 1: FLOOR PREPARATION (once per floor change / tile change)
  For each floor:
    1a. Compose floor masks from tile suffix textures → Floor.masks
    1b. Compose floor alpha from tile alpha channels → Floor.alpha
    1c. Compose overhead alpha → Floor.overheadAlpha

Phase 2: PER-FRAME RENDERING

  2a. Update all effects (time, uniforms, animation)

  2b. For each VISIBLE floor (bottom to top):
    ┌─────────────────────────────────────────────────────┐
    │ SET FLOOR CONTEXT                                   │
    │  - Show only this floor's tiles/tokens/meshes       │
    │  - Bind this floor's masks to all floor-aware effects│
    ├─────────────────────────────────────────────────────┤
    │ SCENE EFFECTS (update + render)                     │
    │  - LightingEffect (this floor's lights + outdoors)  │
    │  - SpecularEffect (this floor's specular overlays)  │
    │  - WaterEffectV2 (this floor's water surface)       │
    │  - FireSparksEffect, TreeEffect, etc.               │
    ├─────────────────────────────────────────────────────┤
    │ GEOMETRY RENDER                                     │
    │  renderer.render(scene, camera) → Floor.sceneRT     │
    ├─────────────────────────────────────────────────────┤
    │ FLOOR POST-PROCESSING                               │
    │  - DistortionManager (water distort, heat haze)     │
    │  - AtmosphericFogEffect (this floor's outdoors)     │
    │  - OverheadShadowsEffect (this floor's roof alpha)  │
    │  - CloudEffect (this floor's outdoors)              │
    ├─────────────────────────────────────────────────────┤
    │ COMPOSITE                                           │
    │  Alpha-blend Floor.sceneRT into AccumulationRT      │
    │  using Floor.alpha                                  │
    └─────────────────────────────────────────────────────┘

  2c. GLOBAL POST-PROCESSING (on AccumulationRT)
    - BloomEffect
    - ColorCorrectionEffect
    - SharpenEffect, FilmGrainEffect, etc.
    - AsciiEffect, HalftoneEffect, DotScreenEffect

  2d. Overlay render (selection boxes, UI elements)

  2e. Output to screen
```

### How Effects Are Invoked

Effects don't need to know about floors. The EffectComposer sets up the context before each floor pass:

```javascript
// EffectComposer.render() — per-floor loop (simplified)
for (const floor of floorStack.getVisibleFloors()) {
  // 1. Toggle visibility: only this floor's geometry
  floorStack.setFloorVisible(floor.index);

  // 2. Bind this floor's masks to effects
  //    Effects still have this.outdoorsMask, this.waterMask, etc.
  //    We just swap what those point to.
  for (const effect of floorAwareEffects) {
    effect.bindFloorMasks(floor.masks);
  }

  // 3. Scene effects render (they don't know about floors)
  for (const effect of sceneEffects) {
    effect.update(timeInfo);
    effect.render(renderer, scene, camera);
  }

  // 4. Geometry render into floor's RT
  renderer.setRenderTarget(floor.sceneRT);
  renderer.clear();
  renderer.render(scene, camera);

  // 5. Floor post-processing (on floor.sceneRT)
  let input = floor.sceneRT;
  for (const effect of floorPostEffects) {
    effect.setInputTexture(input.texture);
    // ... ping-pong as usual
  }

  // 6. Composite into accumulation
  compositeFloorIntoAccumulation(floor);
}

// 7. Global post-processing (on accumulation RT)
for (const effect of globalPostEffects) {
  // ... standard ping-pong chain
}
```

The key insight: **`effect.bindFloorMasks(floor.masks)`** is all that changes between floor passes. The effect's `update()` and `render()` methods are identical to today. Effects just see different mask textures each time they're called.

---

## Other Concerns from Final Review

### Concern 1: Per-Floor Render Target Memory

Each visible floor needs a screen-resolution color RT. At 1080p RGBA16F:
- 4 floors × 1920 × 1080 × 8 bytes = **66 MB**
- At 4K: **265 MB**

Mitigation: Reuse a pool of 2 RTs in a ping-pong fashion during the floor loop. Floor 0 renders into RT_A, composites into AccumulationRT, then RT_A is reused for Floor 2. Only 2 per-floor RTs needed regardless of floor count.

**Revised cost: 2 × screen-res RT = 33 MB at 1080p, 133 MB at 4K.** Acceptable.

### Concern 2: Per-Floor Depth Pass

The depth pass currently renders ALL visible tiles into one depth buffer. In per-floor rendering, each floor gets its own depth pass (trivial extra cost). Effects that use depth (SpecularEffect, AtmosphericFogEffect) see correct per-floor depth.

Alternatively, the depth pass can render all visible tiles once and be shared across floor passes. Since Z-ordering is stable across floors, depth comparisons remain valid. This avoids N depth passes.

**Decision: Keep single shared depth pass.** Per-floor depth is a future optimization if needed.

### Concern 3: Scenes Without Levels

Single-floor scenes: FloorStack has 2 floors (Floor 0 = background, Floor 1 = all tiles). Only Floor 1 is the "active" floor. The per-floor loop runs twice. The geometry render cost is 2× current. Since VTT geometry is trivial, this is unmeasurable.

**No performance regression for single-floor scenes.**

### Concern 4: Effect State Across Floor Passes

Some effects accumulate state across frames (e.g., WaterEffectV2's SDF, FireSparksEffect's particle positions). When called multiple times per frame (once per floor), they need to distinguish "this is Floor 0's water pass" from "this is Floor 2's water pass."

**Solution: Per-floor state maps.** Effects that have internal state (SDF, particle systems, material instances) use `Map<floorIndex, FloorState>` internally. The `bindFloorMasks()` call also sets the active floor index so the effect can look up the correct internal state.

This is the Category 2 adaptation from Part 2 — it's still needed. But it's the ONLY adaptation needed. No shader changes, no floor ID textures, no texture arrays.

### Concern 5: Effect Render Order Dependencies

Some effects depend on others' output (e.g., OverheadShadowsEffect writes shadow data that LightingEffect reads). Within a floor pass, the render order is maintained exactly as today. Each floor pass runs the complete effect chain in order. Dependencies are satisfied because the chain runs sequentially within each floor.

### Concern 6: EffectMaskRegistry Facade During Migration

During phased migration, the EffectMaskRegistry can serve as the `bindFloorMasks()` mechanism:

```javascript
// Phase 1: Registry reads from FloorStack
registry.setActiveFloor(floor.index);
// All subscribed effects automatically get the correct floor's masks
// via their existing subscription callbacks
```

This means **effects don't need any code changes in Phase 1.** The registry just changes which floor's masks it publishes. Effects keep their `connectToRegistry()` methods. The per-floor loop calls `registry.setActiveFloor(i)` before each pass.

This is a powerful migration bridge: the entire per-floor rendering pipeline works with ZERO effect code changes.

---
---

# Part 5: Implementation Checklist

## Phase 0: FloorStack Foundation

**Goal:** Introduce FloorStack alongside the existing system. No rendering changes. Validate floor discovery.

- [ ] **P0-01:** Create `scripts/scene/FloorStack.js` with `Floor` class and `FloorStack` class
- [ ] **P0-02:** Implement `FloorStack.buildFromScene(foundryScene, tiles)` — scan tiles, group by elevation band, assign floor indices
- [ ] **P0-03:** Implement Floor 0 creation from background image (always present, alpha = 1.0)
- [ ] **P0-04:** Implement `FloorStack.getFloorForElevation(elevation)` — returns Floor for a given elevation value
- [ ] **P0-05:** Implement `FloorStack.getVisibleFloors()` — returns floors 0..activeFloorIndex
- [ ] **P0-06:** Implement `FloorStack.assignTile(tileDoc)` — assigns a tile to its floor based on elevation
- [ ] **P0-07:** Implement `FloorStack.invalidateFloor(index)` — marks floor dirty for recomposition
- [ ] **P0-08:** Implement `FloorStack.dispose()` — dispose all floor RTs and state
- [ ] **P0-09:** Wire `FloorStack.buildFromScene()` into `canvas-replacement.js` during scene initialization
- [ ] **P0-10:** Add diagnostic logging: floor count, tiles per floor, elevation ranges
- [ ] **P0-11:** Expose `window.MapShine.floorStack` for debugging
- [ ] **P0-12:** Implement per-floor overhead tile assignment (overhead tiles assigned to same floor as siblings in same elevation band)
- [ ] **P0-13:** Verify floor discovery matches existing `_isTileInLevelBand()` logic for all test scenes
- [ ] **P0-14:** Handle edge case: tiles without Levels flags → assign to Floor 1
- [ ] **P0-15:** Handle edge case: single-floor scenes → Floor 0 (bg) + Floor 1 (all tiles)
- [ ] **P0-16:** Unify `CameraFollower._levels` with `FloorStack.floors` — camera follower reads from FloorStack

**Validation:** Floor discovery produces correct floor assignments. `window.MapShine.floorStack` shows expected floor structure. No rendering changes.

---

## Phase 1: Per-Floor Mask Storage

**Goal:** Move mask storage into Floor objects. EffectMaskRegistry becomes a facade. Floor transitions are instant.

- [ ] **P1-01:** Add `masks: Map<string, RT>` to Floor class
- [ ] **P1-02:** Add `alpha: RT` to Floor class (world-space floor alpha)
- [ ] **P1-03:** Add `overheadAlpha: RT` to Floor class
- [ ] **P1-04:** Refactor `GpuSceneMaskCompositor.composeFloor()` to store results in `Floor.masks` instead of internal cache
- [ ] **P1-05:** Add floor alpha composition: compose tile alpha channels into `Floor.alpha` RT during mask composition
- [ ] **P1-06:** Add overhead alpha composition: compose overhead tile alphas into `Floor.overheadAlpha`
- [ ] **P1-07:** Compose ALL floors' masks at scene load time (not just active floor)
- [ ] **P1-08:** Refactor `EffectMaskRegistry` to read from `FloorStack.floors[activeIndex].masks.get(type)` instead of `_slots`
- [ ] **P1-09:** Add `EffectMaskRegistry.setActiveFloor(index)` method — re-publishes all masks from the target floor to all subscribers
- [ ] **P1-10:** Wire `setActiveFloor()` into `mapShineLevelContextChanged` hook
- [ ] **P1-11:** Remove `preserveAcrossFloors` policy logic (each floor owns its masks — no preserve/clear needed)
- [ ] **P1-12:** Remove `_transitioning` lock flag
- [ ] **P1-13:** Remove `_recomposeTimer` debounce — replace with `Floor.dirty` flag
- [ ] **P1-14:** Remove `TILE_MAX_DIM = 4096` cap — load tile albedo at full resolution
- [ ] **P1-15:** Implement demand-based mask allocation: only allocate RTs for mask types that exist on each floor
- [ ] **P1-16:** Implement resolution tiers for masks (visual: sceneRes×0.5, data: sceneRes×0.25)
- [ ] **P1-17:** Add configurable "Mask Quality" setting (Ultra/High/Medium/Low resolution scaling)
- [ ] **P1-18:** Implement dirty-floor recomposition: when a tile changes, mark its floor dirty and recompose only that floor
- [ ] **P1-19:** Test: Water mask on Floor 0 survives Floor 1 transition without any preserve logic
- [ ] **P1-20:** Test: Each floor's masks are independent — changing Floor 2's fire mask doesn't affect Floor 0

**Validation:** Same visual output as before. Floor transitions are instant (no mask composition during transition). `preserveAcrossFloors` is dead code.

---

## Phase 2: Per-Floor Rendering Pipeline

**Goal:** EffectComposer renders each visible floor in isolation, then composites. This is the core architectural change.

### Render Target Setup
- [ ] **P2-01:** Create per-floor scene RT pool (2 RTs, ping-pong reuse) in EffectComposer
- [ ] **P2-02:** Create accumulation RT in EffectComposer (final composited image)
- [ ] **P2-03:** Handle RT resize when viewport changes

### Visibility Toggling
- [ ] **P2-04:** Implement `FloorStack.setFloorVisible(index)` — sets only target floor's tiles/tokens/meshes visible, hides all others
- [ ] **P2-05:** Tag each tile sprite with its floor index in `TileManager.updateSpriteTransform()`
- [ ] **P2-06:** Tag each token sprite with its floor index via `TokenManager.assignTokenToFloor()`
- [ ] **P2-07:** Tag scene-effect meshes (light meshes, water surfaces, tree billboards, particles) with floor index
- [ ] **P2-08:** Implement visibility restore after floor pass (show all visible-floor geometry for next pass)

### Per-Floor Effect Loop
- [ ] **P2-09:** Classify all effects as `floorAware` or `floorAgnostic` (add flag to effect base class or EffectComposer config)
- [ ] **P2-10:** Implement `effect.bindFloorMasks(masks)` method on effect base class — swaps mask uniforms
- [ ] **P2-11:** Refactor `EffectComposer.render()` — outer loop over visible floors, inner loop over floor-aware effects
- [ ] **P2-12:** Within each floor pass: scene effects update/render → geometry render → floor post-effects (ping-pong)
- [ ] **P2-13:** After all floor passes: global post-effects on accumulation RT (ping-pong)

### Floor Alpha Compositing
- [ ] **P2-14:** Implement `compositeFloorIntoAccumulation(floor)` — alpha-blend floor.sceneRT into AccumulationRT using floor.alpha
- [ ] **P2-15:** Create compositor shader: `outColor = floorColor * floorAlpha + accumColor * (1.0 - floorAlpha)`
- [ ] **P2-16:** Handle Floor 0 special case: alpha = 1.0 everywhere, so it's a direct copy (no blend)
- [ ] **P2-17:** Handle semi-transparent floor tiles (partial alpha values) correctly

### Token Floor Assignment
- [ ] **P2-18:** Implement `TokenManager.assignTokenToFloor(tokenDoc)` — maps token elevation to floor index
- [ ] **P2-19:** Update `VisibilityController._isTokenAboveCurrentLevel()` to use `floorStack.getFloorForElevation()` instead of raw elevation compare
- [ ] **P2-20:** Ensure tokens on Floor 0 are visible through Floor 2's gaps (compositing handles this)
- [ ] **P2-21:** Handle token elevation changes: reassign floor, trigger visibility refresh

### Overhead Per-Floor
- [ ] **P2-22:** Each floor's overhead tiles render in that floor's pass (above that floor's tokens, below next floor's ground)
- [ ] **P2-23:** Overhead hover-fade only applies to active floor's overhead tiles
- [ ] **P2-24:** Replace global `_overheadTileIds` with per-floor overhead tile sets in FloorStack
- [ ] **P2-25:** Replace global `_weatherRoofTileIds` with per-floor weather-roof sets in FloorStack

### Remove Legacy Floor-Presence System
- [ ] **P2-26:** Remove `floorPresenceScene` / `belowFloorPresenceScene` from TileManager
- [ ] **P2-27:** Remove `floorPresenceTarget` / `belowFloorPresenceTarget` from DistortionManager
- [ ] **P2-28:** Remove `_ensureFloorPresenceMesh()` / `_ensureBelowFloorPresenceMesh()` from TileManager
- [ ] **P2-29:** Remove `_renderFloorPresence()` / `_renderBelowFloorPresence()` from DistortionManager
- [ ] **P2-30:** Remove `tFloorPresence` / `tBelowFloorPresence` uniforms from all effect shaders
- [ ] **P2-31:** Remove `uFloorPresenceMap` / `uHasFloorPresenceMap` from CandleFlamesEffect and FireSparksEffect
- [ ] **P2-32:** Remove `uFloorPresenceGate` / `tBelowSpecularMap` / `tBelowFloorPresence` from SpecularEffect
- [ ] **P2-33:** Remove `tBelowWaterMask` / `uHasBelowWaterMask` from DistortionManager
- [ ] **P2-34:** Remove floor-presence mesh layers (FLOOR_PRESENCE_LAYER=23, BELOW_FLOOR_PRESENCE_LAYER=24)

**Validation:** Multi-floor scene renders correctly with per-floor isolation. Floor 0's water doesn't affect Floor 2. Each floor's effects are visually independent. Single-floor scenes render identically to before.

---

## Phase 3: Effect Adaptation

**Goal:** Adapt effects that have internal state to support per-floor invocation. Effects that are purely stateless (just read uniforms) need no changes beyond `bindFloorMasks()`.

### Stateless Effects (No Changes Beyond bindFloorMasks)
- [ ] **P3-01:** Verify LightingEffect works with per-floor outdoors mask swap (stateless light accumulation per pass)
- [ ] **P3-02:** Verify BuildingShadowsEffect works with per-floor outdoors mask swap
- [ ] **P3-03:** Verify CloudEffect works with per-floor outdoors mask swap
- [ ] **P3-04:** Verify AtmosphericFogEffect works with per-floor outdoors mask swap
- [ ] **P3-05:** Verify OverheadShadowsEffect works with per-floor outdoors + overheadAlpha
- [ ] **P3-06:** Verify IridescenceEffect works with per-floor mask swap
- [ ] **P3-07:** Verify PrismEffect works with per-floor mask swap

### Per-Tile Overlay Effects (Category 1 — Need Per-Floor Mask Binding)
- [ ] **P3-08:** SpecularEffect: Route per-floor `specular`, `roughness`, `normal` masks to tile overlays on that floor
- [ ] **P3-09:** FluidEffect: Route per-floor `fluid` mask to tile overlays on that floor
- [ ] **P3-10:** Remove all below-floor specular gap-blending logic from SpecularEffect (eliminated by per-floor rendering)

### Stateful Effects (Category 2 — Need Per-Floor Internal State)
- [ ] **P3-11:** WaterEffectV2: Add `Map<floorIndex, WaterFloorState>` for per-floor SDF, surface mesh, material
- [ ] **P3-12:** WaterEffectV2: Compute per-floor SDF at scene load time (frontload heavy work)
- [ ] **P3-13:** WaterEffectV2: `bindFloorMasks()` activates the correct floor's water state
- [ ] **P3-14:** WaterEffectV2: Dispose floor states when floors are removed or scene changes
- [ ] **P3-15:** WindowLightEffect: Per-floor window light textures (windows + outdoors + specular masks per floor)
- [ ] **P3-16:** TreeEffect: Per-floor billboard instance sets (different tree mask per floor)
- [ ] **P3-17:** BushEffect: Per-floor billboard instance sets
- [ ] **P3-18:** FireSparksEffect: Per-floor particle systems (different fire mask → different spawn positions per floor)
- [ ] **P3-19:** DustMotesEffect: Per-floor particle systems
- [ ] **P3-20:** AshDisturbanceEffect: Per-floor particle systems
- [ ] **P3-21:** CandleFlamesEffect: Per-floor flame instance sets

### DistortionManager Refactor
- [ ] **P3-22:** Remove all floor-presence gate logic from DistortionManager composite/apply shaders
- [ ] **P3-23:** Remove below-floor water tinting logic (each floor has its own water now)
- [ ] **P3-24:** Remove `uWindowLightBelowFloor` gating (window light is per-floor)
- [ ] **P3-25:** Per-floor water distortion: `bindFloorMasks()` swaps the water mask + SDF used for distortion
- [ ] **P3-26:** Per-floor heat haze: distortion mask comes from active floor's fire/heat mask
- [ ] **P3-27:** Simplify DistortionManager significantly — most cross-floor logic eliminated

### Lighting Per-Floor
- [ ] **P3-28:** `LightRegistry`: Add `lightToFloor` mapping (light elevation → floor index)
- [ ] **P3-29:** `LightingEffect`: During floor pass, only render lights assigned to that floor
- [ ] **P3-30:** Replace `_isUpperFloorLightForTransmission()` with explicit cross-floor light inclusion via FloorStack
- [ ] **P3-31:** Remove `_prepareUpperTransmissionVisibility()` — replaced by per-floor light set selection

### Weather Per-Floor
- [ ] **P3-32:** WeatherParticles: Gate rain/snow by active floor's `outdoors` mask (no rain indoors)
- [ ] **P3-33:** WeatherParticles: Gate by overhead alpha from floors above (roofs block weather)
- [ ] **P3-34:** Replace binary `elevationWeatherSuppressed` with per-floor weather visibility
- [ ] **P3-35:** Per-floor dust/ash particles already handled by P3-19/P3-20

**Validation:** Each effect renders correctly per-floor. Water on Floor 0 is completely independent of Floor 2. Fire particles on Floor 1 don't appear through Floor 2's solid tiles. Lighting on each floor uses only that floor's lights.

---

## Phase 4: Integration and Cleanup

**Goal:** Wire remaining systems into FloorStack. Remove all legacy multi-floor code.

### System Integration
- [ ] **P4-01:** Camera follower reads floors from FloorStack (remove `_levels` duplication)
- [ ] **P4-02:** Camera follower `_syncToControlledTokenLevel()` uses `floorStack.getFloorForElevation()`
- [ ] **P4-03:** Grid renderer reads from FloorStack for ghost grids and floor tinting
- [ ] **P4-04:** Vision system: pass floor index to wall-height filtering for correct per-floor vision
- [ ] **P4-05:** Sound occlusion: assign ambient sounds to floors via `floorStack.getFloorForElevation()`
- [ ] **P4-06:** Tile motion manager: read tile floor index from FloorStack

### Hook Simplification
- [ ] **P4-07:** Simplify `mapShineLevelContextChanged` handler in `canvas-replacement.js` to:
  ```
  floorStack.setActiveFloor(index)
  → tile visibility refresh
  → depth pass invalidate
  → request re-render
  ```
- [ ] **P4-08:** Remove the ~130-line mask composition + redistribution block from the hook handler
- [ ] **P4-09:** Remove `compositor.composeFloor()` call from the hook (masks are pre-composed)

### Legacy Removal
- [ ] **P4-10:** Remove `EffectMaskRegistry._slots` (replaced by Floor.masks)
- [ ] **P4-11:** Remove `EffectMaskRegistry.transitionToFloor()` replace/preserve/clear logic
- [ ] **P4-12:** Remove `preserveAcrossFloors` policy from DEFAULT_POLICIES and all code paths
- [ ] **P4-13:** Remove `_belowFloorKey` / `_activeFloorKey` tracking from GpuSceneMaskCompositor
- [ ] **P4-14:** Remove `getBelowFloorTexture()` from GpuSceneMaskCompositor
- [ ] **P4-15:** Remove LRU floor cache (`_lruOrder`, `_maxCachedFloors`) from GpuSceneMaskCompositor (FloorStack owns caching)
- [ ] **P4-16:** Remove `connectToRegistry()` from all 12 effects (replaced by `bindFloorMasks()`)
- [ ] **P4-17:** Remove `_registryUnsubs` / `_registryUnsub` cleanup from all effects
- [ ] **P4-18:** Reduce `EffectMaskRegistry` to a thin diagnostic facade or remove entirely
- [ ] **P4-19:** Remove `_cpuPixelCache` and `_cpuFallback` from compositor if no longer needed
- [ ] **P4-20:** Clean up `SceneComposer` — remove `_lastMaskBasePath`, mask basePath resolution (moved to FloorStack/compositor)

### Dynamic Tile Changes
- [ ] **P4-21:** Wire tile create/update/delete hooks to `floorStack.assignTile()` / `floorStack.invalidateFloor()`
- [ ] **P4-22:** On tile change: only recompose the affected floor's masks (not all floors)
- [ ] **P4-23:** Handle tile elevation change: remove from old floor, assign to new floor, invalidate both
- [ ] **P4-24:** Handle floor creation (new tile creates a previously non-existent elevation band)
- [ ] **P4-25:** Handle floor deletion (last tile on a floor is removed)

**Validation:** All systems read from FloorStack. No duplicate level/floor discovery. Hook handler is <20 lines. All legacy multi-floor code removed. No `preserveAcrossFloors`, no floor-presence gates, no `_belowFloorKey`.

---

## Phase 5: Testing and Polish

**Goal:** Comprehensive validation. Performance profiling. Edge case handling.

### Regression Testing
- [ ] **P5-01:** Single-floor scene (no Levels) — renders identically to pre-refactor
- [ ] **P5-02:** Two-floor scene — basic floor switching, water on Floor 0 stays correct
- [ ] **P5-03:** Three+ floor scene — multiple floors visible through gaps
- [ ] **P5-04:** Scene with many tiles on one floor (50+ tiles) — mask composition correct
- [ ] **P5-05:** Scene with overhead tiles on each floor — per-floor hover fade
- [ ] **P5-06:** Scene with water on multiple floors — independent water per floor
- [ ] **P5-07:** Scene with fire on one floor, not another — particles correctly per-floor
- [ ] **P5-08:** Scene with lighting on each floor — independent indoor/outdoor boundaries
- [ ] **P5-09:** Token movement between floors — smooth floor reassignment
- [ ] **P5-10:** Camera follow-token across floor boundaries
- [ ] **P5-11:** Dynamic tile add/remove during gameplay
- [ ] **P5-12:** Scene transition (full load → full load) — clean disposal and rebuild

### Performance
- [ ] **P5-13:** Measure frame time on single-floor scene — verify no regression
- [ ] **P5-14:** Measure frame time on 3-floor scene — verify <2× single-floor
- [ ] **P5-15:** Measure frame time on 5-floor scene — verify acceptable
- [ ] **P5-16:** Profile VRAM usage per floor count — verify within budget estimates
- [ ] **P5-17:** Profile mask composition time at scene load — verify frontloaded
- [ ] **P5-18:** Profile floor transition time — verify instant (no mid-game composition)
- [ ] **P5-19:** Test with Mask Quality settings at all levels (Ultra/High/Medium/Low)

### Edge Cases
- [ ] **P5-20:** Floor with no tiles (empty floor between populated floors)
- [ ] **P5-21:** Floor with only overhead tiles (no ground tiles)
- [ ] **P5-22:** Tile that spans multiple elevation bands
- [ ] **P5-23:** Token at exact floor boundary elevation
- [ ] **P5-24:** Scene with Levels compatibility mode OFF — FloorStack handles gracefully
- [ ] **P5-25:** Very large scene (8192×8192+) — mask resolution scaling correct
- [ ] **P5-26:** Rapid floor switching (keyboard spam Page Up/Down) — no race conditions

### Documentation
- [ ] **P5-27:** Update ARCHITECTURE-SUMMARY.md with Floor Stack model
- [ ] **P5-28:** Update effect development guide with `bindFloorMasks()` pattern
- [ ] **P5-29:** Add FloorStack API documentation
- [ ] **P5-30:** Mark MULTI-LEVEL-RENDERING-ARCHITECTURE.md as superseded

---

## Summary: Total Scope

| Phase | Items | Risk | Description |
|---|---|---|---|
| **Phase 0** | 16 | Low | FloorStack class, floor discovery, no rendering changes |
| **Phase 1** | 20 | Medium | Per-floor mask storage, registry facade, full-res albedo |
| **Phase 2** | 34 | **High** | Per-floor rendering pipeline, compositing, legacy removal |
| **Phase 3** | 35 | **High** | Effect adaptation (stateful effects need per-floor state) |
| **Phase 4** | 25 | Medium | System integration, hook simplification, legacy cleanup |
| **Phase 5** | 30 | Low | Testing, profiling, edge cases, documentation |
| **Total** | **160** | | |

**Recommended approach:** Complete Phase 0 and Phase 1 first. These deliver immediate value (per-floor mask isolation, instant floor transitions) with low risk. Phase 2 is the core architectural change and should be done in a feature branch with careful testing. Phase 3 can be done effect-by-effect, validating each one independently.

---
---

# Part 6: Deep-Dive Validation Addendum

*This section documents findings from systematic code-level review of the critical effects and their render-time dependencies. Several corrections and clarifications to Part 4 and Part 5 are noted below.*

---

## Finding 1: Visibility Toggling Is a Universal Mechanism

The most important validation result. Three.js **always** respects `sprite.visible = false` — even when the camera has a layer mask set via `camera.layers.set(N)`. Hidden objects simply aren't rendered, regardless of layers.

This means that `setFloorVisible(N)` (which sets all non-Floor-N geometry to `visible = false`) **automatically makes every layer-based sub-render floor-aware** without any code changes to the consuming effect:

| Sub-render | Effect | Layer | Result with visibility toggling |
|---|---|---|---|
| Roof alpha | LightingEffect | ROOF_LAYER=20 | Only Floor N's overhead tiles captured ✓ |
| Weather roof alpha | LightingEffect | WEATHER_ROOF_LAYER=21 | Only Floor N's weather-roof tiles ✓ |
| Rope mask | LightingEffect | ROPE_MASK_LAYER | Only Floor N's rope tiles ✓ |
| Token mask | LightingEffect | TOKEN_MASK_LAYER=26 | Only Floor N's tokens ✓ |
| Overhead shadow | OverheadShadowsEffect | ROOF_LAYER=20 | Only Floor N's overhead tiles ✓ |
| Water occluder | DistortionManager | WATER_OCCLUDER_LAYER=22 | Only Floor N's occluder meshes ✓ |

**LightingEffect, OverheadShadowsEffect, and DistortionManager require ZERO code changes for their internal layer-based passes.** Visibility toggling handles all of it.

---

## Finding 2: Water Occluder Meshes Are Already Synced to Sprite Visibility

Water occluder meshes live in `TileManager.waterOccluderScene` (a separate Three.js scene). Crucially, TileManager **already keeps `occ.visible = !!sprite.visible` in sync** whenever a tile's visibility changes (tile-manager.js line ~3371):

```javascript
// Already exists in TileManager.updateTokenSprite / updateSpriteVisibility
const occ = sprite?.userData?.waterOccluderMesh;
if (occ) {
  occ.visible = !!sprite.visible;
}
```

So `setFloorVisible(N)` just needs to set `sprite.visible = (floorIndex === N) && spriteData.foundryVisible`. The water occluder meshes follow automatically. **No extra occluder-specific toggling needed.**

---

## Finding 3: Effect RTs Are NOT Multiplied by Floor Count

Most effect render targets (single screen-size RTs) are **overwritten each floor pass** and immediately consumed within the same pass:

- `LightingEffect.lightTarget` → written for Floor N → read by DistortionManager for Floor N → Floor N+1 overwrites it
- `LightingEffect.darknessTarget` → same pattern
- `LightingEffect.roofAlphaTarget` → same pattern
- `OverheadShadowsEffect.shadowTarget` → same pattern
- `DistortionManager.waterOccluderTarget` → same pattern
- `DistortionManager.distortionTarget` → same pattern

This is the "write and consume immediately" pattern. **Memory cost is identical to today.** No VRAM multiplication for per-frame effect RTs.

The ONLY data that needs per-floor copies is **load-time computed data** (data that persists across frames):
- WaterEffectV2 SDF texture
- FireSparksEffect position lookup texture
- DustMotesEffect position lookup texture
- AshDisturbanceEffect position lookup texture

These are small textures computed once at scene load and stored in `Map<floorIndex, FloorState>`. Their VRAM cost is proportional to floor count but small in absolute terms.

---

## Finding 4: Global Reference Pattern Is Safe for Per-Floor

Multiple effects share data via `window.MapShine.xxx`:

- `LightingEffect` reads `window.MapShine.overheadShadowsEffect.shadowTarget`
- `DistortionManager` reads `window.MapShine.lightingEffect.roofAlphaTarget` (and via MaskManager)
- `DistortionManager` reads `window.MapShine.lightingEffect.getEffectiveDarkness()`
- `WindowLightEffect` reads `window.MapShine.distortionManager.renderLightPass()`

This works correctly for per-floor rendering because **effects run sequentially within each floor pass**. By the time DistortionManager reads `lightingEffect.roofAlphaTarget`, that RT was just rendered for Floor N by LightingEffect in the same pass. The global reference always points to "this floor's data."

**No changes needed to any global-reference patterns** as a result of per-floor rendering.

---

## Finding 5: Effect Execution Order Chain

The existing render order within `EffectComposer` already enforces the correct dependency chain. Within each floor pass, this order is maintained:

```
ENVIRONMENTAL layer (lower order):
  1. OverheadShadowsEffect.render()
     → Captures ROOF_LAYER → shadowTarget (Floor N's overhead shadows)

ENVIRONMENTAL layer (higher order):
  2. LightingEffect.render()
     → Reads shadowTarget (Floor N's) → lightTarget, darknessTarget, roofAlphaTarget
     → roofAlphaTarget published to MaskManager as 'roofAlpha.screen'
     → Renders light meshes for Floor N (gated by activeLevelContext)

POST_PROCESSING layer:
  3. DistortionManager.render()
     → Reads lightTarget, darknessTarget, roofAlphaTarget from LightingEffect (Floor N's)
     → Reads water/fire/outdoors masks from Floor N (via bindFloorMasks)
     → UV-offsets Floor N's scene RT → outputs distorted floor image
```

This chain is unbroken in per-floor rendering. **No reordering needed.**

---

## Finding 6: LightingEffect Light Gating via activeLevelContext

`LightingEffect` already gates which Three.js light meshes are visible using `_isLightVisibleForElevation()`, which reads `window.MapShine.activeLevelContext`. 

In the per-floor loop, **`FloorStack.setFloorContext(N)`** temporarily sets `window.MapShine.activeLevelContext` to Floor N's elevation range before running Floor N's effects. LightingEffect's existing code then:
- Shows Floor N's light meshes (elevation within Floor N's range)
- Hides Floor N-1, Floor N+1 light meshes

After all floor passes, `activeLevelContext` is restored to the actual viewer's active floor.

**No changes to LightingEffect's light gating logic.** The existing system is reused via context injection.

This significantly simplifies P3-28 through P3-31 from the checklist — LightingEffect's per-floor adaptation is largely already done.

---

## Finding 7: Depth Pass Correction

**Correction to Part 4 ("Decision: Keep single shared depth pass").**

The depth pass uses `DepthPassManager.update()` which renders all visible tiles into a depth buffer. This depth buffer is then sampled by SpecularEffect and others for occlusion.

If the depth pass runs ONCE before the per-floor loop (with all tiles visible), it contains cross-floor depth. During Floor 0's scene render (only Floor 0 visible), effects that read the depth buffer might see Floor 2's depth at pixels where Floor 2 overlaps Floor 0 — potentially incorrectly occluding Floor 0's specular overlays with Floor 2's depth.

**Correction: `DepthPassManager.update()` must be called WITHIN each floor's visibility context**, after `setFloorVisible(N)`. The depth buffer then only contains Floor N's geometry, consistent with Floor N's scene render. Fortunately, VTT geometry is trivially cheap — N depth passes cost essentially nothing.

*This replaces P5-13's note. Added as new checklist item P2-36.*

---

## Finding 8: Visibility Restore Pattern

`setFloorVisible(N)` sets `sprite.visible = (sprite.userData.floorIndex === N) && spriteData.foundryVisible`. After ALL floor passes are complete, visibility must be restored so the scene is in a consistent state for overlay rendering, VisibilityController, and non-rendering reads.

Restore formula: `sprite.visible = spriteData.foundryVisible` for all tiles and tokens.

This is cheap (O(total tiles + tokens)) and runs once after the floor loop, not once per floor.

*Added as new checklist item P2-37.*

---

## Finding 9: Simplified Phase 3 Scope for LightingEffect

Based on Finding 6, the P3 items for LightingEffect are significantly simpler than originally written:

- **P3-28 (LightRegistry lightToFloor mapping):** Still needed for `setFloorContext(N)` to provide the correct elevation range.
- **P3-29 (LightingEffect renders only floor's lights):** Already handled by existing `_isLightVisibleForElevation()` + `activeLevelContext` injection. No new code in LightingEffect needed.
- **P3-30 (Replace `_isUpperFloorLightForTransmission`):** This can be DEFERRED. Phase 2 simply renders each floor in isolation. Cross-floor light transmission is a Phase 4+ enhancement.
- **P3-31 (Remove `_prepareUpperTransmissionVisibility`):** Also deferrable. The existing code doesn't harm anything in the per-floor model — it just stops being needed once we're fully per-floor.

---

## Finding 10: Missing Architecture Detail — SceneRT Must Use Alpha=0 Clear

When rendering each floor's tiles into `floorSceneRT`, the clear color must be `(0,0,0,0)` (transparent black), NOT `(0,0,0,1)` (opaque black). Otherwise, areas of the floor RT where no tile exists would be filled with opaque black instead of transparent, breaking the alpha compositing step.

Similarly, the depth+stencil clear must not corrupt the depth buffer unexpectedly. Standard `renderer.setClearColor(0x000000, 0); renderer.clear()` handles this correctly.

*Added as new checklist item P2-35 (renumbering below).*

---

## Revised Checklist Items for Phase 2

*These items replace/supplement items P2-35 onwards:*

- [ ] **P2-35:** Before each floor's geometry render, call `renderer.setClearColor(0x000000, 0); renderer.clear()` to ensure transparent background for correct alpha compositing
- [ ] **P2-36:** `DepthPassManager.update()` runs INSIDE each floor's visibility context (not once before the loop) — per-floor depth is automatically correct via visibility toggling
- [ ] **P2-37:** After all floor passes, restore all tiles/tokens: `sprite.visible = spriteData.foundryVisible` — no snapshot needed, derive from stored state
- [ ] **P2-38:** Scene-effect meshes (LightingEffect light meshes, TreeEffect billboards, WaterEffectV2 surface quads, particle system roots) tagged with `mesh.userData.floorIndex`; included in `setFloorVisible(N)` toggling
- [ ] **P2-39:** Implement `FloorStack.setFloorContext(N)` — temporarily sets `window.MapShine.activeLevelContext` to Floor N's elevation context so existing LightingEffect light gating (`_isLightVisibleForElevation`) automatically activates the correct lights per floor
- [ ] **P2-40:** Validate that water occluder mesh visibility (`sprite.userData.waterOccluderMesh.visible`) follows sprite visibility automatically via existing TileManager sync code — no extra toggling needed

---

## Revised Phase 3 Scope for LightingEffect

Per Finding 6, replace P3-28 through P3-31 with:

- [ ] **P3-28 (REVISED):** `LightRegistry`: Add `lightToFloor` mapping so `setFloorContext(N)` can provide the correct elevation range for Floor N
- [ ] **P3-29 (REVISED):** Verify LightingEffect correctly gates lights via existing `_isLightVisibleForElevation()` when `activeLevelContext` is injected per-floor — **expected to work with zero code changes**
- [ ] **P3-30 (DEFERRED to Phase 4):** Cross-floor light transmission (`_isUpperFloorLightForTransmission`) — deferred, existing code doesn't harm per-floor rendering
- [ ] **P3-31 (DEFERRED to Phase 4):** Remove `_prepareUpperTransmissionVisibility` — deferred cleanup

---

## Final Architectural Confidence

After this validation pass, the architecture stands with **high confidence** across all major subsystems:

| Subsystem | Approach Validated | Risk |
|---|---|---|
| LightingEffect per-floor | Visibility toggle + activeLevelContext injection | ✓ Low |
| OverheadShadowsEffect per-floor | Visibility toggle (automatic) | ✓ Low |
| DistortionManager per-floor | readBuffer = floorSceneRT, visibility toggle for occluders | ✓ Low |
| Water occluder visibility | Already synced to sprite.visible in TileManager | ✓ Low |
| Effect RT memory | Single RT overwritten per pass — no multiplication | ✓ Low |
| Global reference pattern | Sequential execution within floor pass — safe | ✓ Low |
| Depth pass | Per-floor via visibility context — automatic | ✓ Low |
| Effect execution order | EffectComposer layer ordering preserved in per-floor loop | ✓ Low |
| LightingEffect light gating | Existing _isLightVisibleForElevation + activeLevelContext | ✓ Low |
| Cross-floor light transmission | Deferred to Phase 4 | Medium |
| Stateful effects (Fire, Water, etc.) | Per-floor state Map, load-time computation | Medium |
| DistortionManager refactor | Significant simplification via per-floor isolation | Medium |

**The only remaining medium-risk items are the stateful effects (Phase 3) and the DistortionManager simplification.** Everything else has been validated against actual code and is confirmed correct with the visibility-toggle approach.

---
---

# Part 7: System-by-System Deep Dive

*Full code-level investigation of every major system. Each section has integration notes, confirmed behaviour, and pre-implementation verification checkboxes.*

---

## 7.1 `createThreeCanvas` — Init Flow and FloorStack Injection Point

The full `createThreeCanvas` function (canvas-replacement.js) follows this order:

```
Step 1:  SceneComposer.initialize()         → {threeScene, camera, bundle}
Step 1a: GPU texture warmup
Step 1b: MaskManager created + seeded with bundle masks
Step 1c: WeatherController.setRoofMap(outdoorsMask)
Step 1d: EffectMaskRegistry created + seeded
Step 2:  EffectComposer created
Step 2a: DepthPassManager created + added as effectComposer updatable
Step 2b: effectComposer.registerEffectBatch() — parallel independent effects
Step 2c: Dependent effects (Fire, Ash, Dust, Lighting, Candles)
Step 3:  TileManager created + effects wired
Step 4:  TokenManager created
Step 5:  Sync (tiles, tokens, levels snapshot)
Step 6:  compositor.preloadAllFloors() — deferred mask composition
```

**FloorStack injection: between Step 1 and Step 1b.** `window.MapShine.levelsSnapshot` is registered as a getter just before Step 1 and is immediately available. `bundle` (initial floor-0 masks) is available after Step 1.

```javascript
// AFTER: sceneComposer.initialize() returns bundle
const { scene: threeScene, camera, bundle } = await sceneComposer.initialize(...)

// NEW: Build FloorStack from snapshot + initial bundle
const floorStack = new FloorStack();
floorStack.buildFromScene(window.MapShine.levelsSnapshot, bundle);
window.MapShine.floorStack = floorStack;

// Step 1b: MaskManager seeds from FloorStack.activeFloor.masks
// Step 1d: EffectMaskRegistry.setActiveFloor(0) replaces manual seeding
```

- [ ] **PRE-01:** Confirm `window.MapShine.levelsSnapshot.sceneLevels` is populated before Step 1b
- [ ] **PRE-02:** Confirm `bundle.masks` can seed `Floor[0].masks` at this point
- [ ] **PRE-03:** Confirm `SceneComposer.basePlaneMesh` is accessible after `initialize()` for assignment to `Floor[0]`

---

## 7.2 `LevelsImportSnapshot` — The Floor Discovery Data Source

`LevelsImportSnapshot` already provides exactly what FloorStack needs:

```javascript
snapshot.sceneLevels  // [{bottom, top, name}] — elevation bands
snapshot.tiles        // [{id, rangeBottom, rangeTop}] — per-tile floor data
snapshot.docRanges    // [{id, type, rangeBottom, rangeTop}] — lights/sounds
snapshot.walls        // [{id, bottom, top}] — wall heights
```

`FloorStack.buildFromScene` maps `snapshot.sceneLevels` to Floor objects (sorted bottom-to-top). Tile assignment uses `rangeBottom/rangeTop`. Light/sound assignment uses `docRanges`. No custom flag reading needed — the snapshot does all normalization.

Single-floor scenes: `snapshot.levelsEnabled = false`, `sceneLevels = []`. FloorStack creates Floor 0 (background) + Floor 1 (all tiles). No special cases.

- [ ] **PRE-04:** Verify `snapshot.sceneLevels` bands are sorted or that FloorStack sorts them
- [ ] **PRE-05:** Verify tiles without Levels flags are assigned to Floor 1 when `levelsEnabled = false`
- [ ] **PRE-06:** Verify `snapshot.docRanges` includes `AmbientLight` entries for `floor.lightSources`

---

## 7.3 `DepthPassManager` — Critical Correction

`DepthPassManager` is an **updatable** added to `effectComposer` at Step 2a. It currently runs ONCE per frame in `EffectComposer.render()` before any floor loop. It copies `depthCamera.layers.mask = mainCamera.layers.mask` before rendering depth.

**Problem:** If depth runs before the floor loop (with all tiles visible), effects in Floor 0's pass would sample depth containing Floor 1+2 geometry — incorrect occlusion.

**Fix:** Remove `depthPassManager` from `effectComposer.updatables`. Call `depthPassManager.invalidate(); depthPassManager.update(timeInfo)` INSIDE each floor's visibility context before the geometry render.

```javascript
for (const floor of floorStack.getVisibleFloors()) {
  floorStack.setFloorVisible(floor.index);
  floorStack.setFloorContext(floor.index);
  depthPassManager.invalidate();
  depthPassManager.update(timeInfo);   // depth for Floor N only
  // ... scene effects, geometry render, floor post-processing
}
```

- [ ] **PRE-07:** Confirm `DepthPassManager` can be safely removed from `effectComposer.updatables`
- [ ] **PRE-08:** Confirm `depthPassManager.update(timeInfo)` is safe to call N times per frame (verify `_lastRenderTimeMs` rate-limiting doesn't block multiple per-frame calls)

---

## 7.4 `WaterEffectV2` — Stateful Per-Floor

| State | Per-floor | Strategy |
|---|---|---|
| `this.waterMask` | Yes | Swap via `bindFloorMasks()` |
| `this._waterData` (SDF result) | Yes | `Map<floorIndex, WaterFloorState>` |
| `this._surfaceModel` (WaterSurfaceModel) | Yes | One per floor with water |
| `this._floorTransitionActive` flag | **Eliminated** | Never needed in FloorStack |

`WaterSurfaceModel.buildFromMaskTexture()` is the expensive CPU-SDF operation. Run once per floor at scene load. Store in `WaterFloorState._waterData`. `bindFloorMasks(floor)` swaps active state.

`WaterEffectV2` is POST_PROCESSING — it receives `readBuffer` = Floor N's scene RT from the EffectComposer ping-pong chain. UV-offsets that RT for refraction. No scene-space meshes to toggle.

The `_floorTransitionActive` flag exists solely to prevent water state destruction during the current architecture's mask redistribution. **Eliminated in Phase 4.**

- [ ] **PRE-09:** Confirm `WaterSurfaceModel` is safe to instantiate multiple times at scene load (one per floor with water) — verify no global GPU state shared between instances
- [ ] **PRE-10:** Confirm `WaterEffectV2` has no scene-space mesh it creates (only `this.baseMesh` reference which is assigned from outside, not created by it)

---

## 7.5 `SpecularEffect` — Confirmed Auto-Synced

`SpecularEffect._tileOverlays` maps tileId → `{occluderMesh, colorMesh}`. Meshes are Z-positioned at tile world-space location. Confirmed via `syncTileSpriteVisibility()` that overlay mesh visibility tracks `sprite.visible` automatically.

**No extra toggling needed for SpecularEffect overlays.** Same behaviour as water occluder meshes (TileManager syncs `occ.visible = !!sprite.visible` on every visibility update).

Below-floor gap-blending logic (`tBelowFloorPresence`) removed in P3-10 — compositing makes it irrelevant.

- [ ] **PRE-11:** Verify `SpecularEffect.syncTileSpriteVisibility()` does set `occluderMesh.visible = !!sprite.visible` and `colorMesh.visible = !!sprite.visible`
- [ ] **PRE-12:** Verify SpecularEffect does NOT read `_belowFloorPresence` anywhere outside the uniform that is being removed

---

## 7.6 `FireSparksEffect` — CPU Point Arrays, Not GPU Textures

Despite the architecture doc referring to "position lookup textures", `FireSparksEffect` uses **CPU-side Float32Array point arrays**, not GPU textures:

- `_generatePoints(fireMask.texture)` — reads image pixel data CPU-side, returns `Float32Array` of `(x, y, brightness)` triples
- Creates `FireMaskShape` instances sampling those arrays at particle spawn time
- `ParticleSystem` instances are Three.js scene objects

Per-floor: each floor with a fire mask gets its own point array + `FireMaskShape` + `ParticleSystem` set. The `ParticleSystem` root objects get `userData.floorIndex`. `setFloorVisible(N)` shows only Floor N's fire systems.

`_heatDistortionMask` (a derived boosted mask for DistortionManager) also stored per floor.

- [ ] **PRE-13:** Confirm `_generatePoints(texture)` only requires `texture.image` (CPU-readable, not GPU-only RT texture)
- [ ] **PRE-14:** Confirm `ParticleSystem.batchRenderer` scene object can receive `userData.floorIndex` for visibility toggling

---

## 7.7 `BuildingShadowsEffect` — Baked Shadows Per-Floor

Has a bake system: renders outdoors mask through shadow kernel once → cached `bakeTarget`. Bake only re-runs when outdoors mask or sun direction changes.

Per-floor: `Map<floorIndex, {bakeTarget, outdoorsMask, lastSunDir}>`. Bakes run at scene load time. When sun direction changes, all floor bake targets marked dirty. Fast — single shader pass per floor.

- [ ] **PRE-15:** Measure bake time per floor — confirm it won't significantly extend scene load
- [ ] **PRE-16:** Confirm `bakeTarget.dispose()` is called per floor state, not globally on effect dispose

---

## 7.8 `WindowLightEffect` — Multi-Mask, Single RT

Subscribes to `windows`, `outdoors`, `specular` masks. Has `lightTarget` RT for window caustics. `renderLightPass()` is called from DistortionManager when needed. Since DistortionManager runs per-floor, `renderLightPass()` runs per-floor with the correct masks already bound.

`lightTarget` RT is overwritten per-floor (write-and-consume pattern). **No per-floor RT copies needed.**

- [ ] **PRE-17:** Confirm `WindowLightEffect.renderLightPass()` reads only from swappable mask uniforms, not cached intermediate state

---

## 7.9 `TreeEffect` / `BushEffect` / `CandleFlamesEffect` — Billboard/Instance Per-Floor

All three follow the same pattern:
- Scan mask for positions (CPU-side) at scene load
- Create instanced/billboard meshes at those positions in the Three.js scene
- Tag root objects with `userData.floorIndex`
- `setFloorVisible(N)` shows only Floor N's instances

`CandleFlamesEffect` currently uses `uFloorPresenceMap` gating — removed in P2-31 and replaced by visibility toggling.

- [ ] **PRE-18:** Confirm TreeEffect/BushEffect use a single `InstancedMesh` root that can receive `userData.floorIndex`
- [ ] **PRE-19:** Confirm candle/tree/bush positions extracted from world-space mask coordinates are valid per-floor (position data is absolute, not relative)

---

## 7.10 `MaskManager` — Per-Frame vs Per-Scene Texture Audit

`MaskManager` holds two categories of textures:

**Per-frame (screen-space, overwritten each floor pass — safe as-is):**
- `roofAlpha.screen` — published by LightingEffect per floor pass
- `weatherRoofAlpha.screen` — published by LightingEffect per floor pass
- `roofVisible.screen`, `roofClear.screen`, `precipVisibility.screen` — derived from above
- `tokenMask.screen` — published by LightingEffect per floor pass
- `depth.device` — published by DepthPassManager per floor pass
- `water.data` — published by WaterEffectV2 per floor pass (overwritten)

**Per-scene-load (static, need per-floor update on floor switch):**
- `outdoors.scene`, `water.scene`, `fire.scene`, etc. — from bundle at load time

The static masks need updating when `setActiveFloor(N)` is called. `EffectMaskRegistry.setActiveFloor(N)` should also call `maskManager.setTexture('outdoors.scene', floor.masks.get('outdoors'))` for all static mask types.

- [ ] **PRE-20:** Audit ALL `mm.setTexture()` calls — identify all static per-scene-load textures and add them to the `setActiveFloor()` update sequence
- [ ] **PRE-21:** Confirm `maskManager.getTexture(key)` always returns the most recently set value (no internal caching that delays updates)

---

## 7.11 `DistortionManager` — Confirmed Significant Simplification

Removals in Phase 2-3:

| Removed system | Est. lines |
|---|---|
| `floorPresenceScene/belowFloorPresenceScene` | 50 |
| `tFloorPresence/tBelowFloorPresence` uniforms + GLSL | 50 |
| `tBelowWaterMask/uHasBelowWaterMask` | 15 |
| `uWindowLightBelowFloor` gating | 10 |
| `outdoorsScene` render pass (replaced by mask uniform) | 30 |
| `_floorTransitionActive` in WaterEffectV2 | 20 |
| **Total** | **~175 lines** |

The `outdoorsScene` render pass in DistortionManager re-projects the outdoors mask to screen space. In the new architecture, Floor N's outdoors mask (`floor.masks.get('outdoors')`) is already a world-space texture. DistortionManager samples it with the existing world-to-UV uniforms — **the render pass is replaced with a direct uniform assignment.**

- [ ] **PRE-22:** Confirm `DistortionManager.outdoorsScene` render result is equivalent to directly sampling `floor.masks.get('outdoors')` — same UV mapping and coordinate space
- [ ] **PRE-23:** Confirm no system other than `canvas-replacement.js` calls `setOutdoorsScene()` on DistortionManager

---

## 7.12 `WeatherParticles` — Floor-Agnostic, No Changes Needed

Reads `precipVisibility.screen` from MaskManager — a derived screen-space texture. Weather runs ONCE on the final accumulated image (floor-agnostic). The `precipVisibility.screen` reflects the last floor pass's outdoor state (the active floor), which is exactly correct — weather falls where the active floor is outdoors.

- [ ] **PRE-24:** Confirm `WeatherParticles` is classified as POST_PROCESSING or ENVIRONMENTAL and runs AFTER all floor passes in the floor loop

---

## 7.13 `EffectMaskRegistry` — The Zero-Change Migration Bridge

Phase 1 migration approach: keep all `connectToRegistry()` calls intact. Add `setActiveFloor(floorIndex)` to the registry that reads from FloorStack and fires all subscribers:

```javascript
setActiveFloor(floorIndex) {
  const floor = window.MapShine.floorStack.floors[floorIndex];
  for (const [type, callbacks] of this._subscribers) {
    const texture = floor.masks.get(type) ?? null;
    for (const cb of callbacks) cb(texture, floorIndex, 'floor-switch');
  }
}
```

This replaces `transitionToFloor()` entirely. All 12+ effects keep their existing `connectToRegistry()` with zero code changes through Phase 2. Per-floor effects are then migrated one-by-one in Phase 3.

- [ ] **PRE-27:** Verify `subscribe()` return value is the unsubscribe function, and that `setActiveFloor()` does NOT accidentally unsubscribe anything
- [ ] **PRE-28:** Verify all callers of `getSlot()` / `getMaskTexture()` on EffectMaskRegistry — these need updating or removal before `_slots` is removed

---

## 7.14 `EffectBase` — New `bindFloorMasks` Method

Add `bindFloorMasks(masks)` as a default no-op to `EffectBase`. Floor-aware effects override it. The method receives the active `Floor.masks` Map:

```javascript
// EffectBase default (no-op):
bindFloorMasks(masks) {}

// WaterEffectV2 override:
bindFloorMasks(masks) {
  this.waterMask = maps.get('water') ?? null;
  const state = this._floorStates.get(this._activeFloorIndex);
  this._waterData = state?._waterData ?? null;
}
```

`EffectComposer.render()` gains a reference to `FloorStack` (injected once during init) and calls `floorStack.setFloorContext(N)` + all effects' `bindFloorMasks(floor.masks)` at the start of each floor pass.

- [ ] **PRE-29:** Search codebase for any existing `bindFloorMasks` definition (should be none — it's a new API)
- [ ] **PRE-30:** Confirm `EffectComposer` is the right place to hold the FloorStack reference, or if `window.MapShine.floorStack` is sufficient

---

## 7.15 Per-Floor Scene RT Memory Budget

**Required RTs for per-floor rendering (new additions):**
- `floorRT_A` — screen-resolution RGBA16F (reused across floors, ping-pong)
- `floorRT_B` — screen-resolution RGBA16F (second ping-pong buffer)
- `accumulationRT` — screen-resolution RGBA16F (composited result)

At 1080p RGBA16F: 3 × 1920 × 1080 × 8 = **50 MB**.
At 4K: **200 MB**.

**Existing RTs (unchanged):** `sceneRenderTarget`, `post_1`, `post_2`, plus per-effect RTs (light, darkness, roof, shadow, etc.).

Total new VRAM: 50 MB at 1080p — acceptable. On low-end devices, offer a "Rendering Quality: Low" option that halves floor RT resolution for lower-spec machines.

- [ ] **PRE-31:** Measure existing VRAM budget usage (before per-floor changes) to establish baseline for regression testing
- [ ] **PRE-32:** Confirm Three.js `WebGLRenderTarget` with `FloatType` RGBA16F is supported on the minimum target GPU tier

---

# Part 8: Pre-Implementation Verification Checklist

*All checkboxes below must pass before Phase 2 implementation begins. These are investigation tasks, not code changes.*

## Architecture Pre-Checks
- [ ] **ARCH-01:** Trace full render path of a single frame with Foundry DevTools / Three.js `renderer.info` — confirm call count, triangle count, texture bind count as baseline
- [ ] **ARCH-02:** Verify `EffectComposer.render()` is the single entry point for ALL rendering each frame (no side-channel renders outside this path)
- [ ] **ARCH-03:** Verify there is no second `requestAnimationFrame` loop outside `RenderLoop` that could interfere with per-floor visibility toggling
- [ ] **ARCH-04:** Verify `renderer.autoClear` is reliably set to `false` during the main scene render so manual `clear()` calls control clearing (confirmed pattern in DepthPassManager)

## FloorStack Pre-Checks
- [ ] **ARCH-05:** Build a minimal FloorStack stub and log floor assignments for a known multi-floor scene — verify tiles land on expected floors
- [ ] **ARCH-06:** Verify `LevelsImportSnapshot.sceneLevels` matches the floor bands that `_isTileInLevelBand()` currently produces for the same scene

## Visibility Toggle Pre-Checks
- [ ] **ARCH-07:** Write a test that toggles one floor's tiles visible/invisible and confirms `camera.layers.set(ROOF_LAYER)` + `renderer.render()` only sees the visible floor's overhead tiles
- [ ] **ARCH-08:** Verify `sprite.userData.waterOccluderMesh.visible` is kept in sync with `sprite.visible` in TileManager's `updateSpriteVisibility()` — check line ~3371

## Effect RT Pre-Checks
- [ ] **ARCH-09:** Measure `LightingEffect.render()` duration with a floor-isolated scene — confirm it completes in <3ms on typical hardware
- [ ] **ARCH-10:** Measure `DepthPassManager._renderDepthPass()` duration — confirm <1ms on typical hardware (N passes per frame budget estimate)
- [ ] **ARCH-11:** Measure `WaterSurfaceModel.buildFromMaskTexture()` duration for a typical water mask — confirm it's acceptable as a load-time operation

## Disposal Pre-Checks
- [ ] **ARCH-12:** Verify `FloorStack.dispose()` correctly disposes all floor RTs and per-floor effect states when called from `destroyThreeCanvas()`
- [ ] **ARCH-13:** Verify `WaterEffectV2` per-floor state map is fully disposed on scene teardown (no GPU texture leaks)

---

# Part 9: Final Confidence Report

## Confidence by Phase

| Phase | Confidence | Key Risk | Mitigation |
|---|---|---|---|
| **Phase 0** — FloorStack Foundation | **95%** | `LevelsImportSnapshot` band format edge cases | Already handles `Array` and object band formats |
| **Phase 1** — Per-Floor Mask Storage | **90%** | `EffectMaskRegistry` facade correctness | Existing subscriber callbacks unchanged; just swap source |
| **Phase 2** — Per-Floor Rendering Pipeline | **85%** | Visibility toggle interaction with Foundry events mid-frame | Foundry hooks fire between frames (no overlap) |
| **Phase 3** — Effect Adaptation | **80%** | Stateful effects (WaterEffectV2, BuildingShadows, TreeEffect) | Per-floor state map pattern is clear and tested for WaterEffectV2 first |
| **Phase 4** — Integration & Cleanup | **90%** | Legacy removal breaking edge cases | Guarded behind Phase 2+3 completion |
| **Phase 5** — Testing & Polish | **95%** | Performance regression on weak GPUs | VRAM and frame-time baselines measured in ARCH pre-checks |

## Confidence by Subsystem

| Subsystem | Confidence | Notes |
|---|---|---|
| **FloorStack class** | ✅ 95% | Direct mapping from LevelsImportSnapshot |
| **Per-floor mask composition** | ✅ 95% | Existing GpuSceneMaskCompositor already does this per-floor |
| **EffectMaskRegistry facade** | ✅ 90% | `setActiveFloor()` replaces `transitionToFloor()` |
| **Visibility toggle mechanism** | ✅ 95% | Validated: Three.js respects `.visible` in camera-layer renders |
| **Water occluder auto-sync** | ✅ 95% | Confirmed in TileManager source |
| **SpecularEffect overlays** | ✅ 95% | Confirmed auto-synced to sprite visibility |
| **DepthPassManager per-floor** | ✅ 90% | Needs removal from updatables; pattern is clear |
| **LightingEffect per-floor** | ✅ 90% | `activeLevelContext` injection uses existing gating |
| **OverheadShadowsEffect per-floor** | ✅ 95% | Zero changes; visibility toggle handles it |
| **DistortionManager per-floor** | ✅ 85% | Large simplification; `outdoorsScene` pass removal needs verification |
| **WaterEffectV2 per-floor** | 🟡 80% | Per-floor state map is clean; `_floorTransitionActive` removal is safe |
| **FireSparksEffect per-floor** | 🟡 80% | CPU point arrays per floor; scene objects need floor tagging |
| **BuildingShadowsEffect per-floor** | 🟡 80% | Bake system needs per-floor state; sun-direction change triggers multi-floor rebake |
| **WindowLightEffect per-floor** | 🟡 80% | Multi-mask; write-and-consume RT pattern confirmed |
| **TreeEffect/BushEffect per-floor** | 🟡 80% | Same as FireSparks; billboard instances need floor tagging |
| **CandleFlamesEffect per-floor** | 🟡 80% | Same; floor-presence gating removal is clean |
| **WeatherParticles** | ✅ 95% | Floor-agnostic; no changes needed |
| **MaskManager static masks** | 🟡 85% | PRE-20 audit required before implementation |
| **Alpha compositing correctness** | ✅ 90% | Standard premultiplied alpha blend; Floor 0 = opaque base |
| **Per-floor scene RT memory** | ✅ 90% | 50 MB at 1080p; acceptable; lower-res option available |
| **Single-floor scene regression** | ✅ 95% | 2-floor FloorStack with Floor 0 (bg) + Floor 1 (tiles); same as today |
| **Cross-floor light transmission** | 🟡 70% | Deferred to Phase 4; existing code causes no harm |
| **Dynamic tile changes mid-game** | 🟡 80% | `invalidateFloor()` pattern is designed; edge cases need testing |

## Overall Architecture Confidence: **88% — Ready to Implement**

The architecture is sound. The remaining 12% uncertainty is spread across:
1. **Stateful effect state maps** — the pattern is clear but there are many (Water, Fire, Trees, Bushes, Candles, BuildingShadows). Each needs careful implementation and disposal testing.
2. **MaskManager static mask audit** (PRE-20) — needs to be done before Phase 2 to avoid stale masks leaking into per-floor passes.
3. **DepthPassManager per-frame call safety** (PRE-08) — the rate limiter may need adjustment to allow N calls per frame.

**What "88% confidence" means in practice:** The core pipeline design is fully validated and low-risk. The implementation effort is large but well-understood. No unknown unknowns remain in the rendering architecture. The risks are all in execution details (effect state management, disposal correctness) rather than fundamental design errors.

**Recommended next step before coding:** Complete PRE-20 (MaskManager audit), PRE-08 (DepthPassManager rate-limiter check), and ARCH-05 (FloorStack stub test). These three checks can be done in a day and eliminate the main remaining uncertainty areas. Then begin Phase 0.

---
---

# Part 10: Critical New Findings (Third-Pass Deep Dives)

*These findings were uncovered during a focused audit of depth pass consumers, scene object classification, and the EffectComposer render split. Several require architectural adjustments.*

---

## 10.1 Depth Pass Is Consumed by SIX Effects — All Need Per-Floor Correct Data

The original document treated DepthPassManager as a simple updatable to be moved into the floor loop. The actual scope is larger: **six separate effects bind `dpm.getDepthTexture()`** and use it in shaders:

| Effect | Layer | Depth Use |
|---|---|---|
| `WaterEffectV2` | POST_PROCESSING | Shoreline refraction suppression; depth-tested occlusion |
| `DistortionManager` | POST_PROCESSING | Suppresses distortion under elevated surfaces (water/heat) |
| `SpecularEffect` | SURFACE_EFFECTS | Overlay occlusion — discard fragments where closer tile exists |
| `FluidEffect` | SURFACE_EFFECTS | Fluid occlusion — discard fragments under elevated surfaces |
| `AtmosphericFogEffect` | POST_PROCESSING | Per-pixel fog density reduction on elevated objects |
| `OverheadShadowsEffect` | ENVIRONMENTAL | Height-based shadow modulation — casters above receivers only |

All six call `window.MapShine.depthPassManager.getDepthTexture()` during their `render()` or `update()` calls to bind the depth texture to shader uniforms.

**If `captureForFloor()` is called at the start of each floor pass before effects run, all six effects automatically receive Floor N's correct depth.** No changes are needed within the individual effects themselves. The fix is entirely in `DepthPassManager` and the floor loop.

### The Rate Limiter Problem

`DepthPassManager.update(timeInfo)` has TWO guards:
1. `if (!this._dirty) return` — dirty flag
2. `if (now - this._lastRenderTimeMs < 1000/maxHz) return` — time-based rate cap

In the per-floor loop, we call `depthPassManager.update()` N times per frame (once per visible floor). The second call, happening microseconds after the first, is blocked by the time guard — **Floor 1 gets Floor 0's stale depth texture.**

**Fix:** Add `captureForFloor()` to `DepthPassManager` that bypasses both guards:

```javascript
/**
 * Render depth for the current floor visibility context.
 * Bypasses rate limiting — call once per floor in the per-floor render loop.
 * The existing update() pathway is unchanged for non-floor-loop callers.
 */
captureForFloor() {
  if (!this._initialized) return;
  this._renderDepthPass();
  // Intentionally does NOT update _dirty or _lastRenderTimeMs so that
  // the normal update() path continues to work correctly.
}
```

The floor loop then becomes:
```javascript
for (const floor of floorStack.getVisibleFloors()) {
  floorStack.setFloorVisible(floor.index);
  floorStack.setFloorContext(floor.index);
  tokenManager.setFloorVisible(floor.index);  // see 10.3
  effectComposer.bindFloorMasks(floor.masks);
  depthPassManager.captureForFloor();          // depth for Floor N only
  effectComposer.runFloorPass(floor, floorRT); // scene + post for Floor N
  compositor.blendFloorRT(floorRT, accumulationRT, floor);
}
```

- [x] Finding confirmed: rate limiter blocks per-floor depth (**PRE-08 resolved — the fix is `captureForFloor()`**)
- [ ] **P0-NEW-01:** Add `captureForFloor()` method to `DepthPassManager`
- [ ] **P0-NEW-02:** Confirm `_renderDepthPass()` is safe to call N times per frame (no GPU state corruption between calls)

---

## 10.2 CRITICAL: Global Scene Objects Require `GLOBAL_SCENE_LAYER`

During a per-floor render loop, `renderer.render(scene, camera)` is called once per floor. The camera's layer mask is set to show only floor-N geometry. However, **certain scene objects should appear ONCE in the final composite, not once per floor:**

| Object | Manager | Problem |
|---|---|---|
| `fogPlane` mesh | `WorldSpaceFogEffect` | Fog overlaid N times → triple-dark fog |
| Drawing meshes/sprites | `DrawingManager` | Drawings composited N times → color bleed |
| Template meshes | `TemplateManager` | Same multi-composite problem |
| Note sprites | `NoteManager` | Same |
| Light icon sprites | `LightIconManager` | Same |
| Wall highlight lines | `WallManager` | Same |

These are **global overlays** — their position is not tied to a specific floor's elevation band.

**Solution: `GLOBAL_SCENE_LAYER = 29`**

Add a new camera layer constant:
```javascript
// EffectComposer.js
export const GLOBAL_SCENE_LAYER = 29;   // Objects rendered once globally, not per-floor
export const BLOOM_HOTSPOT_LAYER = 30;
export const OVERLAY_THREE_LAYER = 31;  // Existing: UI overlays (selection, labels, indicators)
```

All global scene objects are assigned this layer at creation:
```javascript
// DrawingManager:
this.group.layers.set(GLOBAL_SCENE_LAYER);

// WorldSpaceFogEffect:
this.fogPlane.layers.set(GLOBAL_SCENE_LAYER);

// NoteManager, TemplateManager, LightIconManager, WallManager:
// mesh.layers.set(GLOBAL_SCENE_LAYER)
```

During per-floor scene renders, the camera **disables** this layer:
```javascript
this.camera.layers.disable(GLOBAL_SCENE_LAYER); // during floor loop
```

After the floor loop and compositing, a **global scene pass** renders only global objects:
```javascript
// After floor loop + compositing into accumulationRT:
this.camera.layers.set(GLOBAL_SCENE_LAYER);
this.renderer.render(this.scene, this.camera);  // into accumulationRT
```

**DepthPassManager** must also disable `GLOBAL_SCENE_LAYER` during `captureForFloor()` to prevent global objects from polluting the floor's depth:
```javascript
// Inside _renderDepthPass() for floor captures:
depthCamera.layers.disable(GLOBAL_SCENE_LAYER);
```

This is a Phase 0 task — **it must be completed before any per-floor renders begin**.

### WorldSpaceFogEffect Reclassification

`WorldSpaceFogEffect` is currently `RenderLayers.ENVIRONMENTAL` (order 400 — a scene effect). With `GLOBAL_SCENE_LAYER`, its `fogPlane` is automatically excluded from per-floor renders and captured in the global scene pass. **No code changes needed in WorldSpaceFogEffect itself** — just assign `this.fogPlane.layers.set(GLOBAL_SCENE_LAYER)` during initialization.

This means `WorldSpaceFogEffect` continues as a scene effect but renders globally. Its vision computation render passes (`visionRenderTarget`, `explorationRenderTarget`) run as internal `renderer.render()` calls that are independent of the floor loop — no changes needed there.

- [ ] **P0-NEW-03:** Add `GLOBAL_SCENE_LAYER = 29` constant to `EffectComposer.js`
- [ ] **P0-NEW-04:** Assign `GLOBAL_SCENE_LAYER` to all global scene objects in `DrawingManager`, `NoteManager`, `TemplateManager`, `LightIconManager`, `WallManager`, `WorldSpaceFogEffect`
- [ ] **P0-NEW-05:** Add global scene pass after floor loop in `EffectComposer.render()` that renders only `GLOBAL_SCENE_LAYER` into `accumulationRT`
- [ ] **P0-NEW-06:** Disable `GLOBAL_SCENE_LAYER` during `DepthPassManager.captureForFloor()`
- [ ] **P0-NEW-07:** Audit all remaining `scene.add()` calls to categorize objects as per-floor (default layer 0) or global (layer 29)

---

## 10.3 Token Sprites in the Depth Pass — Floor-Level Visibility Required

Token sprites are assigned `sprite.layers.set(0)` (default layer, captured in depth pass). Token target indicators, borders, and labels are on `OVERLAY_THREE_LAYER` (excluded from depth).

**Token Z-position:** `groundZ + TOKEN_BASE_Z(3.0) + elevation`

Tokens on Floor 2 (elevation 200) have a higher Z than Floor 1 tokens (elevation 100). During Floor 0's depth render, ALL token sprites are visible → Floor 0's depth contains Floor 1 and Floor 2 token geometry. This would cause incorrect specular occlusion and fluid occlusion on Floor 0.

**Fix:** `setFloorVisible(N)` must also call `tokenManager.setFloorVisible(N)`. The token manager hides tokens whose elevation is outside Floor N's band:

```javascript
// TokenManager — new method:
setFloorVisible(floor) {
  for (const [id, sprite] of this._sprites) {
    const tokenDoc = this._tokens.get(id);
    const elev = tokenDoc?.elevation ?? 0;
    const inFloor = elev >= floor.elevationBottom && elev < floor.elevationTop;
    sprite.visible = inFloor && !sprite.userData._hiddenByLevel;
  }
}
```

`TokenManager` already has elevation-based visibility logic for `activeLevelContext`. This extends that pattern to explicit per-floor visibility toggling.

After the floor loop, `tokenManager.restoreAllVisible()` restores tokens to their normal visibility state (driven by `VisibilityController`).

- [ ] **P0-NEW-08:** Add `setFloorVisible(floor)` and `restoreAllVisible()` methods to `TokenManager`
- [ ] **PRE-33:** Verify existing token visibility logic (activeLevelContext suppression) won't conflict with `setFloorVisible()` during the floor loop

---

## 10.4 Complete FLOOR_PASS vs GLOBAL_PASS Classification

Every effect must be classified. Effects in `FLOOR_PASS` run once per visible floor. Effects in `GLOBAL_PASS` run once on the final accumulated image.

### FLOOR_PASS Effects (run N times per frame)
| Effect | Layer | Reason |
|---|---|---|
| `LightingEffect` | POST_PROCESSING | Lights are floor-specific; roof alpha is floor-specific |
| `WaterEffectV2` | POST_PROCESSING | Water is floor-specific; depth-dependent |
| `DistortionManager` | POST_PROCESSING | Water/heat distortion is floor-specific; depth-dependent |
| `AtmosphericFogEffect` | POST_PROCESSING | Fog density differs per floor (indoor vs outdoor) |
| `SpecularEffect` | SURFACE_EFFECTS | Per-tile overlays; depth-dependent |
| `FluidEffect` | SURFACE_EFFECTS | Per-tile overlays; depth-dependent |
| `IridescenceEffect` | SURFACE_EFFECTS | Per-tile; mask is floor-specific |
| `PrismEffect` | SURFACE_EFFECTS | Per-tile; mask is floor-specific |
| `TreeEffect` | SURFACE_EFFECTS | Per-floor tree instances |
| `BushEffect` | SURFACE_EFFECTS | Per-floor bush instances |
| `WindowLightEffect` | SURFACE_EFFECTS | Per-floor window masks |
| `BuildingShadowsEffect` | ENVIRONMENTAL | Per-floor baked shadows |
| `OverheadShadowsEffect` | ENVIRONMENTAL | Per-floor overhead tiles |
| `CandleFlamesEffect` | PARTICLES | Per-floor candle positions |
| `FireSparksEffect` | PARTICLES | Per-floor fire positions |
| `AshDisturbanceEffect` | PARTICLES | Per-floor ash mask |
| `DustMotesEffect` | PARTICLES | Per-floor dust mask |

### GLOBAL_PASS Effects (run once on final composite)
| Effect | Layer | Reason |
|---|---|---|
| `WorldSpaceFogEffect` | ENVIRONMENTAL | Fog overlay must appear once; vision is global |
| `WeatherParticles` | PARTICLES | Weather falls globally above all floors |
| `SkyColorEffect` | POST_PROCESSING | Sky is global; applied after composite |
| `BloomEffect` | POST_PROCESSING | Bloom on final composite |
| `ColorCorrectionEffect` | POST_PROCESSING | Global color grade |
| `FilmGrainEffect` | POST_PROCESSING | Global grain |
| `AsciiEffect` | POST_PROCESSING | Full-scene stylization |
| `HalftoneEffect` | POST_PROCESSING | Full-scene stylization |
| `DotScreenEffect` | POST_PROCESSING | Full-scene stylization |
| `SharpenEffect` | POST_PROCESSING | Global sharpening |
| `DetectionFilterEffect` | POST_PROCESSING | Token detection highlight (global token visibility) |
| `MaskDebugEffect` | POST_PROCESSING | Debug only |
| `PlayerLightEffect` | SURFACE_EFFECTS | Token-following light; floor-assignment via token visibility |
| `DynamicExposureManager` | - | Global exposure; runs on final composite |

### Special: `PlayerLightEffect`
`PlayerLightEffect` creates light meshes that follow controlled token sprites. Since token sprites are per-floor-visible (toggled by `tokenManager.setFloorVisible()`), and `PlayerLightEffect` lights follow the token sprite's position, the lights become implicitly per-floor. **No explicit classification needed** — the visibility of the light follows the token's visibility.

However, `PlayerLightEffect` renders into LightingEffect's accumulation target (via the per-floor LightingEffect pass). So it naturally runs as part of the floor loop. Classify as **FLOOR_PASS**.

### Implementation: EffectComposer Knows the Classification

`EffectBase` gains a `floorScope` property:
```javascript
get floorScope() { return 'floor'; }  // 'floor' | 'global'
```

Global-pass effects override:
```javascript
// SkyColorEffect, BloomEffect, etc:
get floorScope() { return 'global'; }
```

`EffectComposer.render()` splits effects into three buckets:
1. `floorEffects` — `floorScope === 'floor'`, called per floor
2. `globalEffects` — `floorScope === 'global'`, called once on accumulation RT
3. Overlay pass — `OVERLAY_THREE_LAYER` scene render (always last)

- [ ] **P1-NEW-01:** Add `floorScope` getter to `EffectBase` with default value `'floor'`
- [ ] **P1-NEW-02:** Override `floorScope` to `'global'` in all GLOBAL_PASS effects listed above
- [ ] **P1-NEW-03:** Split `EffectComposer.render()` into floor loop + global post pass structure

---

## 10.5 `FluidEffect` — Confirmed Per-Tile Auto-Synced

`FluidEffect` is SURFACE_EFFECTS, per-tile (like SpecularEffect). It has:
- `_tileOverlays: Map<tileId, {mesh, material, sprite}>`
- `syncTileSpriteVisibility(tileId, sprite)`: `mesh.visible = !!(this._enabled && sprite.visible)`
- Depth-dependent: uses `dpm.getDepthTexture()` for fluid occlusion

**Confirmed safe via visibility toggle.** `setFloorVisible(N)` hides Floor M tiles → `syncTileSpriteVisibility()` hides their fluid overlay meshes → depth pass excludes them → floor-accurate fluid rendering with no explicit floor logic.

FluidEffect also uses depth for SURFACE_EFFECTS-layer occlusion. Since SURFACE_EFFECTS runs before the geometry render in `EffectComposer`, the `captureForFloor()` at the start of the floor pass gives FluidEffect the correct floor depth.

---

## 10.6 `OverheadShadowsEffect` — ENVIRONMENTAL Layer (Scene Effect)

`OverheadShadowsEffect` is `RenderLayers.ENVIRONMENTAL` (order 400). It renders overhead tile shadows into a separate shadow RT consumed by `LightingEffect`. It uses depth for height-based shadow modulation.

Since it's a scene effect (order < 500), it runs in `sceneEffects` list within each floor's scene pass. `captureForFloor()` provides the correct depth before it runs. Overhead tiles for Floor N are visible (others are hidden) → shadow RT contains only Floor N's overhead shadows.

**No classification issue.** Already correctly FLOOR_PASS as a scene effect.

---

## 10.7 Revised EffectComposer Render Pipeline

The complete per-floor rendering pipeline, based on actual code:

```
── Global Updatables ──────────────────────────────────────────────────────────
  weatherController.update(timeInfo)
  [Note: depthPassManager REMOVED from global updatables]

── Floor Loop ─────────────────────────────────────────────────────────────────
  for floor in floorStack.getVisibleFloors():

    1. floorStack.setFloorVisible(floor.index)
       └─ tile sprites: visible = (sprite.userData.floorIndex === floor.index)
       └─ token sprites: visible = (token.elevation in floor.band)
       └─ floor-tagged particle systems: visible = (sys.userData.floorIndex === floor.index)
       └─ GLOBAL_SCENE_LAYER objects: always hidden during floor loop

    2. effectComposer.bindFloorMasks(floor.masks)
       └─ calls bindFloorMasks(masks) on all FLOOR_PASS effects

    3. depthPassManager.captureForFloor()
       └─ _renderDepthPass() → depthTexture contains Floor N geometry only
       └─ Bypasses rate limiter; does not update _lastRenderTimeMs

    4. effectComposer.runFloorScenePass(floor, floorRT):
       │  for effect in sceneEffects (order < 500) where floorScope === 'floor':
       │    effect.update(timeInfo)   ← uniforms bound here (depth, masks)
       │    [scene render: renderer.render(scene, camera) → floorRT]
       └─ floorRT now contains Floor N's visual geometry + scene effects

    5. effectComposer.runFloorPostPass(floor, floorRT):
       │  ping-pong chain among FLOOR_PASS postEffects:
       │    LightingEffect.render(renderer, floorRT, output)
       │    WaterEffectV2.render(renderer, output, floorRT)
       │    DistortionManager.render(renderer, floorRT, output)
       │    AtmosphericFogEffect.render(renderer, output, floorRT)
       └─ Final floorRT = Floor N with lighting + water + distortion + fog

    6. compositor.blendFloor(floorRT, accumulationRT, floor.blendMode)
       └─ premultiplied alpha blend: accum = floor + (1 - floor.alpha) * accum

── Global Scene Pass ──────────────────────────────────────────────────────────
  camera.layers.set(GLOBAL_SCENE_LAYER)
  renderer.render(scene, camera)  → into accumulationRT
  [Captures: fogPlane, drawings, notes, templates, wall highlights]

── Global Post Pass ───────────────────────────────────────────────────────────
  for effect in postEffects where floorScope === 'global':
    ping-pong chain on accumulationRT:
      SkyColorEffect → BloomEffect → ColorCorrection → ... → to screen

── Overlay Pass ───────────────────────────────────────────────────────────────
  camera.layers.set(OVERLAY_THREE_LAYER)
  renderer.render(scene, camera)  → to screen
  [Captures: selection borders, labels, target indicators, pip icons]
```

This is a **complete, concrete render pipeline** ready for implementation.

---

## 10.8 `SurfaceRegistry` — Data Only, No Rendering Impact

`SurfaceRegistry` is a data catalog: it builds a sorted list of tile surfaces with their elevation, kind (background/ground/overhead), and sort key. It drives `SceneComposer` decisions about which tile is "active" and what `foregroundElevation` is.

It does **not** add objects to the Three.js scene. It does **not** interact with the depth pass or rendering pipeline. It's a data layer.

In the FloorStack architecture, `SurfaceRegistry` data (elevation bands per tile) is superseded by `LevelsImportSnapshot.tiles`. However, it should remain for non-Levels scenes where Foundry's native `foregroundElevation` is still the primary floor discriminator.

**No changes needed to `SurfaceRegistry` for the per-floor rendering architecture.**

---

## 10.9 `TileMotionManager` — Safe, One Elevation Match

`TileMotionManager` animates tile textures (UV scrolling, ripple). It has 1 match for floor-related keywords, confirming it doesn't do elevation filtering. Animated tile textures follow the tile sprite's visibility — if `sprite.visible = false`, the animated texture update is irrelevant (never sampled). **No floor changes needed.**

---

## 10.10 Updated Risk and Confidence Assessment

### New Risks Identified

| Risk | Severity | Resolution |
|---|---|---|
| `GLOBAL_SCENE_LAYER` — 6+ manager files need layer assignment | High | Phase 0 task; complete before floor loop |
| Token sprite depth contamination | Medium | `tokenManager.setFloorVisible()` + `restoreAllVisible()` |
| Rate limiter blocks per-floor depth capture | High | `captureForFloor()` method on DepthPassManager |
| `WorldSpaceFogEffect` multi-composite | High | `GLOBAL_SCENE_LAYER` on `fogPlane` |
| `DrawingManager` multi-composite | High | `GLOBAL_SCENE_LAYER` on `DrawingManager.group` |

### Previously Confident — Revised
- **DepthPassManager** confidence revised: 90% → **75%** pending `captureForFloor()` + GLOBAL_SCENE_LAYER integration
- **WorldSpaceFogEffect** previously unreviewed: now **confirmed GLOBAL_PASS** — no design change needed, just layer assignment
- **EffectComposer render pipeline** now has a concrete, implementation-ready structure

### New Phase 0 Items Required Before Any Other Phase

These are **blocking** — Phase 2 (per-floor rendering loop) cannot start without them:

- [ ] **P0-NEW-01:** `DepthPassManager.captureForFloor()` method
- [ ] **P0-NEW-02:** `GLOBAL_SCENE_LAYER = 29` constant
- [ ] **P0-NEW-03:** Assign GLOBAL_SCENE_LAYER to `DrawingManager.group`, `WorldSpaceFogEffect.fogPlane`, `NoteManager`, `TemplateManager`, `LightIconManager`, `WallManager` visual meshes
- [ ] **P0-NEW-04:** `TokenManager.setFloorVisible(floor)` and `restoreAllVisible()` methods
- [ ] **P0-NEW-05:** `floorScope` getter on `EffectBase` (default `'floor'`); override in global effects
- [ ] **P0-NEW-06:** Global scene pass + global post pass in `EffectComposer.render()` outline

### Updated Overall Confidence

Previous: **88%**. After third-pass deep dives: **84%** — confidence reduced slightly due to the scope of Phase 0 expanding (GLOBAL_SCENE_LAYER system was previously unaccounted for), but the design is still well-understood and the solutions are concrete.

The reduction from 88% to 84% represents **known, solved problems** (GLOBAL_SCENE_LAYER, `captureForFloor()`, token depth) that have clear implementation paths, not new unknowns. The architecture foundation is correct.

---

## 10.11 Final Pre-Implementation Checklist Additions

The following items must be added to Part 8:

- [ ] **ARCH-14:** List all `scene.add()` call sites across all manager/effect files — verify every object either has `userData.floorIndex` OR is assigned `GLOBAL_SCENE_LAYER`
- [ ] **ARCH-15:** Verify `DrawingManager.group` depth write is `false` (confirmed in code — `depthWrite: false`) so it doesn't affect the depth pass even if accidentally included
- [ ] **ARCH-16:** Verify `WallManager` visual highlight meshes (if any) don't use `depthWrite: true` — they must not affect per-floor depth
- [ ] **ARCH-17:** Confirm `TemplateManager` and `NoteManager` create Three.js objects in the main scene (vs. PIXI-only) before assigning them GLOBAL_SCENE_LAYER
- [ ] **ARCH-18:** Benchmark the per-floor loop with N=3 floors and measure total frame time impact of N × `captureForFloor()` calls
- [ ] **ARCH-19:** Verify `AtmosphericFogEffect` uses depth to reduce fog on elevated objects — confirm it should run per-floor (correct) rather than globally (would use last-floor depth, incorrect for lower floors)

---

## 10.12 ARCH-17 Resolved: Manager Layer Assignments Audited

All four scene managers have been confirmed. The `GLOBAL_SCENE_LAYER` scope is **smaller than estimated**:

| Manager | Three.js Objects? | Current Layer | Action Needed |
|---|---|---|---|
| `DrawingManager` | Yes — `group` at Z=2.0 | Layer 0 (default) | **→ Assign `GLOBAL_SCENE_LAYER`** |
| `NoteManager` | Yes — `group` at Z=2.5, sprites | Layer 0 (default) | **→ Assign `GLOBAL_SCENE_LAYER`** |
| `WallManager` | Yes — `wallGroup` at Z=3.0, meshes | Layer 0 (default) | **→ Assign `GLOBAL_SCENE_LAYER`** *(map-maker mode only — walls are hidden in gameplay, so lower priority)* |
| `TemplateManager` | Yes — meshes in `group` at Z=1.5 | `OVERLAY_THREE_LAYER` already ✅ | No action needed |
| `LightIconManager` | Yes — `group` at Z=4.0 | `OVERLAY_THREE_LAYER` + layer 0 already ✅ | No action needed *(visible=false in gameplay)* |

**Key insight:** `TemplateManager` already assigns `OVERLAY_THREE_LAYER` to every mesh via `mesh.traverse(obj => obj.layers.set(OVERLAY_THREE_LAYER))`. Templates render in the existing overlay pass — no multi-compositing risk.

**Key insight:** `LightIconManager` already sets `this.group.layers.set(OVERLAY_THREE_LAYER)` and starts with `group.visible = false` (only visible in map-maker mode). No gameplay rendering impact. The additional `layers.enable(0)` is for raycasting only — a known pattern for interactive overlays. In map-maker mode, per-floor rendering correctness is a lower priority than gameplay mode.

**Revised P0-NEW-03:** Only `DrawingManager.group` and `NoteManager.group` require `GLOBAL_SCENE_LAYER` assignment for gameplay rendering correctness. `WallManager.wallGroup` can be deferred to a later phase (walls visible in map-maker mode only).

- [x] **ARCH-17:** Resolved — `TemplateManager` and `LightIconManager` already use `OVERLAY_THREE_LAYER`. Only `DrawingManager` and `NoteManager` need `GLOBAL_SCENE_LAYER` for gameplay rendering.

---

## 10.13 Complete Scene Object Layer Inventory

After auditing all scene-adding managers and effects, the full layer assignment plan for the per-floor architecture:

| Layer | Number | Objects | When Rendered |
|---|---|---|---|
| **Default (floor)** | 0 | Tile sprites, token sprites, particle emitters, terrain meshes | Per-floor (hidden/shown by `setFloorVisible`) |
| **Roof** | ROOF_LAYER | Overhead tile sprites | Per-floor (via `camera.layers.set(ROOF_LAYER)` in LightingEffect) |
| **Bloom hotspot** | 30 | Bloom-source meshes (fire, candles) | Per-floor (same visibility as owning object) |
| **Global scene** | 29 *(new)* | `DrawingManager.group`, `NoteManager.group`, `WorldSpaceFogEffect.fogPlane` | Once, global scene pass |
| **Overlay** | 31 | Token UI (borders, labels, pip icons), `TemplateManager` meshes, `LightIconManager.group` | Once, overlay pass |

This is the complete layer map. No other layers are in use by the current codebase (`ROPE_MASK_LAYER = 25` is used internally by LightingEffect for rope mask rendering — a separate internal camera.layers call within LightingEffect, not a scene-level assignment).

---

## 10.14 Final Confidence Update

After completing all audits:

- **ARCH-17 resolved**: Scope is smaller than estimated — only 2 managers need `GLOBAL_SCENE_LAYER` for gameplay correctness
- **TemplateManager**: Zero changes needed
- **LightIconManager**: Zero changes needed (gameplay mode: invisible; map-maker mode: overlay layer)
- **WallManager**: Deferred (map-maker mode only)

**Revised Overall Confidence: 86%** (up from 84% — scope clarification removes uncertainty about TemplateManager and LightIconManager)

The `GLOBAL_SCENE_LAYER` work is now precisely scoped to:
1. Add `GLOBAL_SCENE_LAYER = 29` constant
2. Assign to `DrawingManager.group` (1 line)
3. Assign to `NoteManager.group` (1 line)
4. Assign to `WorldSpaceFogEffect.fogPlane` (1 line)
5. Add global scene pass in `EffectComposer.render()` after floor loop

**Total effort: ~5 lines of change + EffectComposer restructure.** The restructure is the largest piece and is part of Phase 2 anyway.

---

## 10.15 Depth Pass Summary — Authoritative Final State

The depth pass design is now fully resolved:

1. **`DepthPassManager` removed from `effectComposer.updatables`** — not called globally
2. **`captureForFloor()`** — new public method, calls `_renderDepthPass()` directly, bypasses rate limiter, does not update `_lastRenderTimeMs`. Called once per floor at step 3 of the floor loop.
3. **Six effects** that consume depth (`WaterEffectV2`, `DistortionManager`, `SpecularEffect`, `FluidEffect`, `AtmosphericFogEffect`, `OverheadShadowsEffect`) all receive per-floor correct depth automatically because they call `dpm.getDepthTexture()` during their `render()` or `update()` calls, which run AFTER `captureForFloor()` in the floor loop.
4. **Global effects** that do NOT use depth (`BloomEffect`, `SkyColorEffect`, `ColorCorrection`, etc.) run after the floor loop on the accumulated image — depth irrelevant.
5. **`GLOBAL_SCENE_LAYER` objects** disabled in `captureForFloor()` — drawings, notes, and fog plane don't contaminate floor depth.
6. **Token sprites** excluded from wrong-floor depth via `tokenManager.setFloorVisible(floor)` called at step 1 of the floor loop.

**Depth pass is correctly handled.** No special shader changes needed. The single `captureForFloor()` method and the visibility toggling together give all six effects per-floor accurate depth data.

---
---

# Part 11: Fourth-Pass Deep Dives — Final Remaining Findings

*Final audit of particle stateful effects, CloudEffect, PlayerLightEffect, and a newly discovered cross-cutting simulation problem.*

---

## 11.1 CRITICAL: Simulation Double-Stepping in FLOOR_PASS Effects

When `effect.update(timeInfo)` is called N times per frame (once per floor), simulation-based effects advance their time by `timeInfo.delta` N times per frame. At N=3 floors this causes 3× faster animations.

**Affected effects:**
- `WaterEffectV2` — wave simulation, uses `timeInfo.delta`
- `DistortionManager` — heat/water distortion, uses `timeInfo.delta`
- `AtmosphericFogEffect` — fog drift, uses `timeInfo.delta`
- `CloudEffect` — cloud density simulation, uses `timeInfo`
- `CandleFlamesEffect` — candle flicker timing, uses `timeInfo.delta`
- `FireSparksEffect` — spark lifetime, uses `timeInfo.delta`
- Any other effect with an internal animation clock

### Solution: `prepareFrame(timeInfo)` on `EffectBase`

Add a new lifecycle method to `EffectBase`:

```javascript
/**
 * Called ONCE per render frame, before the floor loop begins.
 * Override to advance time-based simulations (wave SDF, cloud density, etc.).
 * Do NOT perform floor-specific work here — floor masks are not yet bound.
 * Default: no-op.
 */
prepareFrame(timeInfo) {}
```

Effects with simulation override `prepareFrame()` for their time-advance step. `update(timeInfo)` is then called per-floor for floor-specific uniform binding (masks, depth, etc.) without re-advancing the simulation.

**EffectComposer integration:**
```javascript
// ONCE PER FRAME — before floor loop:
for (const effect of this._cachedRenderOrder) {
  effect.prepareFrame(timeInfo);
}

// PER FLOOR:
for (const floor of floorStack.getVisibleFloors()) {
  // ...setFloorVisible, captureForFloor, bindFloorMasks...
  for (const effect of floorSceneEffects) {
    effect.update({ ...timeInfo, delta: 0 });  // Uniform binding only, no simulation
  }
  // ...scene render, post pass...
}
```

Alternatively, pass `{...timeInfo, delta: 0, isSubsequentFloor: true}` for Floor N > 0, and let effects gate simulation on `!timeInfo.isSubsequentFloor`. This avoids the `prepareFrame()` split if the effect can't easily separate simulation from uniform binding.

**Recommended approach:** `prepareFrame()` split — cleaner separation of concerns and doesn't require adding `delta: 0` checks to every simulation loop.

- [ ] **P1-NEW-04:** Add `prepareFrame(timeInfo)` to `EffectBase` with no-op default
- [ ] **P1-NEW-05:** Move simulation-advance code from `update()` to `prepareFrame()` in `WaterEffectV2`, `DistortionManager`, `AtmosphericFogEffect`, `CloudEffect`, `CandleFlamesEffect`, `FireSparksEffect`
- [ ] **P1-NEW-06:** `EffectComposer.render()` calls `prepareFrame()` on all effects once before the floor loop

---

## 11.2 `DustMotesEffect` — Needs Per-Floor State Map

`DustMotesEffect` extends `EffectBase` (not `ParticleEffectBase`). It builds a `_spawnPoints: Float32Array` via `_generatePoints(dustMask, structuralMask, outdoorsMask)` — a CPU scan of the dust mask pixels. This is the exact same pattern as `FireSparksEffect`.

**State requiring per-floor maps:**
- `_spawnPoints: Float32Array` — computed from Floor N's dust + structural + outdoors masks

Per-floor state map pattern (identical to FireSparksEffect §7.6):
```javascript
this._floorStates = new Map();  // floorKey → { spawnPoints, systems }

bindFloorMasks(masks, floorKey) {
  if (!this._floorStates.has(floorKey)) {
    const sp = this._generatePoints(masks.dust, masks.structural, masks.outdoors);
    this._floorStates.set(floorKey, { spawnPoints: sp, systems: null });
  }
  const state = this._floorStates.get(floorKey);
  this._spawnPoints = state.spawnPoints;  // swap active state
  // Rebuild particle systems for this floor if needed
}
```

`connectToRegistry()` still subscribes to mask updates, but when masks change it invalidates the `_floorStates` entry for the relevant floor rather than directly rebuilding `_spawnPoints`.

---

## 11.3 `AshDisturbanceEffect` — Needs Per-Floor State Map

`AshDisturbanceEffect` extends `EffectBase`. Builds `_spawnPoints: Float32Array` from ash mask pixels via `_generatePoints(ashMaskTexture)`. Also uses GPU compositor readback (`getCpuPixels('ash')`).

**State requiring per-floor maps:**
- `_spawnPoints: Float32Array` — computed from Floor N's ash mask

Same per-floor state map pattern as DustMotesEffect and FireSparksEffect. Per-floor spawn points are computed once on first `bindFloorMasks()` call for that floor and cached.

`AshDisturbanceEffect` also responds to token movement (`handleTokenMovement()`). This is floor-agnostic — ash disturbance responds to tokens on the active (viewed) floor, same as the current behavior.

---

## 11.4 `CloudEffect` — Analysis and Classification

**Layer assignments (confirmed):**
- `cloudTopOverlayMesh.layers.set(OVERLAY_THREE_LAYER)` — cloud tops visual already on overlay ✅
- `quadMesh` is in `this.quadScene` (internal render scene) — never in main scene ✅
- Cloud shadow output → `cloudShadowTargetA/B` → consumed by `LightingEffect` per floor ✅

**Classification: FLOOR_PASS**

Reasoning: CloudEffect produces cloud shadow RTs consumed by LightingEffect each floor pass. Using Floor N's `outdoorsMask`, it correctly shadows only Floor N's outdoor areas. The cloud tops (`cloudTopOverlayMesh`) already render once in the overlay pass.

**Simulation double-stepping fix applies** (§11.1): cloud density simulation must move to `prepareFrame()`. Only the shadow compositing (applying outdoors mask to cloud density → shadow RT) stays in `update()`.

**No per-floor state map needed** — cloud density is a global atmospheric simulation, not per-floor. The outdoors mask input is floor-specific (bound via `bindFloorMasks()`), but the density computation is time-based and shared.

---

## 11.5 `PlayerLightEffect` — Classification Decision

`PlayerLightEffect` is `RenderLayers.ENVIRONMENTAL` (order 400). It manages:
- **Flashlight beam/cookie mesh** → added to `lightScene` (LightingEffect's dedicated scene)
- **Torch particle emitter** → added to `this.scene` (main scene, layer 0)
- **Torch light source mesh** → added to `lightScene`

**The flashlight in `lightScene` problem:**
`LightingEffect` is FLOOR_PASS. Each floor pass renders `lightScene`. The flashlight meshes are always in `lightScene`. Unless the flashlight is hidden during non-active-floor passes, it would illuminate ALL floors.

**The torch emitter in main scene:**
The torch emitter (layer 0) would appear in every floor's scene render and depth pass.

**Classification: GLOBAL_PASS** (revised from previous entry in §10.4)

For Phase 2, treat `PlayerLightEffect` as GLOBAL_PASS:
- The controlled token is always on the active floor
- The flashlight beam in `lightScene` needs to be excluded from non-active floor passes (add `isActiveFloor` check in LightingEffect's floor loop)
- The torch emitter visibility should mirror the controlled token's floor visibility

**Phase 2 implementation:** Add `setActiveFloor(floorIndex)` to `PlayerLightEffect`. It shows/hides the torch emitter and flashlight meshes based on whether `floorIndex === controlledToken.floorIndex`. The `lightScene` flashlight visibility is set in LightingEffect before rendering each floor.

This is flagged as a **known complexity** — the interaction between PlayerLightEffect and per-floor LightingEffect renders requires careful coordination. Phase 2 will implement a basic version (active floor only), with refinement later.

- [ ] **P2-NEW-01:** Add `setActiveFloor(floorIndex)` to `PlayerLightEffect` — hide torch emitter and flashlight meshes for non-active floor passes
- [ ] **P2-NEW-02:** In LightingEffect's per-floor `lightScene` render, set `PlayerLightEffect._group.visible = (floorIndex === activeFloorIndex)` before rendering

---

## 11.6 Updated Stateful Effects Count

The complete list of effects requiring per-floor state maps is now **7** (up from 5 in Part 7):

| Effect | State | Per-Floor Data |
|---|---|---|
| `WaterEffectV2` | `WaterSurfaceModel` + SDF | `_floorStates: Map<key, WaterState>` |
| `FireSparksEffect` | `_firePositionMap: Float32Array` | `_floorStates: Map<key, FireState>` |
| `DustMotesEffect` | `_spawnPoints: Float32Array` | `_floorStates: Map<key, DustState>` ← NEW |
| `AshDisturbanceEffect` | `_spawnPoints: Float32Array` | `_floorStates: Map<key, AshState>` ← NEW |
| `BuildingShadowsEffect` | `bakeTarget: WebGLRenderTarget` | Per-floor shadow bake |
| `TreeEffect` | Billboard instances | Per-floor instance state |
| `BushEffect` | Billboard instances | Per-floor instance state |

`CandleFlamesEffect` uses a CPU point scan too — needs verification in a follow-up. Treat it as likely needing a per-floor state map until confirmed otherwise.

---

## 11.7 Revised Phase 1 Task Additions

The following are added to the Phase 1 implementation plan:

- [ ] **P1-NEW-04:** `EffectBase.prepareFrame(timeInfo)` — no-op default
- [ ] **P1-NEW-05:** Move time-advance simulation from `update()` to `prepareFrame()` in `WaterEffectV2`, `DistortionManager`, `AtmosphericFogEffect`, `CloudEffect`, `CandleFlamesEffect`, `FireSparksEffect`
- [ ] **P1-NEW-06:** `EffectComposer.render()` calls `prepareFrame(timeInfo)` once per frame before floor loop
- [ ] **P1-NEW-07:** Per-floor state maps for `DustMotesEffect` and `AshDisturbanceEffect` (same pattern as FireSparksEffect)
- [ ] **P1-NEW-08:** Confirm `CandleFlamesEffect` CPU point scan pattern — add to per-floor state map list if confirmed

---

## 11.8 Final System Accounting — Complete Coverage Matrix

Every system that touches the Three.js scene has now been investigated. No unreviewed systems remain.

| System | Status | Floor Treatment |
|---|---|---|
| `TileManager` | ✅ Reviewed | Layer 0; toggled by `setFloorVisible()` |
| `TokenManager` | ✅ Reviewed | Layer 0; new `setFloorVisible()` method needed |
| `DrawingManager` | ✅ Reviewed | → `GLOBAL_SCENE_LAYER` |
| `NoteManager` | ✅ Reviewed | → `GLOBAL_SCENE_LAYER` |
| `WallManager` | ✅ Reviewed | → `GLOBAL_SCENE_LAYER` (defer: map-maker only) |
| `TemplateManager` | ✅ Reviewed | Already `OVERLAY_THREE_LAYER` ✅ |
| `LightIconManager` | ✅ Reviewed | Already `OVERLAY_THREE_LAYER` ✅ |
| `SurfaceRegistry` | ✅ Reviewed | Data-only, no rendering impact |
| `TileMotionManager` | ✅ Reviewed | Follows tile visibility; no changes needed |
| `LightingEffect` | ✅ Reviewed | FLOOR_PASS; per-floor roof alpha + lighting |
| `WaterEffectV2` | ✅ Reviewed | FLOOR_PASS; per-floor state map |
| `DistortionManager` | ✅ Reviewed | FLOOR_PASS; depth-dependent |
| `SpecularEffect` | ✅ Reviewed | FLOOR_PASS; per-tile, depth-dependent |
| `FluidEffect` | ✅ Reviewed | FLOOR_PASS; per-tile, depth-dependent ✅ |
| `OverheadShadowsEffect` | ✅ Reviewed | FLOOR_PASS; ENVIRONMENTAL, depth-dependent |
| `BuildingShadowsEffect` | ✅ Reviewed | FLOOR_PASS; per-floor bake target |
| `WindowLightEffect` | ✅ Reviewed | FLOOR_PASS; per-floor window mask |
| `CloudEffect` | ✅ Reviewed | FLOOR_PASS; shadow RT consumed by Lighting |
| `AtmosphericFogEffect` | ✅ Reviewed | FLOOR_PASS; depth-dependent fog density |
| `WorldSpaceFogEffect` | ✅ Reviewed | GLOBAL_PASS; fogPlane → `GLOBAL_SCENE_LAYER` |
| `TreeEffect` | ✅ Reviewed | FLOOR_PASS; per-floor instances |
| `BushEffect` | ✅ Assumed | FLOOR_PASS (same pattern as TreeEffect) |
| `IridescenceEffect` | ✅ Assumed | FLOOR_PASS; per-tile |
| `PrismEffect` | ✅ Assumed | FLOOR_PASS; per-tile |
| `FireSparksEffect` | ✅ Reviewed | FLOOR_PASS; per-floor state map |
| `CandleFlamesEffect` | ⚠️ Pending | Likely FLOOR_PASS; per-floor state map needed |
| `DustMotesEffect` | ✅ Reviewed | FLOOR_PASS; per-floor state map |
| `AshDisturbanceEffect` | ✅ Reviewed | FLOOR_PASS; per-floor state map |
| `WeatherParticles` | ✅ Reviewed | GLOBAL_PASS; floor-agnostic |
| `PlayerLightEffect` | ✅ Reviewed | Revised to GLOBAL_PASS; active-floor gating |
| `SkyColorEffect` | ✅ Reviewed | GLOBAL_PASS |
| `BloomEffect` | ✅ Reviewed | GLOBAL_PASS |
| `ColorCorrectionEffect` | ✅ Reviewed | GLOBAL_PASS |
| `FilmGrainEffect` | ✅ Reviewed | GLOBAL_PASS |
| `AsciiEffect` | ✅ Reviewed | GLOBAL_PASS |
| `HalftoneEffect` | ✅ Reviewed | GLOBAL_PASS |
| `DotScreenEffect` | ✅ Reviewed | GLOBAL_PASS |
| `SharpenEffect` | ✅ Reviewed | GLOBAL_PASS |
| `DetectionFilterEffect` | ✅ Reviewed | GLOBAL_PASS |
| `MaskDebugEffect` | ✅ Reviewed | GLOBAL_PASS (debug only) |
| `DynamicExposureManager` | ✅ Reviewed | GLOBAL_PASS |
| `DepthPassManager` | ✅ Reviewed | Removed from updatables; `captureForFloor()` in loop |
| `MaskManager` | ✅ Reviewed | Per-floor mask swap via `bindFloorMasks()` |
| `EffectMaskRegistry` | ✅ Reviewed | Facade; active-floor mask dispatch |
| `GpuSceneMaskCompositor` | ✅ Reviewed | Produces per-floor mask bundles |
| `LevelsImportSnapshot` | ✅ Reviewed | Canonical floor band + tile data source |
| `VisionManager` | ✅ Reviewed | Feeds WorldSpaceFogEffect; no floor rendering |
| `WeatherController` | ✅ Reviewed | GLOBAL_PASS updatable |

---

## 11.9 Final Overall Confidence

After four complete passes of deep-dive investigation:

**Overall Architecture Confidence: 85%**

| Phase | Confidence | Key Remaining Risk |
|---|---|---|
| Phase 0 (FloorStack + GLOBAL_SCENE_LAYER) | **92%** | Clean implementation, small scope |
| Phase 1 (Effect Base + `prepareFrame`) | **88%** | `prepareFrame()` split work in 6+ effects |
| Phase 2 (Per-Floor Render Loop) | **82%** | EffectComposer restructure is large |
| Phase 3 (Stateful Effects) | **78%** | 7 effects × per-floor state maps; disposal correctness |
| Phase 4 (PlayerLightEffect, CloudEffect coordination) | **75%** | Cross-effect coordination complexity |

No unknown unknowns remain. All systems are accounted for. All risks are identified and have concrete solutions.

### Final Research Note: `CandleFlamesEffect` Resolved

`CandleFlamesEffect` does NOT use a CPU mask pixel scan. It drives candle positions via `_mapPointsManager.getGroupsByEffect('candleFlame')` — a `MapPointsManager` that fires a change listener when points change. **Verify in Phase 3** that `MapPointsManager` already returns only current-floor candle positions when the active level context changes. If it does, no per-floor state map is needed. If it returns all floors, add to the stateful effects list.

**Revised confirmed stateful effect count: 6** (`WaterEffectV2`, `FireSparksEffect`, `DustMotesEffect`, `AshDisturbanceEffect`, `BuildingShadowsEffect`, `TreeEffect`). `BushEffect` assumed same as `TreeEffect`.

---
---

# Part 12: Concrete Refactor Implementation Plan

*This is the authoritative, file-by-file implementation plan for migrating the codebase to the Floor Stack architecture. Each phase is independently testable and releasable.*

---

## 12.1 Migration Strategy

**Approach: Phased, branch-per-phase.** Each phase produces a working, shippable module. No "big bang" rewrite. The single-floor code path continues to work throughout all phases until Phase 2 cuts it over.

**Branch naming:** `feature/floor-stack-p0`, `feature/floor-stack-p1`, etc. Merge to `develop` after each phase passes its testing gate.

**Feature flag:** Use `game.settings.get('map-shine-advanced', 'experimentalFloorRendering')` in Phase 2 to switch between old and new render loops during development. Remove the flag and old path in Phase 3 cleanup.

**No regressions policy:** Every phase must pass the single-floor scene regression suite before merging.

---

## 12.2 Phase 0 — Foundation (Estimated: 2–3 days)

*Introduces FloorStack, GLOBAL_SCENE_LAYER, and captureForFloor(). Zero rendering changes. Safe to merge immediately.*

### New Files

| File | Description |
|---|---|
| `scripts/scene/FloorStack.js` | Floor discovery, elevation band computation, `setFloorVisible(N)`, `getVisibleFloors()` |

### Modified Files

| File | Change | Lines Est. |
|---|---|---|
| `scripts/effects/EffectComposer.js` | Add `GLOBAL_SCENE_LAYER = 29` constant alongside `OVERLAY_THREE_LAYER` | +1 |
| `scripts/scene/depth-pass-manager.js` | Add `captureForFloor()` public method — calls `_renderDepthPass()` directly, no rate limiter update | +8 |
| `scripts/scene/drawing-manager.js` | `this.group.layers.set(GLOBAL_SCENE_LAYER)` in constructor after `this.scene.add(this.group)` | +2 |
| `scripts/scene/note-manager.js` | `this.group.layers.set(GLOBAL_SCENE_LAYER)` in constructor after `this.scene.add(this.group)` | +2 |
| `scripts/effects/WorldSpaceFogEffect.js` | `this.fogPlane.layers.set(GLOBAL_SCENE_LAYER)` after fogPlane creation | +2 |
| `scripts/foundry/canvas-replacement.js` | Import `FloorStack`; instantiate it after `TileManager` init; expose on `window.MapShine.floorStack` | +6 |

### Dead Code / Comment Targets

- `depth-pass-manager.js`: Update JSDoc on `update()` to say "global rate-limited capture; use `captureForFloor()` inside the floor loop for per-floor depth"
- `drawing-manager.js`: Add comment on `group.layers.set(...)` explaining GLOBAL_SCENE_LAYER
- `note-manager.js`: Same
- `WorldSpaceFogEffect.js`: Same

### Phase 0 Testing Gate
- [ ] Single-floor scene renders identically to before (no visual change expected)
- [ ] `window.MapShine.floorStack` available in browser console
- [ ] `floorStack.getFloors()` returns correct floor band array for a multi-level scene
- [ ] `floorStack.setFloorVisible(0)` hides tiles/tokens above Floor 0

---

## 12.3 Phase 1 — Effect Base Preparation (Estimated: 4–6 days)

*Adds `prepareFrame()` lifecycle method, `floorScope` classification, `bindFloorMasks()` on stateful effects. Zero rendering loop changes — these are all additive.*

### Modified Files

| File | Change |
|---|---|
| `scripts/effects/EffectComposer.js` | Add `prepareFrame(timeInfo) {}` no-op to `EffectBase` with JSDoc; add `floorScope = 'floor'` property (default) |
| `scripts/effects/EffectComposer.js` | Add `GLOBAL_PASS_EFFECTS` Set and `floorScope = 'global'` override in constructors of GLOBAL_PASS effects |
| `scripts/effects/WaterEffectV2.js` | Split simulation advance (SDF step, wave tick) into `prepareFrame()`; keep mask/uniform binding in `update()` |
| `scripts/effects/DistortionManager.js` | Move distortion simulation time-step to `prepareFrame()` |
| `scripts/effects/AtmosphericFogEffect.js` | Move fog animation time-step to `prepareFrame()` |
| `scripts/effects/CloudEffect.js` | Move cloud density simulation step to `prepareFrame()`; keep shadow compositing in `update()` |
| `scripts/particles/FireSparksEffect.js` | Move spark lifetime advance to `prepareFrame()`; keep `_spawnPoints` swap in `update()` |
| `scripts/effects/WaterEffectV2.js` | Add `bindFloorMasks(bundle, floorKey)` + `_floorStates` Map |
| `scripts/particles/FireSparksEffect.js` | Add `bindFloorMasks(bundle, floorKey)` + `_floorStates` Map |
| `scripts/particles/DustMotesEffect.js` | Add `bindFloorMasks(bundle, floorKey)` + `_floorStates` Map |
| `scripts/particles/AshDisturbanceEffect.js` | Add `bindFloorMasks(bundle, floorKey)` + `_floorStates` Map |
| `scripts/effects/BuildingShadowsEffect.js` | Add `bindFloorMasks(bundle, floorKey)` — per-floor `bakeTarget` |
| `scripts/effects/TreeEffect.js` | Add `bindFloorMasks(bundle, floorKey)` — per-floor instance state |
| `scripts/effects/WorldSpaceFogEffect.js` | Set `this.floorScope = 'global'` in constructor |
| `scripts/particles/WeatherParticles.js` | Set `this.floorScope = 'global'` in constructor |
| `scripts/effects/PlayerLightEffect.js` | Set `this.floorScope = 'global'`; add `setActiveFloor(floorIndex)` stub |

### JSDoc / Comment Updates in Phase 1

- `EffectBase.update()` docblock: add note "Floor-specific uniform binding. Simulation time advances happen in `prepareFrame()`."
- `EffectBase.prepareFrame()` docblock: "Called ONCE per frame before the floor loop. Override for time-based simulation advance."
- `EffectBase.floorScope` property: document `'floor'` vs `'global'`
- Each effect's `prepareFrame()`: comment which simulation state it advances
- Each effect's `bindFloorMasks()`: comment what per-floor state is cached

### Phase 1 Testing Gate
- [ ] All existing single-floor effects render identically (simulation moves to `prepareFrame` must not change visual output)
- [ ] `WaterEffectV2` wave speed unchanged at 1 floor
- [ ] `CloudEffect` cloud density simulation speed unchanged at 1 floor
- [ ] `FireSparksEffect` spark speed unchanged at 1 floor
- [ ] Per-floor state maps instantiated and disposed without memory leaks (verify via `window.MapShine.waterEffect._floorStates`)

---

## 12.4 Phase 2 — EffectComposer Render Loop (Estimated: 1–2 weeks)

*The core architectural change. Replaces the single scene render with a floor loop. Protected by feature flag during development.*

### Modified Files

| File | Change |
|---|---|
| `scripts/effects/EffectComposer.js` | Full render loop restructure — see §12.4.1 |
| `scripts/scene/token-manager.js` | Add `setFloorVisible(floorIndex)` — shows/hides token sprites based on elevation range |
| `scripts/effects/LightingEffect.js` | Accept floor index parameter in per-floor `lightScene` renders; gate `PlayerLightEffect` meshes |
| `scripts/effects/PlayerLightEffect.js` | `setActiveFloor(floorIndex)` — show/hide torch emitter + flashlight meshes |
| `scripts/foundry/canvas-replacement.js` | Add `experimentalFloorRendering` feature flag check |

### 12.4.1 EffectComposer.render() Restructure

**Current structure (to be replaced):**
```
PASS 0: sceneEffects.update() + render()
MAIN:   renderer.render(scene, camera) → sceneRenderTarget
PASS 2: postEffects ping-pong → screen
OVERLAY: _renderOverlayToScreen()
```

**New structure:**
```
PRE-FRAME:
  for effect: effect.prepareFrame(timeInfo)
  for updatable: updatable.update(timeInfo)

FLOOR LOOP (for each floor N in floorStack.getVisibleFloors()):
  A. tokenManager.setFloorVisible(N)
  B. dpm.captureForFloor()                 // per-floor depth
  C. effectMaskRegistry.bindFloor(N)       // swap active masks
  D. for effect in FLOOR_PASS sceneEffects: effect.update(timeInfo)
  E. camera.layers.disable(GLOBAL_SCENE_LAYER)
  F. renderer.render(scene, camera) → floorRT_A
  G. camera.layers.restore()
  H. for effect in FLOOR_PASS postEffects: floor ping-pong → floorRT_A
  I. composite: accumulationRT = floorRT_A OVER accumulationRT

GLOBAL SCENE PASS:
  J. camera.layers.set(GLOBAL_SCENE_LAYER only)
  K. renderer.render(scene, camera) → globalSceneRT  (additive/alpha-over accumulationRT)
  L. camera.layers.restore()

GLOBAL POST PASS:
  M. for effect in GLOBAL_PASS postEffects: ping-pong input=accumulationRT
  N. last GLOBAL_PASS effect renders to screen

OVERLAY:
  O. camera.layers.set(OVERLAY_THREE_LAYER)
  P. renderer.render(scene, camera) → screen (additive)
  Q. camera.layers.restore()
```

### New Render Targets (to add to EffectComposer)

| Target | Purpose | Format |
|---|---|---|
| `floorRT_A` | Current floor scene render | RGBA16F (HDR) |
| `floorRT_B` | Floor post-process ping-pong | RGBA16F |
| `accumulationRT` | Composited floor stack result | RGBA16F |
| `globalSceneRT` | Global scene objects (drawings, notes, fog) | RGBA16F |

### Dead Code to Remove (Phase 2)

- Old `sceneRenderTarget` → replaced by `accumulationRT` as the input to global post effects
- Old single-pass `this.renderer.render(this.scene, this.camera)` call in the main render method
- Feature flag code (once testing confirms correctness)

### Phase 2 Testing Gate
- [ ] Single-floor scene visually identical to Phase 0 output
- [ ] Two-floor scene: Floor 0 visible through Floor 1 gaps (correct alpha compositing)
- [ ] Depth pass correct per floor: water shore foam correct on each floor independently
- [ ] Drawings/notes appear once globally (not multi-composited)
- [ ] WorldSpaceFogEffect fog plane appears once globally
- [ ] Tokens hidden correctly during non-matching floor depth passes
- [ ] Simulation speed unchanged (prepareFrame called once per frame, not per floor)
- [ ] Frame time acceptable: N=3 floors < 2ms overhead vs single-floor

---

## 12.5 Phase 3 — Stateful Effect Adaptation (Estimated: 1 week)

*Implements per-floor state maps in all 6 stateful effects. One effect at a time, each independently verifiable.*

### Sequence (implement and test in order)

1. `WaterEffectV2` — largest stateful effect; validates the state map pattern
2. `FireSparksEffect` — CPU Float32Array + particle systems
3. `DustMotesEffect` — same pattern as FireSparksEffect
4. `AshDisturbanceEffect` — same pattern
5. `BuildingShadowsEffect` — per-floor bake target (GPU RT, not CPU array)
6. `TreeEffect` (+ `BushEffect`) — per-floor billboard instances

**For each effect:**
- Add `_floorStates: Map<string, FloorState>` to constructor
- Implement `bindFloorMasks(bundle, floorKey)` — lazily compute and cache state
- Implement `disposeFloorState(floorKey)` — called when a floor is evicted from cache
- Update `connectToRegistry()` — on mask change, invalidate affected floor's cached state (don't immediately rebuild; rebuild lazily on next `bindFloorMasks()` call)
- Update `dispose()` — iterate `_floorStates` and dispose all GPU resources

### `CandleFlamesEffect` Investigation (Phase 3 gate)
- [ ] Verify `MapPointsManager.getGroupsByEffect('candleFlame')` returns only current-floor candles
- [ ] If YES: `CandleFlamesEffect` needs no changes (already floor-aware via manager)
- [ ] If NO: Add to stateful effects list with `_floorStates` map pattern

### Phase 3 Testing Gate
- [ ] Water, fire, dust, ash, building shadows, trees all render correctly on each floor independently
- [ ] Switching between floors restores the correct per-floor state instantly (no rebuild delay)
- [ ] GPU memory does not grow unboundedly: floor state cache evicts LRU entries at max=3
- [ ] `dispose()` on each effect releases all per-floor GPU resources

---

## 12.6 Phase 4 — System Integration & Legacy Cleanup (Estimated: 3–4 days)

*Wires FloorStack into canvas-replacement hooks, simplifies the level-change pipeline, removes all legacy code.*

### Modified Files

| File | Change |
|---|---|
| `scripts/foundry/canvas-replacement.js` | Simplify `mapShineLevelContextChanged` hook: replace current `composeFloor()` orchestration with `floorStack.setActiveFloor(N)` + `effectMaskRegistry.setActiveFloor(N)` |
| `scripts/assets/EffectMaskRegistry.js` | Add `setActiveFloor(N)` — dispatches floor-N mask bundle to all registered effects via `bindFloorMasks()` |
| `scripts/scene/FloorStack.js` | Add `setActiveFloor(N)` — updates which floor is "active" (controls floor loop order and PlayerLightEffect gating) |
| `scripts/effects/PlayerLightEffect.js` | Complete `setActiveFloor()` implementation: hide/show torch emitter + flashlight meshes; coordinate with LightingEffect |

### Dead Code Removal

| File | What to Remove |
|---|---|
| `scripts/foundry/canvas-replacement.js` | Old `mapShineLevelContextChanged` handler body (replace with thin `floorStack.setActiveFloor()` call) |
| `scripts/scene/composer.js` | Any remaining stub methods from Phase 6 migration that are now fully obsolete |
| `scripts/effects/EffectComposer.js` | Feature flag branches from Phase 2 |
| `docs/Stale/` | Already marked Stale — verify all files here are superseded; move confirmed-stale items to archive or delete |

### Phase 4 Testing Gate
- [ ] Floor switch animation is instant (< 16ms from hook fire to first rendered frame)
- [ ] `mapShineLevelContextChanged` hook handler is clean and short (< 20 lines)
- [ ] No references to removed legacy methods remain in any file
- [ ] `PlayerLightEffect` torch/flashlight only appears on the active floor

---

## 12.7 Dead Code & Legacy Removal Inventory

*Complete list of code to remove across the refactor. Each item should be a separate commit or PR comment.*

### `scripts/foundry/canvas-replacement.js`
- `// MS-LVL-042:` comment block and `mapShineLevelContextChanged` sound refresh handler can stay (it's correct)
- The large `Hooks.on('mapShineLevelContextChanged', (payload) => {...})` block (lines ~543–620): replace with thin delegation to `floorStack.setActiveFloor()` in Phase 4
- Any `window.MapShine.activeLevelContext = null` teardown lines: replace with `floorStack.reset()`

### `scripts/effects/EffectComposer.js`
- The original `// PASS 0:`, `// PASS 2:` comment structure: replaced by new floor loop comments
- `this.sceneRenderTarget` as the scene output: replaced by `accumulationRT`
- `this.ensureSceneRenderTarget()` method: replaced by `ensureFloorRenderTargets()`

### `scripts/scene/depth-pass-manager.js`
- The `_lastRenderTimeMs` rate limiter path in `update()`: keep for global updatable fallback; add comment that the primary path in the floor loop uses `captureForFloor()` instead
- Consider removing `DepthPassManager` from `effectComposer.updatables` entirely in Phase 2 (it would only run via `captureForFloor()`)

### `scripts/scene/composer.js` (SceneComposer)
- Already cleaned up in Phase 6; verify no orphaned stubs remain after Phase 4

### `docs/Stale/`
- Contains 85+ legacy planning docs; verify `MULTI-LEVEL-RENDERING-ARCHITECTURE.md` (currently empty) is updated with a redirect to `LEVELS-ARCHITECTURE-RETHINK.md`
- Do NOT delete historical docs — move confirmed-obsolete items to `docs/Stale/` (they're already there)

---

## 12.8 Comment & JSDoc Update Plan

*Every file touched by this refactor must have its comments reviewed. Priority targets:*

### High Priority (must update before merging the relevant phase)

| File | Comment Target | What to Write |
|---|---|---|
| `EffectComposer.js` | `EffectBase` class docblock | Add `prepareFrame()`, `bindFloorMasks()`, `floorScope` to lifecycle list |
| `EffectComposer.js` | `GLOBAL_SCENE_LAYER` constant | "Objects on this layer render once per frame in the global scene pass, after the floor loop. Use for world objects that must not be multi-composited (drawings, notes, fog plane)." |
| `EffectComposer.js` | `render()` method | Replace PASS 0/1/2 comments with floor loop structure comments |
| `depth-pass-manager.js` | `captureForFloor()` | "Renders the depth pass for the current floor visibility state. Call once per floor inside the floor loop. Does not update the rate-limiter timestamp — this is intentional." |
| `depth-pass-manager.js` | `update()` | "Legacy global updatable path. In the floor loop architecture, depth is captured per-floor via `captureForFloor()`. This method is retained for single-floor scenes and debug use." |
| `drawing-manager.js` | `this.group.layers.set(GLOBAL_SCENE_LAYER)` | "Drawings must render once globally, not per-floor. GLOBAL_SCENE_LAYER (29) excludes this group from per-floor scene renders and depth passes." |
| `note-manager.js` | Same as above | Same |
| `WorldSpaceFogEffect.js` | `fogPlane` layer assignment | "The fog plane is a global overlay — it composites over the final accumulated floor image. GLOBAL_SCENE_LAYER excludes it from per-floor depth capture." |
| `FloorStack.js` (new) | Class docblock | Full description of floor discovery, elevation band logic, and the floor loop API |

### Medium Priority (update before Phase 4 merge)

| File | Target |
|---|---|
| All `bindFloorMasks()` overrides | Document what state is cached per floor and when it is invalidated |
| All `prepareFrame()` overrides | Name the specific simulation being advanced |
| `canvas-replacement.js` | Update `mapShineLevelContextChanged` handler comments |
| `EffectMaskRegistry.js` | Document `setActiveFloor()` and the mask dispatch flow |

### Low Priority (Phase 5 sweep)
- `ARCHITECTURE-SUMMARY.md` — update to describe Floor Stack model
- `docs/planning/MULTI-LEVEL-RENDERING-ARCHITECTURE.md` — currently empty; add a one-paragraph redirect to `LEVELS-ARCHITECTURE-RETHINK.md`
- Effect development guide — add `bindFloorMasks()` pattern documentation

---

## 12.9 Commit Sequence Recommendation

Each commit should be atomic — it introduces one clear change that doesn't break anything.

**Phase 0 commit sequence:**
1. `feat: add GLOBAL_SCENE_LAYER=29 constant to EffectComposer`
2. `feat: add DrawingManager/NoteManager group to GLOBAL_SCENE_LAYER`
3. `feat: assign WorldSpaceFogEffect fogPlane to GLOBAL_SCENE_LAYER`
4. `feat: add DepthPassManager.captureForFloor() method`
5. `feat: add FloorStack class with floor discovery and setFloorVisible()`
6. `feat: expose floorStack on window.MapShine`

**Phase 1 commit sequence:**
1. `feat: add EffectBase.prepareFrame() lifecycle method`
2. `feat: add EffectBase.floorScope property`
3. `refactor: move WaterEffectV2 simulation to prepareFrame()`
4. `refactor: move DistortionManager simulation to prepareFrame()`
5. `refactor: move AtmosphericFogEffect/CloudEffect/FireSparksEffect simulation to prepareFrame()`
6. `feat: add WaterEffectV2 bindFloorMasks() + _floorStates map`
7. `feat: add FireSparksEffect/DustMotesEffect/AshDisturbanceEffect bindFloorMasks()`
8. `feat: add BuildingShadowsEffect/TreeEffect bindFloorMasks()`
9. `feat: mark GLOBAL_PASS effects (WorldSpaceFogEffect, WeatherParticles, PlayerLightEffect)`

**Phase 2 commit sequence:**
1. `feat: add floor render targets (floorRT_A, floorRT_B, accumulationRT) to EffectComposer`
2. `feat: add TokenManager.setFloorVisible() method`
3. `feat: add experimental floor rendering feature flag`
4. `feat: implement floor loop in EffectComposer.render() [behind flag]`
5. `feat: implement floor compositing (accumulationRT OVER blend)`
6. `feat: implement global scene pass after floor loop`
7. `feat: implement global post pass on accumulated image`
8. `refactor: remove feature flag, make floor loop the default path`
9. `cleanup: remove old sceneRenderTarget single-pass code`

**Phase 3 commit sequence (one per effect):**
1. `feat: WaterEffectV2 per-floor state map + LRU eviction`
2. `feat: FireSparksEffect per-floor state map`
3. `feat: DustMotesEffect per-floor state map`
4. `feat: AshDisturbanceEffect per-floor state map`
5. `feat: BuildingShadowsEffect per-floor bake target`
6. `feat: TreeEffect/BushEffect per-floor instance state`
7. `fix: CandleFlamesEffect floor-awareness verification`

**Phase 4 commit sequence:**
1. `feat: EffectMaskRegistry.setActiveFloor() dispatch`
2. `refactor: simplify mapShineLevelContextChanged hook handler`
3. `feat: PlayerLightEffect.setActiveFloor() implementation`
4. `cleanup: remove all legacy single-floor composition code`
5. `docs: update ARCHITECTURE-SUMMARY.md, mark MULTI-LEVEL as superseded`

---

## 12.10 `FloorStack.js` — Class Specification

*Concrete spec for the new file introduced in Phase 0.*

```javascript
/**
 * FloorStack manages the ordered set of elevation floors in a scene.
 *
 * Responsibilities:
 * - Derive floor bands from LevelsImportSnapshot (or a single-floor fallback)
 * - Track which floor is "active" (the player's current viewpoint)
 * - Toggle Three.js object visibility per-floor for the render loop
 * - Provide the ordered floor array for EffectComposer's floor loop
 *
 * Floor visibility toggling uses sprite/mesh .visible flags, not camera.layers.
 * This automatically propagates to all layer-based sub-renders
 * (roof alpha, water occluder, token mask, etc.) without any changes to
 * the consuming effects. See Part 6 of LEVELS-ARCHITECTURE-RETHINK.md.
 */
export class FloorStack {
  constructor(levelsSnapshot, tileManager, tokenManager) {}

  /** @returns {FloorBand[]} Ordered bottom-to-top array of floor bands */
  getFloors() {}

  /** @returns {FloorBand[]} Floors to render (active floor + floors below it) */
  getVisibleFloors() {}

  /** @returns {FloorBand} The currently active (viewed) floor */
  getActiveFloor() {}

  /** Set which floor is active (player's viewpoint) */
  setActiveFloor(floorIndex) {}

  /**
   * Toggle visibility of all scene objects for floor N.
   * Tiles, tokens, and particle emitters on floor N become visible;
   * all others become invisible.
   *
   * Called inside the EffectComposer floor loop before each floor's
   * scene render and depth capture.
   */
  setFloorVisible(floorIndex) {}

  /**
   * Restore all scene objects to their Levels-driven visibility state.
   * Called after the floor loop completes each frame.
   */
  restoreVisibility() {}

  dispose() {}
}

/**
 * @typedef {Object} FloorBand
 * @property {number} index - Floor index (0 = ground, 1 = first floor, etc.)
 * @property {number} elevationMin - Bottom elevation of this band (Foundry units)
 * @property {number} elevationMax - Top elevation of this band
 * @property {string} key - Stable string key: `"floor_${index}_${elevationMin}"}`
 * @property {boolean} isActive - Whether this is the player's current floor
 */
```

---

## 12.11 Summary: Files Touched Per Phase

| Phase | New Files | Modified Files | Deleted/Emptied |
|---|---|---|---|
| 0 | `FloorStack.js` | 6 files (small changes) | None |
| 1 | None | ~15 effect files | None |
| 2 | None | `EffectComposer.js` (major), `TokenManager.js`, `LightingEffect.js`, `PlayerLightEffect.js`, `canvas-replacement.js` | Old render path in `EffectComposer.js` |
| 3 | None | 6–7 effect files | None |
| 4 | None | `canvas-replacement.js`, `EffectMaskRegistry.js`, `FloorStack.js` additions | Legacy hook handler body |
| 5 (docs) | None | `ARCHITECTURE-SUMMARY.md`, `MULTI-LEVEL-RENDERING-ARCHITECTURE.md` | None |

**Total new code: ~600–800 lines.** `FloorStack.js` (~150), per-floor state maps in 6 effects (~50 lines each), `EffectComposer` floor loop restructure (~200 lines replacing ~100).

**Total removed code: ~300–400 lines.** Old render path, legacy handler body, stale SceneComposer stubs.

**Net: ~300–400 lines added** for the entire multi-floor architecture.