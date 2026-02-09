# Plan: Grid Rendering Upgrade (Foundry Parity + Visual FX)

## Goals
- Achieve **100% visual and behavioral parity** with Foundry VTT grid rendering for all supported grid types and grid configuration options.
- Keep the grid fully within the Three.js render pipeline (no PIXI rendering), consistent with Map Shine Advanced’s “full canvas replacement” goal.
- Add optional, performance-safe **grid visual effects** driven by:
  - Mouse position ("proximity glow" / local opacity + brightness boost with soft falloff)
  - Token positions (cell emphasis, occupancy cues, aura/range rings, movement/path affordances)

## Non-Goals (for this phase)
- Replacing Foundry’s measurement/ruler logic, pathfinding, or snapping math. We should **consume Foundry’s authoritative grid math** (e.g. `canvas.grid.getSnappedPoint`, `canvas.grid.measurePath`) and focus on rendering parity + visuals.
- Reproducing every module/system custom grid style plugin. We will support Foundry’s built-in grid styles first, and add an extensible style API afterward.

## Current State (Map Shine Advanced)
- `scripts/scene/grid-renderer.js` draws a grid into an off-screen 2D canvas and uses a `THREE.CanvasTexture` on a full-map plane.
- Supports:
  - Square grid (repeatable tile texture)
  - Hex grid (naive full-draw of polygons)
  - Basic styling: solid/dashed/dotted (module-defined, not Foundry-style parity)
- Missing key parity items:
  - Full set of Foundry grid types (hex orientations and any special cases)
  - Accurate Foundry grid styles (Foundry uses a shader-based approach)
  - Grid offsets (`shiftX`/`shiftY`) alignment
  - Behavior parity for "gridless" (including highlight semantics)
  - Crispness/anti-alias behavior parity and zoom-consistent thickness
  - Foundry highlight layer parity (conceptually)

## Foundry Reference Points (authoritative)
Key files (Foundry v12+):
- `foundryvttsourcecode/resources/app/client/canvas/layers/grid.mjs`
  - Creates a `GridMesh` and configures it with style, thickness, color, alpha.
  - Supports highlight layers concept (`GridHighlight`) and `highlightPosition` API.
- `foundryvttsourcecode/resources/app/client/canvas/containers/elements/grid-mesh.mjs`
  - Grid is rendered by a mesh + `GridShader`.
  - Grid is not rendered if `type === GRIDLESS` or thickness <= 0.
- `foundryvttsourcecode/resources/app/client/canvas/rendering/shaders/grid/grid.mjs`
  - Grid drawing is shader-based with AA in grid-space using a `resolution` uniform.
  - Enumerates grid types:
    - `SQUARE`
    - `HEXODDR`, `HEXEVENR`, `HEXODDQ`, `HEXEVENQ`
- `foundryvttsourcecode/resources/app/common/grid/*`
  - Defines the math and semantics for Square/Hex/Gridless, diagonals rules, coordinate conversions, snapping.

## Parity Milestones (order of importance)

### P0 — Required for “Any Grid Type Works”
- **P0.1 Grid Type Parity**
  - Support rendering for:
    - `GRIDLESS` (renders nothing)
    - `SQUARE`
    - `HEXODDR`, `HEXEVENR`, `HEXODDQ`, `HEXEVENQ`
  - Ensure hex orientation matches Foundry:
    - “R” variants are row-based (pointy-topped)
    - “Q” variants are column-based (flat-topped)
    - odd/even offset rules match Foundry

- **P0.2 Scene Alignment Parity (Padding + Shifts)**
  - Ensure the rendered grid matches Foundry’s grid origin in scene coordinates.
  - Respect:
    - `canvas.dimensions` vs `canvas.dimensions.sceneRect`
    - Scene background offsets (Foundry derives `sceneX/sceneY` using background offset)
    - Scene grid shifts (`shiftX`, `shiftY`) as the user sets them in Scene configuration
  - Acceptance test: switching between Foundry grid and MSA grid yields identical alignment when overlayed.

- **P0.3 Style/Thickness/Color/Alpha Parity**
  - Use Foundry’s style identifiers, not module-invented ones.
  - Match Foundry defaults and configuration mapping:
    - `grid.style`
    - `grid.thickness`
    - `grid.color`
    - `grid.alpha`

