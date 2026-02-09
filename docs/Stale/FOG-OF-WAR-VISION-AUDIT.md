# Fog of War – Vision Shape Audit

**Date:** 2025-02-06  
**Scope:** Full audit of the token vision → fog-of-war rendering pipeline.  
**Status:** 6 of 9 bugs fixed in `WorldSpaceFogEffect.js`.

---

## Executive Summary

The fog of war is driven by `WorldSpaceFogEffect`, which reads Foundry's native
`token.vision.los` polygons, converts them into `THREE.ShapeGeometry` meshes,
renders them to a world-space render target, and composites the result onto a
fog overlay plane. The coordinate chain (Foundry Y-down → Three.js vision
camera → fog plane UV flip) is mathematically correct. However, there are
**several serious issues** with shape fidelity, reliability, and performance
that collectively produce the "broken shape" symptoms.

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│  Foundry VTT (PIXI, hidden)                                     │
│  token.vision  →  PointVisionSource  → .los (PointSourcePolygon)│
│  Points: flat [x0,y0,x1,y1,...] in absolute canvas coords       │
│  Coordinate system: top-left origin, Y-down                     │
└────────────────────────┬────────────────────────────────────────┘
                         │ read by _renderVisionMask()
                         ▼
┌─────────────────────────────────────────────────────────────────┐
│  WorldSpaceFogEffect._renderVisionMask()                        │
│  1. Offset points by -sceneRect.x/y                             │
│  2. Build THREE.Shape (moveTo/lineTo)                           │
│  3. Create THREE.ShapeGeometry (earcut triangulation)           │
│  4. Render white mesh → visionRenderTarget                      │
│     Camera: Ortho(left=0, right=W, top=H, bottom=0)             │
│     (Y=0 at camera bottom = Foundry top-of-scene)               │
└────────────────────────┬────────────────────────────────────────┘
                         │ sampled in fog fragment shader
                         ▼
