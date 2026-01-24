# Drag Selection Box Rendering Plan

## Context
The drag selection box (left-mouse drag on empty space) is currently implemented in `scripts/scene/interaction-manager.js`.

- Visuals are rendered as a **screen-space DOM overlay** (`dragSelect.overlayEl`) with:
  - `border: 2px solid rgba(51,136,255,0.8)`
  - `backgroundColor: rgba(51,136,255,0.2)`
- Selection *math* is still world-based:
  - `dragSelect.start/current` are computed by `viewportToWorld(..., groundZ)`.

This gives correct selection behavior, but the DOM overlay severely limits rendering sophistication (custom shapes, FX, text, shader-based distortion, scene-aware shadows).

## Goals
- Reduce the “blue fill” so the rectangle reads primarily as an **outline**.
- Add a **drop shadow** for the selection box that is rendered as if it is being **cast onto the scene**.
  - Shadow should be offset from the outline.
  - Shadow should feel “scene-aware” (distorted by camera perspective and ideally by ground/terrain representation).
- Provide an extensible rendering foundation for:
  - Text labels (“Selecting…”, count, mode hints)
  - Decorative line work / corner glyphs
  - Animated effects (glow, noise, scanlines, marching ants, etc.)
  - Debug visualization (selection in world vs screen, snapping, etc.)

## Non-Goals (for first iteration)
- Replacing Foundry’s underlying selection semantics.
- Heavy-weight post-processing that touches the main scene color chain unnecessarily.
- Perfect physical correctness for complex 3D terrain until we confirm what “terrain” actually is in Map Shine Advanced.

## Key Constraints / Invariants
- The *visual* selection rectangle must match Foundry behavior: **screen-space drag rectangle**.
  - The current DOM overlay is correct in that sense.
- The *selection* calculation is already world-based and should stay authoritative.
- Rendering should remain **Three-first** (avoid PIXI usage).

## Existing Infrastructure We Can Reuse
- **Overlay render layer**: `OVERLAY_THREE_LAYER = 31` in `scripts/effects/EffectComposer.js`.
  - `EffectComposer._renderOverlayToScreen()` renders that layer last onto the backbuffer.
- **Shadow patterns**:
  - `OverheadShadowsEffect` uses a dedicated scene and a ground-pinned mesh, sampling a screen-space roof alpha target and applying an offset/blur.
  - `BuildingShadowsEffect` uses a baked (cached) world-space texture, then a cheap per-frame display pass.
- **Time**:
  - All animations should use `TimeManager` via `update(timeInfo)`.

## Proposed Architecture
Introduce a dedicated rendering component for drag selection that is decoupled from `InteractionManager`.

### New Component: `SelectionBoxRenderer`
- Responsible for all visuals related to drag selection.
- Registered as an updatable (like `InteractionManager`) so it can animate (time-based effects).

**Data inputs** (from `InteractionManager`):
- `screenStart`, `screenCurrent` (client coordinates)
- `worldStart`, `worldCurrent` (Three world coordinates at `groundZ`)
- `active`, `dragging`

**Outputs**:
1. Screen-space outline + minimal fill (primary UX)
2. World-space projected shadow (secondary UX)

### Rendering Strategy (Two-Layer)
#### Layer A: Screen-space outline (crisp UI)
We want screen-space consistency and crispness.

Recommended approach:
- Render via Three, in the overlay layer, using a fullscreen quad (or a lightweight overlay scene) and a small shader that draws the rectangle in screen UV space.

Why not DOM?
- DOM is fine for basic rectangles but limits:
  - shader-based patterns
  - text layout integrated with the scene renderer
  - consistent composition with bloom / grading if desired

#### Layer B: World-space “shadow projection”
Render a mesh in world space, placed on (or slightly above) the ground plane.

Recommended approach (v1):
- Create a `THREE.PlaneGeometry(1,1)` mesh.
- Position it at the center of the selection rect in world space.
- Scale it to match the selection extents.
- Apply a custom `ShaderMaterial` that:
  - provides soft edges / penumbra
  - optionally applies subtle noise
- Offset the shadow in world space by a configurable “sun / drop direction”.
  - This automatically produces perspective-correct distortion.

Recommended upgrade path (v2):
- If/when we have a reliable depth texture or height representation, distort the shadow with the scene:
  - Depth-based intersection or parallax offset
  - Normal-map guided warping

