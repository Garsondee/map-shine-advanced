# Fog of War — Clean Shape Production

**Date:** 2025-02-10  
**Status:** Planning  
**Problem:** Fog of war edges produce scalloped/toothed artifacts at grazing angles along walls.

---

## Problem Description

When the fog of war boundary runs nearly parallel to a wall at the edge of vision range, the boundary develops a repeating pattern of dark semi-circular "bites" — a scalloped staircase effect. This is most visible when a long wall is at the periphery of a token's vision, creating a grazing angle between the LOS boundary circle and the wall.

![Scallop artifacts at grazing angles](../../assets/docs/fog-scallop-example.png)

---

## Root Cause Analysis

The fog boundary is produced by a chain of four systems, each contributing to the artifact:

### 1. Foundry's ClockwiseSweepPolygon — Low Vertex Density on Arcs

Foundry's `ClockwiseSweepPolygon` computes a radial sweep polygon, then constrains it with a `PIXI.Circle` boundary shape via `_constrainBoundaryShapes()`. The circle is approximated as a regular polygon using:

```javascript
// source-polygon.mjs:174
cfg.density = cfg.density ?? PIXI.Circle.approximateVertexDensity(cfg.radius);

// circle-extension.mjs:138
PIXI.Circle.approximateVertexDensity = function(radius, epsilon = 1) {
  return Math.ceil(Math.PI / Math.sqrt(2 * (epsilon / radius)));
};
```

For a typical vision radius of 1000px, this produces `density ≈ 70` vertices for the full circle. The circle-polygon intersection (via Weiler-Atherton or Clipper) inserts arc points between wall intersection points using `pointsForArc()`:

```javascript
// circle-extension.mjs:95-111
PIXI.Circle.prototype.pointsForArc = function(fromAngle, toAngle, {density, ...} = {}) {
  const delta = 2π / density;          // ≈ 0.09 radians (≈5.1°) per segment
  const nPoints = Math.round(dAngle / delta);
  for (let i = 1; i < nPoints; i++)
    points.push(this.pointAtAngle(fromAngle + (i * delta)));
};
```

**The problem:** When a wall runs nearly tangent to the vision circle, the arc between the two wall-circle intersection points spans only a tiny angle. With `delta ≈ 5.1°`, arcs smaller than ~5° get **zero intermediate points**, creating a straight chord that cuts inside the true circle. At grazing angles, the wall repeatedly enters and exits the circle boundary over short angular spans, producing many tiny chords — each one creating a visible "scallop" where the chord dips below the true arc.

### 2. WorldSpaceFogEffect — Direct Polygon Passthrough

`_renderVisionMask()` reads `visionSource.los.points` and creates `THREE.Shape` → `THREE.ShapeGeometry` meshes. It applies no smoothing, arc interpolation, or simplification to the boundary. The polygon's chord artifacts are faithfully reproduced in the vision render target.

### 3. Vision Render Target — Resolution Cap at 2048px

The vision RT is capped at `2048px` on its longest axis. For a 6000×4000 scene, each texel covers ~3×3 scene pixels. The chord artifacts are small enough that bilinear filtering partially hides them — but at certain zoom levels, the quantized scallops become visible as regular dark spots.

### 4. Fog Shader — Edge Softening Can't Fix Geometry

The `sampleSoft()` function in the fog fragment shader blurs the vision mask edge over a configurable radius. This helps smooth gentle curves but **cannot fix** geometric artifacts where the polygon boundary is fundamentally wrong (inside the true circle). The dark bites are geometry-level errors, not sampling artifacts — no amount of post-process blur eliminates them.

---

## Current Pipeline

```
Foundry ClockwiseSweepPolygon
  → _constrainBoundaryShapes() clips to PIXI.Circle (N-gon, ~70 sides)
  → Produces flat points array with chord artifacts at grazing angles
  
WorldSpaceFogEffect._renderVisionMask()
  → Reads shape.points verbatim
  → Creates THREE.Shape → THREE.ShapeGeometry (earcut triangulation)
  → Renders white mesh to visionRenderTarget (2048px max)
  
Fog Plane Shader
  → Samples vision texture with sampleSoft() blur
  → Applies smoothstep threshold + noise distortion
  → Computes fog opacity
```

---

## Proposed Solutions

### Option A: Post-Process SDF Approach (Recommended)

**Concept:** Instead of rendering sharp polygon meshes and then trying to blur them, render the vision polygon as-is but generate a Signed Distance Field (SDF) from the vision mask. Use the SDF in the fog shader to produce perfectly smooth edges regardless of polygon quality.