┌─────────────────────────────────────────────────────────────────┐
│  Fog Plane (world-space mesh, renderOrder=9999)                 │
│  Shader samples vision texture with Y-flip:                     │
│    visionUv = vec2(vUv.x, 1.0 - vUv.y)                          │
│  This compensates for Foundry-Y-down in RT vs Three.js-Y-up     │
│  on the fog plane. The mapping is correct.                      │
└─────────────────────────────────────────────────────────────────┘
```

**Parallel dead system (unused):** `VisionManager` + `VisionPolygonComputer` +
`GeometryConverter` + `FogManager` exist in `scripts/vision/` but are
explicitly marked as unused in `canvas-replacement.js:294`.

---

## Findings

### BUG 1 – Critical: `THREE.ShapeGeometry` earcut fails on complex LOS polygons

**File:** `WorldSpaceFogEffect.js:1043–1056`

Foundry's `ClockwiseSweepPolygon` can produce polygons with **hundreds of
vertices** and deep concavities (rooms connected by narrow doorways, many
overlapping walls). The current code feeds these directly into
`THREE.ShapeGeometry`, which uses earcut internally.

**Problems:**
- Earcut can produce **incorrect triangulations** for highly concave polygons
  with near-degenerate edges (vertices very close together or nearly collinear).
  This manifests as "spiky" triangles poking out of the vision shape, or
  missing triangles leaving holes.
- Foundry's polygon may contain **near-duplicate consecutive points** (e.g. two
  vertices 0.01px apart where a wall endpoint meets a boundary circle). Earcut
  handles exact duplicates but can struggle with near-duplicates.
- `closePath()` adds an explicit close segment. If `shape.points` already ends
  at the same position as the start (some Foundry polygon configs do this),
  this creates a zero-length degenerate segment.

**Severity:** HIGH – This is the most likely cause of visibly wrong shapes.

**Recommendation:**
1. Pre-process the point array before feeding to ShapeGeometry:
   - Remove near-duplicate consecutive points (distance < 1px).
   - Remove collinear points (saves vertices and improves earcut robustness).
   - Skip `closePath()` if last point ≈ first point.
2. Consider using `GeometryConverter.toBufferGeometry()` (already exists in
   `scripts/vision/GeometryConverter.js`) which calls `PIXI.utils.earcut`
   directly on the flat point array. PIXI's earcut is the same library but
   avoids the overhead of THREE.Shape path parsing.

---

### BUG 2 – Critical: Vision source may not exist for MapShine-selected tokens

**File:** `WorldSpaceFogEffect.js:958–967, 1016–1027`

The code resolves controlled tokens from MapShine's `InteractionManager.selection`,
finds the corresponding Foundry `Token` placeable, and reads `token.vision`.

**Problem:** Foundry only creates a `PointVisionSource` (and computes LOS
polygons) for tokens that pass `Token._isVisionSource()`. For GM users, this
requires `this.controlled === true`. MapShine's InteractionManager DOES call
`fvttToken.control()` (confirmed at `interaction-manager.js:3991` and `:7148`),
but there are code paths where selection is updated without calling
`.control()`:

- `selection.add(id)` at line 7211 does NOT always have a corresponding
  `fvttToken.control()` call.
- If `.control()` fails silently (e.g. the token placeable isn't found in
  `canvas.tokens`), the token is in MapShine's selection but has no Foundry
  vision source.

When `token.vision` is `undefined`, the code increments
`tokensWithoutValidLOS` and calls `forcePerceptionUpdate()` in a retry loop.
But if Foundry never considers the token controlled, no amount of perception
updates will create a vision source. The fog will **flicker indefinitely**
between hidden (waiting for valid vision) and briefly visible states.

**Severity:** HIGH – Affects token selection → fog correctness.

**Recommendation:**
1. Before reading `token.vision`, explicitly ensure the Foundry token is
   controlled: `if (!fvttToken.controlled) fvttToken.control({releaseOthers: false})`.
2. Add a maximum retry count for the `tokensWithoutValidLOS` loop to prevent
   infinite retrying.
3. If a token genuinely has no vision (e.g. it doesn't have `hasSight`), skip
   it cleanly instead of counting it as "without valid LOS".

---

### BUG 3 – High: Fog plane hides during camera pan (flicker)

**File:** `WorldSpaceFogEffect.js:1118–1153, 1270–1271`

`_detectCameraMovement()` sets `_hasValidVision = false` whenever the camera
moves more than 50px. This causes the fog plane to be hidden:

```javascript
const waitingForVision = this._needsVisionUpdate && !this._hasValidVision;
this.fogPlane.visible = !waitingForVision;
```

The intent is to avoid showing stale vision data during large camera movements.
But in practice, Foundry's perception update completes within the same frame
(or the next), meaning the fog plane flashes invisible for 1–2 frames on every
significant pan. This is visible as **fog flickering**.

**Severity:** HIGH – Visually disruptive.

**Recommendation:**
1. Remove the `_hasValidVision = false` from `_detectCameraMovement()`.
   Camera movement doesn't invalidate the token's LOS polygon – only token
   movement or wall changes do.
2. The fog plane is world-space and already correctly pinned to the map.
   There is no reason to hide it during camera pans.
3. Keep `_needsVisionUpdate = true` to re-render the vision mask, but don't
   hide the fog plane while waiting.

---

### BUG 4 – High: Per-frame object allocation in `_renderVisionMask()`

**File:** `WorldSpaceFogEffect.js:935–1111`

Every call to `_renderVisionMask()` allocates:

| Object | Count per call |
|---|---|
| `new THREE.Shape()` | 1 per token |
| `new THREE.ShapeGeometry()` | 1 per token |
| `new THREE.Mesh()` | 1 per token |
| `new THREE.Color()` | 1 (getClearColor) |
| `Array.from(selection)` | 1 |
| Previous geometries `.dispose()` | N (children cleanup) |

With vision updates triggered by `controlToken`, `updateToken`,
`sightRefresh`, `lightingRefresh`, and selection changes, this runs frequently.
The allocations create GC pressure that causes frame hitches, especially on
scenes with multiple controlled tokens.

**Severity:** HIGH – Performance.

**Recommendation:**
1. Cache and reuse the `THREE.Color` instance.
2. Use a pooled geometry approach: maintain a single `BufferGeometry` per token
   slot, update its position attribute in-place rather than disposing/recreating.
3. Use `GeometryConverter.toBufferGeometry()` which works directly on flat
   arrays without the Shape→Path→extractPoints overhead.
4. Iterate `selection` directly instead of `Array.from()`.

---

### BUG 5 – Medium: Vision render target resolution cap causes blurry edges

**File:** `WorldSpaceFogEffect.js:480–500`

The vision render target is capped at 2048px:

```javascript
const maxSize = Math.min(2048, maxTexSize);
const scale = Math.min(1, maxSize / Math.max(width, height));
```

For a 6000×4000 scene, the vision texture is only ~2048×1365. Each vision
texel covers ~3×3 scene pixels. The fog shader's `sampleSoft` function
performs a weighted blur in this reduced resolution, producing edges that are
~3× softer than intended.

**Severity:** MEDIUM – Affects visual quality on large scenes.

**Recommendation:**
1. Consider allowing a higher cap (e.g. 4096) with a performance warning.
2. Alternatively, render the vision polygon directly to the fog plane's
   shader via a different technique (stencil, SDF) that doesn't depend on
   render target resolution.

---

### BUG 6 – Medium: MSAA on vision render target

**File:** `WorldSpaceFogEffect.js:502–509`

```javascript
if (isWebGL2 && typeof this.visionRenderTarget.samples === 'number') {
  this.visionRenderTarget.samples = 4;
}
```

4× MSAA on the vision render target:
- Adds GPU overhead for a texture that's only sampled (not displayed directly).
- Can introduce sub-pixel edge artifacts when the resolved texture is sampled
  with bilinear filtering in the fog shader.
- Three.js auto-resolves MSAA render targets, but the resolve step consumes
  additional bandwidth.

**Severity:** MEDIUM – Unnecessary overhead, potential edge artifacts.

**Recommendation:** Remove MSAA from the vision render target. The fog shader
already applies its own softening via `sampleSoft()`.

---

### BUG 7 – Medium: Dead vision code still in codebase

**Files:**
- `scripts/vision/VisionManager.js` – Full vision manager with hooks
- `scripts/vision/VisionPolygonComputer.js` – Custom raycasting
- `scripts/vision/GeometryConverter.js` – Coordinate converter
- `scripts/vision/FogManager.js` – Exploration persistence
- `scripts/vision/FoundryFogBridge.js` – PIXI texture bridge

**Problem:** These files implement a complete parallel vision system that is
explicitly marked as unused (`canvas-replacement.js:294`). However:

- `VisionManager` registers Foundry hooks in its constructor. If it is ever
  instantiated (even accidentally), those hooks fire on every token update,
  wall change, etc., consuming CPU for zero benefit.
- `GeometryConverter.toBufferGeometry()` is actually **better** than the
  current `THREE.ShapeGeometry` approach (direct earcut on flat array, no
  Shape path overhead) and should be reused.
- `FogManager` duplicates exploration persistence logic that now lives in
  `WorldSpaceFogEffect`.

**Severity:** MEDIUM – Code confusion, potential accidental instantiation.

**Recommendation:**
1. Extract `GeometryConverter` for reuse in `WorldSpaceFogEffect`.
2. Mark the rest as deprecated or remove entirely.
3. Verify `VisionManager` is never instantiated anywhere.

---

### BUG 8 – Low: Dead noise functions in exploration vertex shaders

**File:** `WorldSpaceFogEffect.js:341–365, 581–608`

Both the minimal-target and full-res exploration material vertex shaders contain
`hash21()`, `noise2()`, and `sampleBlur4()` function definitions that are
**never called** in the vertex shader. They appear to be copy-paste artifacts
from the fog plane's fragment shader.

**Severity:** LOW – No functional impact, but increases shader compile time
and code confusion.

**Recommendation:** Remove the unused functions from both vertex shaders.

---

### BUG 9 – Low: Duplicated target creation code

**File:** `WorldSpaceFogEffect.js:262–391 vs 476–644`

`_createMinimalTargets()` and `_createVisionRenderTarget()` +
`_createExplorationRenderTarget()` both create vision scenes, cameras,
materials, and exploration scenes with near-identical code. The minimal targets
are immediately replaced by the full-res targets via `setTimeout(0)`.

**Severity:** LOW – Maintenance burden, potential for drift between copies.

**Recommendation:** Unify into a single creation path that accepts a resolution
parameter. Create at 1×1 initially, then resize to full-res.

---

## Coordinate System Verification

The Y-coordinate chain was verified end-to-end and is **correct**:

| Stage | Y Convention | Notes |
|---|---|---|
| Foundry LOS polygon points | Y-down, absolute canvas coords | `PointSourcePolygon` extends `PIXI.Polygon` |
| After sceneRect offset | Y-down, relative to sceneRect origin | `points[i+1] - sceneRect.y` |
| Vision camera frustum | bottom=0, top=H (Y-up) | Standard Three.js ortho |
| Vision render target | V=0 at bottom = Foundry top | WebGL convention |
| Fog plane vUv | vUv.y=0 at bottom (Three.js low Y = Foundry bottom) | PlaneGeometry UV convention |
| Fog shader sampling | `vec2(vUv.x, 1.0 - vUv.y)` | Correctly maps fog-plane-bottom → vision-texture-top |

The double Y-flip (Foundry-Y-down rendered into Y-up camera, then flipped
again in the fog shader) produces the correct mapping.

---

## Priority Fix Order

1. **BUG 1** – Pre-process polygons before ShapeGeometry (fixes shape artifacts) ✅ FIXED
2. **BUG 2** – Ensure Foundry token control sync (fixes missing vision) ✅ FIXED
3. **BUG 3** – Stop hiding fog plane on camera movement (fixes flicker) ✅ FIXED
4. **BUG 4** – Pool/reuse vision geometry objects (fixes GC hitches) ✅ FIXED
5. **BUG 6** – Remove MSAA from vision RT (quick win) ✅ FIXED
6. **BUG 5** – Consider higher resolution cap for large scenes
7. **BUG 7** – Clean up dead vision code
8. **BUG 8** – Remove dead shader functions ✅ FIXED
9. **BUG 9** – Unify target creation code

---

## Fixes Applied

All fixes in `scripts/effects/WorldSpaceFogEffect.js`:

### BUG 1 + BUG 4 – Rewrote `_renderVisionMask()`
- Added `_cleanPolygonPoints()` helper that offsets to local coords, removes
  near-duplicate consecutive vertices (< 1px), strips duplicate close-point,
  and removes collinear points. This eliminates degenerate input that caused
  earcut triangulation failures.
- Replaced `THREE.Shape` → `THREE.ShapeGeometry` with direct `earcut()`
  triangulation on the flat 2D point array. More robust for complex concave
  Foundry LOS polygons and avoids Shape path parsing overhead.
- Added `_acquireVisionMesh()` mesh pool. Meshes are reused across frames
  with geometry attributes overwritten in-place instead of dispose/recreate.
- Cached `_tempClearColor` for `getClearColor()` to avoid per-frame allocation.
- Iterate `selection` directly instead of `Array.from(selection)`.

### BUG 2 – Ensured Foundry token control sync
- In `_renderVisionMask()`, when resolving MapShine-selected tokens, the code
  now calls `fvttToken.control({ releaseOthers: false })` if the token isn't
  already controlled. This ensures Foundry creates a `PointVisionSource` for it.
- Tokens without `hasSight` are no longer counted as "missing valid LOS",
  preventing infinite retry loops for non-vision tokens.

### BUG 3 – Stopped fog plane flicker on camera pan
- `_detectCameraMovement()` no longer sets `_hasValidVision = false`. Camera
  movement doesn't invalidate the LOS polygon — only token/wall changes do.
  The fog plane stays visible during pans, eliminating the 1-2 frame flicker.

### BUG 6 – Removed MSAA from vision render target
- Removed `visionRenderTarget.samples = 4` from `_createVisionRenderTarget()`.
  The fog shader already softens edges via `sampleSoft()`. MSAA added GPU
  overhead and potential sub-pixel artifacts for no visual benefit.

### BUG 8 – Removed dead shader functions
- Removed `hash21()`, `noise2()`, `sampleBlur4()` from both exploration
  vertex shaders (`_createMinimalTargets` and `_createExplorationRenderTarget`).
  These were copy-paste artifacts never called in the vertex shader.

### CRITICAL – Vision mask timing race (stale LOS polygon)
**Root cause of "fog doesn't align with walls and moves with token".**

`update()` (Three.js render loop) was calling `_renderVisionMask()` which reads
`token.vision.los`. But `update()` can run BEFORE Foundry's PIXI ticker
recomputes the LOS polygon for the current frame. This produces a stale polygon
from the previous token position — the cutout appears shifted from walls.

The exploration texture wasn't affected because it's dominated by Foundry's own
pre-rendered raster (loaded from `FogExploration`), and the incremental
`max(exploration, vision)` accumulation converges over many frames.

**Fix:**
- Extracted `syncVisionFromPixi()` — a new public method that handles selection
  detection, camera movement, and vision mask rendering.
- Removed ALL `_renderVisionMask()` calls from `update()`.
- `syncVisionFromPixi()` is called exclusively from the post-PIXI callback
  (`frameCoordinator.onPostPixi`), which runs AFTER Foundry's ticker at
  priority -50. At that point `token.vision.los` is guaranteed fresh.
- Updated `canvas-replacement.js` post-PIXI callback to call
  `fog.syncVisionFromPixi()` instead of directly calling `_renderVisionMask()`.
- `update()` now only handles: bypass check, exploration prewarm, fog plane
  visibility, exploration accumulation, and uniform updates.