- **P0.4 Zoom-Consistent Line Appearance**
  - The perceived thickness and AA behavior should match Foundry through zoom changes.
  - Avoid “texture swimming” and scaling artifacts from raster textures.

### P1 — Feature Parity That Users Notice Quickly
- **P1.1 Built-in Grid Styles Parity (Shader Features)**
  - Foundry’s shader supports multiple styles (lines, dashed, dotted, point-based variants).
  - Implement the same family of styles so “grid style” selection behaves identically.

- **P1.2 Highlight Semantics Parity (Rendering Side)**
  - Foundry has multiple named highlight layers and `highlightPosition` which can highlight a cell polygon.
  - We should add a compatible concept:
    - Multiple highlight channels (by name)
    - Each channel can draw filled polygons + optional border
  - We don’t have to reimplement Foundry’s measurement logic—just render the highlight data.

- **P1.3 Performance Parity**
  - Grid rendering cost should be essentially constant with map size (fill-rate bound only), not CPU-bound by drawing thousands of lines to a canvas.

### P2 — Nice-to-Have Parity and “Pro” Features
- **P2.1 Legacy Hex Handling**
  - Foundry has a `scene.flags.core.legacyHex` path which affects hex sizing.
  - Ensure we match Foundry when that flag is present.

- **P2.2 User Overrides (Module UI) mapped onto Foundry semantics**
  - If MSA exposes overrides, they should be expressed as:
    - Multipliers or additive adjustments on Foundry settings
    - Never breaking the base Foundry parity defaults

## Proposed Rendering Architecture (Three.js)

### Why move away from CanvasTexture
- Rasterizing the grid into a 2D canvas texture is:
  - Memory heavy for large scenes
  - Sensitive to resolution and zoom (blurriness or aliasing)
  - Expensive for hex grids if drawn “full map”
- Foundry solved this with a **procedural shader**, which is an ideal fit for Three.js.

### Core approach
- Render the grid as a **single plane mesh** covering `canvas.dimensions`.
- Replace the CanvasTexture approach with a **procedural `ShaderMaterial`** (grid computed analytically in fragment shader).
- Use uniforms that mirror Foundry’s shader inputs:
  - `uGridType` (square/hex variants)
  - `uGridSize` (+ `uGridSizeX/Y` for hex)
  - `uThickness`, `uColor`, `uAlpha`
  - `uResolution` (pixels per grid unit, used for consistent AA)
  - `uGridShift` (shiftX/shiftY)
  - Any style-specific uniforms

### Coordinate contract
- Compute the grid in **Foundry world pixel coordinates**.
- Ensure the plane’s mapping aligns with `canvas.dimensions` and background offsets.
- Avoid mixing screen-space UVs with world coordinates unless the effect is explicitly screen-space.

### Highlight layer integration (rendering only)
Two viable strategies (pick one for implementation; both can coexist later):
- **A. World-space highlight render target**
  - Render highlight geometry (polygons) into a world-space mask texture.
  - Sample this mask in the grid shader to composite fill/border.
  - Benefits: decouples highlight complexity from grid shader; easy to blur or animate.

- **B. Multi-mesh overlay**
  - Keep the base grid plane.
  - Add one mesh per highlight layer (or batch them) with a simple fill/border material.
  - Benefits: simpler pipeline, less RTT complexity.

## Visual Effects Roadmap

### FX0 — Cursor Proximity Glow (requested)
Goal: around mouse cursor, grid becomes higher opacity + higher brightness with blurred radius.

Implementation idea (shader-level, no post blur needed):
- Maintain `uCursorWorld` in world coords (Foundry pixel coords).
- In grid fragment shader compute distance `d = length(worldXY - uCursorWorld)`.
- Define a smooth falloff:
  - `falloff = exp(-(d*d) / (2*sigma*sigma))`
  - or `smoothstep(radius, 0, d)` for cheaper
- Apply boost to both:
  - **Opacity**: `alpha *= mix(1.0, cursorAlphaBoost, falloff)`
  - **Brightness** (grid line color): `rgb *= mix(1.0, cursorBrightnessBoost, falloff)`

