# PLAN — Debug Layer Effect (Token Tether + LOS Probe)

## Goal
Create a developer-facing **Debug Layer** which can draw stable diagnostic information on top of the Three.js render.

Immediate goals (Phase 1):
- Track tokens:
  - World position (center)
  - Foundry document identifiers
  - Ownership / controllability (player ownership + `canUserModify`)
- Detect selection state:
  - “Selected/controlled” tokens
  - Which selected token is the active debug target
- Draw a tether line:
  - Line from selected token center → mouse pointer (on ground plane)
  - Show distance in **scene distance units** (grid units), stable under pan/zoom
- Detect wall blocking:
  - Determine if the tether segment is interrupted by a wall
  - Surface the collision point and “blocked/unblocked” state

Long-term goal:
- Provide the foundation for a **handheld torch** interaction:
  - If a player selects a token they own, the mouse becomes a torch/light
  - The torch can be moved within range of the token
  - The flame gutters / extinguishes when moved through a wall or too far away
  - It re-ignites when brought back within valid range

Non-goals (for this doc):
- Replacing Foundry UI/controls
- Any PIXI rendering; debug visuals must be **Three.js + HTML overlay only**

---

## Architectural Constraints (Project Rules)
- Foundry coordinates are **top-left origin, Y-down**.
- Three.js world is **bottom-left origin, Y-up**.
- Use `Coordinates.toWorld()` / `Coordinates.toFoundry()` for conversions.
- Token/tile docs are **top-left anchored** but Three.js sprites/meshes are positioned at **document center**.
- Prefer Three.js rendering; avoid PIXI except for data queries (walls/collision, ownership, etc.).

---

## Rendering Strategy (Overlay Layer)
We already have a dedicated overlay pass in `EffectComposer`:
- `OVERLAY_THREE_LAYER = 31`
- `EffectComposer._renderOverlayToScreen()` renders the scene again to screen, but with `camera.layers.set(OVERLAY_THREE_LAYER)`.

**Decision**: The Debug Layer should render exclusively in this overlay pass.

Implementation implications:
- Debug meshes (line, markers, hover text sprites if any) must be on Three layer `31`.
- Debug meshes must not pollute post-processing buffers.
- Use `depthTest: false` + `depthWrite: false` for readability.

For text, prefer HTML overlay (fixed-position div) instead of generating many Three.js text sprites.

---

## Data Sources & Responsibilities

### 1) Token Data
Primary data sources:
- `TokenManager` (Three-side):
  - Token center in Three coords: `sprite.position`
  - Document ref: `sprite.userData.tokenDoc`
  - Selection visuals already exist (`TokenManager.setTokenSelection`)
- Foundry token object (data/permissions/collision):
  - `canvas.tokens.get(tokenId)`
  - Ownership checks:
    - `token.document.isOwner`
    - `token.document.canUserModify(game.user, "update")`

### 2) Selection State
We need consistent selection truth for the debug target:
- **Foundry control state**: `controlToken` hooks (authoritative for “controlled tokens”)
- **Three selection set**: `InteractionManager.selection` (used for Three interactions)

**Decision**: For gameplay-facing mechanics (torch), use **Foundry controlled tokens** as the source of truth.
- Rationale: Foundry already enforces permissions/ownership semantics.

For debug display, show both:
- `isControlled` (Foundry)
- `isSelected` (Three)

### 3) Mouse Pointer World Position
We need stable world coordinates for the cursor on the ground plane.

Preferred approach:
- Reuse `InteractionManager.screenToWorld(clientX, clientY)` (already used for map points).
- Add a tiny API surface (if needed) so other systems can read it without reaching into private state:
  - `interactionManager.getLastPointerWorld()`
  - or a `debugState.pointerWorld` updated every `pointermove`.

### 4) Distance Measurement (World-Stable Units)
Compute in pixel/world units first:
- `distancePx = hypot(dx, dy)` using world XY

Convert to scene units:
- `distanceUnits = distancePx * (canvas.dimensions.distance / canvas.dimensions.size)`

This is stable across zoom because it derives from world positions, not screen-space.

### 5) Wall Blocking / Collision
We want to know if the segment (token center → cursor target) intersects blocking walls.

Primary candidate APIs:
- `Token.checkCollision(destination, { mode: 'closest' | 'any' })`
  - Already used in `InteractionManager` for token drag “fall back”.
  - Likely handles door state, wall types, and Foundry’s configured backends.
- Alternative (if we need raw segment tests): `canvas.walls` backend collision tests.

**Design goal**: get both
- boolean `blocked`
- optional `collisionPointFoundry` / `collisionPointWorld`

