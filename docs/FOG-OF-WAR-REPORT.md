# Fog of War Report & Implementation Plan

> **Status**: REVISED (December 2024)  
> **Previous Approach**: Extract polygons from Foundry's `VisionSource` objects  
> **New Approach**: Compute vision polygons ourselves using wall segment data

---

## 1. Problem Statement

### 1.1. What We Tried (Data-Driven Approach)

Our initial strategy was to treat Foundry's `VisionSource` objects as **Geometry Providers**:
- Read `source.shape.points` (the pre-computed LOS polygon)
- Triangulate into `THREE.BufferGeometry`
- Render to a vision mask texture

### 1.2. Why It Failed

When Map Shine Advanced hides the PIXI canvas (setting `visible = false` or `alpha = 0`), Foundry's vision system breaks down:

1. **`VisionSource.active` returns `false`** because it checks `this.object.visible`, which is false when the layer is hidden.
2. **`source.shape` is never computed** because Foundry skips inactive sources.
3. **`source.radius` is undefined** because the source was never initialized.
4. **`canvas.walls.computePolygon()` behaves unexpectedly** when called with parameters derived from uninitialized sources.
5. **PF2e and other systems** store vision data in non-standard locations (`actor.system.perception.vision`), making radius extraction unreliable.

**Result**: The vision mask is either entirely white (fallback) or entirely black (no sources), with no actual LOS occlusion.

### 1.3. The Root Cause

Foundry's vision system is **tightly coupled to its PIXI rendering pipeline**. It assumes the canvas is visible and actively rendering. By hiding the canvas, we break fundamental assumptions that Foundry's code relies on.

---

## 2. Decision: Compute Vision Ourselves

**New Decision: Self-Computed Vision Polygons**

Instead of fighting Foundry's internal state, we will compute line-of-sight polygons ourselves using:
- **Wall segment data** from `canvas.walls.placeables`
- **Token positions** from `canvas.tokens.placeables`
- **Vision radius** from `GameSystemManager` (handles PF2e, 5e, etc.)

### 2.1. Why This Is Better

| Aspect | Data-Driven (Old) | Self-Computed (New) |
|--------|-------------------|---------------------|
| Dependency on Foundry state | High (fragile) | Low (data only) |
| Works with hidden canvas | No | Yes |
| System compatibility | Requires per-system hacks | Centralized in `GameSystemManager` |
| Debugging | Opaque (Foundry internals) | Transparent (our code) |
| Performance | Unknown (Foundry overhead) | Controllable |

### 2.2. What We Keep