**How it works:**
1. Render the polygon mesh to the vision RT as today (white on black).
2. Run a Jump Flood Algorithm (JFA) pass to compute a distance field from the binary mask edges. JFA runs in O(log₂(N)) passes for an N×N texture — for 2048px, that's ~11 passes.
3. The fog shader reads the SDF instead of the raw mask. Edge softness becomes `smoothstep(0, softnessPx, distance)` — perfectly smooth regardless of polygon vertex density.

**Pros:**
- Completely eliminates scalloping — any polygon shape produces smooth edges
- Resolution-independent edge quality
- Natural support for variable-width soft edges
- No changes needed to Foundry's polygon output
- JFA is well-understood and GPU-efficient (~0.3ms for 2048² on mid-range GPU)

**Cons:**
- Adds 11 render passes per frame (can be optimized to only run when vision changes)
- Requires two ping-pong render targets for JFA
- Slightly more complex shader pipeline

**Implementation sketch:**
```
Phase 1: JFA Distance Field
  - Create two JFA ping-pong RTs at vision RT resolution
  - Seed pass: initialize from vision mask (inside=0, outside=large)
  - 11 JFA passes: for step = 1024, 512, ..., 2, 1
  - Output: distance-to-edge texture

Phase 2: Fog Shader Update
  - Replace raw vision texture sampling with SDF sampling
  - Edge = smoothstep(-softness, +softness, signedDistance)
  - Remove sampleSoft() blur (no longer needed)
```

---

### Option B: Arc Interpolation on CPU (Simpler, Less Robust)

**Concept:** Before creating the THREE.Shape, detect segments of the polygon that lie on the vision circle boundary and interpolate additional arc points.

**How it works:**
1. In `_renderVisionMask()`, after reading `shape.points`, identify consecutive vertices that lie on (or very near) the vision radius circle.
2. For each pair of consecutive on-circle vertices, compute the arc angle and insert intermediate points at a finer density (e.g. 1° per point instead of 5°).
3. Feed the enriched polygon to ShapeGeometry.

**Algorithm:**
```javascript
function enrichCircleArcs(points, center, radius, maxArcDegrees = 1.0) {
  const enriched = [];
  const radiusSq = radius * radius;
  const tolerance = radius * 0.02; // 2% tolerance for "on circle"
  
  for (let i = 0; i < points.length; i += 2) {
    const x = points[i], y = points[i + 1];
    enriched.push(x, y);
    
    const nx = points[(i + 2) % points.length];
    const ny = points[(i + 3) % points.length];
    
    // Check if both current and next point are on the circle
    const distCurr = Math.sqrt((x - center.x) ** 2 + (y - center.y) ** 2);
    const distNext = Math.sqrt((nx - center.x) ** 2 + (ny - center.y) ** 2);
    
    if (Math.abs(distCurr - radius) < tolerance && 
        Math.abs(distNext - radius) < tolerance) {
      // Both on circle — interpolate arc
      const angleA = Math.atan2(y - center.y, x - center.x);
      const angleB = Math.atan2(ny - center.y, nx - center.x);
      let dAngle = angleB - angleA;
      // Normalize to shortest arc
      while (dAngle > Math.PI) dAngle -= 2 * Math.PI;
      while (dAngle < -Math.PI) dAngle += 2 * Math.PI;
      
      const maxStep = maxArcDegrees * Math.PI / 180;
      const steps = Math.ceil(Math.abs(dAngle) / maxStep);
      if (steps > 1) {
        const step = dAngle / steps;
        for (let s = 1; s < steps; s++) {
          const a = angleA + s * step;
          enriched.push(center.x + Math.cos(a) * radius,
                        center.y + Math.sin(a) * radius);
        }
      }
    }
  }
  return enriched;
}
```

**Pros:**
- Simple to implement
- No additional render passes
- Directly fixes the polygon quality at source

**Cons:**
- Requires knowing the vision center and radius (available from token data)
- Increases vertex count (more earcut work, more triangles to render)
- Tolerance-based "on circle" detection can misclassify wall intersection points
- Does not help with other polygon artifacts (earcut failures, degenerate edges)
- Does not improve exploration mask edges

---

### Option C: Higher-Resolution Vision RT + Gaussian Blur

**Concept:** Increase the vision RT resolution and add a dedicated Gaussian blur pass before the fog shader samples it.

**How it works:**
1. Raise the vision RT cap from 2048 to 4096.
2. After rendering vision polygons, run a separable Gaussian blur (two passes: horizontal + vertical) with a configurable kernel radius.
3. The fog shader samples the blurred vision texture and uses a simple threshold.

**Pros:**
- Very simple to implement (just add blur passes)
- Improves all edge quality, not just circle arcs
- Works regardless of polygon source

