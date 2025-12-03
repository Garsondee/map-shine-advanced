# Fog of War Analysis & Implementation Guide

> **Status**: REVISED (December 2024)  
> **Approach**: Self-computed vision polygons using wall data

This document outlines technical strategies and potential difficulties for implementing the Fog of War system in Map Shine Advanced. We compute vision polygons ourselves rather than relying on Foundry's internal `VisionSource` state.

---

## 1. Why We Compute Vision Ourselves

### 1.1. The Problem with Foundry's VisionSource

When Map Shine hides the PIXI canvas, Foundry's vision system breaks:

| Issue | Cause |
|-------|-------|
| `source.active === false` | Checks `this.object.visible`, which is false |
| `source.shape` is undefined | Foundry skips inactive sources |
| `source.radius` is undefined | Source never initialized |
| `computePolygon()` fails | Depends on initialized source state |

### 1.2. Our Solution

We read **raw data** that Foundry always provides:
- `canvas.walls.placeables` → Wall segment coordinates
- `canvas.tokens.placeables` → Token positions
- `GameSystemManager` → Vision radius per game system

Then we compute visibility polygons ourselves using a standard 2D raycasting algorithm.

---

## 2. Technical Challenges

### 2.1. Coordinate System Mismatch (CRITICAL)

| System | Origin | Y Direction |
|--------|--------|-------------|
| Foundry | Top-Left (0,0) | Down (+Y) |
| Three.js | Center (0,0) | Up (+Y) |

**Transformation Formula** (in `GeometryConverter`):
```javascript
const threeX = foundryX - (sceneWidth / 2);
const threeY = -(foundryY - (sceneHeight / 2));
```

**Verification**: The `VisionManager` camera must match `scripts/scene/composer.js` camera setup.

### 2.2. Performance Considerations

| Operation | Cost | Mitigation |
|-----------|------|------------|
| Raycasting | O(walls × rays) | Spatial indexing (quadtree) |
| Triangulation | O(n log n) | Use `earcut` directly, not `THREE.ShapeGeometry` |
| Geometry creation | GC pressure | Pool `BufferGeometry` instances |
| Pixel readback | Pipeline stall | Only on save (throttled), not every frame |

### 2.3. Wall Filtering

Not all walls block vision. Filter logic:

```javascript
function getVisionBlockingWalls(walls) {
  return walls.filter(wall => {
    const doc = wall.document;
    
    // CONST.WALL_SENSE_TYPES: 0=None, 10=Limited, 20=Normal
    if (doc.sight === 0) return false;
    
    // Skip open doors (ds=1 means open)
    if (doc.door > 0 && doc.ds === 1) return false;
    
    return true;
  });
}
```

### 2.4. Game System Compatibility

Different systems store vision data differently:

| System | Vision Enabled | Vision Range |
|--------|----------------|--------------|
| Core | `token.sight.enabled` | `token.sight.range` |
| PF2e | `actor.system.perception.vision` | Often 0 (unlimited) |
| 5e | `token.sight.enabled` | `actor.system.attributes.senses.darkvision` |

**Solution**: `GameSystemManager` abstracts these differences.

---

## 3. Algorithm: 2D Visibility Polygon