**Research item (implementation phase)**:
- Confirm exact return shape and options of `token.checkCollision` for v12.

---

## Proposed Class Design

### `DebugLayerEffect` (Effect-like, but overlay-rendered)
- **Location**: `scripts/effects/DebugLayerEffect.js`
- **Base**: extends `EffectBase`
- **Layer**: `RenderLayers.POST_PROCESSING` (or any layer), but it should **not** participate in ping-pong post buffers.
  - Its `render()` can be a no-op.
  - It uses `update(timeInfo)` to update overlay meshes and HTML.

Why still extend `EffectBase`?
- Unified lifecycle (initialize, update, dispose)
- Easy toggling + UI integration
- Centralized time via `timeInfo`

### Overlay Scene Objects
Owned by the effect:
- `this.overlayGroup` (THREE.Group)
- `this.tetherLine` (THREE.Line or a thin quad mesh)
- `this.cursorMarker` (ring/reticle)
- `this.collisionMarker` (optional)

All overlay objects:
- `object.layers.set(OVERLAY_THREE_LAYER)`
- `depthTest: false`, `depthWrite: false`

### HTML Debug Panel
- A single `div` with `pointer-events: none`.
- Displays:
  - selected token name/id
  - owner/permission summary
  - token center (world + foundry)
  - cursor pos (world + foundry)
  - distance (px + units)
  - blocked status and collision point

---

## UI / Controls
- Add a **Debug** section to Tweakpane:
  - `enabled`
  - `showPanel`
  - `showTether`
  - `showCollisionPoint`
  - `onlyWhenTokenControlled`
  - `onlyForOwnedTokens`
  - `maxDistanceUnits` (for future torch)

Optional:
- Keybind toggle: `Ctrl+Shift+D` (implementation decision).

---

## Phased Roadmap

### Phase 1 — Scaffold + Token Introspection
- Create `DebugLayerEffect` with overlay group and HTML panel.
- Identify “active token”:
  - Prefer first Foundry-controlled token.
  - Fallback to first Three-selected token.
- Display:
  - token id/name
  - ownership
  - token center (world/foundry)

### Phase 2 — Mouse Tether + Distance
- Track cursor world position via `InteractionManager.screenToWorld`.
- Draw line token→cursor.
- Display distance in scene units.

### Phase 3 — Wall Blocking Probe
- Add collision test each frame for the tether segment:
  - Convert endpoints to Foundry coords using `Coordinates.toFoundry`.
  - Run `token.checkCollision(dest, { mode: 'closest' })` (or equivalent) to get hit.
- Visualize:
  - Unblocked: green line
  - Blocked: red line + collision marker

### Phase 4 — Multi-Token + Ownership Rules
- Handle multiple controlled tokens:
  - Display list
  - Pick an “active” one deterministically (e.g. last controlled)
- Enforce “ownership gating”:
  - When not owner, show read-only debug info but disable torch behaviors.

### Phase 5 — Torch Prototype (Gameplay Interaction)
- When user is owner + token controlled:
  - Spawn a small flame sprite at cursor (overlay or world layer depending on desired occlusion)
  - Spawn a temporary light source driven by cursor position

Integration notes:
- Prefer routing temporary light through the existing Three lighting system rather than creating Foundry documents.
- Time animation uses `timeInfo` only.

### Phase 6 — Torch Rules: Gutter / Extinguish / Reignite
- Define torch state machine:
  - `LIT` / `GUTTERING` / `OUT`
- Rules:
  - If distance > max: gutter → out
  - If tether is blocked by wall: immediate out
  - If returned within range and unblocked: re-ignite
- Add audiovisual polish later (smoke puff, sound hooks, etc.).

---

## Performance Guardrails
- No per-frame allocations in `update()`:
  - Cache temp `Vector2/3`, arrays, and line geometry buffers.
- Single overlay line object reused; update its buffer attributes in-place.
- HTML panel updates throttled (e.g. 10–20 Hz) if needed.

---

## Open Questions / Research Items
- Exact Foundry collision API shape and best practice:
  - Is `token.checkCollision` sufficient for segment testing?
  - How to retrieve the collision point reliably?
- Which walls count as “blocking” for torch tether?
  - doors open vs closed
  - ethereal/invisible walls
  - terrain walls
- Where should the torch render relative to roofs?
  - overlay always visible vs physically occluded
  - interaction with roof alpha pass / indoor lighting logic

---

## Next Action
Implement **Phase 1–3** (scaffold → tether → wall blocking), because those directly de-risk the handheld torch design.
