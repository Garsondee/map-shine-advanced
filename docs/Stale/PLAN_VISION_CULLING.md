# Vision-Driven Early Discard System

**Date**: 2024-12-12  
**Status**: Planning / Research  
**Priority**: Future Optimization (Player Performance)

---

## Executive Summary

This document explores a performance optimization technique that uses the Fog of War vision mask to drive early fragment discards across all shaders. The goal is to skip expensive shader computations for pixels the player cannot see, providing significant performance gains for players while having minimal impact on GMs (who often bypass fog).

---

## The Idea

### Concept
Use the existing vision/fog mask as a "global visibility texture" that all shaders can sample at the start of their fragment shader. If the pixel is in an unexplored/invisible region, immediately `discard` or early-return before performing expensive computations.

### Current State
- **WorldSpaceFogEffect** already renders vision polygons to a world-space render target (`visionRenderTarget`)
- The fog plane shader already uses this to `discard` visible fragments
- Many effects already use `discard` for mask-based early exits (see: `IridescenceEffect`, `WindowLightEffect`, `PrismEffect`, `BushEffect`, `TreeEffect`, `ThreeLightSource`)

### Proposed Enhancement
Instead of each effect independently checking masks, provide a **centralized visibility texture** that all effects can sample first, before any other computation.

---

## Architecture Options

### Option A: Global Uniform Injection
Inject `uVisionMask` uniform into all ShaderMaterials automatically.

```glsl
// At the very start of every fragment shader
uniform sampler2D uVisionMask;
uniform float uVisionCullingEnabled;

void main() {
  if (uVisionCullingEnabled > 0.5) {
    float visibility = texture2D(uVisionMask, vUv).r;
    if (visibility < 0.1) discard; // Not visible - skip everything
  }
  
  // ... rest of shader
}
```

**Pros:**
- Simple concept
- Works with existing shader architecture
- Can be toggled per-effect or globally

**Cons:**
- Requires modifying every shader
- UV mapping varies between effects (world-space vs screen-space)
- Texture sample overhead even for visible pixels

---

### Option B: Stencil Buffer Pre-Pass
Render vision mask to stencil buffer, then use stencil test to reject fragments.

```javascript
// Pre-pass: Render vision polygons with stencil write
renderer.state.buffers.stencil.setTest(true);
renderer.state.buffers.stencil.setFunc(gl.ALWAYS, 1, 0xFF);
renderer.state.buffers.stencil.setOp(gl.KEEP, gl.KEEP, gl.REPLACE);
renderVisionPolygons();

// Main pass: Only render where stencil == 1
renderer.state.buffers.stencil.setFunc(gl.EQUAL, 1, 0xFF);
renderScene();
```

**Pros:**
- Hardware-accelerated rejection (before fragment shader runs)
- No shader modifications needed
- True early-z rejection

**Cons:**
- Stencil buffer management complexity
- May conflict with other stencil uses
- Requires careful render order management
- Not all effects render to the same target

---

### Option C: Depth Pre-Pass with Vision Geometry
Render vision polygons as depth-only geometry, then use depth test to reject.

**Pros:**
- Leverages GPU early-z optimization
- No shader changes

**Cons:**
- Vision polygons are 2D, depth approach doesn't map well
- Would require artificial depth values
- Conflicts with actual scene depth

---

### Option D: Post-Processing Mask (Current Approach, Enhanced)
Keep the current approach where fog is applied last, but optimize individual effects to check visibility early.

**Pros:**
- Already working
- No architectural changes
- Effects can opt-in individually

**Cons:**
- Expensive effects still run for invisible pixels
- Each effect needs manual optimization
- Inconsistent implementation

---

### Option E: Visibility Texture + Shader Include System
Create a shared GLSL include that effects can import.

```glsl
// visibility_culling.glsl
uniform sampler2D uGlobalVisionMask;
uniform vec4 uVisionMaskBounds; // x, y, width, height in world coords
uniform float uVisionCullingEnabled;

bool shouldCullFragment(vec2 worldPos) {
  if (uVisionCullingEnabled < 0.5) return false;
  
  vec2 uv = (worldPos - uVisionMaskBounds.xy) / uVisionMaskBounds.zw;
  if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) return true;
  
  return texture2D(uGlobalVisionMask, uv).r < 0.1;
}
```