Based on [Red Blob Games: 2D Visibility](https://www.redblobgames.com/articles/visibility/).

### 3.1. Overview

1. **Collect endpoints**: All wall segment endpoints within vision radius
2. **Add boundary**: Circle points at vision radius (for areas with no walls)
3. **Cast rays**: From origin to each endpoint (and slightly past)
4. **Find intersections**: Where each ray hits walls
5. **Sort by angle**: Order points around origin
6. **Build polygon**: Connect sorted points

### 3.2. Pseudocode

```javascript
function computeVisibilityPolygon(origin, radius, walls) {
  const segments = getVisionBlockingWalls(walls)
    .map(w => ({ a: {x: w.c[0], y: w.c[1]}, b: {x: w.c[2], y: w.c[3]} }));
  
  // Add boundary circle as segments
  segments.push(...createCircleSegments(origin, radius, 32));
  
  // Collect unique endpoints
  const endpoints = new Set();
  for (const seg of segments) {
    if (distance(origin, seg.a) <= radius) endpoints.add(seg.a);
    if (distance(origin, seg.b) <= radius) endpoints.add(seg.b);
  }
  
  // Cast rays and find closest intersections
  const intersections = [];
  for (const endpoint of endpoints) {
    const angle = Math.atan2(endpoint.y - origin.y, endpoint.x - origin.x);
    
    // Cast 3 rays: slightly before, at, and slightly after the endpoint
    for (const offset of [-0.0001, 0, 0.0001]) {
      const ray = { origin, angle: angle + offset };
      const hit = findClosestIntersection(ray, segments);
      if (hit) intersections.push({ point: hit, angle: ray.angle });
    }
  }
  
  // Sort by angle and build polygon
  intersections.sort((a, b) => a.angle - b.angle);
  return intersections.flatMap(i => [i.point.x, i.point.y]);
}
```

### 3.3. Edge Cases

| Case | Handling |
|------|----------|
| No walls | Return circle polygon |
| Token outside scene | Clamp to scene bounds |
| Degenerate polygon | Fallback to circle |
| Collinear points | Earcut handles this |

---

## 4. Component Architecture

### 4.1. VisionPolygonComputer (NEW)

```javascript
// scripts/vision/VisionPolygonComputer.js
export class VisionPolygonComputer {
  /**
   * Compute visibility polygon
   * @param {{x: number, y: number}} center - Token center (Foundry coords)
   * @param {number} radius - Vision radius in pixels
   * @param {Wall[]} walls - Wall placeables (optional)
   * @returns {number[]} Flat array [x0, y0, x1, y1, ...] (Foundry coords)
   */
  compute(center, radius, walls = null) { ... }
  
  filterVisionBlockingWalls(walls) { ... }
  createBoundaryCircle(center, radius, segments = 32) { ... }
  castRay(origin, angle, segments) { ... }
  findClosestIntersection(ray, segments) { ... }
}
```

### 4.2. Updated VisionManager

```javascript
// scripts/vision/VisionManager.js
import { VisionPolygonComputer } from './VisionPolygonComputer.js';

export class VisionManager {
  constructor(renderer, width, height) {
    this.computer = new VisionPolygonComputer();
    this.converter = new GeometryConverter(width, height);
    // ... existing setup ...
  }

  update() {
    // Clear scene
    this.clearScene();
    
    const gsm = window.MapShine?.gameSystem;
    const walls = canvas.walls.placeables;
    
    // Get tokens with vision
    const tokens = canvas.tokens.placeables.filter(t => 
      gsm ? gsm.hasTokenVision(t) : t.hasSight
    );
    
    for (const token of tokens) {
      // Skip hidden tokens
      if (token.document.hidden) continue;
      
      // Get vision radius
      const distRadius = gsm?.getTokenVisionRadius(token) || 0;
      if (distRadius <= 0) continue;
      const radius = gsm?.distanceToPixels(distRadius) || distRadius;
      
      // Compute visibility polygon
      const points = this.computer.compute(token.center, radius, walls);
      
      if (points && points.length >= 6) {
        const geometry = this.converter.toBufferGeometry(points);
        const mesh = new THREE.Mesh(geometry, this.material);
        this.scene.add(mesh);
      }
    }
    
    // Render to texture
    this.renderToTexture();
  }
}
```

---

## 5. Existing Components (Unchanged)

### 5.1. GeometryConverter

Converts flat point arrays to `THREE.BufferGeometry`:
- Transforms Foundry → Three.js coordinates
- Triangulates with `earcut`

### 5.2. FogManager

Handles exploration persistence:
- `accumulate()`: MAX blend vision onto exploration
- `load()`: Load from Foundry's `FogExploration` document
- `_save()`: Save to Foundry (currently buggy, needs fix)

### 5.3. FogEffect

Shader compositor:
- Samples `tVision` (real-time) and `tExplored` (persistent)
- Outputs: visible (scene), explored (dimmed), unexplored (black)

---

## 6. Verification Plan

### 6.1. Unit Tests

1. **Wall filtering**: Verify open doors are excluded
2. **Raycasting**: Test ray-segment intersection math
3. **Polygon generation**: Compare output to known configurations

### 6.2. Visual Debug Mode

Add a debug overlay that renders:
- Wall segments (red lines)
- Cast rays (yellow lines)
- Visibility polygon (green fill)
- Token center (blue dot)

```javascript
// Enable with: window.MapShine.visionManager.debugMode = true
```

### 6.3. Performance Benchmarks

| Metric | Target |
|--------|--------|
| Polygon computation | < 2ms for 100 walls |
| Triangulation | < 1ms for 200 vertices |
| Full update cycle | < 5ms total |

---

## 7. Key Files

| File | Purpose |
|------|---------|
| `scripts/vision/VisionPolygonComputer.js` | **NEW**: Raycasting algorithm |
| `scripts/vision/VisionManager.js` | Orchestrates vision mask generation |
| `scripts/vision/GeometryConverter.js` | Polygon → BufferGeometry |
| `scripts/vision/FogManager.js` | Exploration persistence |
| `scripts/effects/FogEffect.js` | Shader compositor |
| `scripts/core/game-system.js` | System-specific vision radius |

---

## 8. References

- [Red Blob Games: 2D Visibility](https://www.redblobgames.com/articles/visibility/)
- [visibility-polygon.js](https://github.com/byronknoll/visibility-polygon-js)
- [Foundry VTT Wall Data](https://foundryvtt.com/api/WallDocument.html)