- **`FogManager`**: Exploration persistence (save/load to Foundry's `FogExploration` document)
- **`FogEffect`**: The shader that composites vision/exploration masks
- **`GeometryConverter`**: Polygon → Three.js BufferGeometry conversion
- **`GameSystemManager`**: System-specific vision radius logic

### 2.3. What We Replace

- **`VisionManager.update()`**: Instead of reading `source.shape`, we call our own `VisionPolygonComputer`

---

## 3. New Architecture

### 3.1. Component Overview

```
scripts/
  vision/
    VisionManager.js           # Orchestrates vision mask generation
    VisionPolygonComputer.js   # NEW: Computes LOS polygons from walls + token
    FogManager.js              # Exploration persistence (unchanged)
    GeometryConverter.js       # Polygon → BufferGeometry (unchanged)
  core/
    game-system.js             # GameSystemManager (vision radius per system)
  effects/
    FogEffect.js               # Shader compositor (unchanged)
```

### 3.2. Data Flow (New)

```
[Token Position] + [Vision Radius from GameSystemManager]
         |
         v
[VisionPolygonComputer]
    - Read wall segments from canvas.walls.placeables
    - Cast rays to wall endpoints
    - Build visibility polygon
         |
         v
[Polygon Points Array]
         |
         v
[GeometryConverter] → THREE.BufferGeometry
         |
         v
[VisionManager] → Render to visionTexture
         |
         v
[FogManager] → Accumulate to explorationTexture
         |
         v
[FogEffect] → Composite final output
```

### 3.3. VisionPolygonComputer (New Component)

**Purpose**: Given a point (token center) and radius, compute the visible area polygon considering wall occlusion.

**Algorithm**: 2D Visibility / Shadow Casting
1. Collect all wall segment endpoints within radius
2. Cast rays from origin to each endpoint (and slightly past)
3. Find intersection points with walls
4. Sort intersection points by angle
5. Build polygon from sorted points

**Reference Implementations**:
- [Red Blob Games: 2D Visibility](https://www.redblobgames.com/articles/visibility/)
- [visibility-polygon.js](https://github.com/byronknoll/visibility-polygon-js)

**Inputs**:
- `center: {x, y}` - Token center in Foundry coordinates
- `radius: number` - Vision radius in pixels
- `walls: Wall[]` - Array of wall placeables

**Output**:
- `points: number[]` - Flat array `[x0, y0, x1, y1, ...]` in Foundry coordinates

---

## 4. Implementation Plan

### Phase 1: VisionPolygonComputer
1. Create `scripts/vision/VisionPolygonComputer.js`
2. Implement basic raycasting algorithm
3. Handle wall types: `sight`, `move`, `light` (filter by `sight` for vision)
4. Handle special cases: doors (open/closed), one-way walls
5. Unit test with known wall configurations

### Phase 2: Integrate with VisionManager
1. Replace `source.shape` extraction with `VisionPolygonComputer.compute()`
2. Get token center from `token.center` (always available)
3. Get radius from `GameSystemManager.getTokenVisionRadius()` + `distanceToPixels()`
4. Remove fallback "full white quad" once computation is reliable

### Phase 3: Verify FogEffect
1. Test pure LOS mode (currently enabled)
2. Re-enable exploration accumulation once LOS works
3. Fix `FogManager._save()` to avoid corrupting Foundry's `FogExploration`

### Phase 4: Polish
1. Soft edges (blur pass on vision texture)
2. Performance optimization (spatial indexing for walls)
3. Handle edge cases (token outside scene bounds, zero walls, etc.)

---

## 5. Technical Details

### 5.1. Wall Data Structure

```javascript
// canvas.walls.placeables[i]
{
  document: {
    c: [x1, y1, x2, y2],  // Wall segment coordinates
    sight: 20,            // CONST.WALL_SENSE_TYPES (0=None, 10=Limited, 20=Normal)
    door: 0,              // CONST.WALL_DOOR_TYPES (0=None, 1=Door, 2=Secret)
    ds: 0,                // Door state (0=Closed, 1=Open, 2=Locked)
    // ... other properties
  }
}
```

### 5.2. Filtering Walls for Vision

```javascript
function getVisionBlockingWalls() {
  return canvas.walls.placeables.filter(wall => {
    const doc = wall.document;
    // Skip walls that don't block sight
    if (doc.sight === 0) return false; // NONE
    // Skip open doors
    if (doc.door > 0 && doc.ds === 1) return false; // Open door
    return true;
  });
}
```

### 5.3. Coordinate Transformation

Foundry uses top-left origin (Y down). Three.js uses center origin (Y up).

```javascript
// Foundry → Three.js
const threeX = foundryX - (sceneWidth / 2);
const threeY = -(foundryY - (sceneHeight / 2));
```

---

## 6. Risks & Mitigations

| Risk | Mitigation |
|------|------------|
| Algorithm bugs (incorrect polygons) | Visual debug mode: render walls + rays |
| Performance (many walls) | Spatial indexing (quadtree), limit ray count |
| Edge cases (degenerate polygons) | Robust triangulation with earcut, fallback to circle |
| System compatibility | `GameSystemManager` abstracts radius logic |

---

## 7. Success Criteria

1. **Visual**: Selecting a token shows a clear LOS bubble with walls blocking vision
2. **Walls**: Areas behind walls are black (unexplored) or dimmed (explored)
3. **Movement**: Moving the token updates the vision polygon in real-time
4. **Systems**: Works with PF2e, 5e, and core Foundry tokens
5. **Persistence**: Exploration saves/loads correctly without corrupting Foundry data
