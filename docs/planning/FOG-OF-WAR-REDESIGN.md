# Fog of War Redesign

## Status: Implemented (Option B — PIXI Texture Bridge)
## Priority: Critical — current system produces incorrect vision shapes → **RESOLVED**

---

## 1. Requirements

1. **Unexplored areas** (never seen by any controlled token) are rendered **solid black** (opaque).
2. **Previously explored areas** (seen before but not currently visible) are rendered with a **50% dark overlay**.
3. **Currently visible areas** (within active token LOS) are rendered **fully clear** (no overlay).
4. Must integrate with Foundry VTT's wall/door system for line-of-sight blocking.
5. Must persist exploration progress to Foundry's `FogExploration` document.
6. Must work for both Players (see through owned tokens) and GMs (bypass when no token selected).
7. Must not depend on PIXI rendering — the PIXI canvas is hidden.

---

## 2. Diagnosis of Current System

### 2.1 Architecture (WorldSpaceFogEffect.js — ~1850 lines)

The current system:
1. Reads `token.vision.los` polygon from Foundry's `PointVisionSource` (computed by Foundry's perception system).
2. Cleans/deduplicates polygon points, offsets by `sceneRect.x/y`.
3. Triangulates with `earcut` into `THREE.BufferGeometry`.
4. Renders white triangulated meshes into a world-space render target (`visionRenderTarget`) using an orthographic camera.
5. Accumulates vision into an exploration texture via ping-pong rendering (`explored = max(explored, vision)`).
6. A fog plane mesh samples both textures in its fragment shader and composites the fog overlay.

### 2.2 Identified Bugs

#### Bug A: Y-Axis Double-Flip (Root Cause of Incorrect Shapes)

The vision camera is configured as:
```javascript
this.visionCamera = new THREE.OrthographicCamera(
  0, width,    // left=0, right=width
  height, 0,   // top=height, bottom=0
  0, 100
);
```

This maps:
- Foundry point `(x, 0)` → rendered at **bottom** of the vision texture (NDC y=-1)
- Foundry point `(x, height)` → rendered at **top** of the vision texture (NDC y=+1)

In WebGL, texture UV `(0, 0)` is the bottom-left. So `texture2D(tVision, vec2(u, 0))` samples the bottom = where Foundry Y=0 (top of scene) was rendered. This means **without any flip, the mapping is already correct**.

However, the fog shader applies an additional Y-flip:
```glsl
vec2 visionUv = vec2(vUv.x, 1.0 - vUv.y);
```

The fog plane's UV `(0, 0)` corresponds to the Three.js bottom-left = Foundry top-left. Without the flip, sampling vision UV `(0, 0)` correctly reads the Foundry top-left from the vision texture. **The `1.0 - vUv.y` flip inverts this, causing the vision mask to be vertically mirrored relative to the scene.**

This is the primary cause of "shapes aren't correct" — the LOS polygon is rendered in the right shape but displayed upside-down on the fog plane.

#### Bug B: Exploration Texture Also Double-Flipped

The same `1.0 - vUv.y` flip is applied to the explored texture sampling:
```glsl
vec2 exploredUv = vec2(vUv.x, 1.0 - vUv.y);
```
This means previously explored areas are also shown in the wrong positions.

#### Bug C: Polygon Point Interpretation Fragility

The code reads `visionSource.los || visionSource.shape || visionSource.fov`, but:
- `los` is the **unconstrained** line-of-sight (extends to `maxR` = edge of canvas)
- `shape` is the **range-constrained** polygon (limited by sight range)
- `fov` is an alias for `shape`

Using `los` first means the fog mask shows the full LOS regardless of token sight range, which may not match Foundry's visual behavior (where `shape` is used for the visibility mask).

#### Bug D: Heavy Complexity for a Texture Blit

The system is ~1850 lines handling:
- Dual render targets for ping-pong exploration
- Earcut triangulation of Foundry's already-computed polygons
- Manual mesh pooling, coordinate cleaning, collinearity removal
- Tiled GPU readback for persistence
- Debounced saving with rate limiting

Most of this complexity exists because we're re-rendering Foundry's polygon data through our own pipeline. If we could use Foundry's already-rendered vision mask, the system would be dramatically simpler.

---

## 3. Approach Options

### Option A: Fix Current System (Minimal Change)

**Effort**: Small
**Risk**: Low

Fix the Y-flip bugs and polygon source selection:
1. Remove `1.0 - vUv.y` from both vision and exploration UV sampling in the fog shader.
2. Use `visionSource.shape` (range-constrained) instead of `visionSource.los` (unconstrained).
3. Verify end-to-end with a simple test scene.

**Pros**: Minimal code change, preserves existing architecture.
**Cons**: The underlying architecture remains fragile — 1850 lines of code doing what should be a simple texture composite. Earcut triangulation of complex concave Foundry polygons is inherently error-prone.