```glsl
// In any effect shader
#include <visibility_culling>

void main() {
  if (shouldCullFragment(vWorldPos)) discard;
  // ... expensive computations
}
```

**Pros:**
- Centralized logic
- Effects opt-in by including the snippet
- Consistent UV mapping via world coords

**Cons:**
- Requires shader preprocessing or string injection
- Effects need `vWorldPos` varying
- Still one texture sample per fragment

---

## Recommended Approach: Option E (Visibility Texture + Shader Include)

### Rationale
1. **Opt-in**: Effects can choose to use it or not
2. **Centralized**: Single source of truth for visibility logic
3. **Flexible**: Works with both world-space and screen-space effects
4. **Testable**: Can be toggled globally for A/B performance testing
5. **Incremental**: Can be added to effects one at a time

---

## Implementation Plan

### Phase 1: Infrastructure
1. Create `VisionCullingManager` class
   - Exposes `getVisionTexture()` returning the current vision render target
   - Exposes `getVisionBounds()` returning world-space bounds
   - Provides `isEnabled()` check
   
2. Create shader include string `VISION_CULLING_GLSL`
   - Uniform declarations
   - `shouldCullFragment(vec2 worldPos)` function
   - `shouldCullFragmentScreenSpace(vec2 screenUv)` variant

3. Add global setting: `visionCullingEnabled` (default: true for players, false for GM)

### Phase 2: Effect Integration (Priority Order)
Integrate into effects by computational cost (highest first):

1. **LightingEffect** - Complex multi-pass lighting
2. **SpecularEffect** - PBR calculations, stripe layers
3. **CloudEffect** - Noise sampling, raymarching
4. **BuildingShadowsEffect** - Raymarching
5. **WeatherParticles** - Per-particle visibility
6. **IridescenceEffect** - Already has discard, enhance
7. **WindowLightEffect** - Already has discard, enhance

### Phase 3: Optimization
1. Reduce vision texture resolution for culling (512x512 is sufficient)
2. Cache visibility texture across frames when vision hasn't changed
3. Consider hierarchical culling (tile-based visibility)

---

## Performance Analysis

### Expected Gains

| Scenario | Current Cost | With Culling | Savings |
|----------|--------------|--------------|---------|
| Player sees 25% of map | 100% shader work | ~30% shader work | **~70%** |
| Player sees 50% of map | 100% shader work | ~55% shader work | **~45%** |
| Player sees 75% of map | 100% shader work | ~80% shader work | **~20%** |
| GM (fog bypassed) | 100% shader work | 100% shader work | 0% |

*Note: Overhead from texture sample (~5%) included in estimates*

### Where Savings Come From
- **Fragment shaders**: Skip expensive per-pixel computations
- **Texture bandwidth**: Fewer texture samples for invisible pixels
- **ALU operations**: Skip math for invisible pixels

### Where Savings DON'T Apply
- **Vertex shaders**: Still run for all geometry
- **Draw calls**: Same number of draw calls
- **CPU overhead**: Unchanged
- **Memory**: Unchanged (textures still loaded)

---

## Risks & Mitigations

### Risk 1: UV Coordinate Mismatch
**Problem**: Different effects use different coordinate systems (world-space, screen-space, local UV).

**Mitigation**: 
- Provide multiple helper functions (`shouldCullWorld`, `shouldCullScreen`)
- Document coordinate requirements clearly
- Effects pass their coordinate system explicitly

---

### Risk 2: Vision Texture Lag
**Problem**: Vision texture might be one frame behind, causing visible "popping" at fog edges.

**Mitigation**:
- Use conservative culling (only cull if DEFINITELY invisible)
- Add small margin around visible area
- Sync vision texture update with frame coordinator

---

### Risk 3: GM Experience Degradation
**Problem**: GMs often bypass fog, so they get no benefit but pay the overhead cost.

