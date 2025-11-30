# Plan: Wall-Aware Lighting (Mesh-Based)

## Problem
Current lighting uses a screen-space array of point lights. This ignores walls/occlusion because calculating shadows for 64 lights in a single fragment shader loop is prohibitively expensive and complex (requires raymarching or passing complex polygon data).

Foundry VTT calculates visibility polygons (`PointSourcePolygon`) on the CPU using efficient sweeping algorithms. We should leverage this.

## Solution: Mesh-Based Deferred Lighting
Instead of passing light data to a full-screen shader, we will render **each light as a mesh** into a `Light Accumulation Buffer`. The mesh geometry will be the exact visibility polygon provided by Foundry, effectively "masking" the light by walls automatically.

## Architecture Changes

### 1. New Class: `LightMesh`
A helper class wrapping a `THREE.Mesh` representing a single light source.
*   **Geometry**: `THREE.ShapeGeometry` created from `lightSource.shape.points`.
*   **Material**: `THREE.ShaderMaterial` using `AdditiveBlending`.
    *   Draws the radial gradient (Falloff/Bright/Dim).
    *   Handles "Indoor/Outdoor" logic (Roof Occlusion) via uniforms.
    *   Discards pixels outside the radius (optimization, though geometry handles most of it).

### 2. Refactor `LightingEffect`
*   **Remove**: `lightPosition`, `lightColor`, `lightConfig` uniform arrays.
*   **Add**: `lightScene` (THREE.Scene) and `lightTarget` (WebGLRenderTarget).
*   **Sync Logic**:
    *   `onLightUpdated(doc)`:
        *   Get `doc.object.source` (the Foundry PointSource).
        *   Get `source.shape.points` (Polygon vertices).
        *   Convert points to THREE world space (`Coordinates.toWorld`).
        *   Update `LightMesh` geometry.
        *   Update `LightMesh` material uniforms (color, intensity, position).
*   **Render Loop**:
    1.  Clear `lightTarget` to Black (0,0,0,0).
    2.  Render `lightScene` into `lightTarget` (Additive Blending accumulates light).
    3.  Render Composition Quad (Post-Process):
        *   Input: `tDiffuse` (Base Scene), `tLights` (Light Accumulation).
        *   Output: `Base + (Base * Lights)`.

## Technical Details

### Coordinate Conversion
Foundry Polygon Points are absolute `[x, y]` in Top-Left pixels.
Three.js requires Bottom-Left origin.
Transformation: `y_three = canvas.dimensions.height - y_foundry`.

### Soft Edges
Foundry supports "Soft Edges" via `PolygonMesher`. For v1, we will stick to the hard polygon edges (matching Foundry's hard shadows). Softness can be simulated in the shader or by expanding the polygon slightly if needed later.

### Performance
*   **Vertex Count**: Low. Polygons are usually < 100 verts.
*   **Draw Calls**: 1 per light. ~50 lights = 50 draw calls. Very cheap.
*   **Fill Rate**: High overlap? Additive blending handles this. Geometry culling reduces overdraw compared to full-screen quads.

### Roof Occlusion Integration
The existing "Indoor/Outdoor" logic relies on checking the light's position against `uRoofMap`.
*   Pass `uRoofMap` and `uRoofAlphaMap` to the **LightMesh Material**.
*   Perform the check in the LightMesh fragment shader.
*   This is cleaner than the big loop; each light knows its own status.

## Implementation Steps
1.  Create `scripts/scene/LightMesh.js`.
2.  Modify `LightingEffect.js` to initialize `lightScene` and `lightTarget`.
3.  Implement `syncLight` to transform Foundry polygons to Three.js geometry.
4.  Update shaders to split logic (Light Generation vs Composition).