---

### Option B: PIXI Texture Bridge (Force Foundry to Render Vision Mask)

**Effort**: Medium
**Risk**: Medium

Force Foundry's PIXI renderer to produce the vision mask texture, then share the WebGL texture handle with Three.js. The `FoundryFogBridge` class already has infrastructure for this.

**How it works**:
1. Foundry's perception system computes LOS polygons regardless of canvas visibility.
2. `CanvasVisibility.refreshVisibility()` draws vision shapes into `canvas.masks.vision`.
3. PIXI renders this to `canvas.masks.vision.renderTexture`.
4. We grab the WebGL texture handle via `baseTexture._glTextures` and bind it in Three.js.
5. For exploration, use `canvas.fog.sprite.texture` the same way.

**Implementation**:
- In `frameCoordinator.onPostPixi`, call `frameCoordinator.flushPixi()` to force PIXI to render.
- Extract `canvas.masks.vision.renderTexture` GL handle.
- Use `FoundryFogBridge._pixiToThreeTexture()` (already implemented).
- The fog plane shader stays essentially the same but receives Foundry's authoritative textures.

**Pros**:
- Perfect visual parity with Foundry's native fog behavior.
- No earcut triangulation, no polygon cleaning, no mesh pooling.
- Exploration persistence handled by Foundry natively (don't override `commit`/`save`).
- Detection modes, vision modes, light perception — all handled by Foundry.
- Massive code reduction (~1850 lines → ~300 lines).

**Cons**:
- Depends on PIXI still rendering vision even though canvas is hidden (opacity: 0).
- If Foundry changes internal PIXI structure, the GL handle extraction breaks.
- Two renderers touching the same GL textures can cause subtle state corruption.

**Feasibility Assessment**:
Even with `opacity: 0`, the PIXI canvas is still in the DOM and the PIXI ticker still runs. Foundry's perception updates still fire. The `CanvasVisibility.refresh()` method still executes. The vision container is still rendered to `canvas.masks.vision.renderTexture` by the PIXI renderer. The only question is whether PIXI skips rendering when the canvas is not visible — and the answer is **no**, because PIXI's ticker doesn't check CSS visibility. The `frameCoordinator` already calls `flushPixi()` which forces `canvas.app.renderer.render(canvas.stage)`.

---

### Option C: GPU Raycasting (Shader-Native Vision)

**Effort**: Large
**Risk**: High

Compute line-of-sight entirely on the GPU via a fragment shader that raycasts against wall segments.

**How it works**:
1. Pack all wall segments into a `DataTexture` (4 floats per wall: x1, y1, x2, y2).
2. For each pixel in the vision render target, cast a ray from the token center to the pixel.
3. Check intersection against all walls. If any wall blocks the ray, the pixel is not visible.
4. Apply range constraints (sight radius).

**Pros**:
- Fully GPU-native, no CPU polygon computation at all.
- Smooth at any resolution, no triangulation artifacts.
- Could support soft shadows / penumbra effects.

**Cons**:
- O(pixels × walls) GPU work — expensive for large scenes with many walls.
- Must replicate Foundry's door state, directional walls, limited walls, etc.
- Does not integrate with Foundry's detection modes (tremorsense, darkvision, etc.).
- Significant engineering effort for diminishing returns over Option B.

---

### Option D: Hybrid — Stencil Buffer Vision

**Effort**: Medium
**Risk**: Medium

Instead of earcut triangulation, use the WebGL stencil buffer to fill Foundry's LOS polygon. The stencil buffer natively handles concave polygons via the even-odd or nonzero winding rule.

**How it works**:
1. Read `token.vision.shape.points` from Foundry.
2. Create a triangle fan from the polygon (center + consecutive edge pairs).
3. Render to the stencil buffer with stencil-based polygon filling.
4. Use the stencil to mask a full-screen white quad → vision texture.

**Pros**:
- No earcut dependency, handles concave/complex polygons natively.
- Simple geometry (triangle fan from center point).
- Still Three.js-native, no PIXI dependency.

**Cons**:
- Still requires reading Foundry's polygon data (same coordination complexity).
- Stencil buffer management adds complexity.
- Vision modes / detection modes still not supported.

---

## 4. Recommendation: Option B (PIXI Texture Bridge)

**Option B is the clear winner** for the following reasons:

1. **Correctness**: Uses Foundry's authoritative vision mask — guaranteed visual parity with what Foundry would show. No coordinate conversion bugs possible.

2. **Simplicity**: Eliminates polygon reading, cleaning, triangulation, mesh pooling, and coordinate transformation. The code reduces from ~1850 lines to ~300 lines.

3. **Feature completeness**: Foundry's vision system handles:
   - Basic sight with range constraints
   - Light perception (seeing areas lit by light sources)
   - Detection modes (tremorsense, darkvision, blindsight, etc.)
   - Vision modes (basic, darkvision, blindness, etc.)
   - Directional walls, limited walls, door states
   - Global illumination and darkness sources
   
   Our current system only handles basic LOS polygon rendering and ignores all of these.

4. **Exploration**: Foundry's `FogManager.commit()` already renders vision into the exploration texture. If we let Foundry handle exploration persistence natively, we eliminate ~700 lines of save/load/encode code.

5. **Maintenance**: No custom polygon computation means no bugs from Foundry API changes to polygon data structures.

### Fallback: Option A

If Option B proves infeasible (e.g., PIXI textures aren't actually rendered with canvas hidden), we fall back to **Option A** (fix the Y-flip bugs in the current system) as a quick patch while investigating further.

---

## 5. Implementation Plan (Option B)

### Phase 1: Validate PIXI Texture Availability

Before committing to the full rewrite, validate that Foundry's vision textures are actually rendered and accessible:

```javascript
// Test in browser console with MapShine active:
const visionRT = canvas.masks?.vision?.renderTexture;
console.log('Vision RT valid:', visionRT?.valid, 'Size:', visionRT?.width, 'x', visionRT?.height);

const exploredRT = canvas.fog?.sprite?.texture;
console.log('Explored RT valid:', exploredRT?.valid, 'Size:', exploredRT?.width, 'x', exploredRT?.height);

// Check if GL texture handles exist
const pixiRenderer = canvas.app.renderer;
const glTex = visionRT?.baseTexture?._glTextures?.[pixiRenderer.texture.CONTEXT_UID];
console.log('GL texture handle:', glTex?.texture);
```

If these are null/invalid, we need to force PIXI rendering first.

### Phase 2: New WorldSpaceFogEffect (Rewrite)

Replace `WorldSpaceFogEffect.js` with a much simpler version:

**Core Architecture**:
```
┌─────────────────────────────────────────────────┐
│                Frame Lifecycle                    │
│                                                   │
│  1. Foundry PIXI tick runs (perception updates)  │
│  2. frameCoordinator.onPostPixi fires            │
│  3. Force PIXI flush (ensures textures current)  │
│  4. Extract GL texture handles from PIXI         │
│  5. Bind to Three.js fog material uniforms       │
│  6. Three.js renders fog plane with shared tex   │
└─────────────────────────────────────────────────┘
```

**Components**:
- **FogPlane**: World-space mesh covering sceneRect (keep from current system)
- **TextureBridge**: Extracts and shares PIXI GL textures with Three.js (reuse `FoundryFogBridge`)
- **Fog Shader**: Composites vision + exploration (simplify from current)

**Shader Logic**:
```glsl
uniform sampler2D tVision;       // Foundry's real-time vision mask
uniform sampler2D tExplored;     // Foundry's exploration texture  
uniform vec3 uUnexploredColor;   // Default: black
uniform vec3 uExploredColor;     // Default: dark tint
uniform float uExploredOpacity;  // Default: 0.5
uniform float uBypassFog;        // GM bypass

varying vec2 vUv;

void main() {
    if (uBypassFog > 0.5) discard;
    
    // Map fog plane UVs to Foundry texture UVs
    // Vision texture covers the full canvas dimensions
    // Fog plane covers the sceneRect
    // Need to compute the correct UV mapping
    vec2 texUv = computeFoundryUV(vUv);
    
    float vision = texture2D(tVision, texUv).r;
    float explored = texture2D(tExplored, texUv).r;
    
    // Currently visible → fully clear
    if (vision > 0.5) discard;
    
    // Previously explored → semi-transparent overlay
    float fogAlpha = mix(1.0, uExploredOpacity, step(0.5, explored));
    vec3 fogColor = mix(uUnexploredColor, uExploredColor, step(0.5, explored));
    
    gl_FragColor = vec4(fogColor, fogAlpha);
}
```

### Phase 3: UV Mapping

The critical detail is mapping fog plane UVs to Foundry texture UVs correctly.

**Foundry's vision render texture** covers the `sceneRect` (sceneX, sceneY, sceneWidth, sceneHeight).
**Foundry's exploration texture** also covers the `sceneRect` via `canvas.fog.sprite.position`.

The fog plane also covers the `sceneRect` in Three.js world space.

**UV mapping** depends on whether the PIXI textures cover the full canvas or just the scene:
- `canvas.masks.vision.renderTexture` covers the **full canvas** (including padding).
- `canvas.fog.sprite.texture` covers the **sceneRect** only.

For the vision texture, we need to map fog plane UVs (which cover sceneRect) to the correct sub-region of the full-canvas vision texture:
```glsl
// Scene rect within full canvas
uniform vec4 uSceneRect;  // (sceneX, sceneY, sceneW, sceneH)
uniform vec2 uCanvasSize; // (canvasWidth, canvasHeight)

vec2 computeVisionUV(vec2 fogUv) {
    // fogUv (0,0) = sceneRect top-left, (1,1) = sceneRect bottom-right
    float canvasX = uSceneRect.x + fogUv.x * uSceneRect.z;
    float canvasY = uSceneRect.y + fogUv.y * uSceneRect.w;
    return vec2(canvasX / uCanvasSize.x, canvasY / uCanvasSize.y);
}
```

For the exploration texture (covers sceneRect directly):
```glsl
vec2 computeExploredUV(vec2 fogUv) {
    return fogUv; // Direct 1:1 mapping
}
```

### Phase 4: Exploration Persistence

**Let Foundry handle it.** Remove the overrides on `canvas.fog.commit()` and `canvas.fog.save()`. Foundry's `CanvasVisibility.refreshVisibility()` already calls `canvas.fog.commit()` which renders vision into the exploration texture and schedules saves.

The only thing we need is to ensure Foundry's perception system keeps running, which it does because:
1. The PIXI ticker still runs (`canvas.app.ticker`)
2. `canvas.perception.update()` is called by Foundry on token/wall/light changes
3. `CanvasVisibility.refresh()` is called by Foundry's perception pipeline

### Phase 5: GM Bypass & Edge Cases

- **GM with no tokens selected**: Show full scene (no fog). Already implemented via `_shouldBypassFog()`.
- **Player with no tokens**: Show combined vision of all owned tokens. Foundry handles this natively — all owned tokens have active vision sources.
- **Scene with `tokenVision: false`**: No fog. Already handled.
- **Scene with `fog.exploration: false`**: No exploration persistence, only real-time vision.

### Phase 6: Soft Edges & Visual Polish

Keep the existing soft-edge and noise distortion features from the current shader, but apply them to the Foundry-sourced textures:
- `sampleSoft()` for blurred edge sampling
- Noise-based UV warping for organic edges
- Configurable softness, noise strength, noise speed

---

## 6. Files Affected

### Remove / Deprecate
- `scripts/vision/VisionManager.js` — Already unused, confirm and remove
- `scripts/vision/VisionPolygonComputer.js` — Already unused, confirm and remove
- `scripts/vision/GeometryConverter.js` — Already unused, confirm and remove
- `scripts/vision/FogManager.js` — Already unused, confirm and remove
- `scripts/vision/FoundryFogBridge.js` — Reuse the `_pixiToThreeTexture` logic, then deprecate

### Rewrite
- `scripts/effects/WorldSpaceFogEffect.js` — Complete rewrite (~300 lines from ~1850)

### Modify
- `scripts/foundry/canvas-replacement.js` — Remove fog commit/save overrides, simplify wiring
- `scripts/core/frame-coordinator.js` — Ensure `flushPixi()` is called before fog sync

---

## 7. Risk Mitigation

| Risk | Mitigation |
|------|-----------|
| PIXI textures not rendered when canvas hidden | Test first (Phase 1). If fails, force render via `canvas.app.renderer.render(canvas.masks.vision)` explicitly |
| GL texture handle extraction breaks on Foundry update | Wrap in try/catch with fallback to current polygon approach |
| Shared GL textures cause state corruption | Use `renderer.properties.get(texture).__webglTexture` pattern (already proven in FoundryFogBridge) |
| Exploration texture UV mapping wrong | Foundry's exploration sprite has explicit position/scale — read these to compute correct UVs |
| Performance regression from forcing PIXI render | Benchmark — PIXI render should be lightweight since it's just drawing shapes to a render texture |

---

## 8. Quick Fix (If Rewrite Is Deferred)

If the full rewrite can't be done immediately, apply these minimal fixes to the current system:

1. **Remove Y-flip in fog shader** (Bug A & B):
```glsl
// BEFORE (broken):
vec2 visionUv = vec2(vUv.x, 1.0 - vUv.y) + uvWarp;
vec2 exploredUv = vec2(vUv.x, 1.0 - vUv.y) + uvWarp;

// AFTER (fixed):
vec2 visionUv = vUv + uvWarp;
vec2 exploredUv = vUv + uvWarp;
```

2. **Use `shape` instead of `los`** (Bug C):
```javascript
// BEFORE:
const shape = visionSource.los || visionSource.shape || visionSource.fov;

// AFTER (prefer range-constrained polygon):
const shape = visionSource.shape || visionSource.fov || visionSource.los;
```

3. **Test and verify** — if these two fixes resolve the visual issues, the current system can serve as a working interim solution while the rewrite is planned.