**Mitigation**:
- Detect GM + no controlled tokens = disable culling entirely
- Make culling a player-only optimization
- Add explicit toggle in settings

---

### Risk 4: Shader Compilation Overhead
**Problem**: Adding uniforms/code to shaders increases compile time.

**Mitigation**:
- Use `#ifdef` guards so culling code is compiled out when disabled
- Lazy-compile shaders only when culling is enabled
- Cache compiled shaders

---

### Risk 5: Edge Artifacts
**Problem**: Harsh cutoff at fog boundary could cause visual artifacts.

**Mitigation**:
- Use smooth threshold (0.1 instead of 0.0)
- Consider soft falloff zone where effects fade rather than hard cut
- Test extensively with various fog configurations

---

### Risk 6: Exploration Texture Handling
**Problem**: Explored-but-not-visible areas should still render (dimmed), not be culled.

**Mitigation**:
- Culling should only apply to **unexplored** areas
- Use exploration texture in addition to vision texture
- `shouldCull = !explored && !visible`

---

## Alternatives Considered

### Alternative 1: Tile-Based Culling
Divide map into tiles, track which tiles are visible, skip rendering entire tiles.

**Why Not**: 
- Coarse granularity (visible tile edge = render whole tile)
- Requires spatial data structures
- Doesn't help with partially-visible tiles

### Alternative 2: Frustum Culling Only
Only render what's in camera view.

**Why Not**:
- Already implemented by Three.js
- Doesn't help with fog-hidden areas within view

### Alternative 3: Deferred Rendering
Render geometry to G-buffer, then only shade visible pixels.

**Why Not**:
- Major architectural change
- Overkill for 2.5D rendering
- Transparency handling complexity

---

## Success Metrics

1. **FPS improvement** for players on complex maps (target: +20% on mid-tier hardware)
2. **No visual artifacts** at fog boundaries
3. **No performance regression** for GMs
4. **Minimal code changes** per effect (<10 lines)
5. **Toggle-able** via settings for troubleshooting

---

## Dependencies

- `WorldSpaceFogEffect.visionRenderTarget` - Already exists
- `EffectComposer` uniform injection - May need enhancement
- `FrameCoordinator` - For vision texture sync timing

---

## Open Questions

1. **Should particles use this?** Particles are vertex-shader driven; fragment culling may not help much.

2. **What about post-processing effects?** Screen-space effects (bloom, color correction) operate on the final image, not world geometry. Culling doesn't apply.

3. **How to handle dynamic vision changes?** Token movement causes vision to change. Need to ensure culling texture is always current.

4. **Should we cull scene geometry too?** Currently only considering effects. Could extend to tiles/tokens, but they're cheap to render.

---

## Timeline Estimate

| Phase | Effort | Dependencies |
|-------|--------|--------------|
| Phase 1: Infrastructure | 2-3 hours | None |
| Phase 2: Effect Integration | 4-6 hours | Phase 1 |
| Phase 3: Optimization | 2-3 hours | Phase 2 + Testing |
| Testing & Polish | 2-3 hours | All phases |

**Total**: ~10-15 hours of development

---

## Conclusion

Vision-driven early discard is a **viable optimization** that can provide significant performance improvements for players (the primary beneficiaries of fog of war). The recommended approach (Option E: Visibility Texture + Shader Include) provides a good balance of:

- **Flexibility**: Opt-in per effect
- **Maintainability**: Centralized logic
- **Performance**: Hardware-accelerated texture sampling
- **Safety**: Can be disabled if issues arise

The main risks (coordinate mismatch, edge artifacts, exploration handling) are all manageable with careful implementation.

**Recommendation**: Proceed with implementation after current feature work stabilizes. This is a "nice to have" optimization, not a blocker.

---

## References

- `scripts/effects/WorldSpaceFogEffect.js` - Current fog implementation
- `scripts/effects/EffectComposer.js` - Effect orchestration
- `scripts/core/frame-coordinator.js` - PIXI/Three.js sync
- GPU Gems 2, Chapter 29: "Efficient Occlusion Culling"
- Three.js Stencil Buffer documentation
