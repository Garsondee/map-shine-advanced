# Fog of War Implementation Plan (Three.js)

> **Status**: REVISED (December 2024)  
> **Approach**: Self-computed vision polygons using wall data

## 1. Overview

We will replace Foundry VTT's default PIXI-based Fog of War (FoW) with a high-performance Three.js implementation. **Critically**, we compute vision polygons ourselves rather than relying on Foundry's `VisionSource` objects, which become unreliable when the PIXI canvas is hidden.

## 2. Core Architecture

### 2.1. System Components

| Component | Role | Status |
|-----------|------|--------|
| `VisionPolygonComputer` | Computes LOS polygons from walls + token | **NEW** |
| `VisionManager` | Renders vision polygons to texture | Exists (needs update) |
| `FogManager` | Exploration persistence (save/load) | Exists |
| `FogEffect` | Shader compositor | Exists |
| `GeometryConverter` | Polygon → BufferGeometry | Exists |
| `GameSystemManager` | System-specific vision radius | Exists |

### 2.2. Data Flow

```
[Token Selection / Movement]
         |
         v
[GameSystemManager]
    - hasTokenVision(token) → boolean
    - getTokenVisionRadius(token) → distance units
    - distanceToPixels(distance) → pixels
         |
         v
[VisionPolygonComputer.compute(center, radius, walls)]
    - Filter walls by sight-blocking
    - Cast rays to wall endpoints
    - Build visibility polygon
         |
         v
[points: number[]] (Foundry coordinates)
         |
         v
[GeometryConverter.toBufferGeometry(points)]
    - Transform to Three.js coordinates
    - Triangulate with earcut
         |
         v
[THREE.BufferGeometry]
         |
         v
[VisionManager]
    - Add mesh to vision scene
    - Render to visionTexture (white on black)
         |
         v
[FogManager.accumulate(visionTexture)]
    - MAX blend onto explorationTexture
         |
         v
[FogEffect.render()]
    - Sample tVision, tExplored
    - Composite final output
```

## 3. VisionPolygonComputer (New Component)

### 3.1. Algorithm: 2D Visibility

Based on the [Red Blob Games visibility algorithm](https://www.redblobgames.com/articles/visibility/):

1. **Collect endpoints**: Gather all wall segment endpoints within vision radius
2. **Cast rays**: For each endpoint, cast a ray from origin
3. **Find intersections**: Determine where each ray hits walls
4. **Sort by angle**: Order intersection points around the origin
5. **Build polygon**: Connect sorted points to form visibility polygon

### 3.2. API

```javascript
class VisionPolygonComputer {
  /**
   * Compute visibility polygon for a point
   * @param {Object} center - {x, y} in Foundry coordinates
   * @param {number} radius - Vision radius in pixels
   * @param {Wall[]} walls - Array of wall placeables (optional, defaults to canvas.walls.placeables)
   * @returns {number[]} Flat array [x0, y0, x1, y1, ...] in Foundry coordinates
   */
  compute(center, radius, walls = null) { ... }
  
  /**
   * Filter walls that block vision
   * @param {Wall[]} walls
   * @returns {Wall[]}
   */
  filterVisionBlockingWalls(walls) { ... }
}
```

### 3.3. Wall Filtering Logic

```javascript
filterVisionBlockingWalls(walls) {
  return walls.filter(wall => {
    const doc = wall.document;
    
    // Must block sight (CONST.WALL_SENSE_TYPES: 0=None, 10=Limited, 20=Normal)
    if (doc.sight === 0) return false;
    
    // Skip open doors
    if (doc.door > 0 && doc.ds === 1) return false;
    
    // TODO: Handle one-way walls (doc.dir)
    // TODO: Handle limited sight walls (doc.sight === 10)
    
    return true;
  });
}
```

## 4. Implementation Steps

### Phase 1: VisionPolygonComputer ⬜
- [ ] Create `scripts/vision/VisionPolygonComputer.js`
- [ ] Implement `filterVisionBlockingWalls()`
- [ ] Implement basic raycasting (no optimization)
- [ ] Handle edge case: no walls (return circle polygon)
- [ ] Handle edge case: token outside all walls (return circle clipped to radius)
- [ ] Unit test with simple wall configurations

### Phase 2: VisionManager Integration ⬜
- [ ] Import `VisionPolygonComputer`
- [ ] Replace `source.shape` extraction with `VisionPolygonComputer.compute()`
- [ ] Get center from `token.center` (always available)
- [ ] Get radius from `GameSystemManager`
- [ ] Remove "full white quad" fallback (or keep as last resort)
- [ ] Test with PF2e token

### Phase 3: FogEffect Verification ⬜
- [ ] Verify pure LOS mode works (currently enabled)
- [ ] Test wall occlusion visually
- [ ] Re-enable exploration accumulation
- [ ] Fix `FogManager._save()` dimension mismatch

### Phase 4: Polish ⬜
- [ ] Soft edges (blur pass)
- [ ] Performance: spatial indexing for walls (quadtree)
- [ ] Performance: cache polygon when token hasn't moved
- [ ] Handle limited sight walls (partial transparency?)
- [ ] Handle one-way walls

## 5. Technical Details

### 5.1. Coordinate Systems

| System | Origin | Y Direction |
|--------|--------|-------------|
| Foundry | Top-Left (0,0) | Down (+Y) |
| Three.js | Center (0,0) | Up (+Y) |

**Transformation** (in `GeometryConverter`):
```javascript
const threeX = foundryX - (sceneWidth / 2);
const threeY = -(foundryY - (sceneHeight / 2));
```

### 5.2. Wall Data Structure

```javascript
// canvas.walls.placeables[i].document
{
  c: [x1, y1, x2, y2],  // Segment coordinates (Foundry pixels)
  sight: 20,            // 0=None, 10=Limited, 20=Normal
  light: 20,            // Light blocking (not used for vision)
  move: 20,             // Movement blocking (not used for vision)
  door: 0,              // 0=None, 1=Door, 2=Secret
  ds: 0,                // Door state: 0=Closed, 1=Open, 2=Locked
  dir: 0,               // Direction (for one-way walls)
}
```

### 5.3. Hooks to Listen

| Hook | When to Update |
|------|----------------|
| `updateToken` | Token moved or properties changed |
| `updateWall` | Wall added/removed/modified |
| `controlToken` | Token selection changed |
| `canvasReady` | Scene loaded |

## 6. Risks & Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| Algorithm bugs | Incorrect polygons | Visual debug mode (render rays) |
| Performance (many walls) | Frame drops | Quadtree spatial indexing |
| Degenerate polygons | Triangulation fails | Fallback to circle, robust earcut |
| System compatibility | Wrong radius | `GameSystemManager` abstraction |
| Exploration corruption | Foundry errors | Disable save until stable |

## 7. Success Criteria

1. ✅ Token selection shows LOS bubble
2. ✅ Walls block vision (black behind walls)
3. ✅ Moving token updates vision in real-time
4. ✅ Works with PF2e tokens
5. ✅ Works with 5e tokens
6. ✅ Exploration persists across sessions
7. ✅ No Foundry console errors