## Coordinate / Math Notes
- Foundry coordinates are Y-down; Three world coordinates are Y-up.
- Selection math currently uses `viewportToWorld(clientX, clientY, groundZ)` which already produces a Three-world point; keep this as source of truth.

World-space bounds:
- `minX = min(worldStart.x, worldCurrent.x)`
- `maxX = max(worldStart.x, worldCurrent.x)`
- `minY = min(worldStart.y, worldCurrent.y)`
- `maxY = max(worldStart.y, worldCurrent.y)`
- Center: `((minX+maxX)/2, (minY+maxY)/2)`
- Size: `(maxX-minX, maxY-minY)`

Screen-space bounds:
- `left = min(screenStart.x, screenCurrent.x)`
- `top = min(screenStart.y, screenCurrent.y)`
- `width = abs(dx)`, `height = abs(dy)`

## Visual Design Targets
### Outline
- Primary: bright “MapShine blue” outline
- Corners can be emphasized (corner brackets) instead of a full rectangular stroke
- Opacity should remain high (~0.8–1.0)
- Optional glow can be added by:
  - a second, wider stroke pass in shader
  - or a small dedicated bloom-like blur in the overlay layer

### Fill
- Near-transparent fill (goal: “almost all blue removed”)
- Suggested alpha: 0.02–0.06
- Alternatively: no fill, but a faint diagonal-hatch procedural pattern

### Shadow
- Dark neutral (not blue)
- Softness should scale with rectangle size (larger selection => slightly softer penumbra)
- Shadow offset should be stable in world-space, not UV-space.
- Shadow should respect scene layering:
  - it should appear on the ground
  - it should not incorrectly draw on top of roofs/overhead elements

## Implementation Phases
### Phase 0: Minimal DOM tweak (optional, fastest)
- Reduce fill alpha, keep border.
- Pros: trivial
- Cons: doesn’t unlock shader/text/scene-aware shadow

### Phase 1: Three-based overlay renderer (replace DOM overlay)
- Remove or disable `dragSelect.overlayEl`.
- Add `SelectionBoxOverlayPass` rendered via `OVERLAY_THREE_LAYER`.
- Shader draws outline with minimal fill.

Acceptance criteria:
- Visual rect matches current DOM behavior.
- No jitter with camera pan/zoom.

### Phase 2: World-space shadow mesh
- Add a world-space mesh (rendered in normal scene or overlay scene depending on desired occlusion).
- Update transform from worldStart/worldCurrent each frame while dragging.
- Use a shader for soft edge.

Acceptance criteria:
- Shadow is offset and perspective-correct.
- Shadow does not block interaction (render-only).

### Phase 3: “Scene interaction” upgrades
Pick one depending on what the renderer exposes:
- **Depth-based**: attach a depth texture to `sceneRenderTarget` and reconstruct world position in a post pass.
- **Height/normal-based**: use normal/displacement maps for subtle warping.
- **Occlusion-aware**: mask shadow using roof alpha / outdoor mask where appropriate.

## Open Questions / Risks
- What is the authoritative “terrain” representation?
  - If the ground is always a flat plane with normal mapping, then “distortion onto terrain” likely means:
    - perspective distortion + subtle normal-based warping
  - If there is real depth (e.g., elevated meshes), we should use a depth texture.
- Depth texture availability:
  - `EffectComposer.sceneRenderTarget` currently has `depthBuffer: true` but does not explicitly publish a `depthTexture`.
  - Adding a depth texture may have WebGL compatibility/perf implications.
- Composition / occlusion rules:
  - Should the shadow appear under overhead tiles (roof visible)?
  - Or should it always be visible (UI affordance)?

## Proposed File/Code Touchpoints
- `scripts/scene/interaction-manager.js`
  - Keep input + selection logic
  - Forward selection state to renderer component
- New: `scripts/scene/selection-box-renderer.js`
  - Owns overlay + shadow meshes/materials
  - Implements `update(timeInfo)`
- `scripts/foundry/canvas-replacement.js`
  - Register `SelectionBoxRenderer` as an updatable and provide it access to `sceneComposer`, `effectComposer`, etc.

## Success Criteria
- Selection box reads cleanly with minimal fill.
- Shadow feels grounded and cinematic, not like a flat UI drop shadow.
- Architecture supports adding:
  - animated line effects
  - text
  - additional decorative layers