Tunable parameters:
- Radius (in pixels or in grid units)
- Softness (sigma)
- Alpha boost
- Brightness boost
- Optional “snap ring” mode: strongest boost at nearest vertex/center

Performance notes:
- Zero additional passes; just a few ALU ops per fragment.
- Cursor updates can be throttled (e.g., only when pointer moves).

### FX1 — Token-Relative Grid Effects
Goal: grid responds to tokens’ positions relative to cells.

Candidate effects (choose a minimal initial set):
- **FX1.1 Occupied-cell emphasis**
  - Cells containing a token get a mild boost (or distinct tint).
  - Helps readability in dense scenes.

- **FX1.2 Controlled token “aura” emphasis**
  - Stronger grid near the currently controlled token(s).
  - Can help with tactical positioning.

- **FX1.3 Movement preview / drag affordance**
  - While dragging a token, subtly brighten the candidate destination cell and its neighbors.
  - Integrate with `canvas.grid.getSnappedPoint` output.

Data source options:
- **Option A (recommended): world-space influence mask RTT**
  - Render token-centered gaussian blobs into a low/medium-res world-space render target.
  - Sample it in grid shader as `influence = texture(uInfluenceMask, worldToUv(worldXY))`.
  - Works for square + hex without special casing.

- **Option B: cell-space DataTexture**
  - Build a 2D texture indexed by grid offsets (i,j) and sample via computed cell coords.
  - Great for square; trickier for hex (but doable using Foundry’s offset/cube mapping logic).

### FX2 — Style-aware “Smart Emphasis”
Goal: effects that work nicely regardless of chosen grid style.
- If style is point-based: emphasize points near cursor/token.
- If style is line-based: emphasize edges near cursor/token.
- If dashed/dotted: modulate dash visibility rather than brute-force alpha.

### FX3 — Cinematic / Magical Grid Modes (optional)
- Animated “scanline” pulse emanating from cursor or controlled token.
- Subtle noise-based shimmer at high zoom levels.
- Per-scene “material” for the grid (ink, neon, hologram) with stable parameter scaling.

## Settings / UX Plan
- Keep Foundry parity as the default path:
  - “Use Foundry grid settings” ON by default.
  - Extra FX features are additive toggles.

Suggested UI groups under existing Grid Settings:
- **Foundry Parity**
  - (Read-only) Detected grid type/style
  - (Optional) “Override thickness/color/alpha” but defaults to Foundry values
- **Cursor Glow**
  - Enabled
  - Radius
  - Softness
  - Opacity boost
  - Brightness boost
- **Token Effects**
  - Enabled
  - Occupancy highlight intensity
  - Controlled token aura intensity

## Testing & Acceptance Criteria

### Parity tests (visual)
- Compare against native Foundry grid with:
  - Square grid
  - Each hex orientation (`HEXODDR`, `HEXEVENR`, `HEXODDQ`, `HEXEVENQ`)
  - Multiple thickness values
  - Multiple styles
  - Non-zero `shiftX/shiftY`
  - Different padding settings

### Interaction tests
- `InteractionManager.snapToGrid` uses `canvas.grid.getSnappedPoint` already; confirm visual grid aligns exactly with snapping results.

### Performance tests
- Very large scenes (high `canvas.dimensions.width/height`)
- Hex grids (historically worst-case)
- Confirm grid render cost stays stable and doesn’t allocate memory per frame.

## Risks and Mitigations
- **Risk: Misalignment due to sceneRect/padding/background offsets**
  - Mitigation: explicitly define and document a single grid origin formula and test it with overlays.

- **Risk: Visual mismatch vs Foundry shader styles**
  - Mitigation: port the same conceptual style primitives (edge distance, nearest vertex, AA based on resolution).

- **Risk: Token-driven effects become CPU-heavy**
  - Mitigation: use an influence mask render target updated only on token changes (hooks) and mouse movement; avoid per-frame rebuilding.

## Implementation Notes (future work, not in this doc)
- After planning approval, implement parity in small steps:
  - Replace CanvasTexture grid with shader-based grid plane.
  - Add shift/padding alignment.
  - Add style parity.
  - Add cursor glow.
  - Add token influence mask and a small set of token-driven effects.
