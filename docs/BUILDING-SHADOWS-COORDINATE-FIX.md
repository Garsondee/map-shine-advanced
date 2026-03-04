# BuildingShadowsEffect Coordinate System Fix

## Issues Fixed

### 1. **Bake Camera Y-Axis Orientation** ✅
**Problem**: Camera was using `top=1, bottom=0` (Y-down), incompatible with Three.js Y-up world coordinates.

**Fix**: Changed to `OrthographicCamera(0, 1, 0, 1, 0, 1)` with `bottom=0, top=1` (Y-up).

**Rationale**: The baseMesh uses `scale.y=-1` to flip from Foundry's Y-down to Three.js Y-up. The bake camera must match this Y-up orientation so the baked shadow texture aligns correctly with the world mesh.

### 2. **Scene Bounds Clamping** ✅
**Problem**: Raymarching used simple `0..1` UV bounds check, causing shadows to raymarch into canvas padding areas and create artifacts at scene edges.

**Fix**: 
- Added `uSceneBounds` uniform (vec4: x, y, width, height in UV space)
- Updated `inBounds()` shader function to clamp to actual scene rect
- Scene bounds computed from `canvas.dimensions.sceneRect` each frame

**Impact**: Shadows now only raymarch within the actual playable scene area, eliminating edge artifacts.

### 3. **Shadow Mesh Transform** ✅
**Problem**: Documentation unclear about whether Y-flip should be copied.

**Fix**: Explicitly copy `baseMesh.scale` including the Y-flip with clear comments explaining the intentional coordinate system alignment.

**Rationale**: The shadow mesh must match the baseMesh transform exactly (including `scale.y=-1`) to align the baked world-space shadow texture with the world geometry.

## Coordinate System Architecture

### Foundry → Three.js Coordinate Mapping
```
Foundry (Y-down):          Three.js (Y-up):
  0 ─────────── W            H ─────────── W
  │             │            │             │
  │   Scene     │    →       │   Scene     │
  │             │            │             │
  H ─────────── W            0 ─────────── W
```

### Implementation Strategy
1. **baseMesh**: Uses `flipY=false` textures + `scale.y=-1` to flip geometry
2. **Bake Camera**: Y-up (`bottom=0, top=1`) matches Three.js world space
3. **Bake Texture**: Rendered in Y-up orientation, aligned with flipped baseMesh
4. **Shadow Mesh**: Copies baseMesh transform exactly (including Y-flip)

### Sun Direction
- Computed as `x = -sin(azimuth)`, `y = -cos(azimuth) * latitude`
- This matches the mesh-UV coordinate system (V=0 at north after Y-flip)
- No additional Y-inversion needed for bake pass (camera is now Y-up)

## Testing Checklist

- [ ] Shadows appear at correct building locations (not inverted)
- [ ] Shadow direction matches time of day
- [ ] No shadow artifacts at scene edges
- [ ] Shadows respect scene padding boundaries
- [ ] Shadow length/blur parameters work correctly
- [ ] Multi-floor scenes show correct shadows per floor

## Related Files
- `scripts/effects/BuildingShadowsEffect.js` - Main effect implementation
- `scripts/scene/composer.js` - baseMesh with `scale.y=-1` (line 990)
- `scripts/compositor-v2/effects/BuildingShadowsEffectV2.js` - V2 implementation (may need same fixes)