**Cons:**
- 4× VRAM increase for the vision RT (4096² RGBA = 64MB)
- Blur can cause vision to "leak" through thin walls
- Does not fix the underlying geometry — just hides it at a cost
- Higher-res RT means more expensive exploration readback for persistence

---

### Option D: Hybrid SDF + Arc Enrichment

**Concept:** Combine Option B (arc enrichment) for the polygon quality fix with a lightweight distance field for edge softening.

**How it works:**
1. Enrich circle arcs at 2° resolution (Option B) — cheap CPU step
2. Run a small-radius (4-pass) JFA for smooth edge softening only
3. Fog shader uses the SDF for edge blending

This gives clean polygon geometry (fewer artifacts to hide) plus resolution-independent smooth edges, at lower cost than full SDF (4 passes instead of 11).

---

## Recommendation

**Option A (SDF via JFA)** is the recommended approach. It:

1. **Completely solves the problem** — any polygon shape produces smooth edges, regardless of vertex density or grazing angles.
2. **Is future-proof** — works with any polygon source (Foundry LOS, custom vision, light shapes, darkness sources).
3. **Is resolution-independent** — edge quality doesn't degrade on large scenes or at different zoom levels.
4. **Eliminates the need for sampleSoft()** — the fog shader becomes simpler and cheaper per-pixel.
5. **Only runs when vision changes** — the JFA passes can be cached and reused across frames where the vision mask hasn't changed, amortizing the cost to near-zero for static scenes.

If the JFA complexity is a concern, **Option D (Hybrid)** provides 80% of the benefit at lower implementation cost.

---

## Implementation Plan

### Phase 1: JFA Infrastructure (Core)

1. **Create `VisionSDF` utility class** (`scripts/vision/VisionSDF.js`)
   - Manages two ping-pong RTs at vision RT resolution
   - Seed pass shader: converts binary mask → initial JFA seeds
   - JFA step shader: standard jump flood with configurable step size
   - Final pass shader: converts JFA output → signed distance field
   - Public API: `update(visionTexture)` → returns SDF texture

2. **Integrate into WorldSpaceFogEffect**
   - After `_renderVisionMask()` renders the binary vision mask:
     - Call `visionSDF.update(visionRenderTarget.texture)`
     - Pass resulting SDF texture to fog material as `tVisionSDF`
   - Only run JFA when `_needsVisionUpdate` was true this frame

3. **Update fog plane shader**
   - Replace `sampleSoft(tVision, ...)` with SDF-based edge:
     ```glsl
     float dist = texture2D(tVisionSDF, visionUv).r;
     float visible = smoothstep(-softnessPx * texelSize, softnessPx * texelSize, dist);
     ```
   - Remove `sampleSoft()` function (no longer needed)
   - Keep noise distortion (apply to UV before SDF sample)

### Phase 2: Exploration SDF (Polish)

4. **Apply SDF to exploration texture edges**
   - Run a second (lower-frequency) JFA on the exploration accumulation texture
   - Gives smooth explored/unexplored boundaries too
   - Can use fewer passes (lower resolution is acceptable for exploration)

### Phase 3: Performance Optimization

5. **Frame caching**
   - Track `_visionSDFDirty` flag — only re-run JFA when vision mask changes
   - On static scenes with no token movement, JFA cost = 0

6. **Resolution tuning**
   - JFA can run at half the vision RT resolution (1024px) for a 4× speedup
   - The SDF naturally upscales smoothly due to bilinear filtering

---

## Performance Budget

| Component | Cost (2048² RT) | When |
|---|---|---|
| Vision polygon render | ~0.1ms | Per vision change |
| JFA seed pass | ~0.05ms | Per vision change |
| JFA step passes (×11) | ~0.3ms | Per vision change |
| SDF → fog sample | ~0.02ms | Per frame |
| **Total additional** | **~0.45ms** | **Per vision change only** |

On static scenes (no token movement), the additional cost is **zero** — only the per-frame SDF sample cost remains, which is cheaper than the current `sampleSoft()` multi-tap blur.

---

## Files to Create/Modify

| File | Action | Description |
|---|---|---|
| `scripts/vision/VisionSDF.js` | **Create** | JFA distance field generator |
| `scripts/effects/WorldSpaceFogEffect.js` | Modify | Wire SDF into vision pipeline, update fog shader |
| `scripts/foundry/canvas-replacement.js` | Modify | Initialize VisionSDF alongside fog effect |

---

## Fallback

If JFA proves too complex or has driver compatibility issues, **Option B (arc enrichment)** can be implemented as a quick fix in `_renderVisionMask()` with ~50 lines of code. It won't produce perfectly smooth edges but will reduce the scalloping to imperceptible levels at typical zoom.
